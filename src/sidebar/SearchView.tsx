import { useEffect, useMemo, useRef, useState } from "react";
import { filesApi, SearchMatch } from "../lib/ipc";
import { openAt } from "../editor/navigation";
import { IconChevronDown, IconChevronRight } from "../components/Icons";

/** Search across files in the folder (respects .gitignore). */
export default function SearchView({ root }: { root: string }) {
  const [query, setQuery] = useState("");
  const [regex, setRegex] = useState(false);
  const [matchCase, setMatchCase] = useState(false);
  const [results, setResults] = useState<SearchMatch[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const input = useRef<HTMLInputElement>(null);
  const seq = useRef(0);

  useEffect(() => input.current?.focus(), []);

  // Debounced search; stale responses are dropped.
  useEffect(() => {
    if (!query) {
      setResults(null);
      setError(null);
      return;
    }
    const n = ++seq.current;
    const t = setTimeout(async () => {
      setBusy(true);
      try {
        const r = await filesApi.search(root, query, regex, matchCase);
        if (n === seq.current) {
          setResults(r);
          setError(null);
        }
      } catch (e) {
        if (n === seq.current) setError(String(e));
      } finally {
        if (n === seq.current) setBusy(false);
      }
    }, 200);
    return () => clearTimeout(t);
  }, [query, regex, matchCase, root]);

  const groups = useMemo(() => {
    const map = new Map<string, SearchMatch[]>();
    for (const m of results ?? []) map.set(m.path, [...(map.get(m.path) ?? []), m]);
    return [...map.entries()];
  }, [results]);

  const rel = (p: string) => (p.startsWith(root + "/") ? p.slice(root.length + 1) : p);

  return (
    <div className="sidebar-view">
      <div className="sidebar-header">
        <span className="sidebar-title">Search</span>
      </div>
      <div className="search-box">
        <div className="search-input">
          <input
            ref={input}
            className="text-input"
            placeholder="Search in files"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <button className={`toggle${matchCase ? " on" : ""}`} title="Match case" onClick={() => setMatchCase(!matchCase)}>
            Aa
          </button>
          <button className={`toggle${regex ? " on" : ""}`} title="Regular expression" onClick={() => setRegex(!regex)}>
            .*
          </button>
        </div>
        <div className="search-summary">
          {error ? (
            <span className="field-error">{error}</span>
          ) : busy ? (
            "Searching…"
          ) : results ? (
            `${results.length}${results.length >= 2000 ? "+" : ""} results in ${groups.length} files`
          ) : null}
        </div>
      </div>
      <div className="sidebar-body">
        {groups.map(([path, matches]) => {
          const isCollapsed = collapsed.has(path);
          return (
            <div key={path}>
              <div
                className="tree-row search-file"
                onClick={() => {
                  const next = new Set(collapsed);
                  if (isCollapsed) next.delete(path);
                  else next.add(path);
                  setCollapsed(next);
                }}
                title={path}
              >
                <span className="tree-chevron">{isCollapsed ? <IconChevronRight /> : <IconChevronDown />}</span>
                <span className="tree-name">{path.split("/").pop()}</span>
                <span className="search-dir">{rel(path).split("/").slice(0, -1).join("/")}</span>
                <span className="search-count">{matches.length}</span>
              </div>
              {!isCollapsed &&
                matches.map((m, i) => (
                    <div
                      key={i}
                      className="search-match"
                      onClick={() =>
                        openAt(m.path, {
                          startLineNumber: m.line,
                          startColumn: m.column,
                          endLineNumber: m.line,
                          endColumn: m.column + m.length,
                        })
                      }
                    >
                      <span className="search-line">{m.line}</span>
                      <MatchText text={m.text} needle={query} regex={regex} matchCase={matchCase} />
                    </div>
                ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function MatchText({ text, needle, regex, matchCase }: { text: string; needle: string; regex: boolean; matchCase: boolean }) {
  let re: RegExp;
  try {
    re = new RegExp(regex ? needle : needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), matchCase ? "" : "i");
  } catch {
    return <span className="search-text">{text}</span>;
  }
  const m = re.exec(text);
  if (!m || !m[0]) return <span className="search-text">{text}</span>;
  return (
    <span className="search-text">
      {text.slice(0, m.index)}
      <mark>{m[0]}</mark>
      {text.slice(m.index + m[0].length)}
    </span>
  );
}
