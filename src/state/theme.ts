import { useEffect, useSyncExternalStore } from "react";
import { create } from "zustand";

export type ThemePref = "system" | "light" | "dark";
const KEY = "orbit.theme";

function loadPref(): ThemePref {
  try {
    const v = localStorage.getItem(KEY);
    if (v === "light" || v === "dark" || v === "system") return v;
  } catch {}
  return "system";
}

interface ThemeState {
  pref: ThemePref;
  set: (pref: ThemePref) => void;
  cycle: () => void;
}

export const useThemePref = create<ThemeState>((set, get) => ({
  pref: loadPref(),
  set: (pref) => {
    try {
      localStorage.setItem(KEY, pref);
    } catch {}
    set({ pref });
  },
  cycle: () => {
    const order: ThemePref[] = ["system", "light", "dark"];
    get().set(order[(order.indexOf(get().pref) + 1) % order.length]);
  },
}));

const media = window.matchMedia("(prefers-color-scheme: dark)");
const subscribe = (cb: () => void) => {
  media.addEventListener("change", cb);
  return () => media.removeEventListener("change", cb);
};

/** Applies the preference to <html data-theme> (same convention as the CSS) and returns the resolved theme. */
export function useResolvedTheme(): "light" | "dark" {
  const pref = useThemePref((s) => s.pref);
  const systemDark = useSyncExternalStore(subscribe, () => media.matches);

  useEffect(() => {
    if (pref === "system") document.documentElement.removeAttribute("data-theme");
    else document.documentElement.setAttribute("data-theme", pref);
  }, [pref]);

  return pref === "system" ? (systemDark ? "dark" : "light") : pref;
}
