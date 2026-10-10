import { create } from "zustand";
import { Check, setupApi } from "../lib/ipc";

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
  setPlatform: (platform: Platform) => void;
  refresh: () => Promise<Check[]>;
}

export const isReady = (checks: Check[] | null) => !!checks && checks.every((c) => c.status === "ok");

export const useSetup = create<SetupState>((set, get) => ({
  platform: loadPlatform(),
  checks: null,
  checking: false,
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
      const checks = await (platform === "android" ? setupApi.androidHealth() : setupApi.health());
      // Drop results for a platform the user has since switched away from.
      if (get().platform === platform) set({ checks });
      return checks;
    } finally {
      if (get().platform === platform) set({ checking: false });
    }
  },
}));
