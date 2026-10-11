import { ReactNode, useEffect, useState } from "react";
import { AutoSave, EditorSettings, SettingsScope, useSettings } from "../state/settings";
import { ThemePref, useThemePref } from "../state/theme";
import { useUi } from "../state/ui";
import { useWorkspace } from "../state/workspace";
import { IconClose, IconCode, IconInfo, IconKeyboard, IconSettings, IconSparkle } from "../components/Icons";
import SearchField from "../components/SearchField";
import { ShortcutList } from "./Shortcuts";
import AiSetup from "../ai/AiSetup";
import { appInfo, openLogs, reportProblem } from "../lib/log";
import { checkForUpdates } from "../state/updates";

type Page = "general" | "editor" | "ai" | "keyboard" | "about";
const PAGES: { id: Page; label: string; group: string; icon: ReactNode; keywords: string }[] = [
  { id: "general", label: "General", group: "Settings", icon: <IconSettings />, keywords: "theme appearance dark light system mode colors" },
  { id: "editor", label: "Editor", group: "Settings", icon: <IconCode />, keywords: "font size family ligatures tab spaces word wrap minimap auto save format on save inlay hints project override" },
  { id: "ai", label: "AI", group: "Settings", icon: <IconSparkle />, keywords: "model download qwen llama context memory idle unload inline completions chat assistant license import gguf" },
  { id: "keyboard", label: "Keyboard Shortcuts", group: "Orbit", icon: <IconKeyboard />, keywords: "keys hotkeys bindings shortcuts command" },
  { id: "about", label: "About", group: "Orbit", icon: <IconInfo />, keywords: "version update check logs report problem privacy telemetry license" },
];

/** A titled group of rows, like Claude's settings sections. */
function Section({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <section className="settings-section">
      {title && <h3>{title}</h3>}
      {children}
    </section>
  );
}

/** A row that isn't a per-project editor setting. */
function Plain({ label, detail, children }: { label: string; detail?: string; children: ReactNode }) {
  return (
    <div className="setting-row">
      <div>
        <div>{label}</div>
        {detail && <small className="muted">{detail}</small>}
      </div>
      {children}
    </div>
  );
}

/** A setting row; in project scope, overridden values are marked and can be reset to the global value. */
function Row({ label, detail, field, scope, children }: { label: string; detail?: string; field: keyof EditorSettings; scope: SettingsScope; children: ReactNode }) {
  const overridden = useSettings((s) => field in s.project);
  const clearOverride = useSettings((s) => s.clearOverride);
  return (
    // A div, not a label: a label would forward clicks on its text to the first button inside.
    <div className="setting-row">
      <div>
        <div>
          {label}
          {scope === "project" && overridden && (
            <>
              {" "}
              <span className="muted">· this project</span>{" "}
              <button className="link" onClick={() => clearOverride(field)}>
                Use global
              </button>
            </>
          )}
        </div>
        {detail && <small className="muted">{detail}</small>}
      </div>
      {children}
    </div>
  );
}

export default function Settings() {
  const setShowSettings = useUi((s) => s.setShowSettings);
  const initialPage = useUi((s) => s.settingsPage) as Page;
  const root = useWorkspace((s) => s.root);
  const [selected, setSelected] = useState<Page>(PAGES.some((p) => p.id === initialPage) ? initialPage : "general");
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<SettingsScope>("global");
  const [version, setVersion] = useState<string | null>(null);
  const s = useSettings();
  const { pref, set: setTheme } = useThemePref();
  // Global scope edits and shows the global values; project scope shows the effective ones.
  const values: EditorSettings = scope === "global" ? s.global : s;
  const update = (patch: Partial<EditorSettings>) => s.update(patch, scope);
  const projectName = root?.split("/").pop();
  const close = () => {
    setShowSettings(false);
    useUi.getState().setSettingsPage("general");
  };

  // The sidebar search narrows the pages; the first match is shown when the current page doesn't match.
  const q = query.trim().toLowerCase();
  const pageMatches = (p: (typeof PAGES)[number]) => `${p.label} ${p.keywords}`.toLowerCase().includes(q);
  // Keyboard Shortcuts stays listed while searching: its rows are filtered by the query instead.
  const matches = PAGES.filter((p) => !q || pageMatches(p) || p.id === "keyboard");
  const page = matches.some((p) => p.id === selected) || matches.length === 0 ? selected : matches[0].id;
  const groups = [...new Set(PAGES.map((p) => p.group))];

  useEffect(() => {
    appInfo().then((i) => setVersion(i.version), () => {});
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggle = (field: "wordWrap" | "minimap" | "formatOnSave" | "inlayHints", label: string, detail?: string) => (
    <Row label={label} detail={detail} field={field} scope={scope}>
      <input type="checkbox" className="switch" checked={values[field]} onChange={(e) => update({ [field]: e.target.checked })} />
    </Row>
  );

  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-label="Settings" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="settings-window">
        <nav className="settings-nav">
          <SearchField autoFocus placeholder="Search" value={query} onValueChange={setQuery} />
          {groups.map((g) => {
            const items = matches.filter((p) => p.group === g);
            return (
              items.length > 0 && (
                <div className="settings-nav-group" key={g}>
                  <div className="settings-nav-label">{g}</div>
                  {items.map((p) => (
                    <button key={p.id} className={`settings-nav-item${page === p.id ? " active" : ""}`} onClick={() => setSelected(p.id)}>
                      {p.icon}
                      <span>{p.label}</span>
                    </button>
                  ))}
                </div>
              )
            );
          })}
          {matches.length === 0 && <div className="settings-nav-empty muted">No settings match “{query}”.</div>}
        </nav>

        <div className="settings-page">
          <button className="icon-btn settings-close" title="Close (Esc)" onClick={close}>
            <IconClose />
          </button>

          {page === "general" && (
            <>
              <h2>General</h2>
              <Section title="Appearance">
                <Plain label="Theme" detail="Follow macOS, or always use light or dark.">
                  <div className="segmented">
                    {(["system", "light", "dark"] as ThemePref[]).map((t) => (
                      <button key={t} className={pref === t ? "on" : ""} onClick={() => setTheme(t)}>
                        {t[0].toUpperCase() + t.slice(1)}
                      </button>
                    ))}
                  </div>
                </Plain>
              </Section>
            </>
          )}

          {page === "editor" && (
            <>
              <h2>
                Editor {root && scope === "project" && <span className="settings-badge">{projectName}</span>}
              </h2>
              {root && (
                <div className="settings-scope">
                  <div className="segmented">
                    <button className={scope === "global" ? "on" : ""} onClick={() => setScope("global")}>
                      All projects
                    </button>
                    <button className={scope === "project" ? "on" : ""} title={`Overrides for ${projectName} only`} onClick={() => setScope("project")}>
                      This project
                    </button>
                  </div>
                  <small className="muted">
                    {scope === "global" ? "Saved on this Mac and applied immediately." : `Overrides for ${projectName} only; everything else follows All projects.`}
                  </small>
                </div>
              )}
              <Section title="Text">
                <Row label="Font size" field="fontSize" scope={scope}>
                  <div className="stepper-input">
                    <button className="btn" title="Smaller" disabled={values.fontSize <= 9} onClick={() => update({ fontSize: values.fontSize - 1 })}>−</button>
                    <span>{values.fontSize}px</span>
                    <button className="btn" title="Larger" disabled={values.fontSize >= 28} onClick={() => update({ fontSize: values.fontSize + 1 })}>+</button>
                  </div>
                </Row>
                <Row label="Font" detail="Any installed monospace font; ligatures turn on for custom fonts." field="fontFamily" scope={scope}>
                  <input className="text-input" list="font-families" placeholder="SF Mono (default)" value={values.fontFamily} onChange={(e) => update({ fontFamily: e.target.value })} />
                  <datalist id="font-families">
                    {["SF Mono", "Menlo", "Monaco", "Courier New", "JetBrains Mono", "Fira Code", "Cascadia Code", "Source Code Pro", "IBM Plex Mono"].map((f) => (
                      <option key={f} value={f} />
                    ))}
                  </datalist>
                </Row>
                <Row label="Tab size" field="tabSize" scope={scope}>
                  <div className="segmented">
                    {[2, 4, 8].map((n) => (
                      <button key={n} className={values.tabSize === n ? "on" : ""} onClick={() => update({ tabSize: n })}>
                        {n} spaces
                      </button>
                    ))}
                  </div>
                </Row>
                {toggle("wordWrap", "Word wrap", "Wrap long lines at the edge of the editor.")}
                {toggle("minimap", "Minimap", "A zoomed-out view of the file beside the scroll bar.")}
              </Section>
              <Section title="Saving">
                <Row label="Auto save" detail="Save files automatically as you work." field="autoSave" scope={scope}>
                  <div className="segmented">
                    {(
                      [
                        ["off", "Off"],
                        ["afterDelay", "After a delay"],
                        ["onFocusChange", "On focus change"],
                      ] as [AutoSave, string][]
                    ).map(([v, l]) => (
                      <button key={v} className={values.autoSave === v ? "on" : ""} onClick={() => update({ autoSave: v })}>
                        {l}
                      </button>
                    ))}
                  </div>
                </Row>
                {toggle("formatOnSave", "Format on save", "Formats through the language server when you press ⌘S.")}
              </Section>
              <Section title="Code intelligence">{toggle("inlayHints", "Inlay hints", "Parameter names and inferred types, shown inline by the language server.")}</Section>
              <div className="settings-reset">
                <button className="btn subtle" title={scope === "global" ? "Restore the default editor settings" : "Remove this project's overrides"} onClick={() => s.reset(scope)}>
                  {scope === "global" ? "Reset editor settings to defaults" : "Clear project overrides"}
                </button>
              </div>
            </>
          )}

          {page === "ai" && (
            <>
              <h2>AI</h2>
              <Section>
                <AiSetup />
              </Section>
            </>
          )}

          {page === "keyboard" && (
            <>
              <h2>Keyboard Shortcuts</h2>
              <p className="muted settings-lead">Everything else is in the Command Palette (⇧⌘P).</p>
              <ShortcutList query={q && !pageMatches(PAGES.find((p) => p.id === "keyboard")!) ? q : ""} />
            </>
          )}

          {page === "about" && (
            <>
              <h2>About</h2>
              <Section title="Orbit">
                <Plain label="Version" detail={version ? `Orbit ${version}` : undefined}>
                  <button className="btn" title="Look for a newer version on GitHub" onClick={() => checkForUpdates(true)}>
                    Check for Updates
                  </button>
                </Plain>
              </Section>
              <Section title="Support">
                <Plain label="Logs" detail="Kept on this Mac; useful when reporting a problem.">
                  <button className="btn" title="Show Orbit's log files in Finder" onClick={() => openLogs()}>
                    Open Logs
                  </button>
                </Plain>
                <Plain label="Report a problem" detail="Opens a pre-filled GitHub issue that you review before sending.">
                  <button className="btn" title="Open a new GitHub issue" onClick={() => reportProblem()}>
                    Report…
                  </button>
                </Plain>
              </Section>
              <Section title="Privacy">
                <p className="muted settings-note">
                  Orbit has no telemetry or accounts. The AI runs on this Mac; your code and chats never leave it. Orbit connects to the internet only to check for updates, download
                  models and toolchains you choose, and upload builds to Apple or Google.
                </p>
              </Section>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
