import * as monaco from "monaco-editor";
import { useWorkspace } from "../state/workspace";

/** Opens `path` in a tab and moves the cursor to `target` (1-based) once its editor is showing. */
export async function openAt(path: string, target?: monaco.IRange | monaco.IPosition) {
  await useWorkspace.getState().openFile(path);
  const uri = monaco.Uri.parse(path).toString();
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
