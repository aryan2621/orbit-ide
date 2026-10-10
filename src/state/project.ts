import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";
import {
  archiveApi,
  ArchiveMethod,
  Device,
  Diagnostic,
  jobApi,
  JobExit,
  projectApi,
  ProjectInfo,
  RunPhase,
  runApi,
} from "../lib/ipc";
import { useWorkspace } from "./workspace";
import { useUi } from "./ui";
import { restartSwiftServer } from "../lsp/swift";
import { isReady, useSetup } from "./setup";
import { loadSigning } from "./signing";
import { DebugTarget, useDebug } from "./debug";

const MAX_LOG_LINES = 5000;

export type ActivityStatus = "idle" | "active" | "succeeded" | "failed" | "cancelled";

/** The current (or last) build or run. Only one runs at a time, like Xcode. */
export type Action = "build" | "run" | "debug" | "archive";

export interface ArchiveOptions {
  method: ArchiveMethod;
  upload: boolean;
}

interface Activity {
  action: Action;
  status: ActivityStatus;
  /** Run progress while active. */
  phase: RunPhase | null;
  deviceName: string | null;
  jobId: string | null;
  log: string[];
  /** The running app's stdout/stderr. */
  console: string[];
  diagnostics: Diagnostic[];
  startedAt: number | null;
  finishedAt: number | null;
  /** Archive output (.xcarchive or export folder) to reveal in Finder. */
  artifact: string | null;
}

interface ProjectState {
  info: ProjectInfo | null;
  loading: boolean;
  scheme: string | null;
  configuration: string;
  build: Activity;
  devices: Device[];
  deviceId: string | null;
  loadingDevices: boolean;
  load: (root: string) => Promise<void>;
  loadDevices: () => Promise<void>;
  setDevice: (id: string) => void;
  setScheme: (scheme: string) => void;
  setConfiguration: (configuration: string) => void;
  startBuild: () => Promise<void>;
  startRun: () => Promise<void>;
  startDebug: () => Promise<void>;
  startArchive: (options: ArchiveOptions) => Promise<void>;
  cancelBuild: () => void;
}

const IDLE: Activity = {
  action: "build",
  status: "idle",
  phase: null,
  deviceName: null,
  jobId: null,
  log: [],
  console: [],
  diagnostics: [],
  startedAt: null,
  finishedAt: null,
  artifact: null,
};
const DEVICE_KEY = "orbit.device";
const schemeKey = (root: string) => `orbit.scheme:${root}`;

function remember(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {}
}
function recall(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** Xcode projects need one successful build before xcode-build-server can feed sourcekit-lsp. */
let lspPrimedFor: string | null = null;

async function configureLsp(root: string, scheme: string) {
  try {
    if (await projectApi.configureLsp(root, scheme)) await restartSwiftServer();
  } catch (e) {
    console.warn("xcode-build-server config failed", e);
  }
}

export const useProject = create<ProjectState>((set, get) => ({
  info: null,
  loading: false,
  scheme: null,
  configuration: "Debug",
  build: IDLE,
  devices: [],
  deviceId: recall(DEVICE_KEY),
  loadingDevices: false,

  load: async (root) => {
    set({ loading: true, info: null, scheme: null, build: IDLE });
    try {
      const info = await projectApi.info(root);
      if (useWorkspace.getState().root !== root) return; // folder changed meanwhile
      const saved = recall(schemeKey(root));
      const scheme = saved && info.schemes.includes(saved) ? saved : (info.schemes[0] ?? null);
      set({ info, scheme });
      if (scheme && info.project?.kind !== "package") configureLsp(root, scheme);
    } finally {
      set({ loading: false });
    }
  },

  setScheme: (scheme) => {
    const root = useWorkspace.getState().root;
    if (root) {
      remember(schemeKey(root), scheme);
      configureLsp(root, scheme);
    }
    set({ scheme });
  },

  setConfiguration: (configuration) => set({ configuration }),

  loadDevices: async () => {
    if (get().info?.platform === "mac") {
      set({ devices: [MY_MAC], deviceId: MY_MAC.id });
      return;
    }
    set({ loadingDevices: true });
    try {
      const devices = await runApi.devices();
      const current = get().deviceId;
      // Keep the chosen device if it's still there; else prefer a booted simulator, then the newest one.
      const deviceId = devices.some((d) => d.id === current)
        ? current
        : (devices.find((d) => d.kind === "simulator" && d.booted) ?? devices.find((d) => d.kind === "simulator") ?? devices[0])?.id ?? null;
      set({ devices, deviceId });
    } finally {
      set({ loadingDevices: false });
    }
  },

  setDevice: (deviceId) => {
    remember(DEVICE_KEY, deviceId);
    set({ deviceId });
  },

  startBuild: () => startActivity("build"),
  startRun: () => startActivity("run"),
  startDebug: () => startActivity("debug"),
  startArchive: (options) => startActivity("archive", options),

  cancelBuild: () => {
    const { jobId, status } = get().build;
    if (jobId && status === "active") jobApi.cancel(jobId);
  },
}));

const MY_MAC: Device = { id: "my-mac", name: "My Mac", kind: "mac", os: "macOS", booted: true };

async function startActivity(action: Action, archive?: ArchiveOptions) {
  const { getState: get, setState: set } = useProject;
  const root = useWorkspace.getState().root;
  const { scheme, configuration, build, deviceId, devices } = get();
  if (!root || !scheme || build.status === "active") return;
  const device = devices.find((d) => d.id === deviceId);
  const needsDevice = action === "run" || action === "debug";
  if (needsDevice && !device) {
    useWorkspace.setState({ error: "Choose a Simulator or device to run on." });
    return;
  }

  // Build what's on screen, like Xcode does.
  await useWorkspace.getState().saveAll();

  const jobId = crypto.randomUUID();
  const update = (fn: (a: Activity) => Partial<Activity>) =>
    set((s) => (s.build.jobId === jobId ? { build: { ...s.build, ...fn(s.build) } } : s));
  set({
    build: {
      ...IDLE,
      action,
      status: "active",
      phase: action !== "build" ? "building" : null,
      deviceName: needsDevice ? (device?.name ?? null) : null,
      jobId,
      startedAt: Date.now(),
    },
  });
  useUi.getState().showBottomTab("build");

  const unlisten = [
    await listen<string>(`job://${jobId}/log`, (e) => update((a) => ({ log: [...a.log, e.payload].slice(-MAX_LOG_LINES) }))),
    await listen<string>(`job://${jobId}/console`, (e) =>
      update((a) => ({ console: [...a.console, e.payload].slice(-MAX_LOG_LINES) })),
    ),
    await listen<RunPhase>(`job://${jobId}/phase`, (e) => {
      update(() => ({ phase: e.payload }));
      if (e.payload === "running") useUi.getState().showBottomTab("console");
    }),
    // Build and device steps each report their own diagnostics.
    await listen<string>(`job://${jobId}/artifact`, (e) => update(() => ({ artifact: e.payload }))),
    await listen<DebugTarget>(`job://${jobId}/debug-target`, (e) => useDebug.getState().start(e.payload)),
    await listen<Diagnostic[]>(`job://${jobId}/diagnostics`, (e) =>
      update((a) => ({ diagnostics: [...a.diagnostics, ...e.payload] })),
    ),
    await listen<JobExit>(`job://${jobId}/exit`, (e) => {
      unlisten.forEach((u) => u());
      const status: ActivityStatus = e.payload.cancelled ? "cancelled" : e.payload.code === 0 ? "succeeded" : "failed";
      update(() => ({ status, finishedAt: Date.now() }));
      // Simulator debugging lives as long as the app; package debugging outlives its build job.
      if (action === "debug" && get().info?.platform === "ios") useDebug.getState().onJobEnded();
      const a = get().build;
      if (status === "failed" && a.diagnostics.some((d) => d.severity === "error")) useUi.getState().showBottomTab("problems");
      // A build that got past compiling gives xcode-build-server the settings sourcekit-lsp needs.
      const compiled = status === "succeeded" || (needsDevice && a.phase !== "building");
      if (compiled && lspPrimedFor !== root && get().info?.project?.kind !== "package") {
        lspPrimedFor = root;
        restartSwiftServer();
      }
    }),
  ];

  try {
    if (needsDevice) {
      await runApi.run(root, scheme, configuration, device!.id, loadSigning(root), action === "debug", jobId);
    } else if (action === "archive") {
      await archiveApi.archive(root, scheme, archive!.method, archive!.upload, loadSigning(root), jobId);
    } else {
      await projectApi.build(root, scheme, configuration, jobId);
    }
  } catch (e) {
    unlisten.forEach((u) => u());
    update(() => ({ status: "failed", log: [String(e)], finishedAt: Date.now() }));
  }
}

// Re-read the project whenever a different folder is opened.
useWorkspace.subscribe((s, prev) => {
  if (s.root && s.root !== prev.root) useProject.getState().load(s.root);
});

// Once setup finishes (e.g. Xcode just got installed), re-read the project so schemes appear.
useSetup.subscribe((s, prev) => {
  const root = useWorkspace.getState().root;
  if (root && isReady(s.checks) && !isReady(prev.checks)) useProject.getState().load(root);
});
