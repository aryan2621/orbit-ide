// The agent's tools. Read-only tools run freely; writes and builds ask for approval first.
// There is deliberately no shell tool.
import * as monaco from "monaco-editor";
import { filesApi, fsApi } from "../lib/ipc";
import { useWorkspace, fileText, ensureFileModel, markSaved } from "../state/workspace";
import { useProject } from "../state/project";
import { useMarkers } from "../state/markers";
import { useLogcat } from "../state/logcat";
import { runAllTests, runCurrentFile } from "../state/tests";
import { activeEditor, openAt } from "../editor/navigation";
import { modelUri } from "../editor/monaco-setup";
import { truncate, untrusted } from "./context";

export interface ToolResult {
  /** What the model sees. */
  output: string;
  /** One line for the UI. */
  summary: string;
  error?: boolean;
}

/** What the approval card shows. */
export interface ApprovalPreview {
  title: string;
  /** Edits: the file before and after. */
  diff?: { path: string; before: string; after: string };
  detail?: string;
}

interface Tool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  /** Writes or runs something: ask first. */
  approval: boolean;
  /** For approval tools: what will happen, computed before asking (throws if it can't happen). */
  preview?: (args: Record<string, unknown>) => Promise<ApprovalPreview>;
  run: (args: Record<string, unknown>) => Promise<ToolResult>;
}

const OUTPUT_TOKENS = 2000;

const root = () => {
  const r = useWorkspace.getState().root;
  if (!r) throw new Error("No folder is open");
  return r;
};

/** Resolves a path inside the open folder; anything outside it is refused. */
export function resolvePath(path: unknown): string {
  if (typeof path !== "string" || !path.trim()) throw new Error("A path is required");
  const base = root();
  const raw = path.trim().replace(/^\.\//, "");
  const joined = raw.startsWith("/") ? raw : `${base}/${raw}`;
  const parts: string[] = [];
  for (const p of joined.split("/")) {
    if (!p || p === ".") continue;
    if (p === "..") parts.pop();
    else parts.push(p);
  }
  const full = "/" + parts.join("/");
  if (full !== base && !full.startsWith(base + "/")) throw new Error(`${path} is outside the open folder`);
  return full;
}

const relative = (p: string) => {
  const base = useWorkspace.getState().root ?? "";
  return p.startsWith(base + "/") ? p.slice(base.length + 1) : p;
};

/** The file's current text: the editor's (possibly unsaved) model, else the disk. */
async function currentText(path: string) {
  return fileText(path) ?? (await fsApi.readFile(path));
}

const str = (v: unknown, fallback = "") => (typeof v === "string" ? v : fallback);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.floor(v) : undefined);

/** Writes through the Monaco model so the change shows in the editor and ⌘Z undoes it. */
async function applyText(path: string, after: string) {
  let model = monaco.editor.getModel(modelUri(path));
  if (!model) {
    const disk = await fsApi.readFile(path);
    model = ensureFileModel(path, disk);
    markSaved(path, disk);
  }
  model.pushStackElement();
  model.pushEditOperations([], [{ range: model.getFullModelRange(), text: after }], () => null);
  model.pushStackElement();
  await openAt(path);
}

/** old_text → new_text, which must match exactly once. */
function replaceOnce(text: string, oldText: string, newText: string) {
  if (!oldText) throw new Error("old_text is empty; use create_file for new files");
  let at = text.indexOf(oldText);
  let target = oldText;
  // Models often get trailing whitespace or indentation slightly wrong: retry line-trimmed.
  if (at < 0) {
    const norm = (s: string) => s.split("\n").map((l) => l.trimEnd()).join("\n");
    const normText = norm(text);
    const idx = normText.indexOf(norm(oldText));
    if (idx >= 0) {
      const lineStart = normText.slice(0, idx).split("\n").length - 1;
      const lineCount = norm(oldText).split("\n").length;
      const lines = text.split("\n");
      target = lines.slice(lineStart, lineStart + lineCount).join("\n");
      at = text.indexOf(target);
    }
  }
  if (at < 0) throw new Error("old_text wasn't found in the file. Read the file again and copy the text exactly.");
  if (text.indexOf(target, at + 1) >= 0) throw new Error("old_text matches more than once. Include more surrounding lines so it is unique.");
  return text.slice(0, at) + newText + text.slice(at + target.length);
}

/** Waits for the current build/run/test job; for runs, until the app is running. */
function waitForJob(untilRunning: boolean, timeoutMs = 20 * 60_000) {
  return new Promise<void>((resolve) => {
    const done = () => {
      const b = useProject.getState().build;
      return b.status !== "active" || (untilRunning && b.phase === "running");
    };
    if (done()) return resolve();
    const timer = setTimeout(() => (unsub(), resolve()), timeoutMs);
    const unsub = useProject.subscribe(() => {
      if (done()) {
        clearTimeout(timer);
        unsub();
        resolve();
      }
    });
  });
}

function jobReport(label: string) {
  const b = useProject.getState().build;
  const diags = b.diagnostics
    .slice(0, 30)
    .map((d) => `${d.severity}: ${d.file ? `${relative(d.file)}${d.line ? `:${d.line}` : ""}: ` : ""}${d.message}`)
    .join("\n");
  const status = b.status === "active" ? (b.phase === "running" ? "running" : "still running") : b.status;
  const log = b.log.slice(-60).join("\n");
  const tests = b.tests ? `\nTests: ${b.tests.filter((t) => t.status === "passed").length} passed, ${b.tests.filter((t) => t.status === "failed").length} failed\n${b.tests.filter((t) => t.status === "failed").slice(0, 15).map((t) => `FAILED ${t.suite}.${t.name}: ${t.message ?? ""}`).join("\n")}` : "";
  const consoleTail = b.console.length ? `\nApp output (last lines):\n${b.console.slice(-40).join("\n")}` : "";
  return {
    output: `${label}: ${status}\n${diags ? `Diagnostics:\n${diags}\n` : ""}${tests}${consoleTail}\nLog tail:\n${untrusted("build log", truncate(log, 800))}`,
    summary: `${label} ${status}${b.diagnostics.length ? ` · ${b.diagnostics.length} diagnostic${b.diagnostics.length === 1 ? "" : "s"}` : ""}`,
    error: b.status === "failed",
  };
}

async function startJob(label: string, start: () => Promise<void>, untilRunning = false): Promise<ToolResult> {
  const before = useProject.getState().build;
  if (before.status === "active") return { output: "Another build or run is in progress; wait for it to finish.", summary: "Busy", error: true };
  useWorkspace.setState({ error: null });
  await start();
  const after = useProject.getState().build;
  if (after.jobId === before.jobId || (after.status !== "active" && after.startedAt === before.startedAt)) {
    const why = useWorkspace.getState().error ?? "It couldn't start (no scheme or device selected?)";
    return { output: `${label} didn't start: ${why}`, summary: `${label} didn't start`, error: true };
  }
  await waitForJob(untilRunning);
  // Give a freshly launched app a moment to print its first lines or crash.
  if (untilRunning && useProject.getState().build.status === "active") await new Promise((r) => setTimeout(r, 4000));
  return jobReport(label);
}

const TOOLS: Tool[] = [
  {
    name: "read_file",
    description: "Read a file in the project, with line numbers. Use start_line/end_line for large files.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path relative to the project root" },
        start_line: { type: "integer", description: "First line (1-based), optional" },
        end_line: { type: "integer", description: "Last line, optional" },
      },
      required: ["path"],
    },
    approval: false,
    run: async (args) => {
      const path = resolvePath(args.path);
      const lines = (await currentText(path)).split("\n");
      const start = Math.max(1, num(args.start_line) ?? 1);
      const end = Math.min(lines.length, num(args.end_line) ?? start + 399);
      const body = lines.slice(start - 1, end).map((l, i) => `${String(start + i).padStart(5)}  ${l}`).join("\n");
      const more = end < lines.length ? `\n(${lines.length - end} more lines; read with start_line=${end + 1})` : "";
      return { output: untrusted(relative(path), truncate(body, OUTPUT_TOKENS)) + more, summary: `${relative(path)} lines ${start}–${end}` };
    },
  },
  {
    name: "list_dir",
    description: "List the files and folders in a directory of the project.",
    parameters: { type: "object", properties: { path: { type: "string", description: "Directory relative to the project root; empty for the root" } } },
    approval: false,
    run: async (args) => {
      const path = str(args.path) ? resolvePath(args.path) : root();
      const entries = await fsApi.readDir(path);
      const text = entries.map((e) => (e.is_dir ? `${e.name}/` : e.name)).join("\n");
      return { output: text || "(empty)", summary: `${relative(path) || "."} · ${entries.length} entries` };
    },
  },
  {
    name: "find_files",
    description: "Find project files whose path contains the given text (case-insensitive).",
    parameters: { type: "object", properties: { pattern: { type: "string" } }, required: ["pattern"] },
    approval: false,
    run: async (args) => {
      const pattern = str(args.pattern).toLowerCase();
      const files = (await filesApi.list(root())).map(relative).filter((f) => f.toLowerCase().includes(pattern));
      return { output: files.slice(0, 100).join("\n") + (files.length > 100 ? `\n(${files.length - 100} more)` : "") || "No matches", summary: `${files.length} files match "${pattern}"` };
    },
  },
  {
    name: "search",
    description: "Search the text of all project files. Returns matching lines with file and line number.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string" },
        regex: { type: "boolean", description: "Treat query as a regular expression" },
        include: { type: "string", description: "Glob of files to search, e.g. *.kt" },
      },
      required: ["query"],
    },
    approval: false,
    run: async (args) => {
      const matches = await filesApi.search(root(), str(args.query), args.regex === true, false, str(args.include));
      const text = matches.slice(0, 60).map((m) => `${relative(m.path)}:${m.line}: ${m.text.trim()}`).join("\n");
      return { output: untrusted("search results", truncate(text || "No matches", OUTPUT_TOKENS)) + (matches.length > 60 ? `\n(${matches.length - 60} more matches)` : ""), summary: `${matches.length} matches for "${str(args.query)}"` };
    },
  },
  {
    name: "get_problems",
    description: "Current errors and warnings from the language servers and the last build.",
    parameters: { type: "object", properties: {} },
    approval: false,
    run: async () => {
      const lsp = useMarkers.getState().problems.map((p) => `${p.severity}: ${relative(p.file)}:${p.line}:${p.column}: ${p.message}`);
      const build = useProject.getState().build.diagnostics.map((d) => `${d.severity}: ${d.file ? `${relative(d.file)}${d.line ? `:${d.line}` : ""}: ` : ""}${d.message}`);
      const all = [...build, ...lsp];
      return { output: untrusted("problems", truncate(all.slice(0, 80).join("\n") || "No problems", OUTPUT_TOKENS)), summary: `${all.length} problems` };
    },
  },
  {
    name: "get_build_log",
    description: "The last lines of the most recent build/run log.",
    parameters: { type: "object", properties: { lines: { type: "integer", description: "How many lines (default 80)" } } },
    approval: false,
    run: async (args) => {
      const n = Math.min(400, num(args.lines) ?? 80);
      const log = useProject.getState().build.log.slice(-n).join("\n");
      return { output: untrusted("build log", truncate(log || "The log is empty", OUTPUT_TOKENS)), summary: `Last ${n} build log lines` };
    },
  },
  {
    name: "get_logcat",
    description: "The last lines of the Android device log (Logcat).",
    parameters: { type: "object", properties: { lines: { type: "integer", description: "How many lines (default 80)" } } },
    approval: false,
    run: async (args) => {
      const n = Math.min(400, num(args.lines) ?? 80);
      const lines = useLogcat.getState().lines.slice(-n).map((l) => `${l.time} ${l.level} ${l.tag}: ${l.message}`).join("\n");
      return { output: untrusted("logcat", truncate(lines || "No Logcat lines", OUTPUT_TOKENS)), summary: `Last ${n} Logcat lines` };
    },
  },
  {
    name: "get_open_file",
    description: "The file open in the editor: its path, the cursor line and its contents.",
    parameters: { type: "object", properties: {} },
    approval: false,
    run: async () => {
      const path = useWorkspace.getState().activePath;
      if (!path) return { output: "No file is open", summary: "No open file" };
      const line = activeEditor()?.getPosition()?.lineNumber ?? 1;
      const text = (await currentText(path)).split("\n").map((l, i) => `${String(i + 1).padStart(5)}  ${l}`).join("\n");
      return { output: `Path: ${relative(path)}\nCursor at line ${line}\n${untrusted(relative(path), truncate(text, OUTPUT_TOKENS))}`, summary: relative(path) };
    },
  },
  {
    name: "get_selection",
    description: "The text selected in the editor, with its file and line range.",
    parameters: { type: "object", properties: {} },
    approval: false,
    run: async () => {
      const editor = activeEditor();
      const sel = editor?.getSelection();
      const model = editor?.getModel();
      if (!editor || !sel || !model || sel.isEmpty()) return { output: "Nothing is selected", summary: "No selection" };
      return {
        output: `${relative(model.uri.fsPath)} lines ${sel.startLineNumber}–${sel.endLineNumber}:\n${untrusted("selection", truncate(model.getValueInRange(sel), OUTPUT_TOKENS))}`,
        summary: `Selection, lines ${sel.startLineNumber}–${sel.endLineNumber}`,
      };
    },
  },
  {
    name: "edit_file",
    description: "Change part of an existing file: replaces old_text (copied exactly from the file, unique) with new_text. The user reviews the diff first.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        old_text: { type: "string", description: "Exact text to replace, including enough lines to be unique" },
        new_text: { type: "string", description: "The replacement" },
      },
      required: ["path", "old_text", "new_text"],
    },
    approval: true,
    preview: async (args) => {
      const path = resolvePath(args.path);
      const before = await currentText(path);
      return { title: `Edit ${relative(path)}`, diff: { path, before, after: replaceOnce(before, str(args.old_text), str(args.new_text)) } };
    },
    run: async (args) => {
      const path = resolvePath(args.path);
      const before = await currentText(path);
      const after = replaceOnce(before, str(args.old_text), str(args.new_text));
      await applyText(path, after);
      return { output: `Edited ${relative(path)} (not saved yet; builds save all files).`, summary: `Edited ${relative(path)}` };
    },
  },
  {
    name: "create_file",
    description: "Create a new file with the given content. Fails if the file exists. The user reviews it first.",
    parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] },
    approval: true,
    preview: async (args) => {
      const path = resolvePath(args.path);
      const exists = await fsApi.readFile(path).then(() => true, () => false);
      if (exists) throw new Error(`${relative(path)} already exists; use edit_file`);
      return { title: `Create ${relative(path)}`, diff: { path, before: "", after: str(args.content) } };
    },
    run: async (args) => {
      const path = resolvePath(args.path);
      await filesApi.create(path, false);
      await fsApi.writeFile(path, str(args.content));
      useWorkspace.getState().refreshFolders([path.slice(0, path.lastIndexOf("/"))]);
      await openAt(path);
      return { output: `Created ${relative(path)}.`, summary: `Created ${relative(path)}` };
    },
  },
  {
    name: "run_build",
    description: "Build the project with the selected scheme/module. Returns the result, diagnostics and the log tail.",
    parameters: { type: "object", properties: {} },
    approval: true,
    preview: async () => ({ title: "Build the project", detail: `Scheme: ${useProject.getState().scheme ?? "none"}` }),
    run: () => startJob("Build", () => useProject.getState().startBuild()),
  },
  {
    name: "run_app",
    description: "Build and run the app on the selected device. Returns once it's running (with its first output) or failed.",
    parameters: { type: "object", properties: {} },
    approval: true,
    preview: async () => {
      const { devices, deviceId } = useProject.getState();
      return { title: "Run the app", detail: `On ${devices.find((d) => d.id === deviceId)?.name ?? "the selected device"}` };
    },
    run: () => startJob("Run", () => useProject.getState().startRun(), true),
  },
  {
    name: "run_tests",
    description: "Run the tests: all of them, or those in the file open in the editor.",
    parameters: { type: "object", properties: { scope: { type: "string", enum: ["all", "file"] } } },
    approval: true,
    preview: async (args) => ({ title: args.scope === "file" ? "Run the tests in the open file" : "Run all tests" }),
    run: (args) => startJob("Tests", async () => void (await (args.scope === "file" ? runCurrentFile() : runAllTests()))),
  },
];

export const toolByName = (name: string) => TOOLS.find((t) => t.name === name);
export const toolNames = () => TOOLS.map((t) => t.name);

/** OpenAI-style tool definitions for the request. */
export const toolDefinitions = (android: boolean) =>
  TOOLS.filter((t) => android || t.name !== "get_logcat").map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));
