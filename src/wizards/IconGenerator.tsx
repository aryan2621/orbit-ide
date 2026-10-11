import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { generateAppIcons } from "../lib/ipc";
import { useProject } from "../state/project";
import { IconClose } from "../components/Icons";

/** Generates every iOS/Android icon size from one square image. */
export default function IconGenerator({ root, onClose }: { root: string; onClose: () => void }) {
  const android = useProject((s) => s.info?.platform === "android");
  const [source, setSource] = useState<string | null>(null);
  const [background, setBackground] = useState("#FFFFFF");
  const [busy, setBusy] = useState(false);
  const [written, setWritten] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const pick = async () => {
    const file = await open({ multiple: false, filters: [{ name: "Image", extensions: ["png", "jpg", "jpeg"] }] });
    if (typeof file === "string") {
      setSource(file);
      setWritten(null);
      setError(null);
    }
  };

  const generate = async () => {
    if (!source) return;
    setBusy(true);
    setError(null);
    try {
      setWritten(await generateAppIcons(root, source, background));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const relative = (f: string) => (f.startsWith(root + "/") ? f.slice(root.length + 1) : f);

  return (
    <div className="overlay" role="dialog" aria-modal="true" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="setup settings">
        <header className="setup-header">
          <div>
            <h1>App Icon</h1>
            <p className="muted">
              Pick one square image (1024×1024 PNG works best) and Orbit writes every size the app needs.
              {android ? " Replaced icon files go to the Trash." : " Transparent areas become white: the App Store doesn't allow transparent icons."}
            </p>
          </div>
          <button className="icon-btn" title="Close" onClick={onClose}>
            <IconClose />
          </button>
        </header>

        <section className="settings-section">
          <div className="setting-row">
            <div>
              <div>Image</div>
              <small className="muted">{source ?? "None chosen"}</small>
            </div>
            <div className="row-actions">
              <button className="btn" onClick={pick}>
                Choose…
              </button>
            </div>
          </div>
          {android && (
            <label className="field">
              <span>Background (adaptive icons)</span>
              <input type="color" value={background} onChange={(e) => setBackground(e.target.value.toUpperCase())} />
            </label>
          )}
          {written && (
            <p className="muted">
              Wrote {written.length} files: {written.slice(0, 4).map(relative).join(", ")}
              {written.length > 4 ? "…" : ""}
            </p>
          )}
        </section>

        {error && <div className="check-error">{error}</div>}

        <footer className="setup-footer">
          <span className="grow" />
          <button className="btn" onClick={onClose}>
            Close
          </button>
          <button className="btn primary" disabled={!source || busy} onClick={generate}>
            {busy ? "Generating…" : "Generate"}
          </button>
        </footer>
      </div>
    </div>
  );
}
