import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";
import { AiHardware, AiModels, AiServerStatus, DownloadProgress, aiApi } from "../lib/ipc";
import { toast } from "./toasts";

export interface AiSettings {
  /** AI features on/off (the panel, entry points and completions). */
  enabled: boolean;
  /** The model to use; null until one is set up. */
  model: string | null;
  /** Context size in tokens. */
  ctx: number;
  /** Unload the model after this many idle minutes (0 = never). */
  idleMinutes: number;
  /** Inline ghost-text completions while typing. */
  inlineCompletions: boolean;
  /** Licenses the user accepted, by model id. */
  accepted: string[];
}

export const CONTEXT_SIZES = [4096, 8192, 16384, 32768];
const KEY = "orbit.ai";
const DEFAULTS: AiSettings = { enabled: true, model: null, ctx: 8192, idleMinutes: 10, inlineCompletions: false, accepted: [] };

function read(): AiSettings {
  try {
    const r = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    return {
      enabled: typeof r.enabled === "boolean" ? r.enabled : DEFAULTS.enabled,
      model: typeof r.model === "string" ? r.model : null,
      ctx: CONTEXT_SIZES.includes(r.ctx) ? r.ctx : DEFAULTS.ctx,
      idleMinutes: typeof r.idleMinutes === "number" && r.idleMinutes >= 0 ? Math.min(240, Math.round(r.idleMinutes)) : DEFAULTS.idleMinutes,
      inlineCompletions: typeof r.inlineCompletions === "boolean" ? r.inlineCompletions : DEFAULTS.inlineCompletions,
      accepted: Array.isArray(r.accepted) ? r.accepted.filter((a: unknown) => typeof a === "string") : [],
    };
  } catch {
    return { ...DEFAULTS };
  }
}

interface AiState {
  settings: AiSettings;
  hardware: AiHardware | null;
  models: AiModels | null;
  downloads: Record<string, DownloadProgress>;
  server: AiServerStatus;
  update: (patch: Partial<AiSettings>) => void;
  refresh: () => Promise<void>;
}

export const useAi = create<AiState>((set, get) => ({
  settings: read(),
  hardware: null,
  models: null,
  downloads: {},
  server: { status: "stopped", model: null, ctx: null },
  update: (patch) => {
    const settings = { ...get().settings, ...patch };
    set({ settings });
    try {
      localStorage.setItem(KEY, JSON.stringify(settings));
    } catch {}
    if (patch.idleMinutes !== undefined) aiApi.configure(settings.idleMinutes).catch(() => {});
    if (patch.enabled === false) aiApi.unload().catch(() => {});
  },
  refresh: async () => {
    const [hardware, models] = await Promise.all([aiApi.hardware(), aiApi.models()]);
    set({ hardware, models });
    // The chosen model was deleted (or never installed): fall back to an installed one.
    const { model } = get().settings;
    if (model && !models.installed.some((m) => m.id === model)) get().update({ model: models.installed[0]?.id ?? null });
    if (!model && models.installed.length) get().update({ model: models.installed[0].id });
  },
}));

/** The AI can be used now: supported Mac, turned on, a model installed. */
export const aiReady = (s: AiState = useAi.getState()) =>
  !!s.hardware?.supported && s.settings.enabled && !!s.settings.model && !!s.models?.installed.some((m) => m.id === s.settings.model);

/** AI features are shown at all (supported Mac and turned on); setup may still be needed. */
export const aiAvailable = (s: AiState = useAi.getState()) => !!s.hardware?.supported && s.settings.enabled;

// Initial state, then live updates.
useAi.getState().refresh().catch(() => {});
aiApi.configure(useAi.getState().settings.idleMinutes).catch(() => {});
aiApi.status().then((server) => useAi.setState({ server }), () => {});

listen<DownloadProgress>("ai://download", (e) => {
  const p = e.payload;
  useAi.setState((s) => ({ downloads: { ...s.downloads, [p.id]: p } }));
  if (p.status === "done") {
    useAi.getState().refresh().then(() => {
      if (!useAi.getState().settings.model) useAi.getState().update({ model: p.id });
    });
    toast("Model downloaded and verified");
  } else if (p.status === "error" && p.error) {
    toast(p.error.message, "error");
    useAi.getState().refresh();
  } else if (p.status === "cancelled" || p.status === "paused") {
    useAi.getState().refresh();
  }
});

listen<AiServerStatus>("ai://status", (e) => useAi.setState({ server: e.payload }));
