import { KeyboardEvent, PointerEvent, useEffect, useRef, useState } from "react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { deviceViewApi } from "../lib/ipc";
import { useProject } from "../state/project";
import { useUi } from "../state/ui";
import { IconClose } from "../components/Icons";

/** Pause between frames once one has arrived (screenshots themselves take a few hundred ms). */
const FRAME_GAP_MS = 120;

const KEYS: Record<string, string> = {
  Backspace: "KEYCODE_DEL",
  Delete: "KEYCODE_FORWARD_DEL",
  Enter: "KEYCODE_ENTER",
  Tab: "KEYCODE_TAB",
  Escape: "KEYCODE_BACK",
  ArrowUp: "KEYCODE_DPAD_UP",
  ArrowDown: "KEYCODE_DPAD_DOWN",
  ArrowLeft: "KEYCODE_DPAD_LEFT",
  ArrowRight: "KEYCODE_DPAD_RIGHT",
};

const LIMITS_SEEN_KEY = "orbit.devicePane.limitsSeen";

/** What the pane can and can't do on each platform, so nobody hunts for features that don't exist. */
const LIMITS: Record<"ios" | "android", { can: string[]; cannot: string[] }> = {
  ios: {
    can: ["Live view of the Simulator's screen", "Screenshot and screen recording", "Dark/light mode, location, open a link, text size (⋯)"],
    cannot: [
      "Tapping, swiping or typing here: Apple has no supported way to send input to the Simulator from another app. Use the Simulator window.",
      "Rotating: use ⌘→ in the Simulator window.",
      "Physical iPhones: they can't be mirrored. Use a Simulator, or QuickTime's movie recording.",
      "The view updates a few times a second, so animations and video look choppy.",
    ],
  },
  android: {
    can: [
      "Live view of emulators and connected phones",
      "Tap, swipe, long-press and typing",
      "Back, Home and Recent apps buttons",
      "Rotate (emulators), screenshot and screen recording",
      "Dark/light mode, location, open a link, text size (⋯)",
    ],
    cannot: [
      "The view updates a few times a second, so animations and video look choppy.",
      "Multi-touch gestures (pinch, two-finger rotate) aren't supported.",
      "Rotate works on emulators only, not on phones.",
    ],
  },
};

function limitsSeen(platform: string) {
  try {
    return localStorage.getItem(`${LIMITS_SEEN_KEY}:${platform}`) === "1";
  } catch {
    return true;
  }
}

/** Live screen of the selected Simulator/emulator/phone, with Android touch + keyboard input and device tools. */
export default function DevicePane() {
  const { info, devices, deviceId } = useProject();
  const toggle = useUi((s) => s.toggleDevicePane);
  const platform = info?.platform === "android" ? "android" : info?.platform === "ios" ? "ios" : null;
  const device = devices.find((d) => d.id === deviceId);
  const ready = !!platform && !!device && device.booted && !device.id.startsWith("avd:") && device.kind !== "mac";
  const iosPhone = platform === "ios" && device?.kind === "device";
  const canMirror = ready && !iosPhone;
  const interactive = canMirror && platform === "android";

  const [src, setSrc] = useState<string | null>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const [dark, setDark] = useState(false);
  const [tools, setTools] = useState(false);
  // Shown automatically the first time on iOS, where most people expect to tap the screen.
  const [showLimits, setShowLimits] = useState(() => platform === "ios" && !limitsSeen("ios"));
  // The project may load after the pane opens.
  useEffect(() => {
    if (platform === "ios" && !limitsSeen("ios")) setShowLimits(true);
  }, [platform]);
  const closeLimits = () => {
    setShowLimits(false);
    try {
      if (platform) localStorage.setItem(`${LIMITS_SEEN_KEY}:${platform}`, "1");
    } catch {}
  };
  const refreshNow = useRef<() => void>(() => {});
  const imgRef = useRef<HTMLImageElement>(null);

  // The picker's list is only refreshed on focus; keep it current here until the device is up
  // (e.g. while Run boots an emulator).
  useEffect(() => {
    if (ready || !platform) return;
    useProject.getState().loadDevices();
    const t = setInterval(() => useProject.getState().loadDevices(), 5000);
    return () => clearInterval(t);
  }, [ready, platform]);

  // Frame loop: one screenshot at a time, while the pane is visible.
  useEffect(() => {
    if (!canMirror || !platform || !device) {
      setSrc(null);
      return;
    }
    let stopped = false;
    let url: string | null = null;
    let wake: (() => void) | null = null;
    refreshNow.current = () => wake?.();
    const sleep = (ms: number) =>
      new Promise<void>((resolve) => {
        const t = setTimeout(() => {
          wake = null;
          resolve();
        }, ms);
        wake = () => {
          clearTimeout(t);
          wake = null;
          resolve();
        };
      });
    (async () => {
      while (!stopped) {
        if (document.hidden) {
          await sleep(1000);
          continue;
        }
        try {
          const bytes = await deviceViewApi.screenshot(platform, device.id);
          if (stopped) break;
          const next = URL.createObjectURL(new Blob([bytes], { type: "image/png" }));
          setSrc(next);
          if (url) URL.revokeObjectURL(url);
          url = next;
          setError(null);
          await sleep(FRAME_GAP_MS);
        } catch (e) {
          setError(String(e));
          await sleep(2000);
        }
      }
    })();
    return () => {
      stopped = true;
      wake?.();
      if (url) URL.revokeObjectURL(url);
    };
  }, [canMirror, platform, device?.id]);

  const flash = (text: string) => {
    setNotice(text);
    setTimeout(() => setNotice((n) => (n === text ? null : n)), 4000);
  };
  const fail = (e: unknown) => flash(String(e));
  const after = (p: Promise<unknown>) => p.then(() => refreshNow.current(), fail);

  // ---- input (Android)
  const toDevice = (clientX: number, clientY: number) => {
    const img = imgRef.current;
    if (!img || !size) return null;
    const r = img.getBoundingClientRect();
    return { x: Math.round(((clientX - r.left) / r.width) * size.w), y: Math.round(((clientY - r.top) / r.height) * size.h) };
  };
  const down = useRef<{ x: number; y: number; cx: number; cy: number; t: number } | null>(null);
  const onPointerDown = (e: PointerEvent<HTMLImageElement>) => {
    if (!interactive) return;
    const p = toDevice(e.clientX, e.clientY);
    if (p) down.current = { ...p, cx: e.clientX, cy: e.clientY, t: Date.now() };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerUp = (e: PointerEvent<HTMLImageElement>) => {
    const start = down.current;
    down.current = null;
    if (!interactive || !start || !device) return;
    const end = toDevice(e.clientX, e.clientY);
    if (!end) return;
    const moved = Math.hypot(e.clientX - start.cx, e.clientY - start.cy);
    const held = Date.now() - start.t;
    if (moved < 6 && held < 500) after(deviceViewApi.input(device.id, "tap", start));
    // A long press is a zero-distance swipe that lasts as long as the press.
    else after(deviceViewApi.input(device.id, "swipe", { x: start.x, y: start.y, x2: end.x, y2: end.y, ms: Math.min(2000, Math.max(80, held)) }));
  };

  const typed = useRef("");
  const typeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flushTyped = () => {
    typeTimer.current = null;
    const text = typed.current;
    typed.current = "";
    if (text && device) after(deviceViewApi.input(device.id, "text", { text }));
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!interactive || !device || e.metaKey || e.ctrlKey) return;
    if (e.key.length === 1) {
      e.preventDefault();
      typed.current += e.key;
      if (typeTimer.current) clearTimeout(typeTimer.current);
      typeTimer.current = setTimeout(flushTyped, 150);
    } else if (KEYS[e.key]) {
      e.preventDefault();
      if (typeTimer.current) {
        clearTimeout(typeTimer.current);
        flushTyped();
      }
      key(KEYS[e.key]);
    }
  };
  const key = (k: string) => device && after(deviceViewApi.input(device.id, "key", { text: k }));

  // ---- tools
  const control = (action: string, value?: string) => device && platform && after(deviceViewApi.control(platform, device.id, action, value));
  const screenshot = async () => {
    if (!device || !platform) return;
    try {
      const path = await deviceViewApi.saveScreenshot(platform, device.id);
      flash("Screenshot saved to the Desktop");
      revealItemInDir(path).catch(() => {});
    } catch (e) {
      fail(e);
    }
  };
  const record = async () => {
    if (!device || !platform) return;
    try {
      if (recording) {
        setRecording(false);
        flash("Saving recording…");
        const path = await deviceViewApi.recordStop(device.id);
        flash("Recording saved to the Desktop");
        revealItemInDir(path).catch(() => {});
      } else {
        await deviceViewApi.recordStart(platform, device.id);
        setRecording(true);
      }
    } catch (e) {
      setRecording(false);
      fail(e);
    }
  };

  let empty: string | null = null;
  if (!platform) empty = "Open an iOS or Android project to see its device here.";
  else if (!device) empty = `Pick a ${platform === "android" ? "device or emulator" : "Simulator"} in the toolbar.`;
  else if (iosPhone) empty = "Mirroring a physical iPhone isn't supported; use a Simulator, or QuickTime's movie recording.";
  else if (!ready) empty = `${device.name} isn't running. Press Run (⌘R) or start it from Manage ${platform === "android" ? "emulators" : "Simulators"}.`;

  return (
    <div className="device-view">
      <div className="device-toolbar">
        <span className="device-title" title={device?.name}>
          {device?.name ?? "Device"}
        </span>
        <span className="grow" />
        {canMirror && (
          <>
            {interactive && (
              <>
                <button className="icon-btn small" title="Back" onClick={() => key("KEYCODE_BACK")}>
                  ◀
                </button>
                <button className="icon-btn small" title="Home" onClick={() => key("KEYCODE_HOME")}>
                  ●
                </button>
                <button className="icon-btn small" title="Recent apps" onClick={() => key("KEYCODE_APP_SWITCH")}>
                  ■
                </button>
              </>
            )}
            {platform === "android" && device?.id.startsWith("emulator-") && (
              <button className="icon-btn small" title="Rotate" onClick={() => control("rotate")}>
                ⟳
              </button>
            )}
            <button className="icon-btn small" title="Screenshot to Desktop" onClick={screenshot}>
              📷
            </button>
            <button className={`icon-btn small${recording ? " recording" : ""}`} title={recording ? "Stop recording" : "Record the screen"} onClick={record}>
              {recording ? "■" : "⏺"}
            </button>
            <button className="icon-btn small" title="More device settings" onClick={() => setTools(!tools)}>
              ⋯
            </button>
          </>
        )}
        {platform && (
          <button className="icon-btn small" title="What works here" onClick={() => (showLimits ? closeLimits() : setShowLimits(true))}>
            ⓘ
          </button>
        )}
        <button className="icon-btn small" title="Hide device screen" onClick={toggle}>
          <IconClose />
        </button>
      </div>

      {tools && canMirror && (
        <DeviceTools
          dark={dark}
          onDark={(d) => {
            setDark(d);
            control("appearance", d ? "dark" : "light");
          }}
          onControl={control}
        />
      )}

      {showLimits && platform && (
        <div className="device-limits">
          <strong>{platform === "ios" ? "iOS Simulator: view only" : "Android: fully interactive"}</strong>
          <ul>
            {LIMITS[platform].can.map((t) => (
              <li key={t} className="ok">
                <span className="check-mark">✓</span>
                {t}
              </li>
            ))}
            {LIMITS[platform].cannot.map((t) => (
              <li key={t} className="warn">
                <span className="check-mark">✕</span>
                {t}
              </li>
            ))}
          </ul>
          <button className="link" onClick={closeLimits}>
            Got it
          </button>
        </div>
      )}

      {notice && <div className="device-notice">{notice}</div>}

      <div className="device-screen" tabIndex={interactive ? 0 : -1} onKeyDown={onKeyDown}>
        {empty ? (
          <div className="panel-empty">{empty}</div>
        ) : src ? (
          <img
            ref={imgRef}
            src={src}
            alt={`${device?.name} screen`}
            draggable={false}
            className={interactive ? "interactive" : ""}
            onLoad={(e) => setSize({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
            onPointerDown={onPointerDown}
            onPointerUp={onPointerUp}
          />
        ) : (
          <div className="panel-empty">{error ?? "Connecting…"}</div>
        )}
      </div>
      {canMirror && (
        <div className="device-hint muted">
          {error && src
            ? error
            : interactive
              ? "Click to tap, drag to swipe, hold to long-press. Click the screen, then type."
              : "View only: tap and type in the Simulator window. ⓘ for details."}
        </div>
      )}
    </div>
  );
}

function DeviceTools({
  dark,
  onDark,
  onControl,
}: {
  dark: boolean;
  onDark: (dark: boolean) => void;
  onControl: (action: string, value?: string) => void;
}) {
  const [url, setUrl] = useState("");
  const [location, setLocation] = useState("37.7749,-122.4194");
  return (
    <div className="device-tools">
      <label className="setting-row">
        <span>Dark appearance</span>
        <input type="checkbox" className="switch" checked={dark} onChange={(e) => onDark(e.target.checked)} />
      </label>
      <label className="setting-row">
        <span>Text size</span>
        <select className="text-input" defaultValue="default" onChange={(e) => onControl("textsize", e.target.value)}>
          <option value="small">Small</option>
          <option value="default">Default</option>
          <option value="large">Large</option>
          <option value="largest">Largest</option>
        </select>
      </label>
      <form
        className="setting-row"
        onSubmit={(e) => {
          e.preventDefault();
          onControl("location", location);
        }}
      >
        <span>Location</span>
        <input className="text-input" value={location} onChange={(e) => setLocation(e.target.value)} placeholder="lat,lon" />
        <button className="btn">Set</button>
      </form>
      <form
        className="setting-row"
        onSubmit={(e) => {
          e.preventDefault();
          if (url.trim()) onControl("openurl", url.trim());
        }}
      >
        <span>Open link</span>
        <input className="text-input" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="myapp://path or https://…" />
        <button className="btn">Open</button>
      </form>
    </div>
  );
}
