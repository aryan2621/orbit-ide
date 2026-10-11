import { KeyboardEvent, useEffect, useLayoutEffect, useRef, useState } from "react";
import { AiError } from "../lib/ipc";
import { aiReady, useAi } from "../state/ai";
import { useUi } from "../state/ui";
import { IconChevronRight, IconClose, IconPlus, IconStopSquare } from "../components/Icons";
import { Item, decide, newChat, send, stop, useChat } from "./agent";
import { lineDiff } from "./diff";
import { Markdown } from "./markdown";
import AiSetup from "./AiSetup";

/** What to do about each typed error, shown under the message. */
function ErrorRow({ error }: { error: AiError }) {
  const hint: Partial<Record<AiError["code"], string>> = {
    OUT_OF_MEMORY: "Try a smaller model or a smaller context size in Settings → AI.",
    CONTEXT_TOO_SMALL: "Start a new chat, or raise the context size in Settings → AI.",
    CRASHED: "The model stopped repeatedly. Try a smaller model or restart Orbit.",
    NO_MODEL: "Download a model in Settings → AI.",
  };
  return (
    <div className="ai-error">
      <div>{error.message}</div>
      {hint[error.code] && (
        <div className="muted small">
          {hint[error.code]}{" "}
          <button className="link" onClick={() => (useUi.getState().setSettingsPage("ai"), useUi.getState().setShowSettings(true))}>
            Open Settings
          </button>
        </div>
      )}
    </div>
  );
}

function ToolRow({ item }: { item: Extract<Item, { kind: "tool" }> }) {
  const label = { approval: "waiting for approval", running: "running…", done: "", denied: "denied", error: "failed" }[item.status];
  return (
    <details className={`ai-tool ${item.status}`}>
      <summary>
        <IconChevronRight />
        <code>{item.name}</code>
        <span className="ai-tool-summary">{item.summary}</span>
        {label && <span className="muted small">{label}</span>}
      </summary>
      <pre>{JSON.stringify(item.args, null, 2)}</pre>
      {item.output && <pre className="ai-tool-output">{item.output}</pre>}
    </details>
  );
}

function Approval() {
  const pending = useChat((s) => s.pending);
  if (!pending) return null;
  const { preview } = pending;
  const diff = preview.diff ? lineDiff(preview.diff.before, preview.diff.after) : null;
  return (
    <div className="ai-approval">
      <strong>{preview.title}</strong>
      {preview.detail && <div className="muted small">{preview.detail}</div>}
      {diff && (
        <pre className="ai-diff">
          {diff.map((l, i) => (
            <div key={i} className={`diff-${l.kind}`}>
              {l.kind === "gap" ? "⋯" : `${l.kind === "ins" ? "+" : l.kind === "del" ? "-" : " "} ${l.text}`}
            </div>
          ))}
        </pre>
      )}
      <div className="row-actions">
        <button className="btn primary" autoFocus onClick={() => decide("once")}>
          Allow once
        </button>
        <button className="btn" onClick={() => decide("session")}>
          Allow for this session
        </button>
        <button className="btn subtle" onClick={() => decide("deny")}>
          Deny
        </button>
      </div>
    </div>
  );
}

function StatusLine() {
  const server = useAi((s) => s.server);
  const models = useAi((s) => s.models);
  const stats = useChat((s) => s.stats);
  const name = (id: string | null) => models?.installed.find((m) => m.id === id)?.name ?? id;
  const text =
    server.status === "loading"
      ? `Loading ${name(server.model)}…`
      : server.status === "ready"
        ? `${name(server.model)}${stats?.tokensPerSecond ? ` · ${stats.tokensPerSecond.toFixed(1)} tok/s` : ""}`
        : server.status === "crashed"
          ? "Model stopped"
          : "Model loads on first message";
  return <span className={`ai-status ${server.status}`}>{text}</span>;
}

export default function AiPanel() {
  const ai = useAi();
  const { items, running } = useChat();
  const pending = useChat((s) => !!s.pending);
  const [text, setText] = useState("");
  const list = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const stick = useRef(true);
  const ready = aiReady(ai);

  useEffect(() => {
    input.current?.focus();
  }, [ready]);

  // Follow the stream unless the user scrolled up.
  useLayoutEffect(() => {
    const el = list.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [items, pending]);

  const submit = () => {
    if (!text.trim() || running) return;
    send(text.trim());
    setText("");
    stick.current = true;
  };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    } else if (e.key === "Escape" && running) {
      e.preventDefault();
      stop();
    }
  };

  return (
    <div className="ai-panel">
      <div className="sidebar-header">
        <span>AI</span>
        <span className="grow" />
        {ready && (
          <button className="icon-btn" title="New chat" onClick={newChat} disabled={running}>
            <IconPlus />
          </button>
        )}
        <button className="icon-btn" title="Close (⌘I)" onClick={() => useUi.getState().setShowAiPanel(false)}>
          <IconClose />
        </button>
      </div>

      {!ready ? (
        <div className="ai-onboarding">
          {ai.hardware?.supported && (
            <>
              <h3>On-device AI</h3>
              <p className="muted small">
                Chat about your code, fix build errors and make edits. Everything runs on this Mac; your code never leaves it. The assistant asks before every file change,
                build or run.
              </p>
            </>
          )}
          {ai.hardware?.supported && !ai.settings.enabled ? (
            <button className="btn primary" onClick={() => ai.update({ enabled: true })}>
              Turn on AI
            </button>
          ) : (
            <AiSetup compact />
          )}
        </div>
      ) : (
        <>
          <div
            className="ai-messages"
            ref={list}
            onScroll={(e) => {
              const el = e.currentTarget;
              stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
            }}
          >
            {items.length === 0 && (
              <div className="ai-empty muted">
                <p>Ask about the open project, or try:</p>
                {["Explain the file I have open", "Why is my build failing?", "Add a loading state to this screen"].map((s) => (
                  <button key={s} className="ai-suggestion" onClick={() => send(s)}>
                    {s}
                  </button>
                ))}
              </div>
            )}
            {items.map((item, i) =>
              item.kind === "user" ? (
                <div key={i} className="ai-user">
                  {item.text}
                </div>
              ) : item.kind === "assistant" ? (
                <div key={i} className="ai-assistant">
                  {item.reasoning && (
                    <details className="ai-reasoning">
                      <summary>Thinking</summary>
                      <div className="muted small">{item.reasoning}</div>
                    </details>
                  )}
                  {item.text ? <Markdown text={item.text} /> : running && i === items.length - 1 && <span className="ai-typing" />}
                </div>
              ) : item.kind === "tool" ? (
                <ToolRow key={item.id + i} item={item} />
              ) : (
                <ErrorRow key={i} error={item.error} />
              ),
            )}
            <Approval />
          </div>
          <div className="ai-input">
            <textarea
              ref={input}
              rows={3}
              value={text}
              placeholder={running ? "Working… (Esc to stop)" : "Ask anything about this project (Enter to send, ⇧Enter for a new line)"}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={onKeyDown}
            />
            <div className="ai-input-bar">
              <StatusLine />
              <span className="grow" />
              {running ? (
                <button className="btn" onClick={stop}>
                  <IconStopSquare /> Stop
                </button>
              ) : (
                <button className="btn primary" onClick={submit} disabled={!text.trim()}>
                  Send
                </button>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
