import { create } from "zustand";

export type Activity = "explorer" | "search" | "git" | "packages";
export type PaletteMode = "files" | "commands" | null;

export type BottomTab = "terminal" | "build" | "problems" | "console" | "debug";

interface UiState {
  activity: Activity;
  palette: PaletteMode;
  showSettings: boolean;
  /** Repo-relative path whose diff against HEAD is shown. */
  diffPath: string | null;
  sidebarWidth: number;
  panelHeight: number;
  setActivity: (a: Activity) => void;
  setPalette: (p: PaletteMode) => void;
  setShowSettings: (show: boolean) => void;
  setDiffPath: (path: string | null) => void;
  setSidebarWidth: (w: number) => void;
  setPanelHeight: (h: number) => void;
  showSidebar: boolean;
  showPanel: boolean;
  showSetup: boolean;
  showNewProject: boolean;
  showSigning: boolean;
  showArchive: boolean;
  bottomTab: BottomTab;
  terminalId: number | null;
  toggleSidebar: () => void;
  togglePanel: () => void;
  setShowSetup: (show: boolean) => void;
  setShowNewProject: (show: boolean) => void;
  setShowSigning: (show: boolean) => void;
  setShowArchive: (show: boolean) => void;
  /** Reveals the bottom panel on the given tab. */
  showBottomTab: (tab: BottomTab) => void;
  setTerminalId: (id: number | null) => void;
}

const SIZE_KEY = "orbit.layout";
function loadSizes(): { sidebarWidth: number; panelHeight: number } {
  try {
    return { sidebarWidth: 260, panelHeight: 260, ...JSON.parse(localStorage.getItem(SIZE_KEY) ?? "{}") };
  } catch {
    return { sidebarWidth: 260, panelHeight: 260 };
  }
}
function saveSizes(s: { sidebarWidth: number; panelHeight: number }) {
  try {
    localStorage.setItem(SIZE_KEY, JSON.stringify(s));
  } catch {}
}

export const useUi = create<UiState>((set, get) => ({
  activity: "explorer",
  palette: null,
  showSettings: false,
  diffPath: null,
  ...loadSizes(),
  setActivity: (activity) =>
    set((s) => (s.activity === activity && s.showSidebar ? { showSidebar: false } : { activity, showSidebar: true })),
  setPalette: (palette) => set({ palette }),
  setShowSettings: (showSettings) => set({ showSettings }),
  setDiffPath: (diffPath) => set({ diffPath }),
  setSidebarWidth: (w) => {
    const sidebarWidth = Math.round(Math.min(560, Math.max(180, w)));
    set({ sidebarWidth });
    saveSizes({ sidebarWidth, panelHeight: get().panelHeight });
  },
  setPanelHeight: (h) => {
    const panelHeight = Math.round(Math.min(window.innerHeight - 200, Math.max(120, h)));
    set({ panelHeight });
    saveSizes({ sidebarWidth: get().sidebarWidth, panelHeight });
  },
  showSidebar: true,
  showPanel: true,
  showSetup: false,
  showNewProject: false,
  showSigning: false,
  showArchive: false,
  bottomTab: "terminal",
  terminalId: null,
  toggleSidebar: () => set((s) => ({ showSidebar: !s.showSidebar })),
  togglePanel: () => set((s) => ({ showPanel: !s.showPanel })),
  setShowSetup: (showSetup) => set({ showSetup }),
  setShowNewProject: (showNewProject) => set({ showNewProject }),
  setShowSigning: (showSigning) => set({ showSigning }),
  setShowArchive: (showArchive) => set({ showArchive }),
  showBottomTab: (bottomTab) => set({ bottomTab, showPanel: true }),
  setTerminalId: (terminalId) => set({ terminalId }),
}));
