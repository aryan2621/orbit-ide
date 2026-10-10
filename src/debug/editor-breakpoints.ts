// Breakpoint dots in the editor gutter (click to toggle) and the paused-line highlight.
import * as monaco from "monaco-editor";
import { useDebug } from "../state/debug";

const decorations = new Map<monaco.editor.ICodeEditor, monaco.editor.IEditorDecorationsCollection>();

function render(editor: monaco.editor.ICodeEditor) {
  const model = editor.getModel();
  if (!model) return;
  const path = model.uri.fsPath;
  const { breakpoints, frames, frameId, status } = useDebug.getState();
  const lines = breakpoints[path] ?? [];
  const frame = status === "paused" ? frames.find((f) => f.id === frameId) : undefined;

  const items: monaco.editor.IModelDeltaDecoration[] = lines.map((line) => ({
    range: new monaco.Range(line, 1, line, 1),
    options: { glyphMarginClassName: "bp-glyph", glyphMarginHoverMessage: { value: "Breakpoint (click to remove)" }, stickiness: 1 },
  }));
  if (frame?.path === path) {
    items.push({
      range: new monaco.Range(frame.line, 1, frame.line, 1),
      options: { isWholeLine: true, className: "debug-current-line", glyphMarginClassName: "debug-current-glyph" },
    });
  }
  let collection = decorations.get(editor);
  if (!collection) {
    collection = editor.createDecorationsCollection();
    decorations.set(editor, collection);
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
    if (isGutter && line && model && e.event.leftButton) useDebug.getState().toggleBreakpoint(model.uri.fsPath, line);
  });
  editor.onDidChangeModel(() => render(editor));
  editor.onDidDispose(() => decorations.delete(editor));
  render(editor);
});

useDebug.subscribe((s, prev) => {
  if (s.breakpoints !== prev.breakpoints || s.frameId !== prev.frameId || s.frames !== prev.frames || s.status !== prev.status) {
    decorations.forEach((_, editor) => render(editor));
  }
});
