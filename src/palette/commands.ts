import { open } from "@tauri-apps/plugin-dialog";
import { useUi } from "../state/ui";
import { useWorkspace } from "../state/workspace";
import { useProject } from "../state/project";
import { useDebug } from "../state/debug";
import { useThemePref } from "../state/theme";
import { useGit } from "../state/git";
import { useSettings } from "../state/settings";
import { restartSwiftServer } from "../lsp/swift";

export interface Command {
  id: string;
  title: string;
  shortcut?: string;
  run: () => void;
}

export async function openFolder() {
  const dir = await open({ directory: true, multiple: false });
  if (typeof dir === "string") useWorkspace.getState().setRoot(dir);
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
    { id: "quick-open", title: "Go to File…", shortcut: "⌘P", run: () => setTimeout(() => ui.setPalette("files")) },
    { id: "save", title: "File: Save", shortcut: "⌘S", run: () => useWorkspace.getState().saveActive() },
    { id: "save-all", title: "File: Save All", shortcut: "⌥⌘S", run: () => useWorkspace.getState().saveAll() },
    { id: "new-app", title: "Project: New iOS App…", shortcut: "⇧⌘N", run: () => ui.setShowNewProject(true) },
    hasRoot && { id: "build", title: "Product: Build", shortcut: "⌘B", run: project.startBuild },
    hasRoot && { id: "run", title: "Product: Run", shortcut: "⌘R", run: project.startRun },
    hasRoot && { id: "debug", title: "Product: Debug", shortcut: "⌘Y", run: project.startDebug },
    hasRoot && { id: "stop", title: "Product: Stop", shortcut: "⌘.", run: () => (project.cancelBuild(), debug.stop()) },
    hasRoot && { id: "archive", title: "Product: Archive & Distribute…", run: () => ui.setShowArchive(true) },
    hasRoot && { id: "signing", title: "Project: Signing…", run: () => ui.setShowSigning(true) },
    { id: "setup", title: "Setup: Toolchain Status…", run: () => ui.setShowSetup(true) },
    hasRoot && { id: "explorer", title: "View: Explorer", shortcut: "⇧⌘E", run: () => ui.setActivity("explorer") },
    hasRoot && { id: "search", title: "View: Search in Files", shortcut: "⇧⌘F", run: () => ui.setActivity("search") },
    hasRoot && { id: "git", title: "View: Source Control", shortcut: "⌃⇧G", run: () => ui.setActivity("git") },
    hasRoot && { id: "packages", title: "View: Packages", run: () => ui.setActivity("packages") },
    { id: "sidebar", title: "View: Toggle Sidebar", shortcut: "⌘0", run: ui.toggleSidebar },
    { id: "panel", title: "View: Toggle Bottom Panel", shortcut: "⌘J", run: ui.togglePanel },
    { id: "terminal", title: "View: Terminal", run: () => ui.showBottomTab("terminal") },
    { id: "problems", title: "View: Problems", run: () => ui.showBottomTab("problems") },
    { id: "theme", title: "Preferences: Cycle Theme (System / Light / Dark)", run: useThemePref.getState().cycle },
    { id: "settings", title: "Preferences: Settings…", shortcut: "⌘,", run: () => ui.setShowSettings(true) },
    { id: "wrap", title: `Preferences: ${settings.wordWrap ? "Disable" : "Enable"} Word Wrap`, run: () => settings.update({ wordWrap: !settings.wordWrap }) },
    { id: "minimap", title: `Preferences: ${settings.minimap ? "Hide" : "Show"} Minimap`, run: () => settings.update({ minimap: !settings.minimap }) },
    hasRoot && { id: "git-refresh", title: "Git: Refresh", run: () => useGit.getState().refresh() },
    hasRoot && { id: "git-pull", title: "Git: Pull", run: () => useGit.getState().sync("pull") },
    hasRoot && { id: "git-push", title: "Git: Push", run: () => useGit.getState().sync("push") },
    { id: "lsp-restart", title: "Swift: Restart Language Server", run: () => restartSwiftServer() },
    { id: "close-tab", title: "File: Close Editor", shortcut: "⌘W", run: () => {
      const { activePath, closeFile } = useWorkspace.getState();
      if (activePath) closeFile(activePath);
    } },
  ];
  return cmds.filter((c): c is Command => !!c);
}
