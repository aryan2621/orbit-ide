import { useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { JobExit, projectApi } from "../lib/ipc";
import { useUi } from "../state/ui";
import { useWorkspace } from "../state/workspace";
import { openAt } from "../editor/navigation";
import { confirmDiscardAll } from "../editor/unsaved";
import { IconClose } from "../components/Icons";

const DEPLOYMENT_TARGETS = ["17.0", "18.0", "26.0"];
const LOCATION_KEY = "orbit.newProject.location";
const PREFIX_KEY = "orbit.newProject.bundlePrefix";

function recall(key: string, fallback: string) {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

export default function NewProject() {
  const setShowNewProject = useUi((s) => s.setShowNewProject);
  const setRoot = useWorkspace((s) => s.setRoot);
  const [name, setName] = useState("MyApp");
  const [prefix, setPrefix] = useState(() => recall(PREFIX_KEY, "com.example"));
  const [location, setLocation] = useState(() => recall(LOCATION_KEY, ""));
  const [target, setTarget] = useState("18.0");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [log, setLog] = useState<string[]>([]);

  const nameValid = /^[A-Za-z][A-Za-z0-9]*$/.test(name);
  const bundleId = `${prefix}.${name.toLowerCase()}`;

  const chooseLocation = async () => {
    const dir = await open({ directory: true, multiple: false, defaultPath: location || undefined });
    if (typeof dir === "string") setLocation(dir);
  };

  const create = async () => {
    if (!(await confirmDiscardAll("Creating a project opens it and closes all files."))) return;
    setBusy(true);
    setError(null);
    setLog([]);
    try {
      localStorage.setItem(LOCATION_KEY, location);
      localStorage.setItem(PREFIX_KEY, prefix);
    } catch {}

    const jobId = crypto.randomUUID();
    const dir = `${location}/${name}`;
    const unlisten = [
      await listen<string>(`job://${jobId}/log`, (e) => setLog((l) => [...l, e.payload])),
      await listen<JobExit>(`job://${jobId}/exit`, (e) => {
        unlisten.forEach((u) => u());
        setBusy(false);
        if (e.payload.code !== 0) {
          setError("XcodeGen failed to generate the project. See the output above.");
          return;
        }
        setRoot(dir);
        setShowNewProject(false);
        openAt(`${dir}/${name}/ContentView.swift`);
      }),
    ];
    try {
      await projectApi.newProject(location, name, bundleId, target, jobId);
    } catch (e) {
      unlisten.forEach((u) => u());
      setBusy(false);
      setError(String(e));
    }
  };

  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-labelledby="new-project-title">
      <div className="setup">
        <header className="setup-header">
          <div>
            <h1 id="new-project-title">New iOS App</h1>
            <p className="muted">
              A SwiftUI app for iPhone and iPad, generated with XcodeGen.{" "}
              <button className="link" onClick={() => setShowNewProject("android")} disabled={busy}>
                Make an Android app instead
              </button>
            </p>
          </div>
          <button className="icon-btn" title="Close" onClick={() => setShowNewProject(false)} disabled={busy}>
            <IconClose />
          </button>
        </header>

        <label className="field">
          <span>App name</span>
          <input className="text-input" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          {!nameValid && <small className="field-error">Letters and numbers only, starting with a letter</small>}
        </label>
        <label className="field">
          <span>Organization identifier</span>
          <input className="text-input" value={prefix} onChange={(e) => setPrefix(e.target.value.trim())} />
          <small className="muted">Bundle ID: {bundleId}</small>
        </label>
        <label className="field">
          <span>Minimum iOS version</span>
          <select className="text-input" value={target} onChange={(e) => setTarget(e.target.value)}>
            {DEPLOYMENT_TARGETS.map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
        </label>
        <div className="field">
          <span>Location</span>
          <div className="row gap">
            <input className="text-input" value={location} readOnly placeholder="Choose a folder…" />
            <button className="btn" onClick={chooseLocation}>
              Choose…
            </button>
          </div>
          {location && <small className="muted">Creates {location}/{name}</small>}
        </div>

        {log.length > 0 && <pre className="check-log">{log.join("\n")}</pre>}
        {error && <div className="check-error">{error}</div>}

        <footer className="setup-footer">
          <button className="btn" onClick={() => setShowNewProject(false)} disabled={busy}>
            Cancel
          </button>
          <button className="btn primary" onClick={create} disabled={busy || !nameValid || !location || !prefix}>
            {busy ? <span className="spinner" /> : "Create"}
          </button>
        </footer>
      </div>
    </div>
  );
}
