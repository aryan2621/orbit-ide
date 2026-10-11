import { useEffect, useState } from "react";
import { ask } from "@tauri-apps/plugin-dialog";
import { Commit, FileChange, gitApi } from "../lib/ipc";
import { useGit } from "../state/git";
import { useUi } from "../state/ui";
import { useWorkspace } from "../state/workspace";
import { openContextMenu } from "../components/ContextMenu";
import { IconArrowDown, IconArrowUp, IconChevronDown, IconChevronRight, IconMinus, IconMore, IconPlus, IconRefresh, IconUndo } from "../components/Icons";

const STATUS_LABEL: Record<string, string> = {
  M: "Modified",
  A: "Added",
  D: "Deleted",
  R: "Renamed",
  C: "Copied",
  T: "Type changed",
  "?": "Untracked",
  U: "Conflict",
};

function ChangeRow({ change, repo }: { change: FileChange; repo: string }) {
  const { run } = useGit();
  const setDiffPath = useUi((s) => s.setDiffPath);
  const openFile = useWorkspace((s) => s.openFile);
  const name = change.path.split("/").pop();
  const dir = change.path.split("/").slice(0, -1).join("/");
  // Untracked shows as "U", a merge conflict (git's "U") as "C".
  const letter = change.status === "?" ? "U" : change.status === "U" ? "C" : change.status;
  const deleted = change.status === "D";
  const conflict = change.status === "U";
  // Staged: HEAD ↔ index. Unstaged: index ↔ working copy (the index is HEAD for unstaged-only files).
  const showDiff = () => setDiffPath(change.path, change.staged ? { left: "HEAD", right: ":" } : { left: ":", right: "working" });
  const open = () => openFile(`${repo}/${change.path}`);

  const discard = async () => {
    const untracked = change.status === "?";
    const ok = await ask(untracked ? `Move ${change.path} to the Trash?` : `Discard your changes to ${change.path}?`, {
      title: untracked ? "Delete new file" : "Discard changes",
      kind: "warning",
      okLabel: untracked ? "Move to Trash" : "Discard",
    });
    if (ok) run("discard", (r) => gitApi.discard(r, change.path, untracked));
  };

  return (
    <div
      className={`change-row git-${letter}`}
      onClick={() => (deleted ? undefined : conflict ? open() : showDiff())}
      onContextMenu={(e) =>
        openContextMenu(e, [
          { label: "Open Changes", disabled: deleted || conflict, onSelect: showDiff },
          { label: "Open File", disabled: deleted, onSelect: open },
          { label: "File History", disabled: deleted, onSelect: () => useGit.getState().showHistory(`${repo}/${change.path}`) },
          null,
          conflict && { label: "Mark Resolved (Stage)", onSelect: () => run("stage", (r) => gitApi.stage(r, [change.path])) },
          change.staged
            ? { label: "Unstage", onSelect: () => run("unstage", (r) => gitApi.unstage(r, [change.path])) }
            : { label: "Stage", onSelect: () => run("stage", (r) => gitApi.stage(r, [change.path])) },
          { label: "Discard Changes", danger: true, disabled: change.staged, onSelect: discard },
        ])
      }
      title={`${change.path} · ${STATUS_LABEL[change.status] ?? change.status}`}
    >
      <span className="change-name">{name}</span>
      <span className="change-dir">{dir}</span>
      <span className="change-actions" onClick={(e) => e.stopPropagation()}>
        {!change.staged && (
          <button className="icon-btn tiny" title="Discard changes" onClick={discard}>
            <IconUndo />
          </button>
        )}
        {change.staged ? (
          <button className="icon-btn tiny" title="Unstage" onClick={() => run("unstage", (r) => gitApi.unstage(r, [change.path]))}>
            <IconMinus />
          </button>
        ) : (
          <button className="icon-btn tiny" title="Stage" onClick={() => run("stage", (r) => gitApi.stage(r, [change.path]))}>
            <IconPlus />
          </button>
        )}
      </span>
      <span className="change-letter">{letter}</span>
    </div>
  );
}

function BranchPicker({ repo, current }: { repo: string; current: string | null }) {
  const { run } = useGit();
  const [branches, setBranches] = useState<string[]>([]);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  useEffect(() => {
    gitApi.branches(repo).then((b) => setBranches(b.local), () => setBranches([]));
  }, [repo, current]);

  if (creating) {
    const finish = (create: boolean) => {
      if (create && name.trim()) run("branch", (r) => gitApi.checkout(r, name.trim(), true));
      setCreating(false);
      setName("");
    };
    return (
      <input
        className="text-input branch-picker"
        autoFocus
        placeholder="New branch name ↩"
        value={name}
        onChange={(e) => setName(e.target.value.replace(/\s+/g, "-"))}
        onKeyDown={(e) => (e.key === "Enter" ? finish(true) : e.key === "Escape" && (e.preventDefault(), finish(false)))}
        onBlur={() => finish(false)}
      />
    );
  }

  return (
    <select
      className="picker branch-picker"
      value={current ?? ""}
      title="Switch branch"
      onChange={(e) => {
        const v = e.target.value;
        if (v === "__new__") setCreating(true);
        else if (v) {
          run("checkout", (r) => gitApi.checkout(r, v, false));
        }
      }}
    >
      {!current && <option value="">(detached HEAD)</option>}
      {branches.map((b) => (
        <option key={b}>{b}</option>
      ))}
      <option value="__new__">＋ New branch…</option>
    </select>
  );
}

/** Recent commits (of one file when `historyPath` is set); expand a commit to diff its files. */
function History({ repo }: { repo: string }) {
  const { historyPath, status } = useGit();
  const setDiffPath = useUi((s) => s.setDiffPath);
  const [open, setOpen] = useState(false);
  const [commits, setCommits] = useState<Commit[] | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [files, setFiles] = useState<{ status: string; path: string }[]>([]);
  const shown = open || !!historyPath;

  useEffect(() => {
    if (!shown) return;
    gitApi.log(repo, historyPath).then(setCommits, () => setCommits([]));
  }, [repo, historyPath, shown, status?.branch, status?.ahead]);

  const expand = (hash: string) => {
    if (expanded === hash) return setExpanded(null);
    setExpanded(hash);
    setFiles([]);
    gitApi.commitFiles(repo, hash).then(setFiles, () => setFiles([]));
  };

  return (
    <>
      <div className="scm-group clickable" onClick={() => (historyPath ? useGit.setState({ historyPath: null }) : setOpen(!open))}>
        {shown ? <IconChevronDown /> : <IconChevronRight />}
        {historyPath ? <>History of {historyPath.split("/").pop()}</> : "History"}
        {historyPath && <span className="link">Show all</span>}
      </div>
      {shown &&
        (commits ?? []).map((c) => (
          <div key={c.hash}>
            <div className="commit-row" title={`${c.hash}\n${c.author}, ${c.date}`} onClick={() => expand(c.hash)}>
              <span className="commit-subject">{c.subject}</span>
              <span className="muted commit-meta">
                {c.author.split(" ")[0]} · {c.date}
              </span>
            </div>
            {expanded === c.hash &&
              files
                .filter((f) => !historyPath || f.path === historyPath || files.length === 1)
                .map((f) => (
                  <div
                    key={f.path}
                    className={`change-row commit-file git-${f.status}`}
                    onClick={() => f.status !== "D" && setDiffPath(f.path, { left: `${c.hash}^`, right: c.hash })}
                  >
                    <span className="change-name">{f.path.split("/").pop()}</span>
                    <span className="change-dir">{f.path.split("/").slice(0, -1).join("/")}</span>
                    <span className="change-letter">{f.status}</span>
                  </div>
                ))}
          </div>
        ))}
      {shown && commits?.length === 0 && <div className="var-empty">No commits yet</div>}
    </>
  );
}

function Stashes({ stashes, onChange }: { stashes: { index: number; message: string }[]; onChange: (s: { index: number; message: string }[]) => void }) {
  const run = useGit((s) => s.run);
  if (stashes.length === 0) return null;
  const act = (action: "pop" | "drop", index: number) =>
    run(action === "pop" ? "stash pop" : "stash drop", async (r) => onChange(await gitApi.stash(r, action, index)));
  return (
    <>
      <div className="scm-group">
        Stashes <span className="badge">{stashes.length}</span>
      </div>
      {stashes.map((s) => (
        <div key={s.index} className="change-row">
          <span className="change-name" title={s.message}>
            {s.message}
          </span>
          <span className="change-actions visible">
            <button className="link" onClick={() => act("pop", s.index)}>
              Pop
            </button>
            <button
              className="link danger"
              onClick={async () => (await ask(`Delete stash "${s.message}"?`, { kind: "warning", okLabel: "Delete" })) && act("drop", s.index)}
            >
              Drop
            </button>
          </span>
        </div>
      ))}
    </>
  );
}

export default function SourceControl({ root }: { root: string }) {
  const { status, busy, error, syncLog, refresh, run, sync } = useGit();
  const [message, setMessage] = useState("");
  const [amend, setAmend] = useState(false);
  const [stashes, setStashes] = useState<{ index: number; message: string }[]>([]);

  useEffect(() => {
    if (status?.repo_root) gitApi.stash(status.repo_root, "list").then(setStashes, () => setStashes([]));
  }, [status?.repo_root, status?.changes.length]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  if (status === null) return <div className="sidebar-view"><div className="sidebar-empty">Loading…</div></div>;

  if (!status.repo_root) {
    return (
      <div className="sidebar-view">
        <div className="sidebar-header">
          <span className="sidebar-title">Source Control</span>
        </div>
        <div className="sidebar-empty">
          <div>This folder isn't a Git repository.</div>
          <button className="btn primary" onClick={() => gitApi.init(root).then(refresh)}>
            Initialize Repository
          </button>
        </div>
      </div>
    );
  }

  const repo = status.repo_root;
  const staged = status.changes.filter((c) => c.staged);
  const unstaged = status.changes.filter((c) => !c.staged);
  const conflicts = unstaged.filter((c) => c.status === "U");
  const changes = unstaged.filter((c) => c.status !== "U");
  const commitAll = staged.length === 0;
  const canCommit = message.trim() && (amend || staged.length > 0 || changes.some((c) => c.status !== "?")) && conflicts.length === 0 && !busy;

  const commit = async () => {
    if (await run("commit", (r) => gitApi.commit(r, message.trim(), commitAll && !amend, amend))) {
      setMessage("");
      setAmend(false);
    }
  };

  const more = (e: React.MouseEvent) =>
    openContextMenu(e, [
      { label: "Fetch", disabled: !!busy, onSelect: () => sync("fetch") },
      null,
      {
        label: "Stash Changes",
        disabled: status.changes.length === 0,
        // The commit box doubles as the stash message.
        onSelect: () => run("stash", async (r) => setStashes(await gitApi.stash(r, "save", null, message.trim() || null))),
      },
      { label: "Pop Latest Stash", disabled: stashes.length === 0, onSelect: () => run("stash pop", async (r) => setStashes(await gitApi.stash(r, "pop", 0))) },
      null,
      { label: "Show History", onSelect: () => useGit.getState().showHistory(null) },
    ]);

  return (
    <div className="sidebar-view">
      <div className="sidebar-header">
        <span className="sidebar-title">Source Control</span>
        <button className="icon-btn small" title="Pull" onClick={() => sync("pull")} disabled={!!busy || !status.has_upstream}>
          <IconArrowDown />
        </button>
        <button className="icon-btn small" title="Push" onClick={() => sync("push")} disabled={!!busy}>
          <IconArrowUp />
        </button>
        <button className="icon-btn small" title="Refresh" onClick={refresh}>
          <IconRefresh />
        </button>
        <button className="icon-btn small" title="More: fetch, stash, history" onClick={more}>
          <IconMore />
        </button>
      </div>
      <div className="scm-top">
        <div className="row gap">
          <BranchPicker repo={repo} current={status.branch} />
          {(status.ahead > 0 || status.behind > 0) && (
            <span className="muted scm-ab" title="Commits ahead / behind upstream">
              ↑{status.ahead} ↓{status.behind}
            </span>
          )}
        </div>
        <textarea
          className="text-input commit-box"
          placeholder={`Message (⌘↩ to commit on ${status.branch ?? "HEAD"})`}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && e.metaKey && canCommit && commit()}
          rows={3}
        />
        <label className="check">
          <input
            type="checkbox"
            checked={amend}
            onChange={(e) => {
              setAmend(e.target.checked);
              // Start from the last commit's message, like `git commit --amend`.
              if (e.target.checked && !message.trim()) gitApi.log(repo, null, 1).then((c) => c[0] && setMessage(c[0].subject), () => {});
            }}
          />{" "}
          Amend last commit
        </label>
        <button className="btn primary" disabled={!canCommit} onClick={commit} title={conflicts.length ? "Resolve the merge conflicts first" : undefined}>
          {busy === "commit" ? <span className="spinner" /> : amend ? "Amend commit" : commitAll ? "Commit all changes" : `Commit ${staged.length} staged`}
        </button>
        {busy && busy !== "commit" && <div className="muted scm-busy"><span className="spinner" /> git {busy}…</div>}
        {error && <pre className="check-error scm-error">{error}</pre>}
        {busy && (busy === "push" || busy === "pull") && syncLog.length > 0 && (
          <div className="muted scm-busy">{syncLog[syncLog.length - 1]}</div>
        )}
      </div>
      <div className="sidebar-body">
        {conflicts.length > 0 && (
          <>
            <div className="scm-group">
              Merge Conflicts <span className="badge">{conflicts.length}</span>
            </div>
            {conflicts.map((c) => (
              <ChangeRow key={`c-${c.path}`} change={c} repo={repo} />
            ))}
            <div className="var-empty">Open a file, pick Accept Current / Incoming / Both above each conflict, save, then Mark Resolved.</div>
          </>
        )}
        {staged.length > 0 && (
          <>
            <div className="scm-group">
              Staged <span className="badge">{staged.length}</span>
              <button className="link" onClick={() => run("unstage", (r) => gitApi.unstage(r, staged.map((c) => c.path)))}>
                Unstage all
              </button>
            </div>
            {staged.map((c) => (
              <ChangeRow key={`s-${c.path}`} change={c} repo={repo} />
            ))}
          </>
        )}
        <div className="scm-group">
          Changes <span className="badge">{changes.length}</span>
          {changes.length > 0 && (
            <button className="link" onClick={() => run("stage", (r) => gitApi.stage(r, changes.map((c) => c.path)))}>
              Stage all
            </button>
          )}
        </div>
        {changes.length === 0 && <div className="var-empty">No changes</div>}
        {changes.map((c) => (
          <ChangeRow key={`u-${c.path}`} change={c} repo={repo} />
        ))}
        <Stashes stashes={stashes} onChange={setStashes} />
        <History repo={repo} />
      </div>
    </div>
  );
}
