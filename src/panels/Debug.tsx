import { KeyboardEvent, useEffect, useRef, useState } from "react";
import { useDebug, Variable } from "../state/debug";
import { useWorkspace } from "../state/workspace";
import { openAt } from "../editor/navigation";
import { useProject } from "../state/project";
import {
  IconChevronDown,
  IconChevronRight,
  IconClose,
  IconContinue,
  IconPause,
  IconStepInto,
  IconStepOut,
  IconStepOver,
  IconStopSquare,
} from "../components/Icons";

function VariableRow({ v, depth }: { v: Variable; depth: number }) {
  const [open, setOpen] = useState(false);
  const { children, loadChildren } = useDebug();
  const expandable = v.ref > 0;
  const toggle = async () => {
    if (!expandable) return;
    if (!open) await loadChildren(v.ref);
    setOpen(!open);
  };
  return (
    <>
      <div className="var-row" style={{ paddingLeft: 8 + depth * 14 }} onClick={toggle} title={v.type}>
        <span className="tree-chevron">{expandable && (open ? <IconChevronDown /> : <IconChevronRight />)}</span>
        <span className="var-name">{v.name}</span>
        <span className="var-value">{v.value}</span>
      </div>
      {open && children[v.ref]?.map((c, i) => <VariableRow key={`${c.name}-${i}`} v={c} depth={depth + 1} />)}
    </>
  );
}

function ScopeSection({ name, refId, defaultOpen }: { name: string; refId: number; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const { children, loadChildren } = useDebug();
  const vars = children[refId];
  return (
    <div className="scope">
      <div
        className="scope-head"
        onClick={async () => {
          if (!open) await loadChildren(refId);
          setOpen(!open);
        }}
      >
        <span className="tree-chevron">{open ? <IconChevronDown /> : <IconChevronRight />}</span>
        {name}
      </div>
      {open &&
        (vars === undefined ? null : vars.length === 0 ? (
          <div className="var-empty">No variables</div>
        ) : (
          vars.map((v, i) => <VariableRow key={`${v.name}-${i}`} v={v} depth={1} />)
        ))}
    </div>
  );
}

/** Every breakpoint in the folder: toggle, open, remove. Plus exception breakpoints from the adapter. */
function BreakpointList() {
  const { breakpoints, setBreakpoint, exceptionFilters, enabledExceptions, toggleException } = useDebug();
  const root = useWorkspace((s) => s.root);
  const rel = (p: string) => (root && p.startsWith(root + "/") ? p.slice(root.length + 1) : p);
  const all = Object.entries(breakpoints).flatMap(([path, list]) => list.map((b) => ({ path, b })));
  return (
    <>
      <div className="debug-section-title">Breakpoints</div>
      <ul className="debug-list">
        {exceptionFilters.map((f) => (
          <li key={f.filter} onClick={() => toggleException(f.filter)}>
            <input type="checkbox" readOnly checked={enabledExceptions.includes(f.filter)} />
            <span className="grow">{f.label}</span>
          </li>
        ))}
        {all.map(({ path, b }) => (
          <li key={`${path}:${b.line}`} onClick={() => openAt(path, { lineNumber: b.line, column: 1 })} title={b.condition ?? b.logMessage ?? path}>
            <input
              type="checkbox"
              checked={b.enabled}
              onClick={(e) => e.stopPropagation()}
              onChange={() => setBreakpoint(path, b.line, { enabled: !b.enabled })}
            />
            <span className="grow">
              {rel(path).split("/").pop()}:{b.line}
              {b.condition && <span className="muted"> if {b.condition}</span>}
              {b.logMessage && <span className="muted"> log {b.logMessage}</span>}
            </span>
            <button className="icon-btn tiny" title="Remove" onClick={(e) => (e.stopPropagation(), setBreakpoint(path, b.line, null))}>
              <IconClose />
            </button>
          </li>
        ))}
        {all.length === 0 && exceptionFilters.length === 0 && <li className="var-empty">Click the gutter to add one</li>}
      </ul>
    </>
  );
}

function Watches() {
  const { watches, watchValues, addWatch, removeWatch, status } = useDebug();
  const [input, setInput] = useState("");
  return (
    <>
      <div className="debug-section-title">Watch</div>
      <ul className="debug-list">
        {watches.map((w) => (
          <li key={w} title={watchValues[w]}>
            <span className="var-name">{w}</span>
            <span className="var-value grow">{status === "paused" ? (watchValues[w] ?? "…") : ""}</span>
            <button className="icon-btn tiny" title="Remove" onClick={() => removeWatch(w)}>
              <IconClose />
            </button>
          </li>
        ))}
      </ul>
      <input
        className="text-input watch-input"
        placeholder="Add expression ↩"
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && input.trim()) {
            addWatch(input);
            setInput("");
          }
        }}
      />
    </>
  );
}

function DebugConsole() {
  const { console: entries, evaluate, status } = useDebug();
  const [input, setInput] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const [cursor, setCursor] = useState(-1);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [entries.length]);

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && input.trim()) {
      evaluate(input.trim());
      setHistory((h) => [input.trim(), ...h].slice(0, 50));
      setCursor(-1);
      setInput("");
    } else if (e.key === "ArrowUp" && history.length) {
      const next = Math.min(cursor + 1, history.length - 1);
      setCursor(next);
      setInput(history[next]);
      e.preventDefault();
    } else if (e.key === "ArrowDown") {
      const next = Math.max(cursor - 1, -1);
      setCursor(next);
      setInput(next === -1 ? "" : history[next]);
      e.preventDefault();
    }
  };

  return (
    <div className="debug-console">
      <div className="debug-console-output" ref={ref}>
        {entries.map((e, i) => (
          <div key={i} className={`dc-${e.kind}`}>
            {e.kind === "input" ? `› ${e.text}` : e.text}
          </div>
        ))}
      </div>
      <input
        className="debug-console-input"
        placeholder={status === "paused" ? "Evaluate an expression, e.g. user.name" : "Pause to evaluate expressions"}
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={onKey}
        disabled={status !== "paused"}
      />
    </div>
  );
}

/** The Run and Debug sidebar view: controls, variables, watches, threads, call stack, breakpoints. */
export function DebugView() {
  const { status, frames, frameId, scopes, stopReason, selectFrame, resume, pause, stepOver, stepInto, stepOut, stop, threads, threadId, selectThread } =
    useDebug();
  const cancelBuild = useProject((s) => s.cancelBuild);
  const paused = status === "paused";
  const live = status === "running" || status === "paused" || status === "starting";
  const stopAll = () => {
    stop();
    cancelBuild();
  };

  return (
    <div className="sidebar-view">
      <div className="sidebar-header">
        <span className="sidebar-title">Run and Debug</span>
      </div>
      <div className="sidebar-body debug-view">
        {status === "idle" ? (
          <p className="debug-hint muted">Click in the gutter to add breakpoints (right-click for conditions and logpoints), then press ⌘Y to debug.</p>
        ) : (
          <div className="debug-toolbar">
            {paused ? (
              <button className="icon-btn" title="Continue (F5)" onClick={resume}>
                <IconContinue />
              </button>
            ) : (
              <button className="icon-btn" title="Pause" onClick={pause} disabled={status !== "running"}>
                <IconPause />
              </button>
            )}
            <button className="icon-btn" title="Step over (F6)" onClick={stepOver} disabled={!paused}>
              <IconStepOver />
            </button>
            <button className="icon-btn" title="Step into (F7)" onClick={stepInto} disabled={!paused}>
              <IconStepInto />
            </button>
            <button className="icon-btn" title="Step out (F8)" onClick={stepOut} disabled={!paused}>
              <IconStepOut />
            </button>
            <button className="icon-btn" title="Stop (⌘.)" onClick={stopAll} disabled={!live}>
              <IconStopSquare />
            </button>
            <span className={`status-pill ${paused ? "state-incomplete" : live ? "state-ready" : ""}`}>
              <span className="dot" />
              {status === "starting" ? "Starting…" : paused ? `Paused${stopReason ? ` · ${stopReason}` : ""}` : live ? "Running" : "Ended"}
            </span>
          </div>
        )}
        {status !== "idle" && (
          <>
            <div className="debug-section-title">Variables</div>
            {scopes.map((s, i) => (
              <ScopeSection key={`${frameId}-${s.ref}`} name={s.name} refId={s.ref} defaultOpen={i === 0} />
            ))}
            {!paused && <div className="var-empty">{live ? "Pause or hit a breakpoint to inspect" : "Session ended"}</div>}
          </>
        )}
        <Watches />
        {paused && threads.length > 1 && (
          <>
            <div className="debug-section-title">Threads</div>
            <ul className="debug-list">
              {threads.map((t) => (
                <li key={t.id} className={t.id === threadId ? "active" : ""} onClick={() => selectThread(t.id)}>
                  <span className="grow">{t.name || `Thread ${t.id}`}</span>
                </li>
              ))}
            </ul>
          </>
        )}
        {status !== "idle" && (
          <>
            <div className="debug-section-title">Call stack</div>
            <ul className="frames">
              {frames.map((f) => (
                <li
                  key={f.id}
                  className={`frame${f.id === frameId ? " active" : ""}${f.path ? "" : " no-source"}`}
                  onClick={() => selectFrame(f.id)}
                >
                  <span className="frame-name">{f.name}</span>
                  {f.path && (
                    <span className="frame-loc">
                      {f.path.split("/").pop()}:{f.line}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </>
        )}
        <BreakpointList />
      </div>
    </div>
  );
}

/** The bottom panel's Debug Console (the controls and variables are in the Run and Debug view). */
export default function DebugPanel() {
  const status = useDebug((s) => s.status);
  if (status === "idle") return <div className="panel-empty">Start debugging with ⌘Y; output and the expression console appear here</div>;
  return (
    <div className="debug-panel">
      <DebugConsole />
    </div>
  );
}
