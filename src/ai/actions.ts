// Entry points into the agent from the rest of the IDE: Problems rows, the build-failed pill,
// Logcat crashes and the editor's context menu.
import * as monaco from "monaco-editor";
import { useWorkspace } from "../state/workspace";
import { useUi } from "../state/ui";
import { aiAvailable, aiReady, useAi } from "../state/ai";
import { send, useChat } from "./agent";
import { editSelectionWithAi } from "./EditSelection";

interface Problem {
  file: string | null;
  line: number | null;
  severity: "error" | "warning";
  message: string;
}

const rel = (file: string) => {
  const root = useWorkspace.getState().root;
  return root && file.startsWith(root + "/") ? file.slice(root.length + 1) : file;
};
const where = (p: Problem) => (p.file ? ` in ${rel(p.file)}${p.line ? `:${p.line}` : ""}` : "");

/** Sends a prompt, or opens the panel's setup when there's no model yet. */
function ask(text: string) {
  if (!aiReady()) return useUi.getState().setShowAiPanel(true);
  if (useChat.getState().running) {
    useUi.getState().setShowAiPanel(true);
    return;
  }
  send(text);
}

export function fixProblem(p: Problem) {
  ask(
    `Fix this ${p.severity}${where(p)}:\n\n\`\`\`\n${p.message}\n\`\`\`\n\nRead the relevant code first, then propose the smallest edit that fixes it.`,
  );
}

export function explainProblem(p: Problem) {
  const crash = p.message.includes("\n\n");
  ask(
    crash
      ? `The app crashed. Explain the likely cause from this crash report and point to the code involved:\n\n\`\`\`\n${p.message}\n\`\`\``
      : `Explain this ${p.severity}${where(p)} and what causes it. Don't edit anything yet:\n\n\`\`\`\n${p.message}\n\`\`\``,
  );
}

export function fixBuild() {
  ask("The last build failed. Use get_problems and get_build_log to find out why, read the relevant code, and propose a fix.");
}

export function explainLogcatCrash(trace: string) {
  ask(`The Android app crashed with this exception. Explain the cause and point to the code involved:\n\n\`\`\`\n${trace}\n\`\`\``);
}

export function askAboutSelection() {
  const editor = monaco.editor.getEditors().find((e) => e.hasTextFocus()) ?? null;
  const model = editor?.getModel();
  const selection = editor?.getSelection();
  const path = useWorkspace.getState().activePath;
  if (!model || !selection || !path) return;
  const text = selection.isEmpty() ? model.getLineContent(selection.startLineNumber) : model.getValueInRange(selection);
  ask(`Explain this code from ${rel(path)}:${selection.startLineNumber}:\n\n\`\`\`\n${text}\n\`\`\``);
}

/** Adds the AI actions to an editor's context menu and binds ⌘K / ⌘I. */
export function installEditorActions(editor: monaco.editor.IStandaloneCodeEditor) {
  // Hidden on Macs without the AI (and while it's turned off).
  const available = editor.createContextKey("orbitAi", aiAvailable());
  const unsubscribe = useAi.subscribe((s) => available.set(aiAvailable(s)));
  editor.onDidDispose(unsubscribe);
  editor.addAction({
    id: "orbit.ai.ask",
    label: "Ask AI About Selection",
    contextMenuGroupId: "0_ai",
    contextMenuOrder: 1,
    precondition: "orbitAi",
    run: askAboutSelection,
  });
  editor.addAction({
    id: "orbit.ai.edit",
    label: "Edit Selection with AI…",
    contextMenuGroupId: "0_ai",
    contextMenuOrder: 2,
    keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyK],
    precondition: "orbitAi",
    run: () => (aiReady() ? editSelectionWithAi() : useUi.getState().setShowAiPanel(true)),
  });
  // Monaco binds ⌘I to Trigger Suggest; the app uses it for the AI panel (⌃Space still suggests).
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyI, () => {
    const ui = useUi.getState();
    ui.setShowAiPanel(!ui.showAiPanel);
  });
}
