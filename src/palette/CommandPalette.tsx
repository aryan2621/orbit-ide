import { KeyboardEvent, ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { filesApi } from "../lib/ipc";
import { documentSymbols, SymbolItem, workspaceSymbols } from "../lsp/servers";
import { activeEditor, openAt } from "../editor/navigation";
import { useUi } from "../state/ui";
import { useWorkspace } from "../state/workspace";
import { getCommands } from "./commands";
import { fuzzy } from "./fuzzy";

function Highlight({ text, hits }: { text: string; hits: number[] }) {
  const set = new Set(hits);
  const out: ReactNode[] = [];
  [...text].forEach((ch, i) => out.push(set.has(i) ? <mark key={i}>{ch}</mark> : ch));
  return <>{out}</>;
}

const PREFIX: Record<string, string> = { commands: ">", symbols: "@", "workspace-symbols": "#", line: ":" };

// Indexed by Monaco SymbolKind.
const KIND_NAMES = [
  "file", "module", "namespace", "package", "class", "method", "property", "field", "constructor", "enum",
  "interface", "function", "variable", "constant", "string", "number", "boolean", "array", "object", "key",
  "null", "enum member", "struct", "event", "operator", "type parameter",
];

const symbolRow = (s: SymbolItem, i: number, hits: number[], detail?: string): Row => ({
  key: `${s.path}:${s.range.startLineNumber}:${i}`,
  title: s.name,
  detail: [KIND_NAMES[s.kind], s.container, detail].filter(Boolean).join(" · "),
  hits,
  run: () => openAt(s.path, s.range),
});

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
  const [query, setQuery] = useState(PREFIX[palette ?? ""] ?? "");
  const [files, setFiles] = useState<string[]>([]);
  const [index, setIndex] = useState(0);
  // The editor that was active when the palette opened (for @ and :).
  const [editor] = useState(activeEditor);
  const [fileSymbols, setFileSymbols] = useState<SymbolItem[] | null>(null);
  const [wsSymbols, setWsSymbols] = useState<SymbolItem[] | null>(null);
  const list = useRef<HTMLDivElement>(null);
  const commandMode = query.startsWith(">");
  const symbolMode = query.startsWith("@");
  const wsSymbolMode = query.startsWith("#");
  const lineMode = query.startsWith(":");
  const close = () => setPalette(null);

  useEffect(() => {
    if (root) filesApi.list(root).then(setFiles, () => setFiles([]));
  }, [root]);

  useEffect(() => {
    const model = editor?.getModel();
    if (symbolMode && fileSymbols === null && model) documentSymbols(model).then(setFileSymbols, () => setFileSymbols([]));
  }, [symbolMode, fileSymbols, editor]);

  const wsQuery = wsSymbolMode ? query.slice(1).trim() : null;
  useEffect(() => {
    if (wsQuery === null) return;
    let stale = false;
    const timer = setTimeout(() => workspaceSymbols(wsQuery).then((s) => !stale && setWsSymbols(s)), 150);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [wsQuery]);

  const rows: Row[] = useMemo(() => {
    if (commandMode) {
      const q = query.slice(1).trim();
      return getCommands()
        .map((c) => ({ c, m: fuzzy(q, c.title) }))
        .filter((x) => x.m)
        .sort((a, b) => b.m!.score - a.m!.score)
        .map(({ c, m }) => ({ key: c.id, title: c.title, shortcut: c.shortcut, hits: m!.hits, run: c.run }));
    }
    if (symbolMode) {
      const q = query.slice(1).trim();
      return (fileSymbols ?? [])
        .map((s, i) => ({ s, i, m: fuzzy(q, s.name) }))
        .filter((x) => x.m)
        // Keep file order when there's no query.
        .sort((a, b) => (q ? b.m!.score - a.m!.score : a.i - b.i))
        .map(({ s, i, m }) => symbolRow(s, i, m!.hits));
    }
    if (wsSymbolMode) {
      const q = query.slice(1).trim();
      const relative = (p: string) => (root && p.startsWith(root + "/") ? p.slice(root.length + 1) : p);
      return (wsSymbols ?? [])
        .map((s, i) => ({ s, i, m: fuzzy(q, s.name) }))
        .filter((x) => x.m)
        .sort((a, b) => b.m!.score - a.m!.score)
        .slice(0, 200)
        .map(({ s, i, m }) => symbolRow(s, i, m!.hits, relative(s.path)));
    }
    if (lineMode) {
      const model = editor?.getModel();
      if (!model) return [];
      const [line, column] = query.slice(1).split(/[:,]/).map((n) => parseInt(n, 10));
      const count = model.getLineCount();
      if (!line) return [{ key: "line", title: `Type a line number between 1 and ${count}`, hits: [], run: () => {} }];
      const lineNumber = Math.min(Math.max(line, 1), count);
      return [
        {
          key: "line",
          title: `Go to line ${lineNumber}${column ? `, column ${column}` : ""}`,
          hits: [],
          run: () => openAt(model.uri.fsPath, { lineNumber, column: column || 1 }),
        },
      ];
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
  }, [commandMode, symbolMode, wsSymbolMode, lineMode, query, files, root, fileSymbols, wsSymbols, editor]);

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
          placeholder={root ? "Search files by name, or type > commands, @ symbols, # workspace symbols, : line" : "Type > for commands"}
        />
        <div className="palette-list" ref={list}>
          {rows.length === 0 && (
            <div className="palette-empty">
              {commandMode
                ? "No matching commands"
                : symbolMode
                  ? !editor
                    ? "Open a file to see its symbols"
                    : fileSymbols === null
                      ? "Loading symbols…"
                      : "No matching symbols (needs the language server for this file)"
                  : wsSymbolMode
                    ? wsSymbols === null
                      ? "Type to search symbols"
                      : "No matching symbols (searches running language servers)"
                    : lineMode
                      ? "Open a file to go to a line"
                      : root
                        ? "No matching files"
                        : "Open a folder to search files"}
            </div>
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
