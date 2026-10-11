import { invoke } from "@tauri-apps/api/core";

export interface DirEntry {
  name: string;
  path: string;
  is_dir: boolean;
}

export const fsApi = {
  readDir: (path: string) => invoke<DirEntry[]>("read_dir", { path }),
  readFile: (path: string) => invoke<string>("read_file", { path }),
  writeFile: (path: string, contents: string) => invoke<void>("write_file", { path, contents }),
};

export const terminalApi = {
  spawn: (cwd: string | null, cols: number, rows: number) =>
    invoke<number>("terminal_spawn", { cwd, cols, rows }),
  write: (id: number, data: string) => invoke<void>("terminal_write", { id, data }),
  resize: (id: number, cols: number, rows: number) => invoke<void>("terminal_resize", { id, cols, rows }),
  kill: (id: number) => invoke<void>("terminal_kill", { id }),
};

export type CheckStatus = "ok" | "missing" | "blocked";

export interface SetupStep {
  text: string;
  command: string | null;
}

export interface Check {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
  steps: SetupStep[];
  /** Nice to have; doesn't count against "ready". */
  optional?: boolean;
}

export interface JobExit {
  code: number | null;
  cancelled: boolean;
}

export const setupApi = {
  health: () => invoke<Check[]>("ios_health"),
  androidHealth: () => invoke<Check[]>("android_health"),
};

export const jobApi = {
  cancel: (id: string) => invoke<void>("job_cancel", { id }),
};

export interface Project {
  kind: "workspace" | "project" | "package" | "gradle";
  path: string;
  name: string;
}

export interface ProjectInfo {
  project: Project | null;
  schemes: string[];
  runnable: string[];
  platform: "ios" | "mac" | "android";
  configurations: string[];
  error: string | null;
}

export interface Diagnostic {
  file: string | null;
  line: number | null;
  column: number | null;
  severity: "error" | "warning";
  message: string;
  hint: string | null;
}

export const projectApi = {
  info: (root: string) => invoke<ProjectInfo>("ios_project_info", { root }),
  configureLsp: (root: string, scheme: string) => invoke<boolean>("ios_configure_lsp", { root, scheme }),
  build: (root: string, scheme: string, configuration: string, deviceId: string | null, signing: SigningOptions, jobId: string) =>
    invoke<void>("ios_build", { root, scheme, configuration, deviceId, signing, jobId }),
  newProject: (parent: string, name: string, bundleId: string, deploymentTarget: string, jobId: string) =>
    invoke<string>("ios_new_project", { parent, name, bundleId, deploymentTarget, jobId }),
};

export interface Device {
  id: string;
  name: string;
  kind: "simulator" | "device" | "mac" | "emulator";
  /** Android emulators: the AVD name. */
  avd?: string;
  os: string;
  booted: boolean;
}

export type RunPhase = "building" | "installing" | "running";

export interface Choice {
  id: string;
  name: string;
}

/** Device Manager: create and manage Simulators (iOS) and emulators (Android). */
export const deviceManagerApi = {
  simulatorOptions: () => invoke<{ deviceTypes: Choice[]; runtimes: Choice[] }>("ios_simulator_options"),
  createSimulator: (name: string, deviceType: string, runtime: string) =>
    invoke<string>("ios_simulator_create", { name, deviceType, runtime }),
  simulatorAction: (udid: string, action: "boot" | "shutdown" | "erase" | "delete") =>
    invoke<void>("ios_simulator_action", { udid, action }),
  avdOptions: () => invoke<{ devices: Choice[]; images: Choice[] }>("android_avd_options"),
  createAvd: (name: string, device: string, image: string) => invoke<string>("android_avd_create", { name, device, image }),
  avdAction: (name: string, action: "start" | "coldboot" | "wipe" | "stop" | "delete") =>
    invoke<void>("android_avd_action", { name, action }),
};

/** The Device pane: screen mirror, input (Android) and device tools. */
export const deviceViewApi = {
  screenshot: (platform: "ios" | "android", id: string) => invoke<ArrayBuffer>("device_screenshot", { platform, id }),
  saveScreenshot: (platform: "ios" | "android", id: string) => invoke<string>("device_save_screenshot", { platform, id }),
  input: (
    id: string,
    kind: "tap" | "swipe" | "text" | "key",
    args: { x?: number; y?: number; x2?: number; y2?: number; ms?: number; text?: string } = {},
  ) => invoke<void>("device_input", { id, kind, ...args }),
  control: (platform: "ios" | "android", id: string, action: string, value?: string) =>
    invoke<void>("device_control", { platform, id, action, value }),
  recordStart: (platform: "ios" | "android", id: string) => invoke<void>("device_record_start", { platform, id }),
  recordStop: (id: string) => invoke<string>("device_record_stop", { id }),
  appId: (root: string, scheme: string, configuration: string) => invoke<string>("device_app_id", { root, scheme, configuration }),
  /** push · grant/revoke/reset (value: privacy service) · statusbar (clean/clear) · appdata (returns the path). */
  appTool: (platform: "ios" | "android", id: string, appId: string, action: string, value?: string) =>
    invoke<string>("device_app_tool", { platform, id, appId, action, value }),
};

export const runApi = {
  devices: () => invoke<Device[]>("ios_devices"),
  run: (
    root: string,
    scheme: string,
    configuration: string,
    deviceId: string,
    signing: SigningOptions,
    debug: boolean,
    jobId: string,
  ) => invoke<void>("ios_run", { root, scheme, configuration, deviceId, signing, debug, jobId }),
};

export interface Team {
  id: string;
  name: string;
}

export interface ApiKey {
  path: string;
  keyId: string;
  issuerId: string;
}

export interface SigningOptions {
  teamId: string | null;
  apiKey: ApiKey | null;
}

export interface SigningInfo {
  target: string | null;
  bundleId: string | null;
  projectTeam: string | null;
  signStyle: string | null;
  teams: Team[];
  xcodegen: boolean;
  error: string | null;
}

export const signingApi = {
  info: (root: string, scheme: string, configuration: string) =>
    invoke<SigningInfo>("ios_signing_info", { root, scheme, configuration }),
  save: (root: string, target: string, bundleId: string, teamId: string, signStyle: string | null = null) =>
    invoke<void>("ios_save_signing", { root, target, bundleId, teamId, signStyle }),
};

export type ArchiveMethod = "app-store-connect" | "release-testing" | "debugging";

export const archiveApi = {
  archive: (root: string, scheme: string, method: ArchiveMethod, upload: boolean, signing: SigningOptions, jobId: string) =>
    invoke<void>("ios_archive", { root, scheme, method, upload, signing, jobId }),
};

export interface SearchMatch {
  path: string;
  line: number;
  column: number;
  length: number;
  text: string;
}

export const filesApi = {
  create: (path: string, dir: boolean) => invoke<void>("create_path", { path, dir }),
  rename: (from: string, to: string) => invoke<void>("rename_path", { from, to }),
  trash: (path: string) => invoke<void>("trash_path", { path }),
  list: (root: string) => invoke<string[]>("list_files", { root }),
  search: (root: string, query: string, regex: boolean, caseSensitive: boolean, include = "", exclude = "") =>
    invoke<SearchMatch[]>("search_text", { root, query, regex, caseSensitive, include, exclude }),
  replace: (paths: string[], query: string, regex: boolean, caseSensitive: boolean, replacement: string) =>
    invoke<number>("replace_in_files", { paths, query, regex, caseSensitive, replacement }),
};

export interface FileChange {
  path: string;
  status: "M" | "A" | "D" | "R" | "C" | "T" | "?" | "U";
  staged: boolean;
}

export interface GitStatus {
  repo_root: string | null;
  branch: string | null;
  ahead: number;
  behind: number;
  has_upstream: boolean;
  changes: FileChange[];
}

export interface Commit {
  hash: string;
  short: string;
  author: string;
  date: string;
  subject: string;
}

export interface BlameLine {
  short: string;
  author: string;
  time: number;
  summary: string;
  uncommitted: boolean;
}

export const gitApi = {
  status: (root: string) => invoke<GitStatus>("git_status", { root }),
  init: (root: string) => invoke<void>("git_init", { root }),
  stage: (repo: string, paths: string[]) => invoke<void>("git_stage", { repo, paths }),
  unstage: (repo: string, paths: string[]) => invoke<void>("git_unstage", { repo, paths }),
  discard: (repo: string, path: string, untracked: boolean) => invoke<void>("git_discard", { repo, path, untracked }),
  commit: (repo: string, message: string, all: boolean, amend = false) => invoke<string>("git_commit", { repo, message, all, amend }),
  headContent: (repo: string, path: string) => invoke<string>("git_head_content", { repo, path }),
  fileAt: (repo: string, rev: string, path: string) => invoke<string>("git_file_at", { repo, rev, path }),
  log: (repo: string, path: string | null, limit = 200) => invoke<Commit[]>("git_log", { repo, path, limit }),
  commitFiles: (repo: string, hash: string) => invoke<{ status: string; path: string }[]>("git_commit_files", { repo, hash }),
  blame: (repo: string, path: string) => invoke<BlameLine[]>("git_blame", { repo, path }),
  stash: (repo: string, action: "save" | "pop" | "drop" | "list", index: number | null = null, message: string | null = null) =>
    invoke<{ index: number; message: string }[]>("git_stash", { repo, action, index, message }),
  branches: (repo: string) => invoke<{ current: string | null; local: string[] }>("git_branches", { repo }),
  checkout: (repo: string, branch: string, create: boolean) => invoke<void>("git_checkout", { repo, branch, create }),
  sync: (repo: string, action: "push" | "pull" | "fetch", jobId: string) => invoke<void>("git_sync", { repo, action, jobId }),
};

export interface Dependency {
  name: string;
  url: string;
  version: string;
}

export const depsApi = {
  list: (root: string) =>
    invoke<{ source: "package" | "xcodegen" | "xcodeproj" | "none"; editable: boolean; items: Dependency[]; error: string | null }>(
      "ios_dependencies",
      { root },
    ),
  add: (root: string, url: string, from: string, target: string | null) =>
    invoke<void>("ios_add_dependency", { root, url, from, target }),
};

export interface AppVersion {
  platform: "ios" | "android";
  version: string | null;
  build: string | null;
  files: string[];
  error: string | null;
}

export const versionApi = {
  get: (root: string) => invoke<AppVersion>("app_version", { root }),
  set: (root: string, version: string, build: string) => invoke<void>("set_app_version", { root, version, build }),
};

/** iOS: Info.plist key + usage description. Android: permission name (value unused). */
export interface AppPermission {
  key: string;
  value: string;
}

export interface AppSettingsInfo {
  platform: "ios" | "android";
  displayName: string | null;
  permissions: AppPermission[];
  files: string[];
  error: string | null;
}

export const appSettingsApi = {
  get: (root: string, scheme: string, configuration: string) => invoke<AppSettingsInfo>("app_settings", { root, scheme, configuration }),
  save: (root: string, scheme: string, configuration: string, displayName: string, permissions: AppPermission[]) =>
    invoke<void>("save_app_settings", { root, scheme, configuration, displayName, permissions }),
};

export const generateAppIcons = (root: string, source: string, background: string) =>
  invoke<string[]>("generate_app_icons", { root, source, background });

export const regenerateProject = (root: string) => invoke<boolean>("ios_regenerate", { root });

/** Android toolchain (Gradle, adb, emulator); same shapes as the iOS commands. */
export const androidApi = {
  platform: (root: string) => invoke<"android" | "ios" | null>("project_platform", { root }),
  projectInfo: (root: string) => invoke<ProjectInfo>("android_project_info", { root }),
  build: (root: string, scheme: string, configuration: string, jobId: string) =>
    invoke<void>("android_build", { root, scheme, configuration, jobId }),
  devices: () => invoke<Device[]>("android_devices"),
  run: (root: string, scheme: string, configuration: string, deviceId: string, debug: boolean, jobId: string) =>
    invoke<void>("android_run", { root, scheme, configuration, deviceId, debug, jobId }),
  archive: (
    root: string,
    scheme: string,
    variant: string,
    format: "aab" | "apk",
    upload: { track: string; serviceAccountJson: string; draft: boolean } | null,
    jobId: string,
  ) => invoke<void>("android_archive", { root, scheme, configuration: variant, format, upload, jobId }),
  pair: (host: string, code: string) => invoke<string>("android_pair", { host, code }),
  connect: (host: string) => invoke<string>("android_connect", { host }),
  mdnsServices: () => invoke<{ name: string; service: string; host: string }[]>("android_mdns_services"),
  stopEmulator: (serial: string) => invoke<void>("android_emulator_stop", { serial }),
};

export interface TestCase {
  /** `Target/Class` (iOS) or `pkg.Class` (Android): pass back as `suite` to run the class. */
  suiteId: string;
  suite: string;
  name: string;
  status: "passed" | "failed" | "skipped";
  duration: number;
  message: string | null;
  file: string | null;
  line: number | null;
}

export interface TestFilter {
  suite: string;
  name?: string;
}

export const testApi = {
  ios: (root: string, scheme: string, configuration: string, deviceId: string | null, signing: SigningOptions, only: TestFilter | null, jobId: string) =>
    invoke<void>("ios_test", { root, scheme, configuration, deviceId, signing, only, jobId }),
  android: (root: string, scheme: string, configuration: string, instrumented: boolean, deviceId: string | null, only: TestFilter | null, jobId: string) =>
    invoke<void>("android_test", { root, scheme, configuration, instrumented, deviceId, only, jobId }),
};

export interface PodsStatus {
  podfileDir: string | null;
  needsInstall: boolean;
  reason: string | null;
}

export const toolApi = {
  iosAction: (root: string, scheme: string, configuration: string, action: "clean" | "resolve", jobId: string) =>
    invoke<void>("ios_project_action", { root, scheme, configuration, action, jobId }),
  androidClean: (root: string, jobId: string) => invoke<void>("android_clean", { root, jobId }),
  podsStatus: (root: string) => invoke<PodsStatus>("ios_pods_status", { root }),
  podInstall: (root: string, jobId: string) => invoke<void>("ios_pod_install", { root, jobId }),
};

// ---------------------------------------------------------------- built-in AI

export interface AiError {
  code: "NO_MODEL" | "OUT_OF_MEMORY" | "CONTEXT_TOO_SMALL" | "DOWNLOAD_FAILED" | "CHECKSUM_MISMATCH" | "CRASHED" | "UNSUPPORTED" | "SERVER";
  message: string;
}

export interface AiHardware {
  supported: boolean;
  reason: string | null;
  memoryGb: number;
  recommendedModel: string | null;
}

export interface CatalogModel {
  id: string;
  name: string;
  description: string;
  url: string;
  size: number;
  sha256: string;
  license: string;
  licenseUrl: string;
  minMemoryGb: number;
  infill: boolean;
}

export interface InstalledModel {
  id: string;
  name: string;
  size: number;
  custom: boolean;
  infill: boolean;
}

export interface AiModels {
  catalog: CatalogModel[];
  installed: InstalledModel[];
  partial: Record<string, number>;
  downloading: string[];
  dir: string;
}

export interface DownloadProgress {
  id: string;
  received: number;
  total: number;
  status: "downloading" | "verifying" | "done" | "paused" | "cancelled" | "error";
  error: AiError | null;
}

export interface AiServerStatus {
  status: "stopped" | "loading" | "ready" | "crashed";
  model: string | null;
  ctx: number | null;
}

export interface ChatRequest {
  model: string;
  ctx: number;
  messages: unknown[];
  tools?: unknown[];
  schema?: unknown;
  maxTokens?: number;
  temperature?: number;
}

export interface AiToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface AiDone {
  finishReason: string | null;
  tokensPerSecond: number | null;
  promptTokens: number | null;
  completionTokens: number | null;
}

export const aiApi = {
  hardware: () => invoke<AiHardware>("ai_hardware"),
  models: () => invoke<AiModels>("ai_models"),
  download: (id: string) => invoke<void>("ai_download", { id }),
  stopDownload: (id: string, discard: boolean) => invoke<void>("ai_download_stop", { id, discard }),
  deleteModel: (id: string) => invoke<void>("ai_delete_model", { id }),
  importModel: (path: string) => invoke<string>("ai_import_model", { path }),
  status: () => invoke<AiServerStatus>("ai_status"),
  unload: () => invoke<void>("ai_unload"),
  configure: (idleMinutes: number) => invoke<void>("ai_configure", { idleMinutes }),
  chat: (id: string, request: ChatRequest) => invoke<void>("ai_chat", { id, request }),
  cancel: (id: string) => invoke<void>("ai_cancel", { id }),
  tokenize: (model: string, ctx: number, text: string) => invoke<number>("ai_tokenize", { model, ctx, text }),
  infill: (model: string, ctx: number, prefix: string, suffix: string) => invoke<string>("ai_infill", { model, ctx, prefix, suffix }),
  loadHistory: (root: string) => invoke<string | null>("ai_history_load", { root }),
  saveHistory: (root: string, json: string) => invoke<void>("ai_history_save", { root, json }),
};

/** "CODE: message" strings from AI commands → AiError. */
export function parseAiError(e: unknown): AiError {
  if (e && typeof e === "object" && "code" in e) return e as AiError;
  const s = String(e);
  const m = /^([A-Z_]+): ([\s\S]*)$/.exec(s);
  return m ? { code: m[1] as AiError["code"], message: m[2] } : { code: "SERVER", message: s };
}
