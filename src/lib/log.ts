import { invoke } from "@tauri-apps/api/core";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";

/** Appends a line to ~/Library/Logs/Orbit/orbit.log (best effort). */
export function logWrite(level: "error" | "warn" | "info", message: string) {
  invoke("log_write", { level, message }).catch(() => {});
}

export function errorText(e: unknown): string {
  if (e instanceof Error) return e.stack ?? `${e.name}: ${e.message}`;
  return typeof e === "string" ? e : JSON.stringify(e);
}

export async function openLogs() {
  await revealItemInDir(await invoke<string>("log_path"));
}

window.addEventListener("error", (e) => logWrite("error", errorText(e.error ?? e.message)));
window.addEventListener("unhandledrejection", (e) => logWrite("error", `unhandled rejection: ${errorText(e.reason)}`));

/** Where Orbit's issues live; also the updater feed's repo (see tauri.conf.json). */
export const REPO_URL = "https://github.com/aryan2621/orbit-ide";

export interface AppInfo {
  version: string;
  macos: string;
  arch: string;
}

export const appInfo = () => invoke<AppInfo>("app_info");

/** Opens a prefilled GitHub issue in the browser. Nothing is sent automatically. */
export async function reportProblem() {
  const info = await appInfo();
  const body = [
    "**What happened?**",
    "",
    "**Steps to reproduce**",
    "1. ",
    "",
    "**Environment**",
    `- Orbit ${info.version}`,
    `- macOS ${info.macos} (${info.arch})`,
    "",
    "_Attach ~/Library/Logs/Orbit/orbit.log if it's relevant (Help: Open Logs). Check it for anything private first._",
  ].join("\n");
  await openUrl(`${REPO_URL}/issues/new?body=${encodeURIComponent(body)}`);
}
