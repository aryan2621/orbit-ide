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
  kind: "workspace" | "project" | "package";
  path: string;
  name: string;
}

export interface ProjectInfo {
  project: Project | null;
  schemes: string[];
  runnable: string[];
  platform: "ios" | "mac";
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
  build: (root: string, scheme: string, configuration: string, jobId: string) =>
    invoke<void>("ios_build", { root, scheme, configuration, jobId }),
  newProject: (parent: string, name: string, bundleId: string, deploymentTarget: string, jobId: string) =>
    invoke<string>("ios_new_project", { parent, name, bundleId, deploymentTarget, jobId }),
};

export interface Device {
  id: string;
  name: string;
  kind: "simulator" | "device" | "mac";
  os: string;
  booted: boolean;
}

export type RunPhase = "building" | "installing" | "running";

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
  save: (root: string, target: string, bundleId: string, teamId: string) =>
    invoke<void>("ios_save_signing", { root, target, bundleId, teamId }),
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
  search: (root: string, query: string, regex: boolean, caseSensitive: boolean) =>
    invoke<SearchMatch[]>("search_text", { root, query, regex, caseSensitive }),
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

export const gitApi = {
  status: (root: string) => invoke<GitStatus>("git_status", { root }),
  init: (root: string) => invoke<void>("git_init", { root }),
  stage: (repo: string, paths: string[]) => invoke<void>("git_stage", { repo, paths }),
  unstage: (repo: string, paths: string[]) => invoke<void>("git_unstage", { repo, paths }),
  discard: (repo: string, path: string, untracked: boolean) => invoke<void>("git_discard", { repo, path, untracked }),
  commit: (repo: string, message: string, all: boolean) => invoke<string>("git_commit", { repo, message, all }),
  headContent: (repo: string, path: string) => invoke<string>("git_head_content", { repo, path }),
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

export const regenerateProject = (root: string) => invoke<boolean>("ios_regenerate", { root });
