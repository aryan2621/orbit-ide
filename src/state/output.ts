import { create } from "zustand";

const MAX_LINES = 5000;

/** The Output panel: one channel of log lines per language server (stderr and window/logMessage). */
interface OutputState {
  channels: Record<string, string[]>;
  active: string | null;
  setActive: (channel: string) => void;
  clear: (channel: string) => void;
}

export const useOutput = create<OutputState>((set) => ({
  channels: {},
  active: null,
  setActive: (active) => set({ active }),
  clear: (channel) => set((s) => ({ channels: { ...s.channels, [channel]: [] } })),
}));

let pending: Record<string, string[]> = {};
let timer: ReturnType<typeof setTimeout> | null = null;

/** Appends a line to a channel (batched, so a chatty server doesn't re-render per line). */
export function appendOutput(channel: string, line: string) {
  (pending[channel] ??= []).push(line);
  timer ??= setTimeout(() => {
    timer = null;
    const batch = pending;
    pending = {};
    useOutput.setState((s) => {
      const channels = { ...s.channels };
      for (const [name, lines] of Object.entries(batch)) channels[name] = (channels[name] ?? []).concat(lines).slice(-MAX_LINES);
      return { channels, active: s.active ?? Object.keys(channels)[0] ?? null };
    });
  }, 100);
}
