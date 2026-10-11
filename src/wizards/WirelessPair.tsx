import { useEffect, useMemo, useRef, useState } from "react";
import { androidApi } from "../lib/ipc";
import { qrPath } from "../lib/qr";
import { useProject } from "../state/project";
import { IconClose, IconRefresh } from "../components/Icons";

const QR_TIMEOUT_MS = 120_000;
const POLL_MS = 1500;

const randomId = (n: number) => {
  const chars = "abcdefghijkmnpqrstuvwxyz23456789";
  return Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => chars[b % chars.length]).join("");
};
const ipOf = (host: string) => host.slice(0, host.lastIndexOf(":"));

type QrState = { phase: "waiting" | "pairing" | "connecting" | "done" | "expired" | "error"; text?: string };

/** "Pair device with QR code": the phone scans our code, advertises itself over mDNS, and we pair and connect. */
function QrPairing({ onConnected }: { onConnected: () => void }) {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<QrState>({ phase: "waiting" });
  // Service name and password the phone learns from the QR code (Android Studio uses the same format).
  const { payload, name, password } = useMemo(() => {
    const name = `orbit-${randomId(6)}`;
    const password = randomId(10);
    return { name, password, payload: `WIFI:T:ADB;S:${name};P:${password};;` };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt]);
  const qr = useMemo(() => qrPath(payload), [payload]);
  const cancelled = useRef(false);

  useEffect(() => {
    cancelled.current = false;
    setState({ phase: "waiting" });
    const started = Date.now();
    let timer: ReturnType<typeof setTimeout>;
    let pairedIp: string | null = null;

    const tick = async () => {
      if (cancelled.current) return;
      if (Date.now() - started > QR_TIMEOUT_MS) return setState({ phase: "expired" });
      try {
        const services = await androidApi.mdnsServices();
        if (cancelled.current) return;
        if (!pairedIp) {
          const pairing = services.find((s) => s.service.startsWith("_adb-tls-pairing") && s.name === name);
          if (pairing) {
            setState({ phase: "pairing" });
            try {
              await androidApi.pair(pairing.host, password);
            } catch (e) {
              if (!cancelled.current) setState({ phase: "error", text: String(e) || "Pairing failed." });
              return;
            }
            pairedIp = ipOf(pairing.host);
            setState({ phase: "connecting" });
          }
        } else {
          const connect = services.find((s) => s.service.startsWith("_adb-tls-connect") && ipOf(s.host) === pairedIp);
          if (connect) {
            const text = await androidApi.connect(connect.host);
            if (cancelled.current) return;
            setState({ phase: "done", text });
            onConnected();
            return;
          }
        }
      } catch {
        // Discovery or connect hiccups (adb restarting, phone still starting the service): retry.
      }
      timer = setTimeout(tick, POLL_MS);
    };
    timer = setTimeout(tick, POLL_MS);
    return () => {
      cancelled.current = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [payload]);

  const status = {
    waiting: "Waiting for the phone to scan…",
    pairing: "Phone found. Pairing…",
    connecting: "Paired. Connecting…",
    done: state.text ?? "Connected",
    expired: "The code expired.",
    error: state.text ?? "Pairing failed.",
  }[state.phase];

  return (
    <div className="pair-qr">
      <div className={`pair-qr-code${state.phase === "expired" || state.phase === "done" ? " faded" : ""}`}>
        <svg viewBox={`-2 -2 ${qr.size + 4} ${qr.size + 4}`} role="img" aria-label="Pairing QR code" shapeRendering="crispEdges">
          <rect x={-2} y={-2} width={qr.size + 4} height={qr.size + 4} fill="#fff" />
          <path d={qr.d} fill="#000" />
        </svg>
      </div>
      <div className="pair-qr-side">
        <ol className="pair-steps">
          <li>On the phone, open Settings → Developer options → Wireless debugging and turn it on.</li>
          <li>Tap “Pair device with QR code” and scan this code with the scanner that opens (the camera app won't work).</li>
        </ol>
        <div className={`pair-status ${state.phase}`}>
          {(state.phase === "waiting" || state.phase === "pairing" || state.phase === "connecting") && <span className="spinner" />}
          <span>{status}</span>
        </div>
        {(state.phase === "expired" || state.phase === "error" || state.phase === "done") && (
          <button className="btn" onClick={() => setAttempt((a) => a + 1)}>
            <IconRefresh /> {state.phase === "done" ? "Pair another phone" : "New code"}
          </button>
        )}
        <p className="muted small">
          The phone and this Mac must be on the same network (Android 11 or later). With a USB cable you don't need to pair: turn on USB debugging, plug in and tap Allow.
        </p>
      </div>
    </div>
  );
}

/** Pair and connect an Android phone over Wi-Fi (Settings → Developer options → Wireless debugging). */
export default function WirelessPair({ onClose }: { onClose: () => void }) {
  const loadDevices = useProject((s) => s.loadDevices);
  const [mode, setMode] = useState<"qr" | "code">("qr");
  const [pairHost, setPairHost] = useState("");
  const [code, setCode] = useState("");
  const [connectHost, setConnectHost] = useState("");
  const [busy, setBusy] = useState<"pair" | "connect" | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async (kind: "pair" | "connect", action: () => Promise<string>) => {
    setBusy(kind);
    setError(null);
    setMessage(null);
    try {
      setMessage(await action());
      if (kind === "pair") {
        // The connect port differs from the pairing port, but the IP is the same.
        const ip = pairHost.trim().split(":")[0];
        if (!connectHost) setConnectHost(`${ip}:`);
      } else {
        await loadDevices();
      }
    } catch (e) {
      setError(String(e) || "Failed");
    } finally {
      setBusy(null);
    }
  };

  const validHost = (h: string) => /^[^\s:]+:\d+$/.test(h.trim());

  return (
    <div className="overlay" role="dialog" aria-modal="true" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="setup pair-window">
        <header className="setup-header">
          <div>
            <h1>Pair Device over Wi-Fi</h1>
            <p className="muted">Run and debug on an Android phone without a cable.</p>
          </div>
          <button className="icon-btn" title="Close (Esc)" onClick={onClose}>
            <IconClose />
          </button>
        </header>

        <div className="segmented pair-mode">
          <button className={mode === "qr" ? "on" : ""} title="Scan a QR code with the phone" onClick={() => setMode("qr")}>
            QR code
          </button>
          <button className={mode === "code" ? "on" : ""} title="Type the IP address and pairing code shown on the phone" onClick={() => setMode("code")}>
            Pairing code
          </button>
        </div>

        {mode === "qr" ? (
          <QrPairing onConnected={() => loadDevices()} />
        ) : (
          <>
            <section className="pair-section">
              <h2>1. Pair</h2>
              <p className="muted">On the phone: Settings → Developer options → Wireless debugging → “Pair device with pairing code”. Enter what it shows.</p>
              <div className="pair-fields">
                <label className="field grow">
                  <span>IP address & port</span>
                  <input className="text-input" placeholder="192.168.1.20:37099" value={pairHost} onChange={(e) => setPairHost(e.target.value)} />
                </label>
                <label className="field pair-code">
                  <span>Pairing code</span>
                  <input className="text-input" placeholder="123456" inputMode="numeric" value={code} onChange={(e) => setCode(e.target.value)} />
                </label>
                <button
                  className="btn primary"
                 
                  disabled={busy !== null || !validHost(pairHost) || !code.trim()}
                  onClick={() => run("pair", () => androidApi.pair(pairHost.trim(), code.trim()))}
                >
                  {busy === "pair" ? "Pairing…" : "Pair"}
                </button>
              </div>
            </section>

            <section className="pair-section">
              <h2>2. Connect</h2>
              <p className="muted">Enter the IP address & port at the top of the Wireless debugging screen. Paired phones only need this step next time.</p>
              <div className="pair-fields">
                <label className="field grow">
                  <span>IP address & port</span>
                  <input className="text-input" placeholder="192.168.1.20:41235" value={connectHost} onChange={(e) => setConnectHost(e.target.value)} />
                </label>
                <button
                  className="btn primary"
                 
                  disabled={busy !== null || !validHost(connectHost)}
                  onClick={() => run("connect", () => androidApi.connect(connectHost.trim()))}
                >
                  {busy === "connect" ? "Connecting…" : "Connect"}
                </button>
              </div>
            </section>

            {message && <p className="muted">{message}</p>}
            {error && <div className="check-error">{error}</div>}
          </>
        )}

        <footer className="setup-footer">
          <span className="grow" />
          <button className="btn primary" onClick={onClose}>
            Done
          </button>
        </footer>
      </div>
    </div>
  );
}
