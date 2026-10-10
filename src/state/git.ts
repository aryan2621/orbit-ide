import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";
import { gitApi, GitStatus, JobExit } from "../lib/ipc";
import { useWorkspace } from "./workspace";

interface GitState {
  status: GitStatus | null;
  busy: string | null;
  syncLog: string[];
  error: string | null;
  refresh: () => Promise<void>;
  run: (label: string, fn: (repo: string) => Promise<unknown>) => Promise<boolean>;
  sync: (action: "push" | "pull" | "fetch") => Promise<void>;
}

export const useGit = create<GitState>((set, get) => ({
  status: null,
  busy: null,
  syncLog: [],
  error: null,

  refresh: async () => {
    const root = useWorkspace.getState().root;
    if (!root) return set({ status: null });
    const status = await gitApi.status(root).catch(() => null);
    if (useWorkspace.getState().root === root) set({ status });
  },

  /** Runs a git action against the repo root, then refreshes; returns whether it succeeded. */
  run: async (label, fn) => {
    const repo = get().status?.repo_root;
    if (!repo) return false;
    set({ busy: label, error: null });
    try {
      await fn(repo);
      return true;
    } catch (e) {
      set({ error: String(e) });
      return false;
    } finally {
      set({ busy: null });
      await get().refresh();
    }
  },

  sync: async (action) => {
    const repo = get().status?.repo_root;
    if (!repo || get().busy) return;
    const jobId = crypto.randomUUID();
    set({ busy: action, syncLog: [], error: null });
    const unlisten = [
      await listen<string>(`job://${jobId}/log`, (e) => set((s) => ({ syncLog: [...s.syncLog, e.payload].slice(-200) }))),
      await listen<JobExit>(`job://${jobId}/exit`, (e) => {
        unlisten.forEach((u) => u());
        const failed = e.payload.code !== 0 && !e.payload.cancelled;
        set({ busy: null, error: failed ? get().syncLog.filter((l) => /error|fatal|rejected/i.test(l)).join("\n") || `git ${action} failed` : null });
        get().refresh();
      }),
    ];
    gitApi.sync(repo, action, jobId).catch((e) => {
      unlisten.forEach((u) => u());
      set({ busy: null, error: String(e) });
    });
  },
}));

// Keep status fresh: on folder change, after saves, and when the window regains focus.
useWorkspace.subscribe((s, prev) => {
  if (s.root !== prev.root || s.treeVersion !== prev.treeVersion) useGit.getState().refresh();
  else if (s.files !== prev.files && s.files.some((f, i) => f.savedContent !== prev.files[i]?.savedContent)) {
    useGit.getState().refresh();
  }
});
window.addEventListener("focus", () => useGit.getState().refresh());
