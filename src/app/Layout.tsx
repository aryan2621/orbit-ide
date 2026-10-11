import { useEffect } from "react";
import { useWorkspace } from "../state/workspace";
import { useResolvedTheme } from "../state/theme";
import { BottomTab, useUi } from "../state/ui";
import { isReady, useSetup } from "../state/setup";
import { useProject } from "../state/project";
import { useDebug } from "../state/debug";
import Explorer, { newFileFolder } from "../sidebar/Explorer";
import SearchView from "../sidebar/SearchView";
import SourceControl from "../sidebar/SourceControl";
import PackagesView from "../sidebar/PackagesView";
import Terminal from "../panels/Terminal";
import BuildLog from "../panels/BuildLog";
import Problems from "../panels/Problems";
import Console from "../panels/Console";
import DebugPanel, { DebugView } from "../panels/Debug";
import Logcat from "../panels/Logcat";
import Output from "../panels/Output";
import Tests from "../panels/Tests";
import { runAllTests } from "../state/tests";
import Toasts from "./Toasts";
import EditorArea, { saveActiveWithFormat } from "../editor/EditorArea";
import { closeTab, cycleTab, reopenClosedTab } from "../editor/unsaved";
import SetupWizard from "../wizards/SetupWizard";
import NewProject from "../wizards/NewProject";
import Signing from "../wizards/Signing";
import Archive from "../wizards/Archive";
import AndroidNewProject from "../wizards/AndroidNewProject";
import AndroidSigning from "../wizards/AndroidSigning";
import AndroidArchive from "../wizards/AndroidArchive";
import Settings from "../wizards/Settings";
import DeviceManager from "../wizards/DeviceManager";
import WirelessPair from "../wizards/WirelessPair";
import VersionEditor from "../wizards/VersionEditor";
import AppSettings from "../wizards/AppSettings";
import Shortcuts from "../wizards/Shortcuts";
import IconGenerator from "../wizards/IconGenerator";
import Localization from "../wizards/Localization";
import Tour, { tourDone } from "./Tour";
import DevicePane from "../panels/DevicePane";
import DiffView from "../wizards/DiffView";
import AiPanel from "../ai/AiPanel";
import { EditSelectionHost } from "../ai/EditSelection";
import CommandPalette from "../palette/CommandPalette";
import { goBack, goForward } from "../editor/navigation";
import { openFolder } from "../palette/commands";
import BuildControls from "../toolbar/BuildControls";
import ActivityBar from "./ActivityBar";
import StatusBar from "./StatusBar";
import Resizer from "../components/Resizer";
import { ContextMenuHost } from "../components/ContextMenu";
import { PromptHost } from "../components/Prompt";
import { TooltipHost } from "../components/Tooltip";
import { IconClose, IconCommand, IconPanelBottom } from "../components/Icons";

const isMac = navigator.userAgent.includes("Mac");
const TABS: { id: BottomTab; label: string }[] = [
  { id: "terminal", label: "Terminal" },
  { id: "build", label: "Build" },
  { id: "console", label: "Console" },
  { id: "debug", label: "Debug Console" },
  { id: "logcat", label: "Logcat" },
];

export default function Layout() {
  const { root, error, clearError } = useWorkspace();
  const theme = useResolvedTheme();
  const ui = useUi();
  const debugStatus = useDebug((s) => s.status);
  const android = useProject((s) => s.info?.platform === "android");
  // Logcat is Android-only.
  const tabs = TABS.filter((t) => android || t.id !== "logcat");

  // The tour starts the first time a folder is open (after the setup wizard, if that's showing).
  useEffect(() => {
    if (root && !ui.showSetup && !tourDone()) useUi.getState().setShowTour(true);
  }, [root, ui.showSetup]);

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
      if (e.ctrlKey && !e.metaKey && !e.altKey && e.key === "Tab") {
        e.preventDefault();
        return cycleTab(e.shiftKey ? -1 : 1);
      }
      if (e.ctrlKey && !e.metaKey && !e.altKey) {
        // ⌃- back, ⌃⇧- forward, ⌃G go to line.
        if (e.code === "Minus") {
          e.preventDefault();
          return e.shiftKey ? goForward() : goBack();
        }
        if (!e.shiftKey && e.code === "KeyG" && useWorkspace.getState().activePath) {
          e.preventDefault();
          return s.setPalette("line");
        }
      }
      if (!e.metaKey) return;
      const key = e.key.toLowerCase();
      const bindings: Record<string, () => void> = e.shiftKey
        ? {
            n: () => s.setShowNewProject(true),
            p: () => s.setPalette("commands"),
            o: () => useWorkspace.getState().activePath && s.setPalette("symbols"),
            k: () => useWorkspace.getState().root && project.startTool("clean"),
            t: () => reopenClosedTab(),
            "[": () => cycleTab(-1),
            "{": () => cycleTab(-1),
            bracketleft: () => cycleTab(-1),
            "]": () => cycleTab(1),
            "}": () => cycleTab(1),
            bracketright: () => cycleTab(1),
            f: () => s.setActivity("search"),
            e: () => s.setActivity("explorer"),
            d: () => useWorkspace.getState().root && s.showActivity("debug"),
          }
        : e.altKey
          ? { s: () => useWorkspace.getState().saveAll() }
          : {
              s: saveActiveWithFormat,
              o: openFolder,
              n: () => {
                const root = useWorkspace.getState().root;
                if (!root) return;
                // Not setActivity: that hides the sidebar when Explorer is already showing.
                useUi.setState({ activity: "explorer", showSidebar: true });
                s.setNewFileIn(newFileFolder(root));
              },
              p: () => s.setPalette("files"),
              t: () => useWorkspace.getState().root && s.setPalette("workspace-symbols"),
              b: project.startBuild,
              u: () => useWorkspace.getState().root && runAllTests(),
              r: project.startRun,
              y: project.startDebug,
              ".": () => (project.cancelBuild(), debug.stop()),
              "0": () => useWorkspace.getState().root && s.toggleSidebar(),
              j: () => useWorkspace.getState().root && s.togglePanel(),
              ",": () => s.setShowSettings(true),
              "\\": () => useWorkspace.getState().splitEditor(),
              backslash: () => useWorkspace.getState().splitEditor(),
              i: () => s.setShowAiPanel(!useUi.getState().showAiPanel),
              w: () => {
                const { activePath } = useWorkspace.getState();
                if (activePath) closeTab(activePath);
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
        problems: <Problems />,
        debug: <DebugView />,
        tests: <Tests />,
        output: <Output />,
      }[ui.activity]
    : null;

  return (
    <div className={`app${isMac ? " mac" : ""}`}>
      <header className="toolbar" data-tauri-drag-region>
        <BuildControls />
        <span className="toolbar-title" data-tauri-drag-region>
          {root ? root.split("/").pop() : "Orbit"}
        </span>
        <button className="toolbar-search" onClick={() => ui.setPalette(root ? "files" : "commands")} title="Go to file (⌘P)">
          <IconCommand />
          <span>{root ? "Go to file…" : "Commands…"}</span>
          <kbd>⌘P</kbd>
        </button>
        {root && (
          <button className={`icon-btn${ui.showPanel ? " pressed" : ""}`} title="Toggle panel (⌘J)" onClick={ui.togglePanel}>
            <IconPanelBottom />
          </button>
        )}
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
          {/* No panel on the Welcome screen. Once a folder is open it's hidden rather than unmounted,
              so the shell session survives toggling. */}
          {root && (
          <div style={ui.showPanel ? { display: "contents" } : { display: "none" }}>
            <Resizer direction="vertical" size={ui.panelHeight} onResize={ui.setPanelHeight} invert />
            <div className="bottom-panel" style={{ height: ui.panelHeight }}>
              <div className="panel-header">
                <div className="panel-tabs">
                  {tabs.map((tab) => (
                    <button
                      key={tab.id}
                      className={`panel-tab${ui.bottomTab === tab.id ? " active" : ""}`}
                      onClick={() => ui.showBottomTab(tab.id)}
                    >
                      {tab.label}
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
              {ui.bottomTab === "console" && <Console />}
              {ui.bottomTab === "debug" && <DebugPanel />}
              {ui.bottomTab === "logcat" && <Logcat />}
            </div>
          </div>
          )}
        </section>
        {root && ui.showDevicePane && (
          <>
            <Resizer direction="horizontal" size={ui.devicePaneWidth} onResize={ui.setDevicePaneWidth} invert />
            <aside className="device-pane" style={{ width: ui.devicePaneWidth }}>
              <DevicePane />
            </aside>
          </>
        )}
        {ui.showAiPanel && (
          <>
            <Resizer direction="horizontal" size={ui.aiPanelWidth} onResize={ui.setAiPanelWidth} invert />
            <aside className="ai-pane" style={{ width: ui.aiPanelWidth }}>
              <AiPanel />
            </aside>
          </>
        )}
      </div>
      <StatusBar />
      {ui.showSetup && <SetupWizard />}
      {ui.showNewProject === "ios" && <NewProject />}
      {ui.showNewProject === "android" && <AndroidNewProject onClose={() => ui.setShowNewProject(false)} />}
      {ui.showSigning && root && (android ? <AndroidSigning onClose={() => ui.setShowSigning(false)} /> : <Signing />)}
      {ui.showArchive && root &&
        (android ? (
          <AndroidArchive
            onClose={() => ui.setShowArchive(false)}
            onArchive={(o) => useProject.getState().startArchive({ platform: "android", ...o })}
            onOpenSigning={() => {
              ui.setShowArchive(false);
              ui.setShowSigning(true);
            }}
          />
        ) : (
          <Archive />
        ))}
      {ui.showSettings && <Settings />}
      {ui.showDevices && <DeviceManager onClose={() => ui.setShowDevices(false)} />}
      {ui.showWirelessPair && <WirelessPair onClose={() => ui.setShowWirelessPair(false)} />}
      {ui.showVersion && root && <VersionEditor root={root} onClose={() => ui.setShowVersion(false)} />}
      {ui.showAppSettings && root && <AppSettings root={root} onClose={() => ui.setShowAppSettings(false)} />}
      {ui.showShortcuts && <Shortcuts onClose={() => ui.setShowShortcuts(false)} />}
      {ui.showIcons && root && <IconGenerator root={root} onClose={() => ui.setShowIcons(false)} />}
      {ui.showLocalization && root && <Localization root={root} onClose={() => ui.setShowLocalization(false)} />}
      {ui.showTour && root && <Tour onClose={() => ui.setShowTour(false)} />}
      {ui.diffPath && <DiffView theme={theme} />}
      <EditSelectionHost theme={theme} />
      {ui.palette && <CommandPalette key={ui.palette} />}
      <ContextMenuHost />
      <Toasts />
      <PromptHost />
      <TooltipHost />
    </div>
  );
}
