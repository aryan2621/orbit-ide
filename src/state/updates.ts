// Auto-update: a quiet check on launch (at most daily) that shows "Update to x.y.z" in the status
// bar, and "Orbit: Check for Updates" in the palette. Installing restarts the app.
import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { ask } from "@tauri-apps/plugin-dialog";
import { errorText, logWrite } from "../lib/log";
import { confirmDiscardAll } from "../editor/unsaved";
import { toast } from "./toasts";

export interface UpdateInfo {
  version: string;
  currentVersion: string;
  notes: string | null;
  date: string | null;
}

interface UpdatesState {
  available: UpdateInfo | null;
  /** Bytes downloaded while installing; null when not installing. */
  progress: { received: number; total: number | null } | null;
}

export const useUpdates = create<UpdatesState>(() => ({ available: null, progress: null }));

const LAST_CHECK_KEY = "orbit.updateCheck";
const DAY = 24 * 60 * 60 * 1000;

/** Checks GitHub Releases. `manual` reports "up to date" and errors; the launch check stays quiet. */
export async function checkForUpdates(manual = false) {
  try {
    const available = await invoke<UpdateInfo | null>("update_check");
    try {
      localStorage.setItem(LAST_CHECK_KEY, String(Date.now()));
    } catch {}
    useUpdates.setState({ available });
    if (manual) {
      if (available) await installUpdate();
      else toast("Orbit is up to date");
    }
  } catch (e) {
    logWrite("warn", `update check: ${errorText(e)}`);
    if (manual) toast(`Couldn't check for updates: ${errorText(e)}`, "error");
  }
}

export async function installUpdate() {
  const u = useUpdates.getState().available;
  if (!u || useUpdates.getState().progress) return;
  const notes = u.notes?.trim() ? `\n\n${u.notes.trim().slice(0, 1200)}` : "";
  if (!(await ask(`Orbit ${u.version} is available (you have ${u.currentVersion}). Install it and restart?${notes}`, { title: "Update Orbit", okLabel: "Install and Restart", cancelLabel: "Later" }))) return;
  if (!(await confirmDiscardAll("Orbit restarts to finish the update."))) return;
  useUpdates.setState({ progress: { received: 0, total: null } });
  try {
    await invoke("update_install");
  } catch (e) {
    useUpdates.setState({ progress: null });
    logWrite("error", `update install: ${errorText(e)}`);
    toast(`Update failed: ${errorText(e)}`, "error");
  }
}

listen<{ received: number; total: number | null }>("update://progress", (e) => useUpdates.setState({ progress: e.payload }));

// Launch check, at most once a day; skipped in development builds.
if (!import.meta.env.DEV) {
  let last = 0;
  try {
    last = Number(localStorage.getItem(LAST_CHECK_KEY)) || 0;
  } catch {}
  if (Date.now() - last > DAY) setTimeout(() => checkForUpdates(), 10_000);
}
