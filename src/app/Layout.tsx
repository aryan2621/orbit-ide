import { useEffect } from "react";
import { useWorkspace } from "../state/workspace";
import { useResolvedTheme } from "../state/theme";
import { BottomTab, useUi } from "../state/ui";
import { isReady, useSetup } from "../state/setup";
import { useProject } from "../state/project";
import { useDebug } from "../state/debug";
import Explorer from "../sidebar/Explorer";
import SearchView from "../sidebar/SearchView";
import SourceControl from "../sidebar/SourceControl";
import PackagesView from "../sidebar/PackagesView";
import Terminal from "../panels/Terminal";
import BuildLog from "../panels/BuildLog";
import Problems from "../panels/Problems";
import Console from "../panels/Console";
import DebugPanel from "../panels/Debug";
import EditorArea, { saveActiveWithFormat } from "../editor/EditorArea";
import SetupWizard from "../wizards/SetupWizard";
import NewProject from "../wizards/NewProject";
import Signing from "../wizards/Signing";
import Archive from "../wizards/Archive";
import Settings from "../wizards/Settings";
import DiffView from "../wizards/DiffView";
import CommandPalette from "../palette/CommandPalette";
import { openFolder } from "../palette/commands";
import BuildControls from "../toolbar/BuildControls";
import ActivityBar from "./ActivityBar";
import StatusBar from "./StatusBar";
import Resizer from "../components/Resizer";
import { ContextMenuHost } from "../components/ContextMenu";
import { IconClose, IconCommand, IconPanelBottom, IconSidebar } from "../components/Icons";

const isMac = navigator.userAgent.includes("Mac");
const TABS: { id: BottomTab; label: string }[] = [
  { id: "terminal", label: "Terminal" },
  { id: "build", label: "Build" },
  { id: "problems", label: "Problems" },
  { id: "console", label: "Console" },
  { id: "debug", label: "Debug" },
];

export default function Layout() {
  const { root, error, clearError } = useWorkspace();
  const theme = useResolvedTheme();
  const ui = useUi();
  const problemCount = useProject((s) => s.build.diagnostics.length);
  const debugStatus = useDebug((s) => s.status);

  // First launch: check the toolchain and open the wizard if anything is missing.
  useEffect(() => {
    useSetup
      .getState()
      .refresh()
      .then((c) => !isReady(c) && useUi.getState().setShowSetup(true), () => useUi.getState().setShowSetup(true));
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = useUi.getState();
      const project = useProject.getState();
      const debug = useDebug.getState();
      // Debugger stepping (works while focus is in the editor too).
      if (debug.status === "paused" && !e.metaKey) {
        const actions: Record<string, () => void> = { F5: debug.resume, F6: debug.stepOver, F7: debug.stepInto, F8: debug.stepOut };
        if (actions[e.key]) {
          e.preventDefault();
          return actions[e.key]();
        }
      }
      if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "g") {
        e.preventDefault();
        return s.setActivity("git");
      }
      if (!e.metaKey) return;
      const key = e.key.toLowerCase();
      const bindings: Record<string, () => void> = e.shiftKey
        ? {
            n: () => s.setShowNewProject(true),
            p: () => s.setPalette("commands"),
            f: () => s.setActivity("search"),
            e: () => s.setActivity("explorer"),
          }
        : e.altKey
          ? { s: () => useWorkspace.getState().saveAll() }
          : {
              s: saveActiveWithFormat,
              o: openFolder,
              p: () => s.setPalette("files"),
              b: project.startBuild,
              r: project.startRun,
              y: project.startDebug,
              ".": () => (project.cancelBuild(), debug.stop()),
              "0": s.toggleSidebar,
              j: s.togglePanel,
              ",": () => s.setShowSettings(true),
              w: () => {
                const { activePath, closeFile } = useWorkspace.getState();
                if (activePath) closeFile(activePath);
              },
            };
      // `e.key` is "Dead"/symbols with ⌥; fall back to the physical key.
      const action = bindings[key] ?? bindings[e.code.replace(/^Key|^Digit/, "").toLowerCase()];
      if (action) {
        e.preventDefault();
        action();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const sidebarView = root
    ? {
        explorer: <Explorer root={root} />,
        search: <SearchView root={root} />,
        git: <SourceControl root={root} />,
        packages: <PackagesView root={root} />,
      }[ui.activity]
    : null;

  return (
    <div className={`app${isMac ? " mac" : ""}`}>
      <header className="toolbar" data-tauri-drag-region>
        <button className={`icon-btn${ui.showSidebar && root ? " pressed" : ""}`} title="Toggle sidebar (⌘0)" onClick={ui.toggleSidebar} disabled={!root}>
          <IconSidebar />
        </button>
        <BuildControls />
        <span className="toolbar-title" data-tauri-drag-region>
          {root ? root.split("/").pop() : "Orbit"}
        </span>
        <button className="toolbar-search" onClick={() => ui.setPalette(root ? "files" : "commands")} title="Go to file (⌘P)">
          <IconCommand />
          <span>{root ? "Go to file…" : "Commands…"}</span>
          <kbd>⌘P</kbd>
        </button>
        <button className={`icon-btn${ui.showPanel ? " pressed" : ""}`} title="Toggle panel (⌘J)" onClick={ui.togglePanel}>
          <IconPanelBottom />
        </button>
      </header>
      {error && (
        <div className="error-bar">
          <span className="grow">{error}</span>
          <button className="icon-btn" title="Dismiss" onClick={clearError}>
            <IconClose />
          </button>
        </div>
      )}
      <div className="main">
        {root && <ActivityBar />}
        {root && ui.showSidebar && (
          <>
            <aside className="sidebar" style={{ width: ui.sidebarWidth }}>
              {sidebarView}
            </aside>
            <Resizer direction="horizontal" size={ui.sidebarWidth} onResize={ui.setSidebarWidth} />
          </>
        )}
        <section className="center">
          <EditorArea theme={theme} />
          {/* Hidden rather than unmounted so the shell session survives toggling. */}
          <div style={ui.showPanel ? { display: "contents" } : { display: "none" }}>
            <Resizer direction="vertical" size={ui.panelHeight} onResize={ui.setPanelHeight} invert />
            <div className="bottom-panel" style={{ height: ui.panelHeight }}>
              <div className="panel-header">
                <div className="panel-tabs">
                  {TABS.map((tab) => (
                    <button
                      key={tab.id}
                      className={`panel-tab${ui.bottomTab === tab.id ? " active" : ""}`}
                      onClick={() => ui.showBottomTab(tab.id)}
                    >
                      {tab.label}
                      {tab.id === "problems" && problemCount > 0 && <span className="badge">{problemCount}</span>}
                      {tab.id === "debug" && (debugStatus === "paused" || debugStatus === "running") && <span className="live-dot" />}
                    </button>
                  ))}
                </div>
                <button className="icon-btn small" title="Hide panel (⌘J)" onClick={ui.togglePanel}>
                  <IconClose />
                </button>
              </div>
              {/* The terminal stays mounted so its shell survives tab switches. */}
              <div className="panel-content" style={ui.bottomTab === "terminal" ? undefined : { display: "none" }}>
                <Terminal cwd={root} theme={theme} />
              </div>
              {ui.bottomTab === "build" && <BuildLog />}
              {ui.bottomTab === "problems" && <Problems />}
              {ui.bottomTab === "console" && <Console />}
              {ui.bottomTab === "debug" && <DebugPanel />}
            </div>
          </div>
        </section>
      </div>
      <StatusBar />
      {ui.showSetup && <SetupWizard />}
      {ui.showNewProject && <NewProject />}
      {ui.showSigning && root && <Signing />}
      {ui.showArchive && root && <Archive />}
      {ui.showSettings && <Settings />}
      {ui.diffPath && <DiffView theme={theme} />}
      {ui.palette && <CommandPalette key={ui.palette} />}
      <ContextMenuHost />
    </div>
  );
}
