import { KeyboardEvent, useEffect, useRef, useState } from "react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { DirEntry, filesApi, fsApi, regenerateProject } from "../lib/ipc";
import { useWorkspace } from "../state/workspace";
import { pathMoved } from "../editor/model-sync";
import { useUi } from "../state/ui";
import { useGit } from "../state/git";
import { openContextMenu } from "../components/ContextMenu";
import {
  IconChevronDown,
  IconChevronRight,
  IconFile,
  IconFilePlus,
  IconFolder,
  IconFolderPlus,
  IconRefresh,
} from "../components/Icons";

/** Folders the user expanded, kept across tree refreshes. */
const expanded = new Set<string>();

type Pending = { kind: "file" | "folder"; parent: string } | { kind: "rename"; path: string } | null;

function useGitDecorations() {
  const status = useGit((s) => s.status);
  const map = new Map<string, string>();
  if (status?.repo_root) {
    for (const c of status.changes) {
      const abs = `${status.repo_root}/${c.path}`;
      // Unstaged wins for display; untracked shows as added, a conflict as "C".
      if (!map.has(abs) || !c.staged) map.set(abs, c.status === "?" ? "A" : c.status === "U" ? "C" : c.status);
    }
  }
  return map;
}

async function afterStructureChange(root: string) {
  useWorkspace.getState().refreshTree();
  // XcodeGen projects pick up added/removed files only after regenerating.
  regenerateProject(root).catch((e) => useWorkspace.setState({ error: `XcodeGen: ${e}` }));
}

function InlineInput({
  initial,
  depth,
  isDir,
  onDone,
}: {
  initial: string;
  depth: number;
  isDir: boolean;
  onDone: (value: string | null) => void;
}) {
  const [value, setValue] = useState(initial);
  const done = useRef(false);
  // Enter and the blur that follows must only finish once.
  const finish = (v: string | null) => {
    if (done.current) return;
    done.current = true;
    onDone(v);
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") finish(value.trim() || null);
    else if (e.key === "Escape") (e.preventDefault(), finish(null));
  };
  return (
    <div className="tree-row editing" style={{ paddingLeft: 4 + depth * 12 }}>
      <span className="tree-chevron" />
      <span className="tree-icon">{isDir ? <IconFolder /> : <IconFile />}</span>
      <input
        className="tree-input"
        autoFocus
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={onKey}
        onBlur={() => finish(value.trim() && value.trim() !== initial ? value.trim() : null)}
        onFocus={(e) => {
          // Select the name without the extension, like Finder.
          const dot = initial.lastIndexOf(".");
          e.target.setSelectionRange(0, dot > 0 ? dot : initial.length);
        }}
      />
    </div>
  );
}

function TreeNode({
  entry,
  depth,
  pending,
  setPending,
  decorations,
}: {
  entry: DirEntry;
  depth: number;
  pending: Pending;
  setPending: (p: Pending) => void;
  decorations: Map<string, string>;
}) {
  const [open, setOpen] = useState(expanded.has(entry.path));
  const { activePath, openFile, root } = useWorkspace();
  const toggle = (next = !open) => {
    if (next) expanded.add(entry.path);
    else expanded.delete(entry.path);
    setOpen(next);
  };

  useEffect(() => {
    // Open the folder when a new item is being created inside it.
    if (pending && pending.kind !== "rename" && pending.parent === entry.path && !open) toggle(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending]);

  const remove = async () => {
    try {
      await filesApi.trash(entry.path);
      pathMoved(entry.path, null);
      afterStructureChange(root!);
    } catch (e) {
      useWorkspace.setState({ error: String(e) });
    }
  };

  const onContextMenu = (e: React.MouseEvent) => {
    const parent = entry.is_dir ? entry.path : entry.path.slice(0, entry.path.lastIndexOf("/"));
    openContextMenu(e, [
      { label: "New File", onSelect: () => setPending({ kind: "file", parent }) },
      { label: "New Folder", onSelect: () => setPending({ kind: "folder", parent }) },
      null,
      { label: "Rename", shortcut: "↩", onSelect: () => setPending({ kind: "rename", path: entry.path }) },
      { label: "Reveal in Finder", onSelect: () => revealItemInDir(entry.path) },
      !entry.is_dir && { label: "File History", onSelect: () => useGit.getState().showHistory(entry.path) },
      { label: "Copy Path", onSelect: () => navigator.clipboard.writeText(entry.path) },
      null,
      { label: "Move to Trash", danger: true, onSelect: remove },
    ]);
  };

  if (pending?.kind === "rename" && pending.path === entry.path) {
    return (
      <InlineInput
        initial={entry.name}
        depth={depth}
        isDir={entry.is_dir}
        onDone={async (name) => {
          setPending(null);
          if (!name) return;
          const invalid = invalidName(name);
          if (invalid) return useWorkspace.setState({ error: invalid });
          const to = entry.path.slice(0, entry.path.lastIndexOf("/") + 1) + name;
          try {
            await filesApi.rename(entry.path, to);
            pathMoved(entry.path, to);
            afterStructureChange(root!);
          } catch (e) {
            useWorkspace.setState({ error: String(e) });
          }
        }}
      />
    );
  }

  const git = decorations.get(entry.path);
  return (
    <>
      <div
        className={`tree-row${activePath === entry.path ? " active" : ""}${git ? ` git-${git}` : ""}`}
        style={{ paddingLeft: 4 + depth * 12 }}
        onClick={() => (entry.is_dir ? toggle() : openFile(entry.path))}
        onContextMenu={onContextMenu}
        title={entry.path}
      >
        <span className="tree-chevron">{entry.is_dir && (open ? <IconChevronDown /> : <IconChevronRight />)}</span>
        <span className="tree-icon">{entry.is_dir ? <IconFolder /> : <IconFile />}</span>
        <span className="tree-name">{entry.name}</span>
        {git && <span className="tree-git">{git}</span>}
      </div>
      {entry.is_dir && open && (
        <DirChildren path={entry.path} depth={depth + 1} pending={pending} setPending={setPending} decorations={decorations} />
      )}
    </>
  );
}

function DirChildren({
  path,
  depth,
  pending,
  setPending,
  decorations,
}: {
  path: string;
  depth: number;
  pending: Pending;
  setPending: (p: Pending) => void;
  decorations: Map<string, string>;
}) {
  const [entries, setEntries] = useState<DirEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const treeVersion = useWorkspace((s) => s.treeVersion);
  const folderVersion = useWorkspace((s) => s.folderVersions[path] ?? 0);
  const { root, openFile } = useWorkspace();

  useEffect(() => {
    fsApi.readDir(path).then(setEntries, (e) => setError(String(e)));
  }, [path, treeVersion, folderVersion]);

  if (error) return <div className="tree-error" style={{ paddingLeft: 10 + depth * 12 }}>{error}</div>;
  if (!entries) return null;
  const creating = pending && pending.kind !== "rename" && pending.parent === path ? pending : null;
  return (
    <>
      {creating && (
        <InlineInput
          initial=""
          depth={depth}
          isDir={creating.kind === "folder"}
          onDone={async (name) => {
            setPending(null);
            if (!name) return;
            const invalid = invalidName(name);
            if (invalid) return useWorkspace.setState({ error: invalid });
            const target = `${path}/${name}`;
            try {
              await filesApi.create(target, creating.kind === "folder");
              afterStructureChange(root!);
              if (creating.kind === "file") openFile(target);
            } catch (e) {
              useWorkspace.setState({ error: String(e) });
            }
          }}
        />
      )}
      {entries.map((e) => (
        <TreeNode key={e.path} entry={e} depth={depth} pending={pending} setPending={setPending} decorations={decorations} />
      ))}
    </>
  );
}

/** The folder for ⌘N: the active file's folder when it's visible in the tree, else the root. */
export function newFileFolder(root: string) {
  const active = useWorkspace.getState().activePath;
  const dir = active?.slice(0, active.lastIndexOf("/"));
  return dir && dir.startsWith(root) && (dir === root || expanded.has(dir)) ? dir : root;
}

export default function Explorer({ root }: { root: string }) {
  const [pending, setPending] = useState<Pending>(null);
  const newFileIn = useUi((s) => s.newFileIn);
  useEffect(() => {
    if (!newFileIn) return;
    setPending({ kind: "file", parent: newFileIn });
    useUi.getState().setNewFileIn(null);
  }, [newFileIn]);
  const refreshTree = useWorkspace((s) => s.refreshTree);
  const decorations = useGitDecorations();

  return (
    <div className="sidebar-view">
      <div className="sidebar-header">
        <span className="sidebar-title" title={root}>
          {root.split("/").pop()}
        </span>
        <button className="icon-btn small" title="New File" onClick={() => setPending({ kind: "file", parent: root })}>
          <IconFilePlus />
        </button>
        <button className="icon-btn small" title="New Folder" onClick={() => setPending({ kind: "folder", parent: root })}>
          <IconFolderPlus />
        </button>
        <button className="icon-btn small" title="Refresh" onClick={refreshTree}>
          <IconRefresh />
        </button>
      </div>
      <div
        className="sidebar-body"
        onContextMenu={(e) =>
          e.target === e.currentTarget &&
          openContextMenu(e, [
            { label: "New File", onSelect: () => setPending({ kind: "file", parent: root }) },
            { label: "New Folder", onSelect: () => setPending({ kind: "folder", parent: root }) },
          ])
        }
      >
        <DirChildren path={root} depth={0} pending={pending} setPending={setPending} decorations={decorations} />
      </div>
    </div>
  );
}

/** Why a new file/folder name can't be used, or null. Names are single path components. */
function invalidName(name: string): string | null {
  if (name.includes("/") || name.includes("\\")) return `"${name}": names can't contain slashes`;
  if (name === "." || name === "..") return `"${name}" isn't a valid name`;
  if (name.includes("\0")) return "Names can't contain null characters";
  return null;
}
