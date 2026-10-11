import { useEffect, useState } from "react";
import { AppVersion, versionApi } from "../lib/ipc";
import { IconClose } from "../components/Icons";

/** 41 → 42, 1.2.3 → 1.2.4. */
function bump(build: string) {
  const parts = build.split(".");
  const last = Number(parts[parts.length - 1]);
  if (!Number.isInteger(last)) return build;
  parts[parts.length - 1] = String(last + 1);
  return parts.join(".");
}

/** View and edit the app's version (versionName / MARKETING_VERSION) and build number. */
export default function VersionEditor({ root, onClose }: { root: string; onClose: () => void }) {
  const [info, setInfo] = useState<AppVersion | null>(null);
  const [version, setVersion] = useState("");
  const [build, setBuild] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    versionApi.get(root).then((v) => {
      setInfo(v);
      setVersion(v.version ?? "");
      setBuild(v.build ?? "");
    });
  }, [root]);

  const save = async () => {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      await versionApi.set(root, version, build);
      setSaved(true);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const android = info?.platform === "android";
  const relative = (f: string) => (f.startsWith(root + "/") ? f.slice(root.length + 1) : f);
  const editable = info && !info.error;

  return (
    <div className="overlay" role="dialog" aria-modal="true" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="setup settings">
        <header className="setup-header">
          <div>
            <h1>Version & Build Number</h1>
            <p className="muted">
              {info?.files.length ? `Saved to ${info.files.map(relative).join(" and ")}.` : "The version users see and the build number stores require to increase."}
            </p>
          </div>
          <button className="icon-btn" title="Close" onClick={onClose}>
            <IconClose />
          </button>
        </header>

        {info === null ? (
          <div className="setup-step skeleton" />
        ) : (
          <section className="settings-section">
            <label className="field">
              <span>Version {android ? "(versionName)" : "(MARKETING_VERSION)"}</span>
              <input
                className="text-input"
                placeholder="1.0.0"
                value={version}
                disabled={!editable}
                onChange={(e) => (setVersion(e.target.value), setSaved(false))}
              />
            </label>
            <label className="field">
              <span>Build {android ? "(versionCode)" : "(CURRENT_PROJECT_VERSION)"}</span>
              <div className="row gap">
                <input
                  className="text-input"
                  placeholder="1"
                  value={build}
                  disabled={!editable}
                  onChange={(e) => (setBuild(e.target.value), setSaved(false))}
                />
                <button className="btn" disabled={!editable || !build} onClick={() => (setBuild(bump(build)), setSaved(false))}>
                  Bump
                </button>
              </div>
            </label>
            {saved && <p className="muted">Saved.</p>}
          </section>
        )}

        {(error || info?.error) && <div className="check-error">{error || info?.error}</div>}

        <footer className="setup-footer">
          <span className="grow" />
          <button className="btn" onClick={onClose}>
            Close
          </button>
          <button className="btn primary" disabled={!editable || busy || !version.trim() || !build.trim()} onClick={save}>
            {busy ? "Saving…" : "Save"}
          </button>
        </footer>
      </div>
    </div>
  );
}
