import { useState } from "react";
import { androidApi } from "../lib/ipc";
import { useProject } from "../state/project";
import { IconClose } from "../components/Icons";

/** Pair and connect an Android phone over Wi-Fi (Settings → Developer options → Wireless debugging). */
export default function WirelessPair({ onClose }: { onClose: () => void }) {
  const loadDevices = useProject((s) => s.loadDevices);
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
      <div className="setup settings">
        <header className="setup-header">
          <div>
            <h1>Pair Device over Wi-Fi</h1>
            <p className="muted">
              On the phone: Settings → Developer options → Wireless debugging. The phone and this Mac must be on the same network.
            </p>
          </div>
          <button className="icon-btn" title="Close" onClick={onClose}>
            <IconClose />
          </button>
        </header>

        <section className="settings-section">
          <h2>1. Pair</h2>
          <p className="muted">Tap “Pair device with pairing code” and enter the IP address & port and the code shown.</p>
          <label className="field">
            <span>IP address & port</span>
            <input className="text-input" placeholder="192.168.1.20:37099" value={pairHost} onChange={(e) => setPairHost(e.target.value)} />
          </label>
          <label className="field">
            <span>Pairing code</span>
            <input className="text-input" placeholder="123456" value={code} onChange={(e) => setCode(e.target.value)} />
          </label>
          <div className="row-actions">
            <button
              className="btn primary"
              disabled={busy !== null || !validHost(pairHost) || !code.trim()}
              onClick={() => run("pair", () => androidApi.pair(pairHost.trim(), code.trim()))}
            >
              {busy === "pair" ? "Pairing…" : "Pair"}
            </button>
          </div>
        </section>

        <section className="settings-section">
          <h2>2. Connect</h2>
          <p className="muted">Enter the IP address & port shown at the top of the Wireless debugging screen. Paired phones only need this step next time.</p>
          <label className="field">
            <span>IP address & port</span>
            <input className="text-input" placeholder="192.168.1.20:41235" value={connectHost} onChange={(e) => setConnectHost(e.target.value)} />
          </label>
          <div className="row-actions">
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
