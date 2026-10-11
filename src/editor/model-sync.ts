// Keeps tabs' dirty flags in sync with every Monaco model, not just the one in the visible editor,
// so edits made programmatically (rename, formatting) in background tabs are tracked and saved.
// Only the flag goes to the store (when it flips); the text stays in the model.
import * as monaco from "monaco-editor";
import { moveSavedState, setSavedVersion, syncDirty, useWorkspace } from "../state/workspace";
import { useDebug } from "../state/debug";
import { scheduleBackup } from "../state/session";
import { languageForPath, modelUri } from "./monaco-setup";

monaco.editor.onDidCreateModel((model) => {
  if (model.uri.scheme !== "file") return;
  model.onDidChangeContent(() => {
    syncDirty(model.uri.fsPath);
    scheduleBackup();
  });
});

/** A file or folder was renamed (`to`) or moved to the Trash (`null`): moves open tabs, their
 * models (the language servers see a close + open) and breakpoints along. */
export function pathMoved(from: string, to: string | null) {
  const inside = (p: string) => p === from || p.startsWith(from + "/");
  const dirty = new Set(useWorkspace.getState().files.filter((f) => f.dirty).map((f) => f.path));
  moveSavedState(from, to);
  for (const model of monaco.editor.getModels()) {
    if (model.uri.scheme !== "file" || !inside(model.uri.fsPath)) continue;
    if (to !== null) {
      const target = to + model.uri.fsPath.slice(from.length);
      if (!monaco.editor.getModel(modelUri(target))) {
        const moved = monaco.editor.createModel(model.getValue(), languageForPath(target), modelUri(target));
        setSavedVersion(target, dirty.has(model.uri.fsPath) ? -1 : moved.getAlternativeVersionId());
      }
    }
    model.dispose();
  }
  useDebug.getState().breakpointsPathMoved(from, to);
  useWorkspace.getState().pathMoved(from, to);
}
