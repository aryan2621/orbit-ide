import { KeyboardEvent, ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { filesApi } from "../lib/ipc";
import { useUi } from "../state/ui";
import { useWorkspace } from "../state/workspace";
import { getCommands } from "./commands";

/** Subsequence match with a score that favours contiguous runs and word starts. */
export function fuzzy(query: string, text: string): { score: number; hits: number[] } | null {
  if (!query) return { score: 0, hits: [] };
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  const hits: number[] = [];
  let score = 0;
  let last = -2;
  for (let i = 0, j = 0; i < q.length; i++) {
    const at = t.indexOf(q[i], j);
    if (at < 0) return null;
    hits.push(at);
    score += at === last + 1 ? 5 : 1;
    if (at === 0 || "/_-. ".includes(t[at - 1])) score += 3;
    last = at;
    j = at + 1;
  }
  return { score: score - t.length * 0.01, hits };
}

function Highlight({ text, hits }: { text: string; hits: number[] }) {
  const set = new Set(hits);
  const out: ReactNode[] = [];
  [...text].forEach((ch, i) => out.push(set.has(i) ? <mark key={i}>{ch}</mark> : ch));
  return <>{out}</>;
}

interface Row {
  key: string;
  title: string;
  detail?: string;
  shortcut?: string;
  hits: number[];
  run: () => void;
}

export default function CommandPalette() {
  const { palette, setPalette } = useUi();
  const root = useWorkspace((s) => s.root);
  const [query, setQuery] = useState(palette === "commands" ? ">" : "");
  const [files, setFiles] = useState<string[]>([]);
  const [index, setIndex] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  const commandMode = query.startsWith(">");
  const close = () => setPalette(null);

  useEffect(() => {
    if (root) filesApi.list(root).then(setFiles, () => setFiles([]));
  }, [root]);

  const rows: Row[] = useMemo(() => {
    if (commandMode) {
      const q = query.slice(1).trim();
      return getCommands()
        .map((c) => ({ c, m: fuzzy(q, c.title) }))
        .filter((x) => x.m)
        .sort((a, b) => b.m!.score - a.m!.score)
        .map(({ c, m }) => ({ key: c.id, title: c.title, shortcut: c.shortcut, hits: m!.hits, run: c.run }));
    }
    if (!root) return [];
    const q = query.trim();
    return files
      .map((f) => {
        const name = f.split("/").pop()!;
        // Prefer matches in the file name, then anywhere in the path.
        const inName = fuzzy(q, name);
        const inPath = inName ? null : fuzzy(q, f);
        const m = inName ? { score: inName.score + 10, hits: inName.hits } : inPath;
        return m ? { f, name, m, inName: !!inName } : null;
      })
      .filter((x): x is NonNullable<typeof x> => !!x)
      .sort((a, b) => b.m.score - a.m.score)
      .slice(0, 200)
      .map(({ f, name, m, inName }) => ({
        key: f,
        title: name,
        detail: f.split("/").slice(0, -1).join("/"),
        hits: inName ? m.hits : [],
        run: () => useWorkspace.getState().openFile(`${root}/${f}`),
      }));
  }, [commandMode, query, files, root]);

  useEffect(() => setIndex(0), [query]);
  useEffect(() => {
    list.current?.querySelector(".palette-row.active")?.scrollIntoView({ block: "nearest" });
  }, [index]);

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setIndex((i) => Math.min(i + 1, rows.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter" && rows[index]) {
      e.preventDefault();
      close();
      rows[index].run();
    } else if (e.key === "Escape") {
      close();
    }
  };

  return (
    <div className="palette-backdrop" onMouseDown={close}>
      <div className="palette" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-label="Command palette">
        <input
          className="palette-input"
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKey}
          placeholder={root ? "Search files by name, or type > for commands" : "Type > for commands"}
        />
        <div className="palette-list" ref={list}>
          {rows.length === 0 && (
            <div className="palette-empty">{commandMode ? "No matching commands" : root ? "No matching files" : "Open a folder to search files"}</div>
          )}
          {rows.map((r, i) => (
            <div
              key={r.key}
              className={`palette-row${i === index ? " active" : ""}`}
              onMouseMove={() => setIndex(i)}
              onClick={() => {
                close();
                r.run();
              }}
            >
              <span className="palette-title">
                <Highlight text={r.title} hits={r.hits} />
              </span>
              {r.detail && <span className="palette-detail">{r.detail}</span>}
              {r.shortcut && <kbd>{r.shortcut}</kbd>}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
