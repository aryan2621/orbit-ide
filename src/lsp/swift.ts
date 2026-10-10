// Swift language features in Monaco, backed by sourcekit-lsp.
// The server starts lazily when the first Swift file opens and restarts when the workspace changes.
import * as monaco from "monaco-editor";
import { LspClient } from "./client";
import { fsApi } from "../lib/ipc";
import { useWorkspace } from "../state/workspace";
import { openAt } from "../editor/navigation";

const LANG = "swift";

let client: LspClient | null = null;
let clientRoot: string | null = null;
let starting: Promise<LspClient | null> | null = null;

const toUri = (model: monaco.editor.ITextModel) => model.uri.toString();
const pathOf = (uri: string) => monaco.Uri.parse(uri).fsPath;

// ---------------------------------------------------------------- lifecycle

async function ensureClient(): Promise<LspClient | null> {
  const root = useWorkspace.getState().root;
  if (!root) return null;
  if (client && clientRoot === root) return client;
  if (starting) return starting;

  starting = (async () => {
    await stopClient();
    try {
      const c = await LspClient.start(root);
      const rootUri = monaco.Uri.file(root).toString();
      await c.request("initialize", {
        processId: null,
        rootUri,
        workspaceFolders: [{ uri: rootUri, name: root.split("/").pop() }],
        capabilities: {
          textDocument: {
            synchronization: { didSave: false, dynamicRegistration: false },
            completion: {
              completionItem: { snippetSupport: true, documentationFormat: ["markdown", "plaintext"] },
            },
            hover: { contentFormat: ["markdown", "plaintext"] },
            definition: { linkSupport: true },
            formatting: {},
            rename: { prepareSupport: false },
            publishDiagnostics: { relatedInformation: false },
          },
          workspace: { workspaceEdit: { documentChanges: true }, configuration: true, workspaceFolders: true },
          window: { workDoneProgress: false },
        },
      });
      c.notify("initialized", {});
      c.onNotification("textDocument/publishDiagnostics", publishDiagnostics);
      c.onExit = () => {
        if (client === c) client = null;
      };
      client = c;
      clientRoot = root;
      monaco.editor.getModels().filter((m) => m.getLanguageId() === LANG).forEach(didOpen);
      return c;
    } catch (e) {
      console.error("sourcekit-lsp failed to start", e);
      return null;
    } finally {
      starting = null;
    }
  })();
  return starting;
}

async function stopClient() {
  const c = client;
  client = null;
  clientRoot = null;
  monaco.editor.getModels().forEach((m) => monaco.editor.setModelMarkers(m, "sourcekit", []));
  await c?.stop().catch(() => {});
}

// Restart against the new folder when the workspace root changes.
useWorkspace.subscribe((s, prev) => {
  if (s.root !== prev.root) {
    stopClient().then(() => {
      if (monaco.editor.getModels().some((m) => m.getLanguageId() === LANG)) ensureClient();
    });
  }
});

// ---------------------------------------------------------------- document sync

function didOpen(model: monaco.editor.ITextModel) {
  client?.notify("textDocument/didOpen", {
    textDocument: { uri: toUri(model), languageId: LANG, version: model.getVersionId(), text: model.getValue() },
  });
}

monaco.editor.onDidCreateModel((model) => {
  if (model.getLanguageId() !== LANG) return;
  if (client) didOpen(model);
  else ensureClient(); // opens every Swift model once ready

  const change = model.onDidChangeContent(() => {
    client?.notify("textDocument/didChange", {
      textDocument: { uri: toUri(model), version: model.getVersionId() },
      contentChanges: [{ text: model.getValue() }],
    });
  });
  model.onWillDispose(() => {
    change.dispose();
    client?.notify("textDocument/didClose", { textDocument: { uri: toUri(model) } });
  });
});

// ---------------------------------------------------------------- conversions

interface LspPosition {
  line: number;
  character: number;
}
interface LspRange {
  start: LspPosition;
  end: LspPosition;
}
interface LspTextEdit {
  range: LspRange;
  newText: string;
}

const toRange = (r: LspRange) =>
  new monaco.Range(r.start.line + 1, r.start.character + 1, r.end.line + 1, r.end.character + 1);
const toPosition = (p: monaco.Position): LspPosition => ({ line: p.lineNumber - 1, character: p.column - 1 });

const SEVERITY = [
  monaco.MarkerSeverity.Error,
  monaco.MarkerSeverity.Error,
  monaco.MarkerSeverity.Warning,
  monaco.MarkerSeverity.Info,
  monaco.MarkerSeverity.Hint,
];

function publishDiagnostics(params: { uri: string; diagnostics: any[] }) {
  const model = monaco.editor.getModel(monaco.Uri.parse(params.uri));
  if (!model) return;
  monaco.editor.setModelMarkers(
    model,
    "sourcekit",
    params.diagnostics.map((d) => ({
      ...toRange(d.range),
      severity: SEVERITY[d.severity ?? 1],
      message: d.message,
      source: d.source,
      code: d.code === undefined ? undefined : String(d.code),
    })),
  );
}

const K = monaco.languages.CompletionItemKind;
// Indexed by LSP CompletionItemKind (1-based).
const COMPLETION_KIND = [
  K.Text, K.Text, K.Method, K.Function, K.Constructor, K.Field, K.Variable, K.Class, K.Interface,
  K.Module, K.Property, K.Unit, K.Value, K.Enum, K.Keyword, K.Snippet, K.Color, K.File, K.Reference,
  K.Folder, K.EnumMember, K.Constant, K.Struct, K.Event, K.Operator, K.TypeParameter,
];

function markdown(contents: any): monaco.IMarkdownString[] {
  const one = (c: any): monaco.IMarkdownString =>
    typeof c === "string"
      ? { value: c }
      : c.kind !== undefined
        ? { value: c.kind === "markdown" ? c.value : "```\n" + c.value + "\n```" }
        : { value: "```" + c.language + "\n" + c.value + "\n```" };
  return Array.isArray(contents) ? contents.map(one) : [one(contents)];
}

/** Applies LSP text edits to a string (edits are non-overlapping; apply back to front). */
function applyEdits(text: string, edits: LspTextEdit[]): string {
  const lineStarts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") lineStarts.push(i + 1);
  const offset = (p: LspPosition) => Math.min((lineStarts[p.line] ?? text.length) + p.character, text.length);
  const sorted = [...edits].sort((a, b) => offset(b.range.start) - offset(a.range.start));
  for (const e of sorted) text = text.slice(0, offset(e.range.start)) + e.newText + text.slice(offset(e.range.end));
  return text;
}

/** Makes sure a model exists for a file the editor hasn't opened, so Monaco can peek into it. */
async function ensureModel(uri: string) {
  const resource = monaco.Uri.parse(uri);
  if (monaco.editor.getModel(resource)) return;
  try {
    const text = await fsApi.readFile(resource.fsPath);
    if (!monaco.editor.getModel(resource)) monaco.editor.createModel(text, undefined, resource);
  } catch {
    // Unreadable target (e.g. SDK interface without a file); Monaco will skip it.
  }
}

// ---------------------------------------------------------------- providers

monaco.languages.registerCompletionItemProvider(LANG, {
  triggerCharacters: [".", ":", "(", "\\"],
  async provideCompletionItems(model, position) {
    const c = await ensureClient();
    if (!c) return { suggestions: [] };
    const result = await c
      .request("textDocument/completion", { textDocument: { uri: toUri(model) }, position: toPosition(position) })
      .catch(() => null);
    if (!result) return { suggestions: [] };
    const items: any[] = Array.isArray(result) ? result : result.items;
    const word = model.getWordUntilPosition(position);
    const defaultRange = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn);
    return {
      incomplete: !Array.isArray(result) && result.isIncomplete,
      suggestions: items.map((item) => ({
        label: item.label,
        kind: COMPLETION_KIND[item.kind ?? 1] ?? K.Text,
        detail: item.detail,
        documentation: item.documentation ? markdown(item.documentation)[0] : undefined,
        sortText: item.sortText,
        filterText: item.filterText,
        insertText: item.textEdit?.newText ?? item.insertText ?? item.label,
        insertTextRules: item.insertTextFormat === 2 ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet : undefined,
        range: item.textEdit?.range ? toRange(item.textEdit.range) : item.textEdit?.insert ? toRange(item.textEdit.insert) : defaultRange,
      })),
    };
  },
});

monaco.languages.registerHoverProvider(LANG, {
  async provideHover(model, position) {
    const c = await ensureClient();
    const hover = await c
      ?.request("textDocument/hover", { textDocument: { uri: toUri(model) }, position: toPosition(position) })
      .catch(() => null);
    if (!hover?.contents) return null;
    return { contents: markdown(hover.contents), range: hover.range ? toRange(hover.range) : undefined };
  },
});

monaco.languages.registerDefinitionProvider(LANG, {
  async provideDefinition(model, position) {
    const c = await ensureClient();
    const result = await c
      ?.request("textDocument/definition", { textDocument: { uri: toUri(model) }, position: toPosition(position) })
      .catch(() => null);
    if (!result) return null;
    const locations = (Array.isArray(result) ? result : [result]).map((l: any) => ({
      uri: l.targetUri ?? l.uri,
      range: l.targetSelectionRange ?? l.range,
    }));
    await Promise.all(locations.map((l) => ensureModel(l.uri)));
    return locations.map((l) => ({ uri: monaco.Uri.parse(l.uri), range: toRange(l.range) }));
  },
});

monaco.languages.registerDocumentFormattingEditProvider(LANG, {
  async provideDocumentFormattingEdits(model, options) {
    const c = await ensureClient();
    const edits: LspTextEdit[] | null = await c
      ?.request("textDocument/formatting", {
        textDocument: { uri: toUri(model) },
        options: { tabSize: options.tabSize, insertSpaces: options.insertSpaces },
      })
      .catch(() => null);
    return (edits ?? []).map((e) => ({ range: toRange(e.range), text: e.newText }));
  },
});

monaco.languages.registerRenameProvider(LANG, {
  async provideRenameEdits(model, position, newName) {
    const c = await ensureClient();
    const edit = await c?.request("textDocument/rename", {
      textDocument: { uri: toUri(model) },
      position: toPosition(position),
      newName,
    });
    if (!edit) return { edits: [] };

    const byUri = new Map<string, LspTextEdit[]>();
    for (const [uri, edits] of Object.entries<LspTextEdit[]>(edit.changes ?? {})) byUri.set(uri, edits);
    for (const dc of edit.documentChanges ?? []) if (dc.textDocument) byUri.set(dc.textDocument.uri, dc.edits);

    // Files open in tabs are edited in the editor (undoable, saved by the user);
    // everything else is rewritten on disk so the rename is complete.
    const openPaths = new Set(useWorkspace.getState().files.map((f) => f.path));
    const result: monaco.languages.IWorkspaceTextEdit[] = [];
    for (const [uri, edits] of byUri) {
      const resource = monaco.Uri.parse(uri);
      if (openPaths.has(resource.fsPath) || resource.toString() === model.uri.toString()) {
        for (const e of edits) {
          result.push({ resource, versionId: undefined, textEdit: { range: toRange(e.range), text: e.newText } });
        }
      } else {
        const path = pathOf(uri);
        await fsApi.writeFile(path, applyEdits(await fsApi.readFile(path), edits));
        monaco.editor.getModel(resource)?.dispose(); // stale peek model
      }
    }
    return { edits: result };
  },
});

// Go-to-definition into another file: open it in a tab and jump to the target.
monaco.editor.registerEditorOpener({
  openCodeEditor(_source, resource, selectionOrPosition) {
    openAt(resource.fsPath, selectionOrPosition);
    return true;
  },
});

/** Restarts sourcekit-lsp, e.g. after buildServer.json appears or a first build provides settings. */
export async function restartSwiftServer() {
  await stopClient();
  if (monaco.editor.getModels().some((m) => m.getLanguageId() === LANG)) await ensureClient();
}
