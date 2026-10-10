import { create } from "zustand";

export interface EditorSettings {
  fontSize: number;
  tabSize: number;
  wordWrap: boolean;
  minimap: boolean;
  formatOnSave: boolean;
}

const KEY = "orbit.settings";
const DEFAULTS: EditorSettings = { fontSize: 13, tabSize: 4, wordWrap: false, minimap: true, formatOnSave: false };

function load(): EditorSettings {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) ?? "{}") };
  } catch {
    return DEFAULTS;
  }
}

interface SettingsState extends EditorSettings {
  update: (patch: Partial<EditorSettings>) => void;
  reset: () => void;
}

export const useSettings = create<SettingsState>((set, get) => ({
  ...load(),
  update: (patch) => {
    set(patch);
    const { update: _u, reset: _r, ...values } = get();
    try {
      localStorage.setItem(KEY, JSON.stringify(values));
    } catch {}
  },
  reset: () => get().update(DEFAULTS),
}));
