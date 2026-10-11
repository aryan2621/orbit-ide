import { useEffect, useState } from "react";
import { deviceViewApi } from "../lib/ipc";
import { useProject } from "../state/project";
import { useWorkspace } from "../state/workspace";
import { toast } from "../state/toasts";

type Platform = "ios" | "android";

/** Privacy services (simctl names; mapped to Android permissions on the Rust side). */
const SERVICES: [string, string][] = [
  ["camera", "Camera"],
  ["photos", "Photos"],
  ["location", "Location"],
  ["location-always", "Location (Always)"],
  ["microphone", "Microphone"],
  ["contacts", "Contacts"],
  ["calendar", "Calendar"],
  ["notifications", "Notifications"],
];

const PUSH_SAMPLE = JSON.stringify({ aps: { alert: { title: "Hello", body: "A test notification from Orbit" }, sound: "default", badge: 1 } }, null, 2);

let cachedAppId: { key: string; id: string } | null = null;

/** The open project's bundle id / applicationId (cached per project and scheme). */
export async function projectAppId(): Promise<string> {
  const root = useWorkspace.getState().root;
  const { scheme, configuration } = useProject.getState();
  if (!root) throw new Error("Open a project first");
  const key = `${root}:${scheme}:${configuration}`;
  if (cachedAppId?.key === key) return cachedAppId.id;
  const id = await deviceViewApi.appId(root, scheme ?? "", configuration);
  cachedAppId = { key, id };
  return id;
}

/** Runs a device tool on the toolbar's selected device, reporting the result as a toast. */
export async function runDeviceTool(action: string, value?: string, done?: string) {
  const { devices, deviceId, info } = useProject.getState();
  const device = devices.find((d) => d.id === deviceId);
  const platform: Platform = info?.platform === "android" ? "android" : "ios";
  if (!device || device.kind === "mac" || !device.booted) return toast("Select a running Simulator or emulator in the toolbar first", "error");
  try {
    const appId = action === "statusbar" ? "" : await projectAppId();
    const result = await deviceViewApi.appTool(platform, device.id, appId, action, value);
    if (done) toast(done);
    return result;
  } catch (e) {
    toast(String(e), "error");
  }
}

/** Device Manager section: push notifications, permissions, status bar, app data. */
export default function DeviceTools({ platform }: { platform: Platform }) {
  const { devices, deviceId } = useProject();
  const running = devices.filter((d) => d.booted && d.kind !== "mac" && (platform === "ios" ? d.kind === "simulator" : true));
  const [target, setTarget] = useState<string>("");
  const [appId, setAppId] = useState("");
  const [service, setService] = useState("camera");
  const [payload, setPayload] = useState(PUSH_SAMPLE);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);

  useEffect(() => {
    if (!running.some((d) => d.id === target)) setTarget(running.find((d) => d.id === deviceId)?.id ?? running[0]?.id ?? "");
  }, [running.map((d) => d.id).join(), deviceId]);

  useEffect(() => {
    projectAppId().then(setAppId, () => {});
  }, []);

  const run = async (action: string, value: string | undefined, done: string) => {
    setBusy(action + (value ?? ""));
    setMessage(null);
    try {
      const result = await deviceViewApi.appTool(platform, target, appId.trim(), action, value);
      setMessage({ text: result ? `${done}: ${result}` : done, error: false });
    } catch (e) {
      setMessage({ text: String(e), error: true });
    } finally {
      setBusy(null);
    }
  };
  const btn = (action: string, value: string | undefined, label: string, done: string, disabled = false) => (
    <button className="btn" disabled={!target || busy !== null || disabled || (action !== "statusbar" && !appId.trim())} onClick={() => run(action, value, done)}>
      {busy === action + (value ?? "") ? "…" : label}
    </button>
  );

  return (
    <section className="settings-section">
      <h2>App tools</h2>
      {running.length === 0 ? (
        <p className="muted">Start a {platform === "android" ? "device or emulator" : "Simulator"} to send notifications, change permissions or clean up the status bar.</p>
      ) : (
        <>
          <div className="setting-row">
            <div>Device</div>
            <select value={target} onChange={(e) => setTarget(e.target.value)}>
              {running.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          </div>
          <div className="setting-row">
            <div>
              <div>App</div>
              <small className="muted">{platform === "android" ? "applicationId" : "Bundle identifier"}</small>
            </div>
            <input className="text-input" value={appId} placeholder="com.example.app" onChange={(e) => setAppId(e.target.value)} />
          </div>
          <div className="setting-row">
            <div>Permission</div>
            <div className="row-actions">
              <select value={service} onChange={(e) => setService(e.target.value)}>
                {SERVICES.map(([k, l]) => (
                  <option key={k} value={k}>
                    {l}
                  </option>
                ))}
              </select>
              {btn("grant", service, "Grant", "Granted")}
              {btn("revoke", service, "Revoke", "Revoked")}
              {btn("reset", service, "Reset", "Reset; the app will ask again")}
            </div>
          </div>
          <div className="setting-row">
            <div>
              <div>Status bar</div>
              <small className="muted">9:41, full battery and signal, for screenshots</small>
            </div>
            <div className="row-actions">
              {btn("statusbar", "clean", "Clean", "Status bar cleaned")}
              {btn("statusbar", "clear", "Restore", "Status bar restored")}
            </div>
          </div>
          {platform === "ios" && (
            <>
              <div className="setting-row">
                <div>
                  <div>App data</div>
                  <small className="muted">Documents, Library and caches of the installed app</small>
                </div>
                {btn("appdata", undefined, "Open in Finder", "Opened")}
              </div>
              <label className="field">
                <span>Test push notification (APNs payload)</span>
                <textarea className="text-input code-input" rows={7} spellCheck={false} value={payload} onChange={(e) => setPayload(e.target.value)} />
              </label>
              <div className="row-actions">{btn("push", payload, "Send Notification", "Notification sent")}</div>
            </>
          )}
          {message && <p className={message.error ? "check-error" : "muted"}>{message.text}</p>}
        </>
      )}
    </section>
  );
}
