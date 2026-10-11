import { create } from "zustand";
import * as monaco from "monaco-editor";

/** A language-server diagnostic for an open file (1-based positions). */
export interface LspProblem {
  file: string;
  line: number;
  column: number;
  severity: "error" | "warning";
  message: string;
  source?: string;
}

/** Marker owners set by our language servers (`lsp-<language>` and sourcekit-lsp). */
const isLspOwner = (owner: string) => owner === "sourcekit" || owner.startsWith("lsp-");

interface MarkersState {
  problems: LspProblem[];
}

export const useMarkers = create<MarkersState>(() => ({ problems: [] }));

function collect(): LspProblem[] {
  const out: LspProblem[] = [];
  for (const m of monaco.editor.getModelMarkers({})) {
    if (!isLspOwner(m.owner) || m.resource.scheme !== "file") continue;
    // Info/hint markers stay in the editor only.
    if (m.severity < monaco.MarkerSeverity.Warning) continue;
    out.push({
      file: m.resource.fsPath,
      line: m.startLineNumber,
      column: m.startColumn,
      severity: m.severity === monaco.MarkerSeverity.Error ? "error" : "warning",
      message: m.message,
      source: m.source,
    });
  }
  return out;
}

monaco.editor.onDidChangeMarkers(() => useMarkers.setState({ problems: collect() }));
