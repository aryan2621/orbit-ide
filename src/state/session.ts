// Restores the last session on launch: the folder, its open tabs and the active tab. Unsaved edits
// are backed up as you type, so a crash or force-quit doesn't lose them; they come back as unsaved
// changes the next time the folder opens.
import { fsApi } from "../lib/ipc";
import * as monaco from "monaco-editor";
import { ensureFileModel, fileText, isDirty, markSaved, savedText, useWorkspace } from "./workspace";
import { modelUri } from "../editor/monaco-setup";

interface Session {
  tabs: string[];
  active: string | null;
  /** Unsaved edits: path → the edited text and the on-disk text it was based on. */
  backups: Record<string, { content: string; saved: string }>;
}

const LAST_ROOT_KEY = "orbit.lastRoot";
const sessionKey = (root: string) => `orbit.session:${root}`;
/** Larger files aren't backed up (browser storage is only a few MB). */
const MAX_BACKUP_CHARS = 500_000;

function read<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function write(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage full: drop backups and keep at least the tab list.
    try {
      const v = value as Session;
      if (v && typeof v === "object" && "backups" in v) localStorage.setItem(key, JSON.stringify({ ...v, backups: {} }));
    } catch {}
  }
}

let restoring = false;
/** Set once the user chose to quit (saving or discarding): don't resurrect discarded edits. */
let exiting = false;

/** Tabs + each dirty model's version at the last write: nothing changed → nothing to write. */
let lastWritten = "";

function save() {
  if (restoring || exiting) return;
  const { root, files, activePath } = useWorkspace.getState();
  if (!root) return;
  const versions = files.map((f) => `${f.path}:${f.dirty ? monaco.editor.getModel(modelUri(f.path))?.getVersionId() : ""}`);
  const key = [root, activePath, ...versions].join("\n");
  if (key === lastWritten) return;
  lastWritten = key;
  const backups: Session["backups"] = {};
  for (const f of files) {
    const content = isDirty(f) ? fileText(f.path) : null;
    if (content !== null && content.length <= MAX_BACKUP_CHARS) backups[f.path] = { content, saved: savedText(f.path) ?? "" };
  }
  write(sessionKey(root), { tabs: files.map((f) => f.path), active: activePath, backups } satisfies Session);
  write(LAST_ROOT_KEY, root);
}

let timer: ReturnType<typeof setTimeout> | null = null;
useWorkspace.subscribe((s, prev) => {
  if (s.files === prev.files && s.activePath === prev.activePath && s.root === prev.root) return;
  if (s.root !== prev.root) {
    if (timer) clearTimeout(timer);
    // Leaving a folder means its unsaved files were saved or discarded on purpose: keep its tabs
    // for next time, but not the edits.
    if (prev.root) write(sessionKey(prev.root), { tabs: prev.files.map((f) => f.path), active: prev.activePath, backups: {} } satisfies Session);
    if (s.root) restore(s.root);
    else write(LAST_ROOT_KEY, null); // went Home: start there next time too
    return;
  }
  scheduleBackup();
});

/** Saves the session (with backups of unsaved edits) shortly after the last change. */
export function scheduleBackup() {
  if (timer) clearTimeout(timer);
  timer = setTimeout(save, 800);
}

/** Called when the user confirmed quitting: their decision about unsaved files is final. */
export function markExiting() {
  if (timer) clearTimeout(timer);
  exiting = false;
  lastWritten = "";
  save(); // record the tabs…
  exiting = true;
  const root = useWorkspace.getState().root;
  const s = root ? read<Session>(sessionKey(root)) : null;
  if (root && s) write(sessionKey(root), { ...s, backups: {} }); // …but not the discarded edits
}

/** Reopens the tabs saved for `root`, re-applying any unsaved edits. */
async function restore(root: string) {
  const session = read<Session>(sessionKey(root));
  write(LAST_ROOT_KEY, root);
  if (!session || session.tabs.length === 0) return;
  restoring = true;
  let changedOnDisk = 0;
  try {
    for (const path of session.tabs) {
      if (useWorkspace.getState().root !== root) return;
      let disk: string;
      try {
        disk = await fsApi.readFile(path);
      } catch {
        continue; // deleted or moved since
      }
      if (useWorkspace.getState().files.some((f) => f.path === path)) continue;
      const model = ensureFileModel(path, disk);
      useWorkspace.setState((s) => ({ files: [...s.files, { path, dirty: false }] }));
      markSaved(path, disk);
      const backup = session.backups[path];
      if (backup && backup.content !== disk) {
        if (backup.saved !== disk) changedOnDisk++;
        // One undoable edit: ⌘Z goes back to the disk version.
        model.pushEditOperations([], [{ range: model.getFullModelRange(), text: backup.content }], () => null);
      }
    }
    const { files } = useWorkspace.getState();
    const active = session.active && files.some((f) => f.path === session.active) ? session.active : (files[0]?.path ?? null);
    useWorkspace.setState({ activePath: active });
    const restored = Object.keys(session.backups).filter((p) => files.some((f) => f.path === p && isDirty(f))).length;
    if (restored > 0) {
      useWorkspace.setState({
        error:
          `Restored unsaved changes in ${restored} file${restored === 1 ? "" : "s"} from your last session.` +
          (changedOnDisk ? ` ${changedOnDisk} of them changed on disk since; compare before saving.` : ""),
      });
    }
  } finally {
    restoring = false;
  }
}

/** On launch, reopen the folder from last time (if it still exists). */
export async function restoreLastFolder() {
  const last = read<string>(LAST_ROOT_KEY);
  if (!last || useWorkspace.getState().root) return;
  try {
    await fsApi.readDir(last);
  } catch {
    return;
  }
  if (!useWorkspace.getState().root) useWorkspace.getState().setRoot(last);
}
