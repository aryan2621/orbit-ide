// Breakpoint dots in the editor gutter (click to toggle) and the paused-line highlight.
// Breakpoints live as sticky decorations on each file's model, so they move with edits above
// them; their lines are read back from the decorations after every change.
import * as monaco from "monaco-editor";
import { Breakpoint, useDebug } from "../state/debug";
import { isFileModel } from "../lsp/servers";
import { openContextMenu } from "../components/ContextMenu";
import { promptText } from "../components/Prompt";

function options(b: Breakpoint): monaco.editor.IModelDecorationOptions {
  const kind = b.logMessage ? "Logpoint" : b.condition ? "Conditional breakpoint" : "Breakpoint";
  const detail = b.logMessage ? `: ${b.logMessage}` : b.condition ? `: ${b.condition}` : "";
  return {
    glyphMarginClassName: `bp-glyph${b.logMessage ? " log" : b.condition ? " conditional" : ""}${b.enabled ? "" : " disabled"}`,
    glyphMarginHoverMessage: { value: `${kind}${detail}${b.enabled ? "" : " (disabled)"} · click to remove, right-click to edit` },
    stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
  };
}

const signature = (list: Breakpoint[]) => JSON.stringify(list.map((b) => [b.line, b.enabled, b.condition, b.logMessage]));

/** Model URI → breakpoint decoration ids, in the same order as the lines they were created for. */
const modelBreakpoints = new Map<string, { ids: string[]; lines: number[]; signature: string }>();
const currentLine = new Map<monaco.editor.ICodeEditor, monaco.editor.IEditorDecorationsCollection>();

/** Recreates a model's breakpoint decorations from the store. */
function syncModel(model: monaco.editor.ITextModel) {
  const key = model.uri.toString();
  const list = useDebug.getState().breakpoints[model.uri.fsPath] ?? [];
  const prev = modelBreakpoints.get(key);
  if (prev && prev.signature === signature(list)) return;
  const ids = model.deltaDecorations(
    prev?.ids ?? [],
    list.map((b) => ({ range: new monaco.Range(b.line, 1, b.line, 1), options: options(b) })),
  );
  modelBreakpoints.set(key, { ids, lines: list.map((b) => b.line), signature: signature(list) });
}

/** After an edit: moves breakpoints whose decorations shifted (and merges ones that collapsed). */
function readBack(model: monaco.editor.ITextModel) {
  const entry = modelBreakpoints.get(model.uri.toString());
  if (!entry || entry.ids.length === 0) return;
  const moved = new Map<number, number>();
  entry.ids.forEach((id, i) => {
    const line = model.getDecorationRange(id)?.startLineNumber;
    if (line !== undefined && line !== entry.lines[i]) moved.set(entry.lines[i], line);
  });
  if (moved.size === 0) return;
  const lines = entry.ids.map((id, i) => model.getDecorationRange(id)?.startLineNumber ?? entry.lines[i]);
  // Keep the decorations; just record their new lines so syncModel sees nothing to redo.
  const list = useDebug.getState().breakpoints[model.uri.fsPath] ?? [];
  const after = list.map((b) => ({ ...b, line: moved.get(b.line) ?? b.line }));
  modelBreakpoints.set(model.uri.toString(), { ids: entry.ids, lines, signature: signature(after) });
  useDebug.getState().moveBreakpoints(model.uri.fsPath, moved);
}

monaco.editor.onDidCreateModel((model) => {
  if (!isFileModel(model)) return;
  syncModel(model);
  const change = model.onDidChangeContent(() => readBack(model));
  model.onWillDispose(() => {
    change.dispose();
    modelBreakpoints.delete(model.uri.toString());
  });
});

function renderCurrentLine(editor: monaco.editor.ICodeEditor) {
  const model = editor.getModel();
  if (!model || !isFileModel(model)) return;
  const { frames, frameId, status } = useDebug.getState();
  const frame = status === "paused" ? frames.find((f) => f.id === frameId) : undefined;
  const items: monaco.editor.IModelDeltaDecoration[] =
    frame?.path === model.uri.fsPath
      ? [
          {
            range: new monaco.Range(frame.line, 1, frame.line, 1),
            options: { isWholeLine: true, className: "debug-current-line", glyphMarginClassName: "debug-current-glyph" },
          },
        ]
      : [];
  let collection = currentLine.get(editor);
  if (!collection) {
    collection = editor.createDecorationsCollection();
    currentLine.set(editor, collection);
  }
  collection.set(items);
}

monaco.editor.onDidCreateEditor((editor) => {
  editor.updateOptions({ glyphMargin: true });
  editor.onMouseDown((e) => {
    const isGutter =
      e.target.type === monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN ||
      e.target.type === monaco.editor.MouseTargetType.GUTTER_LINE_NUMBERS;
    const line = e.target.position?.lineNumber;
    const model = editor.getModel();
    // Diff editors show `orbit-diff:` models: no breakpoints there.
    if (!isGutter || !line || !model || !isFileModel(model)) return;
    if (e.event.leftButton) useDebug.getState().toggleBreakpoint(model.uri.fsPath, line);
    else if (e.event.rightButton) gutterMenu(e.event.browserEvent, model.uri.fsPath, line);
  });
  editor.onDidChangeModel(() => renderCurrentLine(editor));
  editor.onDidDispose(() => currentLine.delete(editor));
  renderCurrentLine(editor);
});

useDebug.subscribe((s, prev) => {
  if (s.breakpoints !== prev.breakpoints) monaco.editor.getModels().filter(isFileModel).forEach(syncModel);
  if (s.frameId !== prev.frameId || s.frames !== prev.frames || s.status !== prev.status) {
    currentLine.forEach((_, editor) => renderCurrentLine(editor));
  }
});

/** Right-click in the gutter: add or edit a (conditional) breakpoint or logpoint. */
function gutterMenu(event: MouseEvent, path: string, line: number) {
  const debug = useDebug.getState();
  const existing = debug.breakpoints[path]?.find((b) => b.line === line);
  const editCondition = async () => {
    const condition = await promptText(`Break at line ${line} when`, {
      initial: existing?.condition ?? "",
      placeholder: "count > 3",
      detail: "An expression in the program's language; leave empty to always stop.",
    });
    if (condition !== null) useDebug.getState().setBreakpoint(path, line, { condition: condition.trim() || undefined, logMessage: undefined });
  };
  const editLog = async () => {
    const message = await promptText(`Log at line ${line}`, {
      initial: existing?.logMessage ?? "",
      placeholder: "count is {count}",
      detail: "Printed to the debug console without stopping; put expressions in {braces}.",
    });
    if (message !== null) useDebug.getState().setBreakpoint(path, line, message.trim() ? { logMessage: message.trim(), condition: undefined } : null);
  };
  openContextMenu(event, [
    !existing && { label: "Add Breakpoint", onSelect: () => debug.toggleBreakpoint(path, line) },
    { label: existing?.condition ? "Edit Condition…" : "Add Conditional Breakpoint…", onSelect: editCondition },
    { label: existing?.logMessage ? "Edit Logpoint…" : "Add Logpoint…", onSelect: editLog },
    !!existing && null,
    !!existing && { label: existing.enabled ? "Disable Breakpoint" : "Enable Breakpoint", onSelect: () => debug.setBreakpoint(path, line, { enabled: !existing.enabled }) },
    !!existing && { label: "Remove Breakpoint", danger: true, onSelect: () => debug.setBreakpoint(path, line, null) },
  ]);
}
