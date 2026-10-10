import { create } from "zustand";
import { DapClient } from "../debug/dap-client";
import { openAt } from "../editor/navigation";
import { useWorkspace } from "./workspace";
import { useUi } from "./ui";

export type DebugTarget =
  | { kind: "attach"; pid: number; program: string }
  | { kind: "launch"; program: string; cwd: string };

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

export interface ConsoleEntry {
  kind: "output" | "input" | "result" | "error";
  text: string;
}

interface DebugState {
  /** Breakpoint lines (1-based) per absolute file path. */
  breakpoints: Record<string, number[]>;
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
let client: DapClient | null = null;

function loadBreakpoints(): Record<string, number[]> {
  const root = useWorkspace.getState().root;
  if (!root) return {};
  try {
    return JSON.parse(localStorage.getItem(bpKey(root)) ?? "{}");
  } catch {
    return {};
  }
}

function persistBreakpoints(bps: Record<string, number[]>) {
  const root = useWorkspace.getState().root;
  if (!root) return;
  try {
    localStorage.setItem(bpKey(root), JSON.stringify(bps));
  } catch {}
}

async function sendBreakpoints(path: string, lines: number[]) {
  await client?.request("setBreakpoints", { source: { path }, breakpoints: lines.map((line) => ({ line })) }).catch(() => {});
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
    const lines = current.includes(line) ? current.filter((l) => l !== line) : [...current, line].sort((a, b) => a - b);
    const breakpoints = { ...get().breakpoints, [path]: lines };
    if (lines.length === 0) delete breakpoints[path];
    set({ breakpoints });
    persistBreakpoints(breakpoints);
    sendBreakpoints(path, lines);
  },

  start: async (target) => {
    await get().stop();
    const root = useWorkspace.getState().root!;
    set({ status: "starting", console: [], frames: [], scopes: [], children: {}, threadId: null, stopReason: null });
    useUi.getState().showBottomTab("debug");
    const log = (entry: ConsoleEntry) => set((s) => ({ console: [...s.console, entry].slice(-MAX_CONSOLE) }));

    try {
      const c = await DapClient.start(target.kind === "launch" ? target.cwd : root);
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
        await loadStack();
      });
      c.on("continued", () => set({ status: "running", frames: [], scopes: [], children: {}, stopReason: null }));
      c.on("terminated", () => get().stop());
      c.on("exited", (b) => log({ kind: "output", text: `Process exited with code ${b.exitCode}` }));

      await c.request("initialize", {
        clientID: "orbit",
        clientName: "Orbit",
        adapterID: "lldb-dap",
        linesStartAt1: true,
        columnsStartAt1: true,
        pathFormat: "path",
        supportsVariableType: true,
      });
      const initialized = c.once("initialized");
      const started =
        target.kind === "launch"
          ? c.request("launch", { program: target.program, cwd: target.cwd })
          : c.request("attach", { pid: target.pid, program: target.program });
      await initialized;
      for (const [path, lines] of Object.entries(get().breakpoints)) await sendBreakpoints(path, lines);
      await c.request("configurationDone");
      await started;
      if (get().status === "starting") set({ status: "running" });
    } catch (e) {
      log({ kind: "error", text: `Debugger failed: ${e instanceof Error ? e.message : e}` });
      await get().stop();
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
  const res = await client.request("stackTrace", { threadId, startFrame: 0, levels: 50 }).catch(() => null);
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

// Breakpoints belong to a folder.
useWorkspace.subscribe((s, prev) => {
  if (s.root !== prev.root) useDebug.setState({ breakpoints: loadBreakpoints() });
});
