// Auto-save: after a pause in typing, or when focus leaves a file (another tab or another app).
import * as monaco from "monaco-editor";
import { useSettings } from "../state/settings";
import { useWorkspace } from "../state/workspace";

const DELAY_MS = 1000;
let timer: ReturnType<typeof setTimeout> | undefined;

const saveAll = () => {
  if (useWorkspace.getState().files.some((f) => f.dirty)) useWorkspace.getState().saveAll();
};

monaco.editor.onDidCreateModel((model) => {
  if (model.uri.scheme !== "file") return;
  model.onDidChangeContent(() => {
    if (useSettings.getState().autoSave !== "afterDelay") return;
    clearTimeout(timer);
    timer = setTimeout(saveAll, DELAY_MS);
  });
});

window.addEventListener("blur", () => {
  if (useSettings.getState().autoSave === "onFocusChange") saveAll();
});

useWorkspace.subscribe((s, prev) => {
  if (s.activePath !== prev.activePath && useSettings.getState().autoSave === "onFocusChange") saveAll();
});
