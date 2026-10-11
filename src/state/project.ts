import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";
import {
  androidApi,
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
  TestCase,
  testApi,
  TestFilter,
  PodsStatus,
  toolApi,
} from "../lib/ipc";
import { restartAndroidServers } from "../lsp/android";
import { useWorkspace } from "./workspace";
import { useUi } from "./ui";
import { restartSwiftServer } from "../lsp/swift";
import { isReady, useSetup } from "./setup";
import { loadSigning } from "./signing";
import { DebugTarget, useDebug } from "./debug";
import type { AndroidArchiveOptions } from "../wizards/AndroidArchive";
import { errorText, logWrite } from "../lib/log";

const MAX_LOG_LINES = 5000;

export type ActivityStatus = "idle" | "active" | "succeeded" | "failed" | "cancelled";

/** The current (or last) build or run. Only one runs at a time, like Xcode. */
export type Action = "build" | "run" | "debug" | "archive" | "test" | "clean" | "resolve" | "pods";

/** What a test run covers: everything, or one class/test; Android also picks unit vs. on-device. */
export interface TestRequest {
  only: TestFilter | null;
  instrumented: boolean;
}

export type ArchiveOptions =
  | { platform: "ios"; method: ArchiveMethod; upload: boolean }
  | ({ platform: "android" } & AndroidArchiveOptions);

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
  /** Build steps done (Gradle tasks, xcodebuild steps) and the total when known (SwiftPM). */
  progress: { done: number; total: number | null } | null;
  /** Test results, once a test run reports them. */
  tests: TestCase[] | null;
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
  startTests: (request: TestRequest) => Promise<void>;
  /** Clean Build, Resolve Packages (iOS) or pod install, as a job like a build. */
  startTool: (action: "clean" | "resolve" | "pods") => Promise<void>;
  /** Gradle Sync: re-read the project and restart the Android language servers. */
  gradleSync: () => Promise<void>;
  /** CocoaPods state of the open project (null when it has no Podfile or isn't iOS). */
  pods: PodsStatus | null;
  refreshPods: () => Promise<void>;
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
  progress: null,
  diagnostics: [],
  startedAt: null,
  finishedAt: null,
  artifact: null,
  tests: null,
};
const DEVICE_KEY = "orbit.device";
const schemeKey = (root: string) => `orbit.scheme:${root}`;
const configKey = (root: string) => `orbit.configuration:${root}`;

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

/** Folder the project info was last loaded for (a reload of the same folder keeps a running job). */
let loadedRoot: string | null = null;
/** Set synchronously while a build/run is being started, so a double ⌘R can't start two jobs. */
let starting = false;

/** Xcode projects need one successful build before xcode-build-server can feed sourcekit-lsp. */
let lspPrimedFor: string | null = null;

async function configureLsp(root: string, scheme: string) {
  try {
    if (await projectApi.configureLsp(root, scheme)) await restartSwiftServer();
  } catch (e) {
    console.warn("xcode-build-server config failed", e);
  }
}

export const useProject = create<ProjectState>()((set, get) => ({
  info: null,
  loading: false,
  scheme: null,
  configuration: "Debug",
  build: IDLE,
  devices: [],
  deviceId: recall(DEVICE_KEY),
  loadingDevices: false,
  pods: null,

  load: async (root) => {
    // Reloading the same folder (after Signing or Setup changes) must not orphan a running job:
    // keep it, so its Stop button and output stay. A different folder cancels it.
    const prev = get().build;
    const keep = prev.status === "active" && loadedRoot === root;
    if (prev.status === "active" && !keep && prev.jobId) jobApi.cancel(prev.jobId);
    loadedRoot = root;
    set({ loading: true, info: null, scheme: null, build: keep ? prev : IDLE });
    try {
      let info: ProjectInfo;
      try {
        // Retry once: the backend can briefly be unavailable (e.g. restarting during development).
        const platform = await androidApi.platform(root).catch(() => androidApi.platform(root));
        info = platform === "android" ? await androidApi.projectInfo(root) : await projectApi.info(root);
      } catch (e) {
        info = { project: null, schemes: [], runnable: [], platform: "ios", configurations: [], error: String(e) };
      }
      if (useWorkspace.getState().root !== root) return; // folder changed meanwhile
      // Show the matching toolchain in setup and the status bar.
      useSetup.getState().setPlatform(info.platform === "android" ? "android" : "ios");
      const saved = recall(schemeKey(root));
      const scheme = saved && info.schemes.includes(saved) ? saved : (info.schemes[0] ?? null);
      // Configurations differ per platform ("Debug" in Xcode, "debug" in Gradle): keep the one
      // remembered for this folder if it still exists, else the debug-like one, else the first.
      const savedConfig = recall(configKey(root));
      const configuration =
        (savedConfig && info.configurations.includes(savedConfig) && savedConfig) ||
        info.configurations.find((c) => c.toLowerCase() === "debug") ||
        info.configurations[0] ||
        "Debug";
      set({ info, scheme, configuration });
      if (info.platform === "ios") get().refreshPods();
      else set({ pods: null });
      if (scheme && info.platform === "ios" && info.project?.kind !== "package") configureLsp(root, scheme);
    } finally {
      set({ loading: false });
    }
  },

  setScheme: (scheme) => {
    const root = useWorkspace.getState().root;
    if (root) {
      remember(schemeKey(root), scheme);
      if (get().info?.platform === "ios") configureLsp(root, scheme);
    }
    set({ scheme });
  },

  setConfiguration: (configuration) => {
    const root = useWorkspace.getState().root;
    if (root) remember(configKey(root), configuration);
    set({ configuration });
  },

  loadDevices: async () => {
    if (get().info?.platform === "mac") {
      set({ devices: [MY_MAC], deviceId: MY_MAC.id });
      return;
    }
    set({ loadingDevices: true });
    try {
      const android = get().info?.platform === "android";
      const devices = android ? await androidApi.devices() : await runApi.devices();
      const current = get().deviceId;
      // Keep the chosen device if it's still there; else prefer a running emulator/simulator, then any.
      const virtual = android ? "emulator" : "simulator";
      const deviceId = devices.some((d) => d.id === current)
        ? current
        : (devices.find((d) => d.kind === virtual && d.booted) ?? devices.find((d) => d.kind === virtual) ?? devices[0])?.id ?? null;
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
  startTests: (request) => startActivity("test", undefined, request),
  startTool: (action) => startActivity(action),

  gradleSync: async () => {
    const root = useWorkspace.getState().root;
    if (!root) return;
    await get().load(root);
    await restartAndroidServers();
  },

  refreshPods: async () => {
    const root = useWorkspace.getState().root;
    if (!root) return;
    const status = await toolApi.podsStatus(root).catch((e) => (logWrite("warn", `pods status: ${errorText(e)}`), null));
    if (useWorkspace.getState().root === root) set({ pods: status?.podfileDir ? status : null });
  },

  cancelBuild: () => {
    const { jobId, status } = get().build;
    if (jobId && status === "active") jobApi.cancel(jobId);
  },
}));

const MY_MAC: Device = { id: "my-mac", name: "My Mac", kind: "mac", os: "macOS", booted: true };

async function startActivity(action: Action, archive?: ArchiveOptions, test?: TestRequest): Promise<void> {
  const { getState: get, setState: set } = useProject;
  const root = useWorkspace.getState().root;
  const { scheme: chosen, configuration, build, deviceId, devices, info } = get();
  // pod install is the one action that doesn't need a scheme (there may be none before it).
  if (!root || (!chosen && action !== "pods") || build.status === "active" || starting) return;
  const scheme = chosen ?? "";
  const device = devices.find((d) => d.id === deviceId);
  const android = info?.platform === "android";
  const needsDevice = action === "run" || action === "debug";
  const fail = (error: string) => useWorkspace.setState({ error });
  // The same checks the toolbar buttons make, so shortcuts and the palette fail early too.
  if (needsDevice && !device) {
    return fail(android ? "Choose an emulator or device to run on." : "Choose a Simulator or device to run on.");
  }
  if (needsDevice && info && !info.runnable.includes(scheme)) {
    return fail(`"${scheme}" doesn't build an app that can run. Pick another ${android ? "module" : "scheme"}.`);
  }
  // Emulators and Simulators are started on demand; a phone must already be connected and ready.
  if (needsDevice && device?.kind === "device" && !device.booted) {
    return fail(
      android
        ? `${device.name} isn't ready: unlock it, accept "Allow USB debugging?", then refresh the device list.`
        : `${device.name} isn't connected: plug it in or put it on the same network, unlock it, then refresh the device list.`,
    );
  }
  if (action === "debug" && !android && device?.kind === "device") {
    return fail("Debugging on a physical iPhone isn't supported yet. Use a Simulator, or Run without debugging.");
  }

  starting = true;
  try {
    // Build what's on screen, like Xcode does.
    await useWorkspace.getState().saveAll();
  } finally {
    starting = false;
  }
  if (get().build.status === "active") return;

  const jobId = crypto.randomUUID();
  const update = (fn: (a: Activity) => Partial<Activity>) =>
    set((s) => (s.build.jobId === jobId ? { build: { ...s.build, ...fn(s.build) } } : s));
  // Build logs arrive line by line (thousands for a big project): batch them into one update per
  // 100 ms instead of copying the whole log and re-rendering for every line.
  const pendingLines = { log: [] as string[], console: [] as string[] };
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  const flushLines = () => {
    flushTimer = null;
    const { log, console: out } = pendingLines;
    pendingLines.log = [];
    pendingLines.console = [];
    if (log.length || out.length)
      update((a) => ({
        log: log.length ? a.log.concat(log).slice(-MAX_LOG_LINES) : a.log,
        console: out.length ? a.console.concat(out).slice(-MAX_LOG_LINES) : a.console,
      }));
  };
  const queueLine = (kind: "log" | "console", line: string) => {
    pendingLines[kind].push(line);
    flushTimer ??= setTimeout(flushLines, 100);
  };
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
    await listen<string>(`job://${jobId}/log`, (e) => queueLine("log", e.payload)),
    await listen<string>(`job://${jobId}/console`, (e) => queueLine("console", e.payload)),
    await listen<RunPhase>(`job://${jobId}/phase`, (e) => {
      update(() => ({ phase: e.payload }));
      if (e.payload === "running") useUi.getState().showBottomTab("console");
    }),
    // Build and device steps each report their own diagnostics.
    await listen<string>(`job://${jobId}/artifact`, (e) => update(() => ({ artifact: e.payload }))),
    await listen<TestCase[]>(`job://${jobId}/tests`, (e) => update(() => ({ tests: e.payload }))),
    await listen<{ done: number; total: number | null }>(`job://${jobId}/progress`, (e) => update(() => ({ progress: e.payload }))),
    await listen<DebugTarget>(`job://${jobId}/debug-target`, (e) => useDebug.getState().start(e.payload)),
    await listen<Diagnostic[]>(`job://${jobId}/diagnostics`, (e) =>
      update((a) => ({ diagnostics: [...a.diagnostics, ...e.payload] })),
    ),
    await listen<JobExit>(`job://${jobId}/exit`, (e) => {
      unlisten.forEach((u) => u());
      if (flushTimer) clearTimeout(flushTimer);
      flushLines();
      const status: ActivityStatus = e.payload.cancelled ? "cancelled" : e.payload.code === 0 ? "succeeded" : "failed";
      update(() => ({ status, finishedAt: Date.now() }));
      // Simulator/emulator debugging lives as long as the app; package debugging outlives its build job.
      if (action === "debug" && get().info?.platform !== "mac") useDebug.getState().onJobEnded();
      const a = get().build;
      if (status === "failed" && a.diagnostics.some((d) => d.severity === "error")) useUi.getState().showActivity("problems");
      else if (action === "test" && a.tests) useUi.getState().showActivity("tests");
      if (action === "pods") {
        get().refreshPods();
        if (status === "succeeded") get().load(root); // the workspace may be new
      }
      // A build that got past compiling gives xcode-build-server the settings sourcekit-lsp needs.
      const compiled = status === "succeeded" || (needsDevice && a.phase !== "building");
      if (compiled && !android && lspPrimedFor !== root && get().info?.project?.kind !== "package") {
        lspPrimedFor = root;
        restartSwiftServer();
      }
    }),
  ];

  try {
    if (action === "clean" || action === "resolve") {
      if (android) await toolApi.androidClean(root, jobId);
      else await toolApi.iosAction(root, scheme, configuration, action, jobId);
    } else if (action === "pods") {
      await toolApi.podInstall(root, jobId);
    } else if (action === "test" && test) {
      if (android) await testApi.android(root, scheme, configuration, test.instrumented, test.instrumented ? (device?.id ?? null) : null, test.only, jobId);
      else await testApi.ios(root, scheme, configuration, device?.id ?? null, loadSigning(root), test.only, jobId);
    } else if (archive?.platform === "android") {
      await androidApi.archive(root, scheme, archive.variant, archive.format, archive.upload, jobId);
    } else if (android) {
      if (needsDevice) await androidApi.run(root, scheme, configuration, device!.id, action === "debug", jobId);
      else await androidApi.build(root, scheme, configuration, jobId);
    } else if (needsDevice) {
      await runApi.run(root, scheme, configuration, device!.id, loadSigning(root), action === "debug", jobId);
    } else if (archive?.platform === "ios") {
      await archiveApi.archive(root, scheme, archive.method, archive.upload, loadSigning(root), jobId);
    } else {
      await projectApi.build(root, scheme, configuration, device?.id ?? null, loadSigning(root), jobId);
    }
  } catch (e) {
    unlisten.forEach((u) => u());
    // The job never started (bad device, missing project…): say so rather than "Build failed".
    update(() => ({ status: "failed", phase: null, log: [`error: ${String(e)}`], finishedAt: Date.now() }));
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
