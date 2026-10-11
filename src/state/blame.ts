// Inline blame for the status bar: `git blame` of the active file, refreshed when it's saved or
// the repo changes, looked up by the cursor line.
import { create } from "zustand";
import { BlameLine, gitApi } from "../lib/ipc";
import { useGit } from "./git";
import { useWorkspace } from "./workspace";

export const useBlame = create<{ path: string | null; lines: BlameLine[] }>(() => ({ path: null, lines: [] }));

let seq = 0;
async function load() {
  const { activePath, files } = useWorkspace.getState();
  const status = useGit.getState().status;
  const repo = status?.repo_root;
  const n = ++seq;
  if (!activePath || !repo || !activePath.startsWith(repo + "/")) return useBlame.setState({ path: null, lines: [] });
  const rel = activePath.slice(repo.length + 1);
  // Untracked files have no history.
  if (status.changes.some((c) => c.path === rel && c.status === "?") || !files.some((f) => f.path === activePath)) {
    return useBlame.setState({ path: activePath, lines: [] });
  }
  const lines = await gitApi.blame(repo, rel).catch(() => []);
  if (n === seq) useBlame.setState({ path: activePath, lines });
}

let timer: ReturnType<typeof setTimeout> | null = null;
const schedule = () => {
  if (timer) clearTimeout(timer);
  timer = setTimeout(load, 300);
};
useWorkspace.subscribe((s, prev) => {
  if (s.activePath !== prev.activePath || s.saves !== prev.saves) schedule();
});
useGit.subscribe((s, prev) => {
  if (s.status !== prev.status) schedule();
});

/** "Author, 3 days ago · summary" for a 1-based line. */
export function blameText(line: BlameLine | undefined): string | null {
  if (!line) return null;
  if (line.uncommitted) return "Not committed yet";
  const days = Math.floor((Date.now() / 1000 - line.time) / 86400);
  const when = days < 1 ? "today" : days === 1 ? "yesterday" : days < 30 ? `${days} days ago` : days < 365 ? `${Math.floor(days / 30)} months ago` : `${Math.floor(days / 365)} years ago`;
  return `${line.author}, ${when} · ${line.summary}`;
}
