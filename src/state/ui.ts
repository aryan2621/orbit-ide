import { create } from "zustand";
import { useSetup } from "./setup";

export type Activity = "explorer" | "search" | "git" | "packages" | "problems" | "debug" | "tests" | "output";
/** Each mode is the file search with a prefix: > commands, @ symbols in file, # workspace symbols, : line. */
export type PaletteMode = "files" | "commands" | "symbols" | "workspace-symbols" | "line" | null;

export type BottomTab = "terminal" | "build" | "console" | "debug" | "logcat";

interface UiState {
  activity: Activity;
  palette: PaletteMode;
  showSettings: boolean;
  /** Repo-relative path whose diff against HEAD is shown. */
  diffPath: string | null;
  /** What the diff compares: a commit, `HEAD`, `:` (staged) or `working` (the file on disk). */
  diffRevs: { left: string; right: string };
  sidebarWidth: number;
  panelHeight: number;
  setActivity: (a: Activity) => void;
  /** Shows a view in the sidebar (setActivity toggles it off when it is already showing). */
  showActivity: (a: Activity) => void;
  setPalette: (p: PaletteMode) => void;
  setShowSettings: (show: boolean) => void;
  /** The Settings page to open next (general, editor, ai, keyboard, about). */
  settingsPage: string;
  setSettingsPage: (page: string) => void;
  setDiffPath: (path: string | null, revs?: { left: string; right: string }) => void;
  setSidebarWidth: (w: number) => void;
  setPanelHeight: (h: number) => void;
  showSidebar: boolean;
  showPanel: boolean;
  showSetup: boolean;
  /** Which New Project dialog is open. */
  showNewProject: false | "ios" | "android";
  showSigning: boolean;
  showArchive: boolean;
  showDevices: boolean;
  showWirelessPair: boolean;
  showVersion: boolean;
  showAppSettings: boolean;
  showShortcuts: boolean;
  showAiPanel: boolean;
  aiPanelWidth: number;
  showIcons: boolean;
  showLocalization: boolean;
  showTour: boolean;
  /** Folder the Explorer should start a new file in (⌘N); cleared once it does. */
  newFileIn: string | null;
  /** The Device pane (live screen) on the right. */
  showDevicePane: boolean;
  devicePaneWidth: number;
  bottomTab: BottomTab;
  terminalId: number | null;
  toggleSidebar: () => void;
  togglePanel: () => void;
  setShowSetup: (show: boolean) => void;
  /** `true` opens the dialog for the current setup platform. */
  setShowNewProject: (show: boolean | "ios" | "android") => void;
  setShowSigning: (show: boolean) => void;
  setShowArchive: (show: boolean) => void;
  setShowDevices: (show: boolean) => void;
  setShowWirelessPair: (show: boolean) => void;
  setShowVersion: (show: boolean) => void;
  setShowAppSettings: (show: boolean) => void;
  setShowShortcuts: (show: boolean) => void;
  setShowAiPanel: (show: boolean) => void;
  setAiPanelWidth: (width: number) => void;
  setShowIcons: (show: boolean) => void;
  setShowLocalization: (show: boolean) => void;
  setShowTour: (show: boolean) => void;
  setNewFileIn: (folder: string | null) => void;
  toggleDevicePane: () => void;
  setDevicePaneWidth: (w: number) => void;
  /** Reveals the bottom panel on the given tab. */
  showBottomTab: (tab: BottomTab) => void;
  setTerminalId: (id: number | null) => void;
}

const SIZE_KEY = "orbit.layout";
type Sizes = { sidebarWidth: number; panelHeight: number; devicePaneWidth: number };
const DEFAULT_SIZES: Sizes = { sidebarWidth: 260, panelHeight: 260, devicePaneWidth: 360 };
function loadSizes(): Sizes {
  try {
    return { ...DEFAULT_SIZES, ...JSON.parse(localStorage.getItem(SIZE_KEY) ?? "{}") };
  } catch {
    return DEFAULT_SIZES;
  }
}
const PANE_KEY = "orbit.devicePane";
function loadPane(): boolean {
  try {
    return localStorage.getItem(PANE_KEY) === "true";
  } catch {
    return false;
  }
}
function saveSizes(s: Sizes) {
  try {
    localStorage.setItem(SIZE_KEY, JSON.stringify(s));
  } catch {}
}

export const useUi = create<UiState>((set, get) => ({
  activity: "explorer",
  palette: null,
  showSettings: false,
  diffPath: null,
  diffRevs: { left: "HEAD", right: "working" },
  ...loadSizes(),
  setActivity: (activity) =>
    set((s) => (s.activity === activity && s.showSidebar ? { showSidebar: false } : { activity, showSidebar: true })),
  showActivity: (activity) => set({ activity, showSidebar: true }),
  setPalette: (palette) => set({ palette }),
  setShowSettings: (showSettings) => set({ showSettings }),
  settingsPage: "general",
  setSettingsPage: (settingsPage) => set({ settingsPage }),
  setDiffPath: (diffPath, diffRevs = { left: "HEAD", right: "working" }) => set({ diffPath, diffRevs }),
  setSidebarWidth: (w) => {
    const sidebarWidth = Math.round(Math.min(560, Math.max(180, w)));
    set({ sidebarWidth });
    saveSizes({ sidebarWidth, panelHeight: get().panelHeight, devicePaneWidth: get().devicePaneWidth });
  },
  setPanelHeight: (h) => {
    const panelHeight = Math.round(Math.min(window.innerHeight - 200, Math.max(120, h)));
    set({ panelHeight });
    saveSizes({ sidebarWidth: get().sidebarWidth, panelHeight, devicePaneWidth: get().devicePaneWidth });
  },
  showSidebar: true,
  showPanel: true,
  showSetup: false,
  showNewProject: false,
  showSigning: false,
  showArchive: false,
  showDevices: false,
  showWirelessPair: false,
  showVersion: false,
  showAppSettings: false,
  showShortcuts: false,
  showAiPanel: false,
  aiPanelWidth: 400,
  showIcons: false,
  showLocalization: false,
  showTour: false,
  newFileIn: null,
  showDevicePane: loadPane(),
  devicePaneWidth: loadSizes().devicePaneWidth,
  bottomTab: "terminal",
  terminalId: null,
  toggleSidebar: () => set((s) => ({ showSidebar: !s.showSidebar })),
  togglePanel: () => set((s) => ({ showPanel: !s.showPanel })),
  setShowSetup: (showSetup) => set({ showSetup }),
  setShowNewProject: (show) =>
    set({ showNewProject: show === true ? useSetup.getState().platform : show }),
  setShowSigning: (showSigning) => set({ showSigning }),
  setShowArchive: (showArchive) => set({ showArchive }),
  setShowDevices: (showDevices) => set({ showDevices }),
  setShowWirelessPair: (showWirelessPair) => set({ showWirelessPair }),
  setShowVersion: (showVersion) => set({ showVersion }),
  setShowAppSettings: (showAppSettings) => set({ showAppSettings }),
  setShowShortcuts: (showShortcuts) => set({ showShortcuts }),
  setShowAiPanel: (showAiPanel) => set({ showAiPanel }),
  setAiPanelWidth: (w) => set({ aiPanelWidth: Math.round(Math.min(800, Math.max(300, w))) }),
  setShowIcons: (showIcons) => set({ showIcons }),
  setShowLocalization: (showLocalization) => set({ showLocalization }),
  setShowTour: (showTour) => set({ showTour }),
  setNewFileIn: (newFileIn) => set({ newFileIn }),
  toggleDevicePane: () =>
    set((s) => {
      try {
        localStorage.setItem(PANE_KEY, String(!s.showDevicePane));
      } catch {}
      return { showDevicePane: !s.showDevicePane };
    }),
  setDevicePaneWidth: (w) => {
    const devicePaneWidth = Math.round(Math.min(720, Math.max(240, w)));
    set({ devicePaneWidth });
    saveSizes({ sidebarWidth: get().sidebarWidth, panelHeight: get().panelHeight, devicePaneWidth });
  },
  showBottomTab: (bottomTab) => set({ bottomTab, showPanel: true }),
  setTerminalId: (terminalId) => set({ terminalId }),
}));
