import { message } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import * as monaco from "monaco-editor";
import { isDirty, OpenFile, useWorkspace } from "../state/workspace";
import { modelUri } from "./monaco-setup";
import { markExiting } from "../state/session";

export type UnsavedChoice = "save" | "discard" | "cancel";

/** Asks what to do with unsaved files: Save / Don't Save / Cancel. */
export async function askUnsaved(files: OpenFile[], context: string): Promise<UnsavedChoice> {
  if (files.length === 0) return "discard";
  const names = files.map((f) => f.path.split("/").pop()).join(", ");
  const text =
    files.length === 1
      ? `Do you want to save the changes you made to ${names}?`
      : `Do you want to save the changes to ${files.length} files (${names})?`;
  const result = await message(`${text}\n\n${context}`, {
    title: "Unsaved changes",
    kind: "warning",
    buttons: { yes: "Save", no: "Don't Save", cancel: "Cancel" },
  });
  // The plugin returns the clicked button's label (or Yes/No/Cancel on older versions).
  if (result === "Save" || result === "Yes") return "save";
  if (result === "Don't Save" || result === "No") return "discard";
  return "cancel";
}

/** Resolves true when it's OK to drop all open files (saved, discarded, or none dirty). */
export async function confirmDiscardAll(context: string): Promise<boolean> {
  const dirty = useWorkspace.getState().files.filter(isDirty);
  const choice = await askUnsaved(dirty, context);
  if (choice === "cancel") return false;
  if (choice === "save") {
    await useWorkspace.getState().saveAll();
    // saveAll reports failures via the error bar; stay put if anything is still dirty.
    return !useWorkspace.getState().files.some(isDirty);
  }
  return true;
}

/** Closes a tab, offering to save it first. */
export async function closeTab(path: string) {
  const ws = useWorkspace.getState();
  const file = ws.files.find((f) => f.path === path);
  if (!file) return;
  // Also shown in another group: close just this group's tab (the file stays open).
  const group = ws.groups[ws.focused].paths.includes(path) ? ws.focused : ws.groups.findIndex((g) => g.paths.includes(path));
  if (ws.groups.some((g, i) => i !== group && g.paths.includes(path))) return ws.closeInGroup(path, group);
  if (isDirty(file)) {
    const choice = await askUnsaved([file], "Your changes will be lost if you don't save them.");
    if (choice === "cancel") return;
    if (choice === "save") {
      await ws.setActive(path);
      await useWorkspace.getState().saveActive();
      if (isDirty(useWorkspace.getState().files.find((f) => f.path === path)!)) return;
    }
  }
  // Dispose the model so reopening the file reloads it from disk instead of showing stale content.
  monaco.editor.getModel(modelUri(path))?.dispose();
  useWorkspace.getState().closeFile(path);
  closed.push(path);
  if (closed.length > 20) closed.shift();
}

/** Recently closed tabs, most recent last. */
const closed: string[] = [];

/** ⇧⌘T: reopens the most recently closed tab that isn't open again already. */
export async function reopenClosedTab() {
  const ws = useWorkspace.getState();
  let path: string | undefined;
  while ((path = closed.pop()) && ws.files.some((f) => f.path === path));
  if (path) await ws.openFile(path);
}

/** Activates the next (1) or previous (-1) tab, wrapping around. */
export function cycleTab(step: 1 | -1) {
  const { groups, focused, activePath, setActive } = useWorkspace.getState();
  const paths = groups[focused].paths;
  if (paths.length < 2) return;
  const i = paths.indexOf(activePath ?? "");
  setActive(paths[(i + step + paths.length) % paths.length]);
}

// ⌘Q / closing the window: Rust holds the quit until we confirm.
// A second ⌘Q, or no ack within 3 s, quits without asking (see lifecycle.rs).
listen<number>("app://quit-requested", async (e) => {
  invoke("app_quit_ack", { request: e.payload });
  if (await confirmDiscardAll("Your changes will be lost if you don't save them.")) {
    markExiting();
    invoke("app_quit");
  } else {
    invoke("app_quit_cancel");
  }
});
