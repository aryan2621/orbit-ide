// Reacts to changes made outside Orbit: refreshes the file tree and Git status, and reloads open
// files that changed on disk (unless they have unsaved edits).
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import * as monaco from "monaco-editor";
import { fsApi } from "../lib/ipc";
import { isDirty, markSaved, savedText, useWorkspace } from "./workspace";
import { modelUri } from "../editor/monaco-setup";
import { useGit } from "./git";

interface FsChange {
  paths: string[];
  git: boolean;
}

const watch = (root: string | null) => invoke("watch_root", { root }).catch((e) => console.warn("watch failed", e));

useWorkspace.subscribe((s, prev) => {
  if (s.root !== prev.root) watch(s.root);
});

async function reload(path: string) {
  const ws = useWorkspace.getState();
  const file = ws.files.find((f) => f.path === path);
  if (!file) return;
  let disk: string;
  try {
    disk = await fsApi.readFile(path);
  } catch {
    return; // deleted or unreadable; the tree refresh shows it
  }
  if (disk === savedText(path)) return; // our own save, or no real change
  if (isDirty(file)) {
    useWorkspace.setState({
      error: `${path.split("/").pop()} changed on disk. Your unsaved edits are kept; saving will overwrite the disk version.`,
    });
    return;
  }
  // Replace the text as one undoable edit so ⌘Z can bring the old version back.
  const model = monaco.editor.getModel(modelUri(path));
  if (model && model.getValue() !== disk) {
    model.pushEditOperations([], [{ range: model.getFullModelRange(), text: disk }], () => null);
  }
  markSaved(path, disk);
}

listen<FsChange>("fs://changed", (e) => {
  const { paths, git } = e.payload;
  if (paths.length > 0) {
    // Re-read only the folders that hold the changes (and the paths themselves, if folders).
    const folders = new Set(paths.flatMap((p) => [p, p.slice(0, p.lastIndexOf("/"))]));
    useWorkspace.getState().refreshFolders([...folders]);
    const open = new Set(useWorkspace.getState().files.map((f) => f.path));
    paths.filter((p) => open.has(p)).forEach(reload);
  }
  if (paths.length > 0 || git) useGit.getState().refreshSoon();
});
