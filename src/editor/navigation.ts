import * as monaco from "monaco-editor";
import { useWorkspace } from "../state/workspace";
import { modelUri } from "./monaco-setup";

/** Opens `path` in a tab and moves the cursor to `target` (1-based) once its editor is showing. */
export async function openAt(path: string, target?: monaco.IRange | monaco.IPosition) {
  await useWorkspace.getState().openFile(path);
  const uri = modelUri(path).toString();
  const reveal = (tries: number) => {
    const editor = monaco.editor.getEditors().find((e) => e.getModel()?.uri.toString() === uri);
    if (!editor) {
      if (tries > 0) requestAnimationFrame(() => reveal(tries - 1));
      return;
    }
    if (target) {
      if (monaco.Range.isIRange(target)) {
        editor.setSelection(target);
        editor.revealRangeInCenter(target);
      } else {
        editor.setPosition(target);
        editor.revealPositionInCenter(target);
      }
    }
    editor.focus();
  };
  reveal(30);
}

/** The editor showing the active tab, if any. */
/** Each editor group's editor instance, by group index (set by EditorArea). */
export const groupEditors: (monaco.editor.IStandaloneCodeEditor | null)[] = [];

export function activeEditor() {
  const { activePath: path, focused } = useWorkspace.getState();
  if (!path) return null;
  const uri = modelUri(path).toString();
  const own = groupEditors[focused];
  if (own?.getModel()?.uri.toString() === uri) return own;
  return monaco.editor.getEditors().find((e) => e.getModel()?.uri.toString() === uri) ?? null;
}

// ---------------------------------------------------------------- back / forward history

interface Location {
  path: string;
  position: monaco.IPosition;
}

const back: Location[] = [];
const forward: Location[] = [];
let last: Location | null = null;
/** Set while going back/forward so the jump itself isn't recorded. */
let navigating = false;

const far = (a: Location, b: Location) => a.path !== b.path || Math.abs(a.position.lineNumber - b.position.lineNumber) > 10;

// Records a history entry whenever the cursor jumps to another file or more than 10 lines away
// (definitions, palette, Problems, clicks), but not for typing or arrow keys.
monaco.editor.onDidCreateEditor((editor) => {
  editor.onDidChangeCursorPosition((e) => {
    const model = editor.getModel();
    if (!model || model.uri.scheme !== "file") return;
    const here = { path: model.uri.fsPath, position: e.position };
    if (!navigating && last && e.source !== "keyboard" && e.source !== "modelChange" && far(last, here)) {
      back.push(last);
      if (back.length > 50) back.shift();
      forward.length = 0;
    }
    last = here;
  });
});

async function jump(from: Location[], to: Location[]) {
  const target = from.pop();
  if (!target) return;
  if (last) to.push(last);
  navigating = true;
  await openAt(target.path, target.position);
  last = target;
  setTimeout(() => (navigating = false), 300);
}

/** ⌃- */
export const goBack = () => jump(back, forward);
/** ⌃⇧- */
export const goForward = () => jump(forward, back);
