import { useEffect, useState } from "react";
import { ask } from "@tauri-apps/plugin-dialog";
import { FileChange, gitApi } from "../lib/ipc";
import { useGit } from "../state/git";
import { useUi } from "../state/ui";
import { useWorkspace } from "../state/workspace";
import { openContextMenu } from "../components/ContextMenu";
import { IconArrowDown, IconArrowUp, IconMinus, IconPlus, IconRefresh, IconUndo } from "../components/Icons";

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
  const letter = change.status === "?" ? "U" : change.status;
  const deleted = change.status === "D";

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
      onClick={() => (deleted ? undefined : setDiffPath(change.path))}
      onContextMenu={(e) =>
        openContextMenu(e, [
          { label: "Open Changes", disabled: deleted, onSelect: () => setDiffPath(change.path) },
          { label: "Open File", disabled: deleted, onSelect: () => openFile(`${repo}/${change.path}`) },
          null,
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
        onKeyDown={(e) => (e.key === "Enter" ? finish(true) : e.key === "Escape" && finish(false))}
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

export default function SourceControl({ root }: { root: string }) {
  const { status, busy, error, syncLog, refresh, run, sync } = useGit();
  const [message, setMessage] = useState("");

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
  const commitAll = staged.length === 0;
  const canCommit = message.trim() && (staged.length > 0 || unstaged.some((c) => c.status !== "?")) && !busy;

  const commit = async () => {
    if (await run("commit", (r) => gitApi.commit(r, message.trim(), commitAll))) setMessage("");
  };

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
        <button className="btn primary" disabled={!canCommit} onClick={commit}>
          {busy === "commit" ? <span className="spinner" /> : commitAll ? "Commit all changes" : `Commit ${staged.length} staged`}
        </button>
        {busy && busy !== "commit" && <div className="muted scm-busy"><span className="spinner" /> git {busy}…</div>}
        {error && <pre className="check-error scm-error">{error}</pre>}
        {busy && (busy === "push" || busy === "pull") && syncLog.length > 0 && (
          <div className="muted scm-busy">{syncLog[syncLog.length - 1]}</div>
        )}
      </div>
      <div className="sidebar-body">
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
          Changes <span className="badge">{unstaged.length}</span>
          {unstaged.length > 0 && (
            <button className="link" onClick={() => run("stage", (r) => gitApi.stage(r, unstaged.map((c) => c.path)))}>
              Stage all
            </button>
          )}
        </div>
        {unstaged.length === 0 && <div className="var-empty">No changes</div>}
        {unstaged.map((c) => (
          <ChangeRow key={`u-${c.path}`} change={c} repo={repo} />
        ))}
      </div>
    </div>
  );
}
