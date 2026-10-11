import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";
import { gitApi, GitStatus, JobExit } from "../lib/ipc";
import { useWorkspace } from "./workspace";
import { useUi } from "./ui";

interface GitState {
  status: GitStatus | null;
  busy: string | null;
  syncLog: string[];
  error: string | null;
  refresh: () => Promise<void>;
  /** Debounced refresh, for bursts of file changes. */
  refreshSoon: () => void;
  run: (label: string, fn: (repo: string) => Promise<unknown>) => Promise<boolean>;
  sync: (action: "push" | "pull" | "fetch") => Promise<void>;
  /** Repo-relative file whose history Source Control shows (null: the whole repo). */
  historyPath: string | null;
  /** Opens Source Control's history, for a file (absolute path) or the repo. */
  showHistory: (path: string | null) => void;
}

let refreshTimer: ReturnType<typeof setTimeout> | null = null;

export const useGit = create<GitState>((set, get) => ({
  status: null,
  busy: null,
  syncLog: [],
  error: null,
  historyPath: null,

  showHistory: (path) => {
    const repo = get().status?.repo_root;
    const rel = path && repo && path.startsWith(repo + "/") ? path.slice(repo.length + 1) : null;
    set({ historyPath: rel });
    useUi.setState({ activity: "git", showSidebar: true });
  },

  refresh: async () => {
    const root = useWorkspace.getState().root;
    if (!root) return set({ status: null });
    const status = await gitApi.status(root).catch(() => null);
    if (useWorkspace.getState().root === root) set({ status });
  },

  /** Runs a git action against the repo root, then refreshes; returns whether it succeeded. */
  refreshSoon: () => {
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => get().refresh(), 400);
  },

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
  if (s.root !== prev.root) useGit.getState().refresh();
  else if (s.treeVersion !== prev.treeVersion || s.saves !== prev.saves) useGit.getState().refreshSoon();
});
window.addEventListener("focus", () => useGit.getState().refresh());
