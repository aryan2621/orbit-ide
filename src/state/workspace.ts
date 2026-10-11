import { create } from "zustand";
import * as monaco from "monaco-editor";
import { fsApi } from "../lib/ipc";
import { languageForPath, modelUri } from "../editor/monaco-setup";

/** An open tab. Its text lives in the Monaco model (see `fileText`), not in the store, so typing
 * doesn't copy the whole file on every keystroke. */
export interface OpenFile {
  path: string;
  /** The model differs from the last load/save (by Monaco's alternative version id, so undoing
   * back to the saved text clears it). */
  dirty: boolean;
}

/** Path → the model's alternative version id at the last load or save. */
const savedVersions = new Map<string, number>();
/** Path → the text last read from or written to disk (to tell our own saves from outside edits). */
const savedTexts = new Map<string, string>();

export const fileText = (path: string) => monaco.editor.getModel(modelUri(path))?.getValue() ?? null;
export const savedText = (path: string) => savedTexts.get(path) ?? null;

/** Gets or creates the model for a file that's being opened, refreshing a leftover model (e.g. a
 * go-to-definition peek) with the disk text. */
export function ensureFileModel(path: string, text: string) {
  const model = monaco.editor.getModel(modelUri(path));
  if (!model) return monaco.editor.createModel(text, languageForPath(path), modelUri(path));
  if (model.getValue() !== text) model.setValue(text);
  return model;
}

/** Records `text` as what's on disk for `path` and the model's current state as saved. */
export function markSaved(path: string, text: string) {
  savedTexts.set(path, text);
  const model = monaco.editor.getModel(modelUri(path));
  if (model) savedVersions.set(path, model.getAlternativeVersionId());
  syncDirty(path);
}

/** Recomputes a tab's dirty flag from its model; only touches the store when it flips. */
export function syncDirty(path: string) {
  const model = monaco.editor.getModel(modelUri(path));
  const dirty = !!model && model.getAlternativeVersionId() !== savedVersions.get(path);
  const { files } = useWorkspace.getState();
  if (files.some((f) => f.path === path && f.dirty !== dirty)) {
    useWorkspace.setState({ files: files.map((f) => (f.path === path ? { ...f, dirty } : f)) });
  }
}

/** Moves the saved state of `from` (a file or folder) to `to`; a moved dirty file stays dirty. */
export function moveSavedState(from: string, to: string | null) {
  for (const map of [savedVersions, savedTexts] as Map<string, unknown>[]) {
    for (const [path, value] of [...map]) {
      if (path !== from && !path.startsWith(from + "/")) continue;
      map.delete(path);
      if (to !== null) map.set(to + path.slice(from.length), value);
    }
  }
}

/** Sets a moved model's saved version: its new model starts fresh, so keep it dirty if it was. */
export function setSavedVersion(path: string, version: number) {
  savedVersions.set(path, version);
}

/** A column of tabs in the editor area (one, or two when split). */
export interface EditorGroup {
  paths: string[];
  active: string | null;
}

interface WorkspaceState {
  root: string | null;
  /** Every open file (across groups), with its dirty flag. */
  files: OpenFile[];
  /** The focused group's active file. */
  activePath: string | null;
  groups: EditorGroup[];
  /** Index of the focused group. */
  focused: number;
  error: string | null;
  /** Recently opened folders, newest first. */
  recent: string[];
  /** Bumped to make the file tree re-read the disk. */
  treeVersion: number;
  /** Per-folder versions: bumping one re-reads only that folder (outside changes). */
  folderVersions: Record<string, number>;
  refreshFolders: (folders: string[]) => void;
  cursor: { line: number; column: number } | null;
  setRoot: (root: string) => void;
  refreshTree: () => void;
  setCursor: (cursor: { line: number; column: number } | null) => void;
  /** Updates open tabs after a file or folder on disk was renamed or deleted. */
  pathMoved: (from: string, to: string | null) => void;
  openFile: (path: string) => Promise<void>;
  closeFile: (path: string) => void;
  setActive: (path: string) => void;
  /** Closes a tab in one group; the file stays open if another group shows it. */
  closeInGroup: (path: string, group: number) => void;
  focusGroup: (group: number) => void;
  /** ⌘\: opens the active file in a second group (or focuses the other group when split). */
  splitEditor: () => void;
  /** Moves (or with `copy`, opens) a tab in another group, splitting if needed. */
  moveToGroup: (path: string, from: number, to: number, copy?: boolean) => void;
  /** Bumped after every successful save (Git status listens). */
  saves: number;
  saveActive: () => Promise<void>;
  saveAll: () => Promise<void>;
  clearError: () => void;
}

export const isDirty = (f: OpenFile) => f.dirty;

type Groups = Pick<WorkspaceState, "files" | "groups" | "focused" | "activePath">;

/** Keeps groups consistent with `files`: every file in a group, no empty second group, valid
 * actives, and `activePath` = the focused group's active file. */
function normalize<T extends Groups>(s: T): T {
  const open = new Set(s.files.map((f) => f.path));
  let groups = s.groups.map((g) => ({ ...g, paths: g.paths.filter((p) => open.has(p)) }));
  let focused = Math.min(s.focused, groups.length - 1);
  const shown = new Set(groups.flatMap((g) => g.paths));
  const orphans = s.files.map((f) => f.path).filter((p) => !shown.has(p));
  if (orphans.length) groups[focused] = { ...groups[focused], paths: [...groups[focused].paths, ...orphans] };
  if (groups.length > 1) {
    const kept = groups.filter((g) => g.paths.length > 0);
    if (kept.length < groups.length) {
      focused = kept.length ? Math.min(kept.indexOf(groups[focused]) === -1 ? 0 : kept.indexOf(groups[focused]), kept.length - 1) : 0;
      groups = kept.length ? kept : [{ paths: [], active: null }];
    }
  }
  groups = groups.map((g) => (g.active && g.paths.includes(g.active) ? g : { ...g, active: g.paths[g.paths.length - 1] ?? null }));
  return { ...s, groups, focused, activePath: groups[focused].active };
}

/** Removes `path` from a group, activating its neighbour when it was the active tab. */
function without(g: EditorGroup, path: string): EditorGroup {
  const idx = g.paths.indexOf(path);
  if (idx === -1) return g;
  const paths = g.paths.filter((p) => p !== path);
  return { paths, active: g.active === path ? (paths[Math.min(idx, paths.length - 1)] ?? null) : g.active };
}

const RECENT_KEY = "orbit.recent";
function loadRecent(): string[] {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
  } catch {
    return [];
  }
}

/** Writes the model's text to disk; the version saved is the one read, even if typing continues. */
async function saveFile(path: string) {
  const model = monaco.editor.getModel(modelUri(path));
  if (!model) return;
  const text = model.getValue();
  const version = model.getAlternativeVersionId();
  await fsApi.writeFile(path, text);
  savedTexts.set(path, text);
  savedVersions.set(path, version);
  syncDirty(path);
}

export const useWorkspace = create<WorkspaceState>((set, get) => ({
  root: null,
  files: [],
  activePath: null,
  groups: [{ paths: [], active: null }],
  focused: 0,
  error: null,
  recent: loadRecent(),
  treeVersion: 0,
  folderVersions: {},
  cursor: null,
  saves: 0,

  setRoot: (root) => {
    const recent = [root, ...get().recent.filter((r) => r !== root)].slice(0, 8);
    try {
      localStorage.setItem(RECENT_KEY, JSON.stringify(recent));
    } catch {}
    // The old folder's files were saved or discarded by now; drop their models too.
    monaco.editor.getModels().filter((m) => m.uri.scheme === "file").forEach((m) => m.dispose());
    savedVersions.clear();
    savedTexts.clear();
    set({ root, files: [], activePath: null, groups: [{ paths: [], active: null }], focused: 0, recent, cursor: null });
  },

  refreshTree: () => set((s) => ({ treeVersion: s.treeVersion + 1 })),

  refreshFolders: (folders) =>
    set((s) => {
      const folderVersions = { ...s.folderVersions };
      for (const f of folders) folderVersions[f] = (folderVersions[f] ?? 0) + 1;
      return { folderVersions };
    }),

  setCursor: (cursor) => set({ cursor }),

  pathMoved: (from, to) =>
    set((s) => {
      const moved = (p: string) => p === from || p.startsWith(from + "/");
      const map = (p: string) => (to !== null && moved(p) ? to + p.slice(from.length) : p);
      const files = s.files.filter((f) => to !== null || !moved(f.path)).map((f) => ({ ...f, path: map(f.path) }));
      let groups = s.groups.map((g) => ({ paths: g.paths.map(map), active: g.active && map(g.active) }));
      if (to === null) for (const p of s.files.map((f) => f.path).filter(moved)) groups = groups.map((g) => without(g, p));
      return { ...normalize({ ...s, files, groups }), treeVersion: s.treeVersion + 1 };
    }),

  openFile: async (path) => {
    if (get().files.some((f) => f.path === path)) {
      get().setActive(path);
      return;
    }
    try {
      const content = await fsApi.readFile(path);
      if (get().files.some((f) => f.path === path)) return get().setActive(path);
      ensureFileModel(path, content);
      set((s) => {
        const groups = s.groups.map((g, i) => (i === s.focused ? { paths: [...g.paths, path], active: path } : g));
        return normalize({ ...s, files: [...s.files, { path, dirty: false }], groups });
      });
      markSaved(path, content);
    } catch (e) {
      set({ error: String(e) });
    }
  },

  closeFile: (path) =>
    set((s) => normalize({ ...s, files: s.files.filter((f) => f.path !== path), groups: s.groups.map((g) => without(g, path)) })),

  closeInGroup: (path, group) =>
    set((s) => {
      const groups = s.groups.map((g, i) => (i === group ? without(g, path) : g));
      const stillShown = groups.some((g) => g.paths.includes(path));
      return normalize({ ...s, groups, files: stillShown ? s.files : s.files.filter((f) => f.path !== path) });
    }),

  setActive: (path) =>
    set((s) => {
      // Prefer the focused group; then a group already showing the file; else open it in the focused one.
      const focusedHas = s.groups[s.focused].paths.includes(path);
      const other = s.groups.findIndex((g) => g.paths.includes(path));
      const focused = focusedHas || other === -1 ? s.focused : other;
      const groups = s.groups.map((g, i) => (i === focused ? { paths: g.paths.includes(path) ? g.paths : [...g.paths, path], active: path } : g));
      return normalize({ ...s, groups, focused });
    }),

  focusGroup: (group) => set((s) => (group === s.focused || !s.groups[group] ? s : normalize({ ...s, focused: group }))),

  splitEditor: () => {
    const s = get();
    if (s.groups.length > 1) return set(normalize({ ...s, focused: 1 - s.focused }));
    if (s.activePath) get().moveToGroup(s.activePath, 0, 1, true);
  },

  moveToGroup: (path, from, to, copy = false) =>
    set((s) => {
      let groups = s.groups.map((g) => ({ ...g }));
      if (to >= groups.length) {
        if (groups.length > 1) return s;
        groups.push({ paths: [], active: null });
        to = 1;
      }
      if (from === to) return s;
      if (!copy) groups[from] = without(groups[from], path);
      groups[to] = { paths: groups[to].paths.includes(path) ? groups[to].paths : [...groups[to].paths, path], active: path };
      // Moving the only tab out of a group closes that group; normalize keeps focus on the destination.
      return normalize({ ...s, groups, focused: to });
    }),

  saveActive: async () => {
    const file = get().files.find((f) => f.path === get().activePath);
    if (!file || !isDirty(file)) return;
    try {
      await saveFile(file.path);
      set((s) => ({ saves: s.saves + 1 }));
    } catch (e) {
      set({ error: String(e) });
    }
  },

  saveAll: async () => {
    const dirty = get().files.filter(isDirty);
    const results = await Promise.allSettled(dirty.map((f) => saveFile(f.path)));
    const failed = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
    set((s) => ({ saves: s.saves + 1, error: failed ? String(failed.reason) : s.error }));
  },

  clearError: () => set({ error: null }),
}));

// Writers outside this file (session restore) only set `files` / `activePath`: fold those into the groups.
useWorkspace.subscribe((s, prev) => {
  if (s.files === prev.files && s.activePath === prev.activePath) return;
  const g = s.groups[s.focused];
  const shown = new Set(s.groups.flatMap((x) => x.paths));
  const consistent = s.activePath === g.active && s.files.every((f) => shown.has(f.path)) && s.groups.every((x) => x.paths.every((p) => s.files.some((f) => f.path === p)));
  if (consistent) return;
  if (s.activePath && s.activePath !== g.active && s.files.some((f) => f.path === s.activePath)) {
    s.setActive(s.activePath);
  } else {
    useWorkspace.setState(normalize(s));
  }
});
