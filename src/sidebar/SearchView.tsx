import { useEffect, useMemo, useRef, useState } from "react";
import { ask } from "@tauri-apps/plugin-dialog";
import * as monaco from "monaco-editor";
import { filesApi, SearchMatch } from "../lib/ipc";
import { openAt } from "../editor/navigation";
import { modelUri } from "../editor/monaco-setup";
import { useWorkspace } from "../state/workspace";
import { IconChevronDown, IconChevronRight } from "../components/Icons";
import SearchField from "../components/SearchField";

/** Expands `$1`, `${1}`, `${name}` and `$&` like the Rust side does for regex replacements. */
function expand(replacement: string, groups: (string | undefined)[], named: Record<string, string> = {}) {
  return replacement.replace(/\$(?:(\d+)|\{(\w+)\}|(&))/g, (_, n, braced, all) =>
    all ? (groups[0] ?? "") : n !== undefined ? (groups[Number(n)] ?? "") : /^\d+$/.test(braced) ? (groups[Number(braced)] ?? "") : (named[braced] ?? ""),
  );
}

function buildRegExp(query: string, regex: boolean, matchCase: boolean, global = false): RegExp | null {
  try {
    return new RegExp(regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), (matchCase ? "" : "i") + (global ? "g" : ""));
  } catch {
    return null;
  }
}

/** Replaces in an open file's model, as one undoable edit. Returns the number of replacements. */
function replaceInModel(path: string, query: string, regex: boolean, matchCase: boolean, replacement: string): number {
  const model = monaco.editor.getModel(modelUri(path));
  if (!model) return 0;
  const matches = model.findMatches(query, false, regex, matchCase, null, true);
  if (matches.length === 0) return 0;
  model.pushStackElement();
  model.pushEditOperations(
    [],
    matches.map((m) => ({ range: m.range, text: regex ? expand(replacement, m.matches ?? []) : replacement })),
    () => null,
  );
  model.pushStackElement();
  return matches.length;
}

/** Search (and replace) across files in the folder; respects .gitignore and the include/exclude globs. */
export default function SearchView({ root }: { root: string }) {
  const [query, setQuery] = useState("");
  const [regex, setRegex] = useState(false);
  const [matchCase, setMatchCase] = useState(false);
  const [showReplace, setShowReplace] = useState(false);
  const [replacement, setReplacement] = useState("");
  const [showGlobs, setShowGlobs] = useState(false);
  const [include, setInclude] = useState("");
  const [exclude, setExclude] = useState("");
  const [results, setResults] = useState<SearchMatch[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  /** Files left out of Replace All (unticked in the preview). */
  const [skipped, setSkipped] = useState<Set<string>>(new Set());
  const [refresh, setRefresh] = useState(0);
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
        const r = await filesApi.search(root, query, regex, matchCase, include, exclude);
        if (n === seq.current) {
          setResults(r);
          setError(null);
          setSkipped(new Set());
        }
      } catch (e) {
        if (n === seq.current) setError(String(e));
      } finally {
        if (n === seq.current) setBusy(false);
      }
    }, 200);
    return () => clearTimeout(t);
  }, [query, regex, matchCase, include, exclude, root, refresh]);

  const groups = useMemo(() => {
    const map = new Map<string, SearchMatch[]>();
    for (const m of results ?? []) map.set(m.path, [...(map.get(m.path) ?? []), m]);
    return [...map.entries()];
  }, [results]);

  const rel = (p: string) => (p.startsWith(root + "/") ? p.slice(root.length + 1) : p);
  const replacing = showReplace && !!results?.length;

  const replaceAll = async () => {
    const paths = groups.map(([p]) => p).filter((p) => !skipped.has(p));
    if (paths.length === 0) return;
    const ok = await ask(`Replace matches in ${paths.length} file${paths.length === 1 ? "" : "s"} with "${replacement}"?`, {
      title: "Replace All",
      kind: "warning",
      okLabel: "Replace",
    });
    if (!ok) return;
    // Open files change in the editor (undoable, saved by you); the rest are written on disk.
    const open = new Set(useWorkspace.getState().files.map((f) => f.path));
    let count = 0;
    for (const p of paths.filter((p) => open.has(p))) count += replaceInModel(p, query, regex, matchCase, replacement);
    try {
      count += await filesApi.replace(paths.filter((p) => !open.has(p)), query, regex, matchCase, replacement);
      setError(null);
    } catch (e) {
      setError(String(e));
    }
    useWorkspace.setState({ error: `Replaced ${count} occurrence${count === 1 ? "" : "s"}${[...open].some((p) => paths.includes(p)) ? "; open files have unsaved changes" : ""}.` });
    setRefresh((r) => r + 1);
  };

  return (
    <div className="sidebar-view">
      <div className="sidebar-header">
        <span className="sidebar-title">Search</span>
      </div>
      <div className="search-box">
        <div className="search-row">
          <button className="icon-btn tiny" title={showReplace ? "Hide replace" : "Replace"} onClick={() => setShowReplace(!showReplace)}>
            {showReplace ? <IconChevronDown /> : <IconChevronRight />}
          </button>
          <div className="search-fields">
            <SearchField
              ref={input}
              className="compact"
              placeholder="Search in files"
              value={query}
              onValueChange={setQuery}
              trailing={
                <>
                  <button className={`search-toggle${matchCase ? " on" : ""}`} title="Match case" onClick={() => setMatchCase(!matchCase)}>
                    Aa
                  </button>
                  <button className={`search-toggle${regex ? " on" : ""}`} title="Regular expression" onClick={() => setRegex(!regex)}>
                    .*
                  </button>
                </>
              }
            />
            {showReplace && (
              <SearchField
                className="compact"
                icon={null}
                placeholder={regex ? "Replace ($1 for groups)" : "Replace"}
                value={replacement}
                onValueChange={setReplacement}
                trailing={
                  <button className="search-toggle" title="Replace all matches" disabled={!results?.length} onClick={replaceAll}>
                    All
                  </button>
                }
              />
            )}
          </div>
        </div>
        <button className="link search-globs-toggle" onClick={() => setShowGlobs(!showGlobs)}>
          {showGlobs ? "Hide file filters" : "Files to include / exclude…"}
        </button>
        {showGlobs && (
          <>
            <SearchField className="compact" icon={null} placeholder="Include, e.g. *.swift, app/src/**" value={include} onValueChange={setInclude} />
            <SearchField className="compact" icon={null} placeholder="Exclude, e.g. *Tests*, **/generated/**" value={exclude} onValueChange={setExclude} />
          </>
        )}
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
                {replacing && (
                  <input
                    type="checkbox"
                    title="Include in Replace All"
                    checked={!skipped.has(path)}
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => {
                      const next = new Set(skipped);
                      if (e.target.checked) next.delete(path);
                      else next.add(path);
                      setSkipped(next);
                    }}
                  />
                )}
                <span className="tree-name">{path.split("/").pop()}</span>
                <span className="search-dir">{rel(path).split("/").slice(0, -1).join("/")}</span>
                <span className="search-count">{matches.length}</span>
              </div>
              {!isCollapsed &&
                matches.map((m, i) => (
                  <div
                    key={i}
                    className={`search-match${skipped.has(path) ? " skipped" : ""}`}
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
                    <MatchText text={m.text} needle={query} regex={regex} matchCase={matchCase} replacement={replacing ? replacement : null} />
                  </div>
                ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function MatchText({ text, needle, regex, matchCase, replacement }: { text: string; needle: string; regex: boolean; matchCase: boolean; replacement: string | null }) {
  const re = buildRegExp(needle, regex, matchCase);
  const m = re?.exec(text);
  if (!m || !m[0]) return <span className="search-text">{text}</span>;
  return (
    <span className="search-text">
      {text.slice(0, m.index)}
      {replacement === null ? (
        <mark>{m[0]}</mark>
      ) : (
        <>
          <del>{m[0]}</del>
          <ins>{regex ? expand(replacement, [...m], m.groups) : replacement}</ins>
        </>
      )}
      {text.slice(m.index + m[0].length)}
    </span>
  );
}
