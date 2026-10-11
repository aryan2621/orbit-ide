import { create } from "zustand";
import { DapClient } from "../debug/dap-client";
import { openAt } from "../editor/navigation";
import { useWorkspace } from "./workspace";
import { useUi } from "./ui";
import { useProject } from "./project";
import { errorText, logWrite } from "../lib/log";

export type DebugTarget =
  | { kind: "attach"; pid: number; program: string }
  | { kind: "launch"; program: string; cwd: string }
  /** Android: kotlin-debug-adapter attaching to the app's forwarded JDWP port. */
  | { kind: "jvm"; program: string; args: string[]; projectRoot: string; hostName: string; port: number };

export type SessionStatus = "idle" | "starting" | "running" | "paused" | "ended";

export interface Frame {
  id: number;
  name: string;
  path: string | null;
  line: number;
  column: number;
}

export interface Variable {
  name: string;
  value: string;
  type?: string;
  ref: number;
}

export interface Scope {
  name: string;
  ref: number;
  expensive: boolean;
}

export interface Breakpoint {
  /** 1-based. */
  line: number;
  /** Only stop when this expression is true. */
  condition?: string;
  /** Logpoint: print this (with `{expressions}`) instead of stopping. */
  logMessage?: string;
  enabled: boolean;
}

export interface ExceptionFilter {
  filter: string;
  label: string;
  default?: boolean;
}

export interface ConsoleEntry {
  kind: "output" | "input" | "result" | "error";
  text: string;
}

interface DebugState {
  /** Breakpoints per absolute file path, sorted by line. */
  breakpoints: Record<string, Breakpoint[]>;
  /** Exception breakpoint kinds the current debug adapter offers, and which are on. */
  exceptionFilters: ExceptionFilter[];
  enabledExceptions: string[];
  /** Watch expressions (per folder) and their values in the selected frame. */
  watches: string[];
  watchValues: Record<string, string>;
  threads: { id: number; name: string }[];
  status: SessionStatus;
  threadId: number | null;
  frames: Frame[];
  frameId: number | null;
  scopes: Scope[];
  /** Loaded children per variablesReference (scopes and expanded variables). */
  children: Record<number, Variable[]>;
  console: ConsoleEntry[];
  stopReason: string | null;
  toggleBreakpoint: (path: string, line: number) => void;
  /** Adds or edits the breakpoint on `line` (`null` removes it). */
  setBreakpoint: (path: string, line: number, patch: Partial<Breakpoint> | null) => void;
  toggleException: (filter: string) => void;
  addWatch: (expression: string) => void;
  removeWatch: (expression: string) => void;
  selectThread: (id: number) => Promise<void>;
  /** Edits shifted breakpoints: old line → new line (lines that merge keep one breakpoint). */
  moveBreakpoints: (path: string, moved: Map<number, number>) => void;
  /** A file or folder was renamed (`to`) or deleted (`null`). */
  breakpointsPathMoved: (from: string, to: string | null) => void;
  start: (target: DebugTarget) => Promise<void>;
  stop: () => Promise<void>;
  resume: () => void;
  pause: () => void;
  stepOver: () => void;
  stepInto: () => void;
  stepOut: () => void;
  selectFrame: (id: number) => Promise<void>;
  loadChildren: (ref: number) => Promise<void>;
  evaluate: (expression: string) => Promise<void>;
  /** Called by the project store when a debug run's job ends (app exited or cancelled). */
  onJobEnded: () => void;
}

const MAX_CONSOLE = 3000;
const bpKey = (root: string) => `orbit.breakpoints:${root}`;
const watchKey = (root: string) => `orbit.watches:${root}`;
const EXCEPTIONS_KEY = "orbit.exceptionBreakpoints";
let client: DapClient | null = null;

function loadBreakpoints(): Record<string, Breakpoint[]> {
  const root = useWorkspace.getState().root;
  if (!root) return {};
  try {
    const raw: Record<string, (number | Breakpoint)[]> = JSON.parse(localStorage.getItem(bpKey(root)) ?? "{}");
    // Older versions stored bare line numbers.
    return Object.fromEntries(
      Object.entries(raw).map(([path, list]) => [path, list.map((b) => (typeof b === "number" ? { line: b, enabled: true } : b))]),
    );
  } catch {
    return {};
  }
}

function loadList(key: string | null): string[] {
  if (!key) return [];
  try {
    const v = JSON.parse(localStorage.getItem(key) ?? "[]");
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function stored(key: string): boolean {
  try {
    return localStorage.getItem(key) !== null;
  } catch {
    return false;
  }
}

function saveList(key: string, list: string[]) {
  try {
    localStorage.setItem(key, JSON.stringify(list));
  } catch {}
}

function persistBreakpoints(bps: Record<string, Breakpoint[]>) {
  const root = useWorkspace.getState().root;
  if (!root) return;
  try {
    localStorage.setItem(bpKey(root), JSON.stringify(bps));
  } catch {}
}

async function sendBreakpoints(path: string, list: Breakpoint[]) {
  // kotlin-debug-adapter needs `name` (it throws without it); lldb-dap ignores it.
  const name = path.split("/").pop();
  const breakpoints = list
    .filter((b) => b.enabled)
    .map((b) => ({ line: b.line, condition: b.condition || undefined, logMessage: b.logMessage || undefined }));
  await client?.request("setBreakpoints", { source: { path, name }, breakpoints }).catch((e) => logWrite("warn", `setBreakpoints ${path}: ${errorText(e)}`));
}

async function sendExceptionBreakpoints() {
  const { exceptionFilters, enabledExceptions } = useDebug.getState();
  if (!client || exceptionFilters.length === 0) return;
  const filters = exceptionFilters.map((f) => f.filter).filter((f) => enabledExceptions.includes(f));
  await client.request("setExceptionBreakpoints", { filters }).catch((e) => logWrite("warn", `setExceptionBreakpoints: ${errorText(e)}`));
}

async function evaluateWatches() {
  const { watches, frameId } = useDebug.getState();
  if (!client || frameId === null) return useDebug.setState({ watchValues: {} });
  const values: Record<string, string> = {};
  await Promise.all(
    watches.map(async (expression) => {
      try {
        const res = await client!.request("evaluate", { expression, frameId, context: "watch" });
        values[expression] = res?.result ?? "";
      } catch (e) {
        values[expression] = e instanceof Error ? e.message : String(e);
      }
    }),
  );
  useDebug.setState({ watchValues: values });
}

/** Replaces a file's breakpoints (sorted, one per line), saves and sends them. */
function setList(path: string, list: Breakpoint[]) {
  const byLine = new Map<number, Breakpoint>();
  for (const b of list) if (!byLine.has(b.line)) byLine.set(b.line, b);
  const unique = [...byLine.values()].sort((a, b) => a.line - b.line);
  const breakpoints = { ...useDebug.getState().breakpoints, [path]: unique };
  if (unique.length === 0) delete breakpoints[path];
  useDebug.setState({ breakpoints });
  persistBreakpoints(breakpoints);
  sendBreakpoints(path, unique);
}

const step = (command: string) => () => {
  const { threadId } = useDebug.getState();
  if (client && threadId !== null) {
    useDebug.setState({ status: "running", frames: [], scopes: [], children: {} });
    client.request(command, { threadId }).catch(() => {});
  }
};

export const useDebug = create<DebugState>((set, get) => ({
  breakpoints: loadBreakpoints(),
  exceptionFilters: [],
  enabledExceptions: loadList(EXCEPTIONS_KEY),
  watches: loadList(useWorkspace.getState().root && watchKey(useWorkspace.getState().root!)),
  watchValues: {},
  threads: [],
  status: "idle",
  threadId: null,
  frames: [],
  frameId: null,
  scopes: [],
  children: {},
  console: [],
  stopReason: null,

  toggleBreakpoint: (path, line) => {
    const current = get().breakpoints[path] ?? [];
    setList(path, current.some((b) => b.line === line) ? current.filter((b) => b.line !== line) : [...current, { line, enabled: true }]);
  },

  setBreakpoint: (path, line, patch) => {
    const current = get().breakpoints[path] ?? [];
    const existing = current.find((b) => b.line === line) ?? { line, enabled: true };
    const others = current.filter((b) => b.line !== line);
    setList(path, patch === null ? others : [...others, { ...existing, ...patch, line }]);
  },

  moveBreakpoints: (path, moved) => {
    setList(path, (get().breakpoints[path] ?? []).map((b) => ({ ...b, line: moved.get(b.line) ?? b.line })));
  },

  toggleException: (filter) => {
    const on = get().enabledExceptions;
    const enabledExceptions = on.includes(filter) ? on.filter((f) => f !== filter) : [...on, filter];
    set({ enabledExceptions });
    saveList(EXCEPTIONS_KEY, enabledExceptions);
    sendExceptionBreakpoints();
  },

  addWatch: (expression) => {
    const root = useWorkspace.getState().root;
    if (!expression.trim() || get().watches.includes(expression.trim())) return;
    const watches = [...get().watches, expression.trim()];
    set({ watches });
    if (root) saveList(watchKey(root), watches);
    evaluateWatches();
  },

  removeWatch: (expression) => {
    const root = useWorkspace.getState().root;
    const watches = get().watches.filter((w) => w !== expression);
    set({ watches });
    if (root) saveList(watchKey(root), watches);
  },

  selectThread: async (id) => {
    set({ threadId: id, frames: [], scopes: [], children: {} });
    await loadStack();
  },

  breakpointsPathMoved: (from, to) => {
    const breakpoints: Record<string, Breakpoint[]> = {};
    const changed: string[] = [];
    for (const [path, list] of Object.entries(get().breakpoints)) {
      if (path !== from && !path.startsWith(from + "/")) breakpoints[path] = list;
      else {
        changed.push(path);
        if (to !== null) breakpoints[to + path.slice(from.length)] = list;
      }
    }
    if (changed.length === 0) return;
    set({ breakpoints });
    persistBreakpoints(breakpoints);
  },

  start: async (target) => {
    await get().stop();
    const root = useWorkspace.getState().root!;
    set({ status: "starting", console: [], frames: [], scopes: [], children: {}, threadId: null, stopReason: null });
    useUi.getState().showActivity("debug");
    useUi.getState().showBottomTab("debug");
    const log = (entry: ConsoleEntry) => set((s) => ({ console: [...s.console, entry].slice(-MAX_CONSOLE) }));

    // If the debugger can't attach, the app stays frozen waiting for it: give up after a minute.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("the debugger didn't attach within 60 seconds")), 60_000);
    });
    try {
      await Promise.race([attach(target, root, log), timeout]);
      if (get().status === "starting") set({ status: "running" });
    } catch (e) {
      log({ kind: "error", text: `Debugger failed: ${e instanceof Error ? e.message : e}` });
      await get().stop();
      // Stop the run too: an app started with "wait for debugger" would otherwise hang forever.
      if (target.kind !== "launch") useProject.getState().cancelBuild();
    } finally {
      clearTimeout(timer);
    }
  },

  stop: async () => {
    const c = client;
    client = null;
    if (c) {
      set({ status: "ended", frames: [], scopes: [], children: {}, threadId: null });
      await c.stop();
    }
  },

  resume: step("continue"),
  stepOver: step("next"),
  stepInto: step("stepIn"),
  stepOut: step("stepOut"),
  pause: () => {
    const { threadId } = get();
    client?.request("pause", { threadId: threadId ?? 0 }).catch(() => {});
  },

  selectFrame: async (id) => {
    set({ frameId: id, scopes: [], children: {} });
    const frame = get().frames.find((f) => f.id === id);
    if (frame?.path) openAt(frame.path, { lineNumber: frame.line, column: frame.column || 1 });
    const res = await client?.request("scopes", { frameId: id }).catch(() => null);
    const scopes: Scope[] = (res?.scopes ?? [])
      .filter((s: any) => s.name !== "Registers")
      .map((s: any) => ({ name: s.name, ref: s.variablesReference, expensive: !!s.expensive }));
    set({ scopes });
    evaluateWatches();
    // Expand the first (Locals) scope automatically.
    if (scopes[0]) await get().loadChildren(scopes[0].ref);
  },

  loadChildren: async (ref) => {
    if (get().children[ref]) return;
    const res = await client?.request("variables", { variablesReference: ref }).catch(() => null);
    const vars: Variable[] = (res?.variables ?? []).map((v: any) => ({
      name: v.name,
      value: v.value,
      type: v.type,
      ref: v.variablesReference ?? 0,
    }));
    set((s) => ({ children: { ...s.children, [ref]: vars } }));
  },

  evaluate: async (expression) => {
    const add = (entry: ConsoleEntry) => set((s) => ({ console: [...s.console, entry].slice(-MAX_CONSOLE) }));
    add({ kind: "input", text: expression });
    if (!client) {
      add({ kind: "error", text: "Not debugging" });
      return;
    }
    try {
      const res = await client.request("evaluate", { expression, frameId: get().frameId ?? undefined, context: "repl" });
      if (res?.result) add({ kind: "result", text: res.result });
    } catch (e) {
      add({ kind: "error", text: e instanceof Error ? e.message : String(e) });
    }
  },

  onJobEnded: () => {
    if (get().status === "starting") return; // package debug: the build job ends before the session starts
    get().stop();
  },
}));

async function loadStack() {
  const { threadId } = useDebug.getState();
  if (!client || threadId === null) return;
  const res = await client.request("stackTrace", { threadId, startFrame: 0, levels: 50 }).catch((e) => (logWrite("warn", `stackTrace: ${errorText(e)}`), null));
  const frames: Frame[] = (res?.stackFrames ?? []).map((f: any) => ({
    id: f.id,
    name: f.name,
    path: f.source?.path ?? null,
    line: f.line,
    column: f.column,
  }));
  useDebug.setState({ frames });
  // Select the first frame that has source code (skips system frames without files).
  const first = frames.find((f) => f.path) ?? frames[0];
  if (first) await useDebug.getState().selectFrame(first.id);
}

// Breakpoints and watches belong to a folder.
useWorkspace.subscribe((s, prev) => {
  if (s.root !== prev.root) useDebug.setState({ breakpoints: loadBreakpoints(), watches: loadList(s.root && watchKey(s.root)) });
});

/** Starts the debug adapter for `target`, attaches/launches, and sends breakpoints. */
async function attach(target: DebugTarget, root: string, log: (entry: ConsoleEntry) => void) {
  const { getState: get, setState: set } = useDebug;
  const c =
    target.kind === "jvm"
      ? await DapClient.start(target.projectRoot, { program: target.program, args: target.args })
      : await DapClient.start(target.kind === "launch" ? target.cwd : root);
  client = c;
  c.onExit = () => {
    if (client === c) {
      client = null;
      set({ status: "ended", frames: [], scopes: [] });
    }
  };
  c.on("output", (b) => {
    if (b.category === "telemetry") return;
    const text = String(b.output ?? "").replace(/\r?\n$/, "");
    if (text) log({ kind: b.category === "stderr" ? "error" : "output", text });
  });
  c.on("stopped", async (b) => {
    set({ status: "paused", threadId: b.threadId ?? get().threadId, stopReason: b.description ?? b.reason ?? null });
    c.request("threads")
      .then((res) => set({ threads: (res?.threads ?? []).map((t: any) => ({ id: t.id, name: t.name })) }))
      .catch(() => {});
    await loadStack();
  });
  c.on("continued", () => set({ status: "running", frames: [], scopes: [], children: {}, stopReason: null, watchValues: {} }));
  c.on("terminated", () => get().stop());
  c.on("exited", (b) => log({ kind: "output", text: `Process exited with code ${b.exitCode}` }));

  const capabilities = await c.request("initialize", {
    clientID: "orbit",
    clientName: "Orbit",
    adapterID: target.kind === "jvm" ? "kotlin" : "lldb-dap",
    linesStartAt1: true,
    columnsStartAt1: true,
    pathFormat: "path",
    supportsVariableType: true,
  });
  const initialized = c.once("initialized");
  // Don't await launch/attach before configurationDone: kotlin-debug-adapter only answers
  // attach once the JVM connection is up, which happens after configurationDone.
  const started =
    target.kind === "launch"
      ? c.request("launch", { program: target.program, cwd: target.cwd })
      : target.kind === "jvm"
        ? c.request("attach", { projectRoot: target.projectRoot, hostName: target.hostName, port: target.port, timeout: 30000 })
        : c.request("attach", { pid: target.pid, program: target.program });
  const filters: ExceptionFilter[] = capabilities?.exceptionBreakpointFilters ?? [];
  // First time with this adapter: start with its default filters on.
  if (!stored(EXCEPTIONS_KEY)) set({ enabledExceptions: filters.filter((f) => f.default).map((f) => f.filter) });
  set({ exceptionFilters: filters });
  await initialized;
  for (const [path, list] of Object.entries(get().breakpoints)) await sendBreakpoints(path, list);
  await sendExceptionBreakpoints();
  await c.request("configurationDone");
  await started;
}
