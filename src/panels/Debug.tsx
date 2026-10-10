import { KeyboardEvent, useEffect, useRef, useState } from "react";
import { useDebug, Variable } from "../state/debug";
import { useProject } from "../state/project";
import {
  IconChevronDown,
  IconChevronRight,
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

export default function DebugPanel() {
  const { status, frames, frameId, scopes, stopReason, selectFrame, resume, pause, stepOver, stepInto, stepOut, stop } =
    useDebug();
  const cancelBuild = useProject((s) => s.cancelBuild);

  if (status === "idle") {
    return (
      <div className="panel-empty">
        Click in the gutter to add breakpoints, then press ⌘Y to debug
      </div>
    );
  }

  const paused = status === "paused";
  const live = status === "running" || status === "paused" || status === "starting";
  const stopAll = () => {
    stop();
    cancelBuild();
  };

  return (
    <div className="debug-panel">
      <div className="debug-side">
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
          {!paused && <li className="var-empty">{live ? "Pause or hit a breakpoint to inspect" : "Session ended"}</li>}
        </ul>
      </div>
      <div className="debug-vars">
        <div className="debug-section-title">Variables</div>
        {scopes.map((s, i) => (
          <ScopeSection key={`${frameId}-${s.ref}`} name={s.name} refId={s.ref} defaultOpen={i === 0} />
        ))}
      </div>
      <DebugConsole />
    </div>
  );
}
