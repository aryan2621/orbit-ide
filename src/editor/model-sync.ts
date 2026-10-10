// Keeps the workspace store in sync with every Monaco model, not just the one in the visible editor,
// so edits made programmatically (rename, formatting) in background tabs are tracked and saved.
import * as monaco from "monaco-editor";
import { useWorkspace } from "../state/workspace";

monaco.editor.onDidCreateModel((model) => {
  model.onDidChangeContent(() => {
    const path = model.uri.fsPath;
    const { files, updateContent } = useWorkspace.getState();
    if (files.some((f) => f.path === path)) updateContent(path, model.getValue());
  });
});
