import { create } from "zustand";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { useProject } from "./project";
import { jobApi } from "../lib/ipc";

/** One line from `adb logcat -v threadtime`, sent by android_run on `job://<id>/logcat`. */
export interface LogcatLine {
  time: string;
  pid: number;
  tid: number;
  /** V, D, I, W, E, F or A. */
  level: string;
  tag: string;
  message: string;
}

export const LEVELS = ["V", "D", "I", "W", "E"] as const;
export type Level = (typeof LEVELS)[number];

const RANK: Record<string, number> = { V: 0, D: 1, I: 2, W: 3, E: 4, F: 5, A: 5 };
const MAX_LINES = 5000;

/** "app": the running app's lines (from Run). "device": everything on the selected device. */
export type LogcatMode = "app" | "device";

interface LogcatState {
  lines: LogcatLine[];
  mode: LogcatMode;
  /** While paused, new lines are dropped so the view stays still. */
  paused: boolean;
  /** Serial of the device being followed in "device" mode. */
  deviceSerial: string | null;
  setMode: (mode: LogcatMode) => void;
  setPaused: (paused: boolean) => void;
  /** Lowest level shown. */
  minLevel: Level;
  /** Matches tag or message, case-insensitive. */
  query: string;
  setMinLevel: (level: Level) => void;
  setQuery: (query: string) => void;
  clear: () => void;
}

export const useLogcat = create<LogcatState>()((set, get) => ({
  lines: [],
  mode: "app",
  paused: false,
  deviceSerial: null,
  setMode: (mode) => {
    if (mode === get().mode) return;
    set({ mode, lines: [], paused: false });
    if (mode === "device") followDevice();
    else stopDevice();
  },
  setPaused: (paused) => set({ paused }),
  minLevel: "V",
  query: "",
  setMinLevel: (minLevel) => set({ minLevel }),
  setQuery: (query) => set({ query }),
  clear: () => set({ lines: [] }),
}));

export function filterLines(lines: LogcatLine[], minLevel: Level, query: string): LogcatLine[] {
  const q = query.trim().toLowerCase();
  return lines.filter(
    (l) =>
      (RANK[l.level] ?? 0) >= RANK[minLevel] &&
      (!q || l.tag.toLowerCase().includes(q) || l.message.toLowerCase().includes(q)),
  );
}

// Follow the current run job: each new run starts a fresh Logcat. Plain builds and archives
// don't produce Logcat, so they leave the last run's lines in place.
let unlisten: UnlistenFn | null = null;
let followed: string | null = null;
let pending: LogcatLine[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
/** Rust already sends batches every 100 ms; this also coalesces batches into one render. */
function flush() {
  flushTimer = null;
  const batch = pending;
  pending = [];
  if (batch.length && !useLogcat.getState().paused)
    useLogcat.setState((st) => ({ lines: st.lines.concat(batch).slice(-MAX_LINES) }));
}
function queue(lines: LogcatLine[]) {
  pending.push(...lines);
  flushTimer ??= setTimeout(flush, 100);
}

// "device" mode: a job streaming the selected device's whole Logcat.
let deviceJob: string | null = null;
let deviceUnlisten: UnlistenFn | null = null;
function stopDevice() {
  if (deviceJob) jobApi.cancel(deviceJob);
  deviceJob = null;
  deviceUnlisten?.();
  deviceUnlisten = null;
  useLogcat.setState({ deviceSerial: null });
}
async function followDevice() {
  stopDevice();
  const { deviceId, devices } = useProject.getState();
  const device = devices.find((d) => d.id === deviceId);
  if (!device || !device.booted || device.id.startsWith("avd:")) {
    useLogcat.setState({ deviceSerial: null });
    return;
  }
  const jobId = crypto.randomUUID();
  deviceJob = jobId;
  useLogcat.setState({ deviceSerial: device.id });
  const off = await listen<LogcatLine[]>(`job://${jobId}/logcat`, (e) => queue(e.payload));
  if (deviceJob !== jobId) return off();
  deviceUnlisten = off;
  await invoke("android_logcat", { serial: device.id, jobId }).catch(() => stopDevice());
}
// Follow the device picker while in device mode.
useProject.subscribe((s, prev) => {
  if (useLogcat.getState().mode === "device" && (s.deviceId !== prev.deviceId || s.devices !== prev.devices)) {
    const d = s.devices.find((x) => x.id === s.deviceId);
    const want = d?.booted && !d.id.startsWith("avd:") ? d.id : null;
    if (want !== useLogcat.getState().deviceSerial) followDevice();
  }
});
useProject.subscribe((s) => {
  const { jobId, action } = s.build;
  if (jobId === followed || (action !== "run" && action !== "debug")) return;
  followed = jobId;
  unlisten?.();
  unlisten = null;
  if (!jobId) return;
  if (useLogcat.getState().mode === "app") {
    pending = [];
    useLogcat.setState({ lines: [] });
  }
  listen<LogcatLine[]>(`job://${jobId}/logcat`, (e) => {
    if (useLogcat.getState().mode === "app") queue(e.payload);
  }).then((fn) => {
    if (followed === jobId) unlisten = fn;
    else fn();
  });
});
