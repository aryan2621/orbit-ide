import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { JobExit } from "../lib/ipc";
import { useWorkspace } from "../state/workspace";
import { openAt } from "../editor/navigation";
import { confirmDiscardAll } from "../editor/unsaved";
import { IconClose } from "../components/Icons";

/** Minimum SDK choices with the share of devices they reach (approximate). The template's launcher
 * icon is an adaptive icon only, which needs API 26, so that's the lowest choice. */
const MIN_SDKS = [
  { api: 26, label: "API 26 · Android 8.0 (~96% of devices)" },
  { api: 29, label: "API 29 · Android 10 (~90% of devices)" },
  { api: 31, label: "API 31 · Android 12 (~80% of devices)" },
];
const LOCATION_KEY = "orbit.newProject.location";
const PREFIX_KEY = "orbit.newProject.bundlePrefix";

function recall(key: string, fallback: string) {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

/** New Android App: Jetpack Compose + Material 3, Kotlin DSL, version catalog, Gradle wrapper. */
export default function AndroidNewProject({ onClose }: { onClose: () => void }) {
  const setRoot = useWorkspace((s) => s.setRoot);
  const [name, setName] = useState("MyApp");
  const [prefix, setPrefix] = useState(() => recall(PREFIX_KEY, "com.example"));
  const [location, setLocation] = useState(() => recall(LOCATION_KEY, ""));
  const [minSdk, setMinSdk] = useState(26);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<string | null>(null);
  const [log, setLog] = useState<string[]>([]);

  const nameValid = /^[A-Za-z][A-Za-z0-9]*$/.test(name);
  const packageName = `${prefix}.${name.toLowerCase()}`;
  const packageValid = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/.test(packageName);

  const chooseLocation = async () => {
    const dir = await open({ directory: true, multiple: false, defaultPath: location || undefined });
    if (typeof dir === "string") setLocation(dir);
  };

  const openProject = (dir: string) => {
    setRoot(dir);
    onClose();
    openAt(`${dir}/app/src/main/java/${packageName.replace(/\./g, "/")}/MainActivity.kt`);
  };

  const create = async () => {
    if (!(await confirmDiscardAll("Creating a project opens it and closes all files."))) return;
    setBusy(true);
    setError(null);
    setCreated(null);
    setLog([]);
    try {
      localStorage.setItem(LOCATION_KEY, location);
      localStorage.setItem(PREFIX_KEY, prefix);
    } catch {}

    const jobId = crypto.randomUUID();
    let dir = `${location}/${name}`;
    const unlisten = [
      await listen<string>(`job://${jobId}/log`, (e) => setLog((l) => [...l, e.payload].slice(-200))),
      await listen<JobExit>(`job://${jobId}/exit`, (e) => {
        unlisten.forEach((u) => u());
        setBusy(false);
        if (e.payload.code === 0) {
          openProject(dir);
        } else {
          // The files exist; only Gradle's first sync failed (often no network).
          setCreated(dir);
          setError("The project was created, but Gradle couldn't prepare it. See the output above.");
        }
      }),
    ];
    try {
      dir = await invoke<string>("android_new_project", { parent: location, name, package: packageName, minSdk, jobId });
    } catch (e) {
      unlisten.forEach((u) => u());
      setBusy(false);
      setError(String(e));
    }
  };

  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-labelledby="android-new-project-title">
      <div className="setup">
        <header className="setup-header">
          <div>
            <h1 id="android-new-project-title">New Android App</h1>
            <p className="muted">A Jetpack Compose app with Material 3, Kotlin build scripts and the Gradle wrapper.</p>
          </div>
          <button className="icon-btn" title="Close" onClick={onClose} disabled={busy}>
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
          {packageValid ? (
            <small className="muted">Package name: {packageName}</small>
          ) : (
            <small className="field-error">Use lowercase reverse-domain form, e.g. com.example</small>
          )}
        </label>
        <label className="field">
          <span>Minimum SDK</span>
          <select className="text-input" value={minSdk} onChange={(e) => setMinSdk(Number(e.target.value))}>
            {MIN_SDKS.map((s) => (
              <option key={s.api} value={s.api}>
                {s.label}
              </option>
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
          {location && (
            <small className="muted">
              Creates {location}/{name}
            </small>
          )}
        </div>

        {log.length > 0 && <pre className="check-log">{log.join("\n")}</pre>}
        {error && <div className="check-error">{error}</div>}

        <footer className="setup-footer">
          <button className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          {created ? (
            <button className="btn primary" onClick={() => openProject(created)}>
              Open anyway
            </button>
          ) : (
            <button
              className="btn primary"
              onClick={create}
              disabled={busy || !nameValid || !packageValid || !location}
            >
              {busy ? <span className="spinner" /> : "Create"}
            </button>
          )}
        </footer>
      </div>
    </div>
  );
}
