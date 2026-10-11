// Merge conflicts in the editor: highlights `<<<<<<<` / `=======` / `>>>>>>>` blocks and offers
// "Accept Current / Incoming / Both" above each one (as undoable edits). Once a file has no
// markers left, it can be marked resolved (staged) from the same place.
import * as monaco from "monaco-editor";
import { gitApi } from "../lib/ipc";
import { useGit } from "../state/git";
import { isFileModel } from "../lsp/servers";

interface Conflict {
  /** 1-based lines of the markers; `base` is the diff3 `|||||||` line, if any. */
  start: number;
  base: number | null;
  middle: number;
  end: number;
}

function findConflicts(model: monaco.editor.ITextModel): Conflict[] {
  const out: Conflict[] = [];
  let open: Partial<Conflict> | null = null;
  const count = model.getLineCount();
  for (let line = 1; line <= count; line++) {
    const text = model.getLineContent(line);
    if (text.startsWith("<<<<<<<")) open = { start: line, base: null };
    else if (open && text.startsWith("|||||||")) open.base = line;
    else if (open && text.startsWith("=======")) open.middle = line;
    else if (open?.middle && text.startsWith(">>>>>>>")) {
      out.push({ ...(open as Conflict), end: line });
      open = null;
    }
  }
  return out;
}

const lines = (model: monaco.editor.ITextModel, from: number, to: number) =>
  from > to ? "" : model.getValueInRange(new monaco.Range(from, 1, to, model.getLineMaxColumn(to))) + "\n";

function resolve(model: monaco.editor.ITextModel, c: Conflict, keep: "current" | "incoming" | "both") {
  const current = lines(model, c.start + 1, (c.base ?? c.middle) - 1);
  const incoming = lines(model, c.middle + 1, c.end - 1);
  const text = keep === "current" ? current : keep === "incoming" ? incoming : current + incoming;
  const endsFile = c.end === model.getLineCount();
  const range = endsFile ? new monaco.Range(c.start, 1, c.end, model.getLineMaxColumn(c.end)) : new monaco.Range(c.start, 1, c.end + 1, 1);
  model.pushStackElement();
  model.pushEditOperations([], [{ range, text: endsFile ? text.replace(/\n$/, "") : text }], () => null);
  model.pushStackElement();
}

const ACCEPT = "orbit.conflict.accept";
const RESOLVED = "orbit.conflict.markResolved";
monaco.editor.registerCommand(ACCEPT, (_accessor, uri: string, c: Conflict, keep: "current" | "incoming" | "both") => {
  const model = monaco.editor.getModel(monaco.Uri.parse(uri));
  if (model) resolve(model, c, keep);
});
monaco.editor.registerCommand(RESOLVED, (_accessor, path: string) => {
  const repo = useGit.getState().status?.repo_root;
  if (repo && path.startsWith(repo + "/")) useGit.getState().run("stage", (r) => gitApi.stage(r, [path.slice(repo.length + 1)]));
});

const conflicted = (path: string) => {
  const status = useGit.getState().status;
  const repo = status?.repo_root;
  return !!repo && status.changes.some((c) => c.status === "U" && `${repo}/${c.path}` === path);
};

const changed = new monaco.Emitter<monaco.languages.CodeLensProvider>();
const provider: monaco.languages.CodeLensProvider = {
  onDidChange: changed.event,
  provideCodeLenses(model) {
    if (!isFileModel(model)) return { lenses: [], dispose() {} };
    const uri = model.uri.toString();
    const found = findConflicts(model);
    const lenses: monaco.languages.CodeLens[] = found.flatMap((c) => {
      const range = new monaco.Range(c.start, 1, c.start, 1);
      return [
        { range, command: { id: ACCEPT, title: "Accept Current", arguments: [uri, c, "current"] } },
        { range, command: { id: ACCEPT, title: "Accept Incoming", arguments: [uri, c, "incoming"] } },
        { range, command: { id: ACCEPT, title: "Accept Both", arguments: [uri, c, "both"] } },
      ];
    });
    if (found.length === 0 && conflicted(model.uri.fsPath)) {
      lenses.push({ range: new monaco.Range(1, 1, 1, 1), command: { id: RESOLVED, title: "No conflicts left: Mark Resolved (stage)", arguments: [model.uri.fsPath] } });
    }
    return { lenses, dispose() {} };
  },
};
monaco.languages.registerCodeLensProvider("*", provider);
// Git status decides whether "Mark Resolved" shows.
useGit.subscribe((s, prev) => s.status !== prev.status && changed.fire(provider));

// Tint the two sides of each conflict.
monaco.editor.onDidCreateEditor((editor) => {
  const tints = editor.createDecorationsCollection();
  const tint = () => {
    const model = editor.getModel();
    if (!model || !isFileModel(model)) return tints.clear();
    tints.set(
      findConflicts(model).flatMap((c) => [
        { range: new monaco.Range(c.start, 1, (c.base ?? c.middle) - 1, 1), options: { isWholeLine: true, className: "conflict-current" } },
        { range: new monaco.Range(c.middle + 1, 1, c.end, 1), options: { isWholeLine: true, className: "conflict-incoming" } },
      ]),
    );
  };
  let pending: ReturnType<typeof setTimeout> | null = null;
  editor.onDidChangeModel(tint);
  editor.onDidChangeModelContent(() => {
    if (pending) clearTimeout(pending);
    pending = setTimeout(tint, 200);
  });
  tint();
});
