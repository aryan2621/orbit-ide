import { open } from "@tauri-apps/plugin-dialog";
import { useUi } from "../state/ui";
import { useWorkspace } from "../state/workspace";
import { useProject } from "../state/project";
import { useDebug } from "../state/debug";
import { useThemePref } from "../state/theme";
import { useGit } from "../state/git";
import { useSettings } from "../state/settings";
import { restartSwiftServer } from "../lsp/swift";
import { restartAndroidServers } from "../lsp/android";
import { activeEditor, goBack, goForward } from "../editor/navigation";
import { closeTab, confirmDiscardAll, cycleTab, reopenClosedTab } from "../editor/unsaved";
import { newFileFolder } from "../sidebar/Explorer";
import { saveActiveWithFormat } from "../editor/EditorArea";
import { openLogs, reportProblem } from "../lib/log";
import { runAllTests, runCurrentFile } from "../state/tests";
import { runDeviceTool } from "../wizards/DeviceTools";
import { aiApi } from "../lib/ipc";
import { aiAvailable, aiReady, useAi } from "../state/ai";
import { newChat } from "../ai/agent";
import { editSelectionWithAi } from "../ai/EditSelection";
import { fixBuild } from "../ai/actions";
import { checkForUpdates } from "../state/updates";

export interface Command {
  id: string;
  title: string;
  shortcut?: string;
  run: () => void;
}

export async function openFolder() {
  const dir = await open({ directory: true, multiple: false });
  if (typeof dir === "string") await switchFolder(dir);
}

/** Opens another folder, offering to save unsaved files from the current one first. */
export async function switchFolder(dir: string) {
  if (dir === useWorkspace.getState().root) return;
  if (await confirmDiscardAll("Opening another folder closes all files.")) useWorkspace.getState().setRoot(dir);
}

/** Everything the palette can do. Shortcuts are shown for reference; Layout binds them. */
export function getCommands(): Command[] {
  const ui = useUi.getState();
  const project = useProject.getState();
  const debug = useDebug.getState();
  const settings = useSettings.getState();
  const hasRoot = !!useWorkspace.getState().root;
  const cmds: (Command | false)[] = [
    { id: "open", title: "File: Open Folder…", shortcut: "⌘O", run: openFolder },
    hasRoot && { id: "quick-open", title: "Go to File…", shortcut: "⌘P", run: () => setTimeout(() => ui.setPalette("files")) },
    hasRoot && { id: "go-symbol", title: "Go to Symbol in File…", shortcut: "⇧⌘O", run: () => setTimeout(() => ui.setPalette("symbols")) },
    hasRoot && { id: "go-ws-symbol", title: "Go to Symbol in Workspace…", shortcut: "⌘T", run: () => setTimeout(() => ui.setPalette("workspace-symbols")) },
    hasRoot && { id: "go-line", title: "Go to Line…", shortcut: "⌃G", run: () => setTimeout(() => ui.setPalette("line")) },
    hasRoot && { id: "references", title: "Find All References", shortcut: "⇧F12", run: () => activeEditor()?.trigger("palette", "editor.action.referenceSearch.trigger", null) },
    hasRoot && { id: "go-back", title: "Go Back", shortcut: "⌃-", run: () => goBack() },
    hasRoot && { id: "go-forward", title: "Go Forward", shortcut: "⌃⇧-", run: () => goForward() },
    hasRoot && { id: "save", title: "File: Save", shortcut: "⌘S", run: () => saveActiveWithFormat() },
    hasRoot && { id: "save-all", title: "File: Save All", shortcut: "⌥⌘S", run: () => useWorkspace.getState().saveAll() },
    { id: "new-app", title: "Project: New iOS App…", run: () => ui.setShowNewProject("ios") },
    { id: "new-android-app", title: "Project: New Android App…", run: () => ui.setShowNewProject("android") },
    hasRoot && { id: "build", title: "Product: Build", shortcut: "⌘B", run: project.startBuild },
    hasRoot && { id: "run", title: "Product: Run", shortcut: "⌘R", run: project.startRun },
    hasRoot && { id: "debug", title: "Product: Debug", shortcut: "⌘Y", run: project.startDebug },
    hasRoot && { id: "test", title: "Product: Test", shortcut: "⌘U", run: () => runAllTests() },
    hasRoot && { id: "test-file", title: "Product: Test Current File", run: () => runCurrentFile() },
    hasRoot && { id: "tests-view", title: "View: Tests", run: () => ui.showActivity("tests") },
    hasRoot && { id: "debug-view", title: "View: Run and Debug", shortcut: "⇧⌘D", run: () => ui.showActivity("debug") },
    hasRoot && { id: "debug-console", title: "View: Debug Console", run: () => ui.showBottomTab("debug") },
    hasRoot && { id: "clean", title: "Product: Clean Build Folder", shortcut: "⇧⌘K", run: () => project.startTool("clean") },
    hasRoot && project.info?.platform === "ios" && { id: "resolve", title: "Product: Resolve Package Versions", run: () => project.startTool("resolve") },
    hasRoot && project.info?.platform === "android" && { id: "gradle-sync", title: "Android: Sync Project with Gradle Files", run: () => project.gradleSync() },
    hasRoot && !!project.pods && { id: "pods", title: "CocoaPods: pod install", run: () => project.startTool("pods") },
    hasRoot && { id: "stop", title: "Product: Stop", shortcut: "⌘.", run: () => (project.cancelBuild(), debug.stop()) },
    hasRoot && { id: "archive", title: "Product: Archive & Distribute…", run: () => ui.setShowArchive(true) },
    hasRoot && { id: "signing", title: "Project: Signing…", run: () => ui.setShowSigning(true) },
    hasRoot && { id: "version", title: "Project: Version & Build Number…", run: () => ui.setShowVersion(true) },
    hasRoot && { id: "app-settings", title: "Project: App Settings…", run: () => ui.setShowAppSettings(true) },
    hasRoot && { id: "icons", title: "Project: Generate App Icons…", run: () => ui.setShowIcons(true) },
    hasRoot && { id: "localization", title: "Project: Localization…", run: () => ui.setShowLocalization(true) },
    { id: "setup", title: "Setup: Toolchain Status…", run: () => ui.setShowSetup(true) },
    hasRoot && { id: "tour", title: "Help: Show Tour", run: () => ui.setShowTour(true) },
    { id: "shortcuts", title: "Help: Keyboard Shortcuts", run: () => ui.setShowShortcuts(true) },
    { id: "ai-panel", title: "AI: Toggle Chat", shortcut: "⌘I", run: () => ui.setShowAiPanel(!ui.showAiPanel) },
    aiReady() && { id: "ai-new-chat", title: "AI: New Chat", run: () => (newChat(), ui.setShowAiPanel(true)) },
    aiReady() && !!useWorkspace.getState().activePath && { id: "ai-edit", title: "AI: Edit Selection…", shortcut: "⌘K", run: () => editSelectionWithAi() },
    aiReady() && hasRoot && useProject.getState().build.status === "failed" && { id: "ai-fix-build", title: "AI: Fix Build Failure", run: fixBuild },
    aiAvailable() && useAi.getState().server.status !== "stopped" && { id: "ai-unload", title: "AI: Unload Model (free memory)", run: () => aiApi.unload() },
    { id: "ai-settings", title: "AI: Settings…", run: () => ui.setShowSettings(true) },
    { id: "check-updates", title: "Orbit: Check for Updates", run: () => checkForUpdates(true) },
    { id: "open-logs", title: "Help: Open Logs", run: () => openLogs() },
    { id: "report-problem", title: "Help: Report a Problem", run: () => reportProblem() },
    !!useWorkspace.getState().activePath && { id: "split-editor", title: "View: Split Editor", shortcut: "⌘\\", run: () => useWorkspace.getState().splitEditor() },
    hasRoot && { id: "explorer", title: "View: Explorer", shortcut: "⇧⌘E", run: () => ui.setActivity("explorer") },
    hasRoot && { id: "search", title: "View: Search in Files", shortcut: "⇧⌘F", run: () => ui.setActivity("search") },
    hasRoot && { id: "git", title: "View: Source Control", shortcut: "⌃⇧G", run: () => ui.setActivity("git") },
    hasRoot && { id: "packages", title: "View: Packages", run: () => ui.setActivity("packages") },
    hasRoot && { id: "sidebar", title: "View: Toggle Sidebar", shortcut: "⌘0", run: ui.toggleSidebar },
    hasRoot && { id: "panel", title: "View: Toggle Bottom Panel", shortcut: "⌘J", run: ui.togglePanel },
    hasRoot && { id: "terminal", title: "View: Terminal", run: () => ui.showBottomTab("terminal") },
    hasRoot && { id: "problems", title: "View: Problems", run: () => ui.showActivity("problems") },
    hasRoot && { id: "output", title: "View: Output (Language Server Logs)", run: () => ui.showActivity("output") },
    hasRoot && { id: "go-impl", title: "Go to Implementation", shortcut: "⌘F12", run: () => activeEditor()?.trigger("palette", "editor.action.goToImplementation", null) },
    hasRoot && { id: "go-type", title: "Go to Type Definition", run: () => activeEditor()?.trigger("palette", "editor.action.goToTypeDefinition", null) },
    hasRoot && { id: "quick-fix", title: "Quick Fix…", shortcut: "⌥↩", run: () => activeEditor()?.trigger("palette", "editor.action.quickFix", null) },
    { id: "theme", title: "Preferences: Cycle Theme (System / Light / Dark)", run: useThemePref.getState().cycle },
    { id: "settings", title: "Preferences: Settings…", shortcut: "⌘,", run: () => ui.setShowSettings(true) },
    { id: "devices", title: "Devices: Manage Simulators & Emulators…", run: () => ui.setShowDevices(true) },
    hasRoot && { id: "device-tools", title: "Devices: Send Test Notification / Permissions…", run: () => ui.setShowDevices(true) },
    hasRoot && { id: "statusbar-clean", title: "Devices: Clean Status Bar for Screenshots", run: () => runDeviceTool("statusbar", "clean", "Status bar cleaned") },
    hasRoot && { id: "statusbar-clear", title: "Devices: Restore Status Bar", run: () => runDeviceTool("statusbar", "clear", "Status bar restored") },
    hasRoot && { id: "app-data", title: "Devices: Open App Data in Finder", run: () => runDeviceTool("appdata") },
    hasRoot && { id: "reset-permissions", title: "Devices: Reset App Permissions", run: () => runDeviceTool("reset", "all", "Permissions reset; the app will ask again") },
    { id: "wireless-pair", title: "Devices: Pair Android Device over Wi-Fi…", run: () => ui.setShowWirelessPair(true) },
    hasRoot && { id: "device-pane", title: "View: Toggle Device Screen", run: () => ui.toggleDevicePane() },
    hasRoot && { id: "wrap", title: `Preferences: ${settings.wordWrap ? "Disable" : "Enable"} Word Wrap`, run: () => settings.update({ wordWrap: !settings.wordWrap }, "wordWrap" in settings.project ? "project" : "global") },
    hasRoot && { id: "minimap", title: `Preferences: ${settings.minimap ? "Hide" : "Show"} Minimap`, run: () => settings.update({ minimap: !settings.minimap }, "minimap" in settings.project ? "project" : "global") },
    hasRoot && { id: "git-refresh", title: "Git: Refresh", run: () => useGit.getState().refresh() },
    hasRoot && { id: "git-pull", title: "Git: Pull", run: () => useGit.getState().sync("pull") },
    hasRoot && { id: "git-push", title: "Git: Push", run: () => useGit.getState().sync("push") },
    hasRoot && { id: "lsp-restart", title: "Swift: Restart Language Server", run: () => restartSwiftServer() },
    hasRoot && { id: "android-lsp-restart", title: "Android: Restart Language Servers", run: () => restartAndroidServers() },
    hasRoot && { id: "new-file", title: "File: New File…", shortcut: "⌘N", run: () => {
      useUi.setState({ activity: "explorer", showSidebar: true });
      ui.setNewFileIn(newFileFolder(useWorkspace.getState().root!));
    } },
    hasRoot && { id: "reopen-tab", title: "File: Reopen Closed Editor", shortcut: "⇧⌘T", run: () => reopenClosedTab() },
    hasRoot && { id: "next-tab", title: "View: Next Editor", shortcut: "⌃Tab", run: () => cycleTab(1) },
    hasRoot && { id: "prev-tab", title: "View: Previous Editor", shortcut: "⌃⇧Tab", run: () => cycleTab(-1) },
    hasRoot && { id: "close-tab", title: "File: Close Editor", shortcut: "⌘W", run: () => {
      const { activePath } = useWorkspace.getState();
      if (activePath) closeTab(activePath);
    } },
  ];
  return cmds.filter((c): c is Command => !!c);
}
