import { create } from "zustand";
import { useWorkspace } from "./workspace";

export interface EditorSettings {
  fontSize: number;
  tabSize: number;
  wordWrap: boolean;
  minimap: boolean;
  formatOnSave: boolean;
  /** Parameter names and inferred types shown inline (from the language server). */
  inlayHints: boolean;
  /** Editor font; empty for the system monospace font. */
  fontFamily: string;
  autoSave: AutoSave;
}

export type AutoSave = "off" | "afterDelay" | "onFocusChange";
export const DEFAULT_FONT = "ui-monospace, 'SF Mono', SFMono-Regular, Menlo, Consolas, monospace";
/** The editor's font stack: the chosen font first, the system monospace font as a fallback. */
export const editorFont = (family: string) => (family.trim() ? `${/[\s,'"]/.test(family.trim()) && !family.includes(",") ? `'${family.trim()}'` : family.trim()}, ${DEFAULT_FONT}` : DEFAULT_FONT);

export type SettingsScope = "global" | "project";

const KEY = "orbit.settings";
const PROJECT_KEY = "orbit.settings.project";
const DEFAULTS: EditorSettings = { fontSize: 13, tabSize: 4, wordWrap: false, minimap: true, formatOnSave: false, inlayHints: true, fontFamily: "", autoSave: "off" };

const clampInt = (v: unknown, min: number, max: number) =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : undefined;

/** Keeps only known keys with valid values (stored JSON may be stale or hand-edited). */
function sanitize(raw: unknown): Partial<EditorSettings> {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const out: Partial<EditorSettings> = {
    fontSize: clampInt(r.fontSize, 9, 28),
    tabSize: clampInt(r.tabSize, 1, 8),
  };
  for (const k of ["wordWrap", "minimap", "formatOnSave", "inlayHints"] as const) if (typeof r[k] === "boolean") out[k] = r[k];
  if (typeof r.fontFamily === "string") out.fontFamily = r.fontFamily.replace(/[;{}]/g, "").slice(0, 120);
  if (r.autoSave === "off" || r.autoSave === "afterDelay" || r.autoSave === "onFocusChange") out.autoSave = r.autoSave;
  for (const k of Object.keys(out) as (keyof EditorSettings)[]) if (out[k] === undefined) delete out[k];
  return out;
}

function read(key: string): Partial<EditorSettings> {
  try {
    return sanitize(JSON.parse(localStorage.getItem(key) ?? "{}"));
  } catch {
    return {};
  }
}

function write(key: string, values: Partial<EditorSettings>) {
  try {
    if (Object.keys(values).length) localStorage.setItem(key, JSON.stringify(values));
    else localStorage.removeItem(key);
  } catch {}
}

const projectKey = (root: string) => `${PROJECT_KEY}:${root}`;

interface SettingsState extends EditorSettings {
  /** Settings for all projects. */
  global: EditorSettings;
  /** Overrides for the open folder only. */
  project: Partial<EditorSettings>;
  update: (patch: Partial<EditorSettings>, scope?: SettingsScope) => void;
  /** Global: back to defaults. Project: drops all overrides. */
  reset: (scope?: SettingsScope) => void;
  /** Removes one project override so the global value applies again. */
  clearOverride: (key: keyof EditorSettings) => void;
}

/** The top-level fields are the effective values (global + project overrides). */
export const useSettings = create<SettingsState>((set, get) => {
  const global = { ...DEFAULTS, ...read(KEY) };
  const root = useWorkspace.getState().root;
  const project = root ? read(projectKey(root)) : {};

  const apply = (global: EditorSettings, project: Partial<EditorSettings>) => {
    set({ ...global, ...project, global, project });
    write(KEY, global);
    const root = useWorkspace.getState().root;
    if (root) write(projectKey(root), project);
  };

  return {
    ...global,
    ...project,
    global,
    project,
    update: (patch, scope = "global") => {
      const clean = sanitize({ ...get()[scope === "global" ? "global" : "project"], ...patch });
      if (scope === "global") apply({ ...DEFAULTS, ...clean }, get().project);
      else if (useWorkspace.getState().root) apply(get().global, clean);
    },
    reset: (scope = "global") => (scope === "global" ? apply(DEFAULTS, get().project) : apply(get().global, {})),
    clearOverride: (key) => {
      const { [key]: _removed, ...rest } = get().project;
      apply(get().global, rest);
    },
  };
});

// Load the new folder's overrides when another folder opens.
useWorkspace.subscribe((s, prev) => {
  if (s.root === prev.root) return;
  const project = s.root ? read(projectKey(s.root)) : {};
  const { global } = useSettings.getState();
  useSettings.setState({ ...global, ...project, project });
});
