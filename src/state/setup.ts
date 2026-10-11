import { create } from "zustand";
import { Check, setupApi } from "../lib/ipc";
import { errorText, logWrite } from "../lib/log";

export type Platform = "ios" | "android";

const PLATFORM_KEY = "orbit.setup.platform";

function loadPlatform(): Platform {
  try {
    return localStorage.getItem(PLATFORM_KEY) === "android" ? "android" : "ios";
  } catch {
    return "ios";
  }
}

interface SetupState {
  /** Toolchain shown in the setup wizard and the toolbar status pill. */
  platform: Platform;
  checks: Check[] | null;
  checking: boolean;
  /** Readiness of each platform (null until checked), for the status bar. */
  ready: Record<Platform, boolean | null>;
  setPlatform: (platform: Platform) => void;
  refresh: () => Promise<Check[]>;
  /** Re-checks both platforms in the background. */
  refreshAll: () => Promise<void>;
}

const health = (platform: Platform) => (platform === "android" ? setupApi.androidHealth() : setupApi.health());

/** Every required check passes; optional ones (e.g. code intelligence) don't block. */
export const isReady = (checks: Check[] | null) => !!checks && checks.every((c) => c.optional || c.status === "ok");

export const useSetup = create<SetupState>((set, get) => ({
  platform: loadPlatform(),
  checks: null,
  checking: false,
  ready: { ios: null, android: null },
  setPlatform: (platform) => {
    if (platform === get().platform) return;
    try {
      localStorage.setItem(PLATFORM_KEY, platform);
    } catch {
      // Storage unavailable; the choice just won't be remembered.
    }
    set({ platform, checks: null });
    get().refresh();
  },
  refresh: async () => {
    const platform = get().platform;
    set({ checking: true });
    try {
      const checks = await health(platform);
      set((s) => ({ ready: { ...s.ready, [platform]: isReady(checks) } }));
      // Drop results for a platform the user has since switched away from.
      if (get().platform === platform) set({ checks });
      return checks;
    } finally {
      if (get().platform === platform) set({ checking: false });
    }
  },
  refreshAll: async () => {
    await Promise.all(
      (["ios", "android"] as const).map(async (p) => {
        const checks = await health(p).catch((e) => (logWrite("error", `toolchain health (${p}): ${errorText(e)}`), null));
        set((s) => ({ ready: { ...s.ready, [p]: checks ? isReady(checks) : false } }));
      }),
    );
  },
}));
