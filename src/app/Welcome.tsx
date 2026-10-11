import { useWorkspace } from "../state/workspace";
import { useUi } from "../state/ui";
import { openFolder, switchFolder } from "../palette/commands";
import { IconFolderOpen, IconPlus, IconSettings } from "../components/Icons";

const SHORTCUTS: [string, string][] = [
  ["Go to file", "⌘P"],
  ["Command palette", "⇧⌘P"],
  ["New app", "⇧⌘N"],
  ["Build / Run / Debug", "⌘B  ⌘R  ⌘Y"],
  ["Go to symbol / line", "⇧⌘O  ⌘T  ⌃G"],
  ["Back / forward", "⌃-  ⌃⇧-"],
  ["Search in files", "⇧⌘F"],
  ["Toggle sidebar / panel", "⌘0  ⌘J"],
];

/** Shown in the editor area when no folder is open. */
export default function Welcome() {
  const recent = useWorkspace((s) => s.recent);
  const { setShowNewProject, setShowSetup } = useUi();
  const home = (p: string) => p.replace(/^\/Users\/[^/]+/, "~");

  return (
    <div className="welcome">
      <div className="welcome-inner">
        <img className="welcome-logo" src="/icon.svg" alt="" />
        <h1>Orbit</h1>
        <p className="muted">Build, run and ship iOS and Android apps, without opening Xcode or Android Studio.</p>

        <div className="welcome-actions">
          <button className="welcome-card" onClick={openFolder}>
            <IconFolderOpen />
            <span>
              <strong>Open Folder</strong>
              <small>Xcode, Swift package or Gradle project</small>
            </span>
            <kbd>⌘O</kbd>
          </button>
          <button className="welcome-card" onClick={() => setShowNewProject("ios")}>
            <IconPlus />
            <span>
              <strong>New iOS App</strong>
              <small>SwiftUI, iPhone and iPad</small>
            </span>
          </button>
          <button className="welcome-card" onClick={() => setShowNewProject("android")}>
            <IconPlus />
            <span>
              <strong>New Android App</strong>
              <small>Jetpack Compose, Kotlin</small>
            </span>
          </button>
          <button className="welcome-card" onClick={() => setShowSetup(true)}>
            <IconSettings />
            <span>
              <strong>Toolchain setup</strong>
              <small>Check what's installed</small>
            </span>
          </button>
        </div>

        <div className="welcome-columns">
          <section>
            <h2>Recent</h2>
            {recent.length === 0 ? (
              <p className="muted">Folders you open appear here.</p>
            ) : (
              <ul className="recent-list">
                {recent.map((r) => (
                  <li key={r}>
                    <button className="recent-item" onClick={() => switchFolder(r)} title={r}>
                      <span>{r.split("/").pop()}</span>
                      <small>{home(r.split("/").slice(0, -1).join("/"))}</small>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section>
            <h2>Shortcuts</h2>
            <dl className="shortcut-list">
              {SHORTCUTS.map(([label, keys]) => (
                <div key={label}>
                  <dt>{label}</dt>
                  <dd>
                    <kbd>{keys}</kbd>
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        </div>
      </div>
    </div>
  );
}
