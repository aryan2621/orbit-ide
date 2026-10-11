// Registry of the running language servers, shared by code navigation (symbols, references)
// and the status bar. Each server module (swift.ts, languageServer.ts) registers itself here.
import * as monaco from "monaco-editor";
import { create } from "zustand";
import { LspClient } from "./client";
import { filesApi, fsApi } from "../lib/ipc";
import { useWorkspace } from "../state/workspace";
import { appendOutput } from "../state/output";
import { toast } from "../state/toasts";

export type ServerState = "starting" | "ready" | "crashed";

export interface ServerEntry {
  /** Monaco language id. */
  language: string;
  /** Shown in the status bar, e.g. "sourcekit-lsp". */
  label: string;
  /** The running client, without starting one. */
  current: () => LspClient | null;
  /** The client, starting the server if needed. */
  ensure: () => Promise<LspClient | null>;
  restart: () => Promise<void>;
}

const entries = new Map<string, ServerEntry>();

export const useLspStatus = create<{
  states: Record<string, ServerState>;
  /** Work in progress per language ($/progress), e.g. "Indexing: 120/300". */
  progress: Record<string, string | null>;
}>(() => ({ states: {}, progress: {} }));

export function registerServer(entry: ServerEntry) {
  entries.set(entry.language, entry);
}

export const serverFor = (language: string) => entries.get(language);

/** `null` removes the entry (server stopped on purpose). */
export function setServerState(language: string, state: ServerState | null) {
  useLspStatus.setState((s) => {
    const states = { ...s.states };
    if (state) states[language] = state;
    else delete states[language];
    return { states, progress: state === "ready" ? s.progress : { ...s.progress, [language]: null } };
  });
}

// ---------------------------------------------------------------- document sync

/** Only real files are synced; diff views (`orbit-diff:`) and other scratch models never are. */
export const isFileModel = (model: monaco.editor.ITextModel) => model.uri.scheme === "file";

/** The server's text sync kind: 2 = incremental, otherwise full text. */
function syncKind(client: LspClient): number {
  const sync = client.capabilities?.textDocumentSync;
  return typeof sync === "number" ? sync : (sync?.change ?? 1);
}

/** didChange params: Monaco's change ranges when the server takes incremental sync, else the full
 * text. Monaco reports one event's changes against the pre-edit text in descending order, so the
 * server applying them in sequence gets the same result. */
export function didChangeParams(client: LspClient, model: monaco.editor.ITextModel, e: monaco.editor.IModelContentChangedEvent) {
  const textDocument = { uri: model.uri.toString(), version: model.getVersionId() };
  if (syncKind(client) !== 2) return { textDocument, contentChanges: [{ text: model.getValue() }] };
  return {
    textDocument,
    contentChanges: e.changes.map((c) => ({
      range: {
        start: { line: c.range.startLineNumber - 1, character: c.range.startColumn - 1 },
        end: { line: c.range.endLineNumber - 1, character: c.range.endColumn - 1 },
      },
      rangeLength: c.rangeLength,
      text: c.text,
    })),
  };
}

/** Makes sure a model exists for a file the editor hasn't opened, so Monaco can peek into it. */
export async function ensureModel(uri: string) {
  const resource = monaco.Uri.parse(uri);
  if (resource.scheme !== "file" || monaco.editor.getModel(resource)) return;
  try {
    const text = await fsApi.readFile(resource.fsPath);
    if (!monaco.editor.getModel(resource)) monaco.editor.createModel(text, undefined, resource);
  } catch {
    // Library sources inside jars, SDK interfaces etc.; Monaco will skip them.
  }
}

// ---------------------------------------------------------------- symbols

interface LspRange {
  start: { line: number; character: number };
  end: { line: number; character: number };
}
const toRange = (r: LspRange) =>
  new monaco.Range(r.start.line + 1, r.start.character + 1, r.end.line + 1, r.end.character + 1);

/** LSP SymbolKind is 1-based; Monaco's is the same list starting at 0. */
const toKind = (k: number | undefined): monaco.languages.SymbolKind => Math.max(0, (k ?? 13) - 1);

export interface SymbolItem {
  name: string;
  kind: monaco.languages.SymbolKind;
  container?: string;
  path: string;
  range: monaco.IRange;
}

function toDocumentSymbols(result: any[] | null): monaco.languages.DocumentSymbol[] {
  return (result ?? []).map((s) =>
    s.location
      ? // SymbolInformation (flat)
        { name: s.name, detail: "", kind: toKind(s.kind), tags: [], containerName: s.containerName, range: toRange(s.location.range), selectionRange: toRange(s.location.range) }
      : { name: s.name, detail: s.detail ?? "", kind: toKind(s.kind), tags: [], range: toRange(s.range), selectionRange: toRange(s.selectionRange ?? s.range), children: toDocumentSymbols(s.children) },
  );
}

async function requestDocumentSymbols(model: monaco.editor.ITextModel) {
  const c = await serverFor(model.getLanguageId())?.ensure();
  const result = await c?.request("textDocument/documentSymbol", { textDocument: { uri: model.uri.toString() } }).catch(() => null);
  return toDocumentSymbols(result);
}

/** The symbols in a file, flattened (with their parent as container) for the palette. */
export async function documentSymbols(model: monaco.editor.ITextModel): Promise<SymbolItem[]> {
  const out: SymbolItem[] = [];
  const walk = (list: monaco.languages.DocumentSymbol[], container?: string) => {
    for (const s of list) {
      out.push({ name: s.name, kind: s.kind, container: container ?? s.containerName, path: model.uri.fsPath, range: s.selectionRange });
      if (s.children) walk(s.children, s.name);
    }
  };
  walk(await requestDocumentSymbols(model));
  return out;
}

/** Searches symbols in every running language server (doesn't start any). */
export async function workspaceSymbols(query: string): Promise<SymbolItem[]> {
  const results = await Promise.all(
    [...entries.values()].map(async (e) => {
      const result: any[] | null = await e.current()?.request("workspace/symbol", { query }).catch(() => null);
      return (result ?? [])
        .filter((s) => s.location?.uri?.startsWith("file:"))
        .map((s) => ({
          name: s.name,
          kind: toKind(s.kind),
          container: s.containerName,
          path: monaco.Uri.parse(s.location.uri).fsPath,
          // WorkspaceSymbol may omit the range until resolved; go to the top of the file then.
          range: s.location.range ? toRange(s.location.range) : new monaco.Range(1, 1, 1, 1),
        }));
    }),
  );
  return results.flat();
}

/** Every shared provider for a language: navigation (outline ⇧⌘O, references ⇧F12) plus editing. */
export function registerSharedProviders(language: string) {
  registerNavigationProviders(language);
  registerEditingProviders(language);
}

/** Document symbols (outline, ⇧⌘O) and references (⇧F12) for a language, through its server. */
function registerNavigationProviders(language: string) {
  monaco.languages.registerDocumentSymbolProvider(language, {
    provideDocumentSymbols: (model) => requestDocumentSymbols(model),
  });

  monaco.languages.registerReferenceProvider(language, {
    async provideReferences(model, position, context) {
      const c = await serverFor(language)?.ensure();
      const result: { uri: string; range: LspRange }[] | null = await c
        ?.request("textDocument/references", {
          textDocument: { uri: model.uri.toString() },
          position: { line: position.lineNumber - 1, character: position.column - 1 },
          context: { includeDeclaration: context.includeDeclaration },
        })
        .catch(() => null);
      const locations = (result ?? []).filter((l) => l.uri.startsWith("file:"));
      await Promise.all(locations.map((l) => ensureModel(l.uri)));
      return locations.map((l) => ({ uri: monaco.Uri.parse(l.uri), range: toRange(l.range) }));
    },
  });
}

// ---------------------------------------------------------------- client setup

/** What Orbit's Monaco integration supports, sent in `initialize` by every server module. */
export const CLIENT_CAPABILITIES = {
  textDocument: {
    synchronization: { didSave: false, dynamicRegistration: false },
    completion: {
      completionItem: { snippetSupport: true, documentationFormat: ["markdown", "plaintext"] },
    },
    hover: { contentFormat: ["markdown", "plaintext"] },
    definition: { linkSupport: true },
    implementation: { linkSupport: true },
    typeDefinition: { linkSupport: true },
    formatting: {},
    rename: { prepareSupport: false },
    references: {},
    documentHighlight: {},
    documentSymbol: { hierarchicalDocumentSymbolSupport: true },
    signatureHelp: {
      signatureInformation: { documentationFormat: ["markdown", "plaintext"], parameterInformation: { labelOffsetSupport: true } },
      contextSupport: true,
    },
    codeAction: {
      codeActionLiteralSupport: {
        codeActionKind: { valueSet: ["", "quickfix", "refactor", "refactor.extract", "refactor.inline", "refactor.rewrite", "source", "source.organizeImports"] },
      },
      isPreferredSupport: true,
      resolveSupport: { properties: ["edit"] },
      dataSupport: true,
    },
    inlayHint: { dynamicRegistration: false },
    publishDiagnostics: { relatedInformation: false },
  },
  workspace: {
    workspaceEdit: { documentChanges: true },
    applyEdit: true,
    executeCommand: {},
    configuration: true,
    workspaceFolders: true,
    symbol: {},
  },
  window: { workDoneProgress: true, showMessage: {} },
};

const MESSAGE_KIND = ["error", "error", "warning", "info", "info"] as const;

/** Wires a freshly initialized client into Orbit: workspace edits, messages as toasts, progress
 * in the status bar, and stderr / log messages in the Output panel. */
export function wireClient(client: LspClient, language: string, channel: string) {
  client.onStderr = (line) => appendOutput(channel, line);
  client.onNotification("window/logMessage", (p) => appendOutput(channel, p?.message ?? ""));
  client.onNotification("window/showMessage", (p) => {
    appendOutput(channel, p?.message ?? "");
    // Errors and warnings are worth a toast; info chatter (e.g. "indexing done") isn't.
    if ((p?.type ?? 4) <= 2) toast(`${channel}: ${p.message}`, MESSAGE_KIND[p.type ?? 4]);
  });
  client.onRequest("window/showMessageRequest", (p) => {
    toast(`${channel}: ${p?.message ?? ""}`, MESSAGE_KIND[p?.type ?? 4]);
    return null;
  });
  client.onRequest("workspace/applyEdit", async (p) => ({ applied: await applyWorkspaceEdit(p?.edit).then(() => true, () => false) }));
  client.onRequest("window/workDoneProgress/create", () => null);
  client.onRequest("client/registerCapability", () => null);
  const titles = new Map<string | number, string>();
  client.onNotification("$/progress", (p) => {
    const v = p?.value;
    if (!v) return;
    if (v.kind === "begin") titles.set(p.token, v.title ?? "Working");
    if (v.kind === "end") titles.delete(p.token);
    const title = titles.get(p.token);
    const text = v.kind === "end" ? [...titles.values()].pop() : `${title}${v.message ? `: ${v.message}` : ""}${v.percentage !== undefined ? ` (${v.percentage}%)` : ""}`;
    useLspStatus.setState((s) => ({ progress: { ...s.progress, [language]: text ?? null } }));
  });
}

// ---------------------------------------------------------------- workspace edits

interface LspTextEdit {
  range: LspRange;
  newText: string;
}

/** Applies LSP text edits to a string (edits are non-overlapping; apply back to front). */
export function applyTextEdits(text: string, edits: LspTextEdit[]): string {
  const lineStarts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") lineStarts.push(i + 1);
  const offset = (p: { line: number; character: number }) => Math.min((lineStarts[p.line] ?? text.length) + p.character, text.length);
  const sorted = [...edits].sort((a, b) => offset(b.range.start) - offset(a.range.start));
  for (const e of sorted) text = text.slice(0, offset(e.range.start)) + e.newText + text.slice(offset(e.range.end));
  return text;
}

/** Applies an LSP WorkspaceEdit: files with a model (open tabs) are edited in the model as one
 * undoable step; others are rewritten on disk. Create/rename/delete file operations are applied too. */
export async function applyWorkspaceEdit(edit: any) {
  if (!edit) return;
  const byUri = new Map<string, LspTextEdit[]>();
  for (const [uri, edits] of Object.entries<LspTextEdit[]>(edit.changes ?? {})) byUri.set(uri, edits);
  for (const dc of edit.documentChanges ?? []) {
    if (dc.textDocument) byUri.set(dc.textDocument.uri, [...(byUri.get(dc.textDocument.uri) ?? []), ...dc.edits]);
    else if (dc.kind === "create") await fsApi.writeFile(monaco.Uri.parse(dc.uri).fsPath, "").catch((e) => useWorkspace.setState({ error: `Couldn't create ${monaco.Uri.parse(dc.uri).fsPath}: ${e}` }));
    else if (dc.kind === "rename") await filesApi.rename(monaco.Uri.parse(dc.oldUri).fsPath, monaco.Uri.parse(dc.newUri).fsPath);
    else if (dc.kind === "delete") await filesApi.trash(monaco.Uri.parse(dc.uri).fsPath);
  }
  const openPaths = new Set(useWorkspace.getState().files.map((f) => f.path));
  for (const [uri, edits] of byUri) {
    const resource = monaco.Uri.parse(uri);
    if (resource.scheme !== "file") continue;
    const model = monaco.editor.getModel(resource);
    if (model && openPaths.has(resource.fsPath)) {
      model.pushStackElement();
      model.pushEditOperations([], edits.map((e) => ({ range: toRange(e.range), text: e.newText })), () => null);
      model.pushStackElement();
    } else {
      const path = resource.fsPath;
      await fsApi.writeFile(path, applyTextEdits(await fsApi.readFile(path), edits));
      model?.dispose(); // stale peek model
    }
  }
}

// ---------------------------------------------------------------- shared providers

const toLspPosition = (p: monaco.IPosition) => ({ line: p.lineNumber - 1, character: p.column - 1 });
const toLspRange = (r: monaco.IRange): LspRange => ({
  start: { line: r.startLineNumber - 1, character: r.startColumn - 1 },
  end: { line: r.endLineNumber - 1, character: r.endColumn - 1 },
});
const SEVERITY_TO_LSP: Record<number, number> = {
  [monaco.MarkerSeverity.Error]: 1,
  [monaco.MarkerSeverity.Warning]: 2,
  [monaco.MarkerSeverity.Info]: 3,
  [monaco.MarkerSeverity.Hint]: 4,
};

function markdownOf(doc: any): monaco.IMarkdownString | string | undefined {
  if (!doc) return undefined;
  if (typeof doc === "string") return doc;
  return doc.kind === "markdown" ? { value: doc.value } : doc.value;
}

/** Location | Location[] | LocationLink[] → Monaco locations (files only), loading peek models. */
async function toLocations(result: any): Promise<monaco.languages.Location[]> {
  if (!result) return [];
  const locations = (Array.isArray(result) ? result : [result])
    .map((l: any) => ({ uri: l.targetUri ?? l.uri, range: l.targetSelectionRange ?? l.range }))
    .filter((l: any) => l.uri?.startsWith("file:"));
  await Promise.all(locations.map((l) => ensureModel(l.uri)));
  return locations.map((l) => ({ uri: monaco.Uri.parse(l.uri), range: toRange(l.range) }));
}

const APPLY_CODE_ACTION = "orbit.lsp.applyCodeAction";
monaco.editor.registerCommand(APPLY_CODE_ACTION, async (_accessor, language: string, action: any) => {
  const client = await serverFor(language)?.ensure();
  if (!client) return;
  try {
    let resolved = action;
    if (!action.edit && !action.command && action.data !== undefined && client.capabilities?.codeActionProvider?.resolveProvider) {
      resolved = (await client.request("codeAction/resolve", action)) ?? action;
    }
    if (resolved.edit) await applyWorkspaceEdit(resolved.edit);
    const command = typeof resolved.command === "string" ? resolved : resolved.command;
    if (command?.command) await client.request("workspace/executeCommand", { command: command.command, arguments: command.arguments });
  } catch (e) {
    toast(`Couldn't apply "${action.title}": ${e instanceof Error ? e.message : e}`, "error");
  }
});

/** Quick fixes, signature help, symbol highlights, inlay hints, go to implementation / type
 * definition: the same LSP requests for every language, through its registered server. */
function registerEditingProviders(language: string) {
  const client = () => serverFor(language)?.ensure() ?? Promise.resolve(null);
  const textDocument = (model: monaco.editor.ITextModel) => ({ uri: model.uri.toString() });

  monaco.languages.registerCodeActionProvider(language, {
    async provideCodeActions(model, range, context) {
      const c = isFileModel(model) ? await client() : null;
      if (!c?.capabilities?.codeActionProvider) return { actions: [], dispose() {} };
      const diagnostics = context.markers.map((m) => ({
        range: toLspRange(m),
        message: m.message,
        severity: SEVERITY_TO_LSP[m.severity] ?? 1,
        code: typeof m.code === "string" ? m.code : m.code?.value,
        source: m.source,
      }));
      const result: any[] | null = await c
        .request("textDocument/codeAction", {
          textDocument: textDocument(model),
          range: toLspRange(range),
          context: { diagnostics, only: context.only ? [context.only] : undefined, triggerKind: context.trigger },
        })
        .catch(() => null);
      const actions: monaco.languages.CodeAction[] = (result ?? []).map((a) => ({
        title: a.title,
        kind: a.kind ?? (typeof a.command === "string" ? undefined : "quickfix"),
        isPreferred: a.isPreferred,
        diagnostics: a.diagnostics ? context.markers : undefined,
        disabled: a.disabled?.reason,
        command: { id: APPLY_CODE_ACTION, title: a.title, arguments: [language, a] },
      }));
      return { actions, dispose() {} };
    },
  });

  monaco.languages.registerSignatureHelpProvider(language, {
    signatureHelpTriggerCharacters: ["(", ","],
    signatureHelpRetriggerCharacters: [")"],
    async provideSignatureHelp(model, position, _token, context) {
      const c = isFileModel(model) ? await client() : null;
      if (!c?.capabilities?.signatureHelpProvider) return null;
      const help = await c
        .request("textDocument/signatureHelp", {
          textDocument: textDocument(model),
          position: toLspPosition(position),
          context: { triggerKind: context.triggerKind, triggerCharacter: context.triggerCharacter, isRetrigger: context.isRetrigger },
        })
        .catch(() => null);
      if (!help?.signatures?.length) return null;
      return {
        value: {
          activeSignature: help.activeSignature ?? 0,
          activeParameter: help.activeParameter ?? 0,
          signatures: help.signatures.map((s: any) => ({
            label: s.label,
            documentation: markdownOf(s.documentation),
            parameters: (s.parameters ?? []).map((p: any) => ({ label: p.label, documentation: markdownOf(p.documentation) })),
            activeParameter: s.activeParameter,
          })),
        },
        dispose() {},
      };
    },
  });

  monaco.languages.registerDocumentHighlightProvider(language, {
    async provideDocumentHighlights(model, position) {
      const c = isFileModel(model) ? await client() : null;
      if (!c?.capabilities?.documentHighlightProvider) return [];
      const result: any[] | null = await c
        .request("textDocument/documentHighlight", { textDocument: textDocument(model), position: toLspPosition(position) })
        .catch(() => null);
      // LSP kinds are 1-based (Text, Read, Write); Monaco's start at 0.
      return (result ?? []).map((h) => ({ range: toRange(h.range), kind: Math.max(0, (h.kind ?? 1) - 1) }));
    },
  });

  monaco.languages.registerInlayHintsProvider(language, {
    async provideInlayHints(model, range) {
      const none = { hints: [], dispose() {} };
      const c = isFileModel(model) ? await client() : null;
      if (!c?.capabilities?.inlayHintProvider) return none;
      const result: any[] | null = await c
        .request("textDocument/inlayHint", { textDocument: textDocument(model), range: toLspRange(range) })
        .catch(() => null);
      return {
        hints: (result ?? []).map((h) => ({
          label: typeof h.label === "string" ? h.label : h.label.map((part: any) => part.value).join(""),
          position: { lineNumber: h.position.line + 1, column: h.position.character + 1 },
          kind: h.kind,
          paddingLeft: h.paddingLeft,
          paddingRight: h.paddingRight,
        })),
        dispose() {},
      };
    },
  });

  monaco.languages.registerImplementationProvider(language, {
    async provideImplementation(model, position) {
      const c = isFileModel(model) ? await client() : null;
      if (!c?.capabilities?.implementationProvider) return [];
      return toLocations(await c.request("textDocument/implementation", { textDocument: textDocument(model), position: toLspPosition(position) }).catch(() => null));
    },
  });

  monaco.languages.registerTypeDefinitionProvider(language, {
    async provideTypeDefinition(model, position) {
      const c = isFileModel(model) ? await client() : null;
      if (!c?.capabilities?.typeDefinitionProvider) return [];
      return toLocations(await c.request("textDocument/typeDefinition", { textDocument: textDocument(model), position: toLspPosition(position) }).catch(() => null));
    },
  });
}
