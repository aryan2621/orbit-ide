import { create } from "zustand";
import { fsApi } from "../lib/ipc";

export interface OpenFile {
  path: string;
  content: string;
  savedContent: string;
}

interface WorkspaceState {
  root: string | null;
  files: OpenFile[];
  activePath: string | null;
  error: string | null;
  /** Recently opened folders, newest first. */
  recent: string[];
  /** Bumped to make the file tree re-read the disk. */
  treeVersion: number;
  cursor: { line: number; column: number } | null;
  setRoot: (root: string) => void;
  refreshTree: () => void;
  setCursor: (cursor: { line: number; column: number } | null) => void;
  /** Updates open tabs after a file or folder on disk was renamed or deleted. */
  pathMoved: (from: string, to: string | null) => void;
  openFile: (path: string) => Promise<void>;
  closeFile: (path: string) => void;
  setActive: (path: string) => void;
  updateContent: (path: string, content: string) => void;
  saveActive: () => Promise<void>;
  saveAll: () => Promise<void>;
  clearError: () => void;
}

export const isDirty = (f: OpenFile) => f.content !== f.savedContent;

const RECENT_KEY = "orbit.recent";
function loadRecent(): string[] {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
  } catch {
    return [];
  }
}

export const useWorkspace = create<WorkspaceState>((set, get) => ({
  root: null,
  files: [],
  activePath: null,
  error: null,
  recent: loadRecent(),
  treeVersion: 0,
  cursor: null,

  setRoot: (root) => {
    const recent = [root, ...get().recent.filter((r) => r !== root)].slice(0, 8);
    try {
      localStorage.setItem(RECENT_KEY, JSON.stringify(recent));
    } catch {}
    set({ root, files: [], activePath: null, recent, cursor: null });
  },

  refreshTree: () => set((s) => ({ treeVersion: s.treeVersion + 1 })),

  setCursor: (cursor) => set({ cursor }),

  pathMoved: (from, to) =>
    set((s) => {
      const moved = (p: string) => p === from || p.startsWith(from + "/");
      const files = s.files
        .filter((f) => to !== null || !moved(f.path))
        .map((f) => (to !== null && moved(f.path) ? { ...f, path: to + f.path.slice(from.length) } : f));
      const activePath =
        s.activePath && moved(s.activePath)
          ? to !== null
            ? to + s.activePath.slice(from.length)
            : (files[0]?.path ?? null)
          : s.activePath;
      return { files, activePath, treeVersion: s.treeVersion + 1 };
    }),

  openFile: async (path) => {
    if (get().files.some((f) => f.path === path)) {
      set({ activePath: path });
      return;
    }
    try {
      const content = await fsApi.readFile(path);
      set((s) => ({ files: [...s.files, { path, content, savedContent: content }], activePath: path }));
    } catch (e) {
      set({ error: String(e) });
    }
  },

  closeFile: (path) =>
    set((s) => {
      const idx = s.files.findIndex((f) => f.path === path);
      const files = s.files.filter((f) => f.path !== path);
      const activePath =
        s.activePath === path ? (files[Math.min(idx, files.length - 1)]?.path ?? null) : s.activePath;
      return { files, activePath };
    }),

  setActive: (path) => set({ activePath: path }),

  updateContent: (path, content) =>
    set((s) => ({ files: s.files.map((f) => (f.path === path ? { ...f, content } : f)) })),

  saveActive: async () => {
    const file = get().files.find((f) => f.path === get().activePath);
    if (!file || !isDirty(file)) return;
    try {
      await fsApi.writeFile(file.path, file.content);
      set((s) => ({
        files: s.files.map((f) => (f.path === file.path ? { ...f, savedContent: file.content } : f)),
      }));
    } catch (e) {
      set({ error: String(e) });
    }
  },

  saveAll: async () => {
    const dirty = get().files.filter(isDirty);
    const results = await Promise.allSettled(dirty.map((f) => fsApi.writeFile(f.path, f.content)));
    const saved = new Map(dirty.filter((_, i) => results[i].status === "fulfilled").map((f) => [f.path, f.content]));
    const failed = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
    set((s) => ({
      files: s.files.map((f) => (saved.has(f.path) ? { ...f, savedContent: saved.get(f.path)! } : f)),
      error: failed ? String(failed.reason) : s.error,
    }));
  },

  clearError: () => set({ error: null }),
}));
