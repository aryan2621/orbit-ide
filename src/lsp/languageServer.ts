// Generic Monaco ↔ language-server wiring: one server per language, started lazily when the
// first file of that language opens, and restarted when the workspace changes. swift.ts is the
// sourcekit-specific original; this is the same pattern parameterized for other servers.
import * as monaco from "monaco-editor";
import { LspClient } from "./client";
import { fsApi } from "../lib/ipc";
import { useWorkspace } from "../state/workspace";
import {
  applyTextEdits,
  CLIENT_CAPABILITIES,
  didChangeParams,
  ensureModel,
  isFileModel,
  registerServer,
  registerSharedProviders,
  setServerState,
  wireClient,
} from "./servers";

export interface ServerCommand {
  program: string;
  args: string[];
  /** Workspace folder for the server (may differ from the opened folder). */
  root: string;
  name: string;
}

export interface LanguageServerOptions {
  /** Monaco language id, also sent as the LSP languageId. */
  language: string;
  /** How to start the server for a workspace root, or null when unavailable. */
  resolve: (root: string) => Promise<ServerCommand | null>;
  triggerCharacters?: string[];
}

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
const toUri = (model: monaco.editor.ITextModel) => model.uri.toString();

const SEVERITY = [
  monaco.MarkerSeverity.Error,
  monaco.MarkerSeverity.Error,
  monaco.MarkerSeverity.Warning,
  monaco.MarkerSeverity.Info,
  monaco.MarkerSeverity.Hint,
];

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

const LABELS: Record<string, string> = { kotlin: "Kotlin", java: "Java", xml: "XML" };

/** Registers Monaco providers for `language`, backed by the server `resolve` returns. */
export function registerLanguageServer({ language, resolve, triggerCharacters = ["."] }: LanguageServerOptions) {
  const owner = `lsp-${language}`;
  let client: LspClient | null = null;
  let clientRoot: string | null = null;
  let starting: Promise<LspClient | null> | null = null;
  /** Roots where no server is available, so we don't retry on every keystroke. */
  const unavailable = new Set<string>();

  const models = () => monaco.editor.getModels().filter((m) => m.getLanguageId() === language && isFileModel(m));

  function didOpen(model: monaco.editor.ITextModel) {
    client?.notify("textDocument/didOpen", {
      textDocument: { uri: toUri(model), languageId: language, version: model.getVersionId(), text: model.getValue() },
    });
  }

  function publishDiagnostics(params: { uri: string; diagnostics: any[] }) {
    const model = monaco.editor.getModel(monaco.Uri.parse(params.uri));
    if (!model) return;
    monaco.editor.setModelMarkers(
      model,
      owner,
      params.diagnostics.map((d) => ({
        ...toRange(d.range),
        severity: SEVERITY[d.severity ?? 1],
        message: d.message,
        source: d.source,
        code: d.code === undefined ? undefined : String(d.code),
      })),
    );
  }

  async function ensureClient(): Promise<LspClient | null> {
    const root = useWorkspace.getState().root;
    if (!root || unavailable.has(root)) return null;
    if (client && clientRoot === root) return client;
    if (starting) return starting;

    starting = (async () => {
      await stopClient();
      try {
        const server = await resolve(root);
        if (!server) {
          unavailable.add(root);
          return null;
        }
        setServerState(language, "starting");
        const c = await LspClient.start(server.root, server);
        const rootUri = monaco.Uri.file(server.root).toString();
        const init = await c.request("initialize", {
          processId: null,
          rootUri,
          workspaceFolders: [{ uri: rootUri, name: server.root.split("/").pop() }],
          capabilities: CLIENT_CAPABILITIES,
        });
        c.capabilities = init?.capabilities ?? {};
        wireClient(c, language, server.name);
        c.notify("initialized", {});
        c.onNotification("textDocument/publishDiagnostics", publishDiagnostics);
        c.onExit = () => {
          if (client !== c) return;
          client = null;
          setServerState(language, "crashed");
        };
        client = c;
        clientRoot = root;
        setServerState(language, "ready");
        models().forEach(didOpen);
        return c;
      } catch (e) {
        console.error(`${language} language server failed to start`, e);
        setServerState(language, "crashed");
        useWorkspace.setState({ error: `The ${language} language server couldn't start (${e}). Code completion and errors in the editor are off until it's fixed; see Setup.` });
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
    setServerState(language, null);
    monaco.editor.getModels().forEach((m) => monaco.editor.setModelMarkers(m, owner, []));
    await c?.stop().catch(() => {});
  }

  useWorkspace.subscribe((s, prev) => {
    if (s.root !== prev.root) {
      stopClient().then(() => {
        if (models().length) ensureClient();
      });
    }
  });

  monaco.editor.onDidCreateModel((model) => {
    if (model.getLanguageId() !== language || !isFileModel(model)) return;
    if (client) didOpen(model);
    else ensureClient();

    const change = model.onDidChangeContent((e) => {
      if (client) client.notify("textDocument/didChange", didChangeParams(client, model, e));
    });
    model.onWillDispose(() => {
      change.dispose();
      client?.notify("textDocument/didClose", { textDocument: { uri: toUri(model) } });
    });
  });

  monaco.languages.registerCompletionItemProvider(language, {
    triggerCharacters,
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
          insertTextRules:
            item.insertTextFormat === 2 ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet : undefined,
          range: item.textEdit?.range
            ? toRange(item.textEdit.range)
            : item.textEdit?.insert
              ? toRange(item.textEdit.insert)
              : defaultRange,
        })),
      };
    },
  });

  monaco.languages.registerHoverProvider(language, {
    async provideHover(model, position) {
      const c = await ensureClient();
      const hover = await c
        ?.request("textDocument/hover", { textDocument: { uri: toUri(model) }, position: toPosition(position) })
        .catch(() => null);
      if (!hover?.contents) return null;
      return { contents: markdown(hover.contents), range: hover.range ? toRange(hover.range) : undefined };
    },
  });

  monaco.languages.registerDefinitionProvider(language, {
    async provideDefinition(model, position) {
      const c = await ensureClient();
      const result = await c
        ?.request("textDocument/definition", { textDocument: { uri: toUri(model) }, position: toPosition(position) })
        .catch(() => null);
      if (!result) return null;
      const locations = (Array.isArray(result) ? result : [result])
        .map((l: any) => ({ uri: l.targetUri ?? l.uri, range: l.targetSelectionRange ?? l.range }))
        .filter((l) => l.uri?.startsWith("file:"));
      await Promise.all(locations.map((l) => ensureModel(l.uri)));
      return locations.map((l) => ({ uri: monaco.Uri.parse(l.uri), range: toRange(l.range) }));
    },
  });

  monaco.languages.registerDocumentFormattingEditProvider(language, {
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

  monaco.languages.registerRenameProvider(language, {
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

      // Open files are edited in the editor (undoable); everything else is rewritten on disk.
      const openPaths = new Set(useWorkspace.getState().files.map((f) => f.path));
      const result: monaco.languages.IWorkspaceTextEdit[] = [];
      for (const [uri, edits] of byUri) {
        const resource = monaco.Uri.parse(uri);
        if (openPaths.has(resource.fsPath) || resource.toString() === model.uri.toString()) {
          for (const e of edits) {
            result.push({ resource, versionId: undefined, textEdit: { range: toRange(e.range), text: e.newText } });
          }
        } else {
          const path = resource.fsPath;
          await fsApi.writeFile(path, applyTextEdits(await fsApi.readFile(path), edits));
          monaco.editor.getModel(resource)?.dispose();
        }
      }
      return { edits: result };
    },
  });

  /** Restarts the server, e.g. after a Gradle sync changes the classpath. */
  async function restart() {
    unavailable.clear();
    await stopClient();
    if (models().length) await ensureClient();
  }

  registerSharedProviders(language);
  registerServer({ language, label: LABELS[language] ?? language, current: () => client, ensure: ensureClient, restart });

  /** Lets the next file open retry roots where no server was found (e.g. one was just installed). */
  const retryUnavailable = () => unavailable.clear();

  return { restart, retryUnavailable };
}
