import { useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openAt } from "../editor/navigation";
import { useWorkspace } from "../state/workspace";
import { filterLines, LEVELS, LogcatLine, useLogcat } from "../state/logcat";
import VirtualLog from "../components/VirtualLog";
import SearchField from "../components/SearchField";
import { aiAvailable, useAi } from "../state/ai";
import { explainLogcatCrash } from "../ai/actions";

/** The exception and its frames, starting at a FATAL EXCEPTION line. */
function crashTrace(start: LogcatLine) {
  const lines = useLogcat.getState().lines;
  const i = lines.indexOf(start);
  const trace = lines.slice(i, i + 60).filter((l) => l.pid === start.pid && l.tag === start.tag);
  return trace.map((l) => l.message).join("\n");
}

/** `at com.example.app.MainActivity.onCreate(MainActivity.kt:14)` */
const FRAME = /^(\s*at\s+)([\w$.]+)\.[\w$<>]+\(([\w$]+\.(?:kt|java)):(\d+)\)/;

async function openFrame(root: string, cls: string, file: string, line: number) {
  // Nested and lambda classes (Outer$Inner$1) live in the outer class's file.
  const path = await invoke<string | null>("android_find_source", { root, class: cls.split("$")[0], file });
  if (path) openAt(path, { lineNumber: line, column: 1 });
}

function Message({ text }: { text: string }) {
  const root = useWorkspace((s) => s.root);
  const m = FRAME.exec(text);
  if (!m || !root) return <>{text}</>;
  const [whole, prefix, cls, file, line] = m;
  return (
    <>
      {prefix}
      {cls}.
      <button className="logcat-frame" onClick={() => openFrame(root, cls, file, Number(line))}>
        {whole.slice(prefix.length + cls.length + 1)}
      </button>
      {text.slice(whole.length)}
    </>
  );
}

function Row({ line }: { line: LogcatLine }) {
  const ai = useAi(aiAvailable);
  const fatal = ai && line.message.startsWith("FATAL EXCEPTION");
  return (
    <div className={`logcat-row level-${line.level}`}>
      <span className="logcat-time">{line.time}</span>
      <span className="logcat-level">{line.level}</span>
      <span className="logcat-pid" title={`pid ${line.pid} · tid ${line.tid}`}>
        {line.pid}
      </span>
      <span className="logcat-tag" title={line.tag}>
        {line.tag}
      </span>
      <span className="logcat-message">
        <Message text={line.message} />
        {fatal && (
          <button className="link logcat-ai" onClick={() => explainLogcatCrash(crashTrace(line))}>
            Explain with AI
          </button>
        )}
      </span>
    </div>
  );
}

/** The running Android app's Logcat, filterable by level and tag/text; stack frames open the source. */
export default function Logcat() {
  const { lines, minLevel, query, setMinLevel, setQuery, clear, mode, setMode, paused, setPaused, deviceSerial } = useLogcat();
  const shown = useMemo(() => filterLines(lines, minLevel, query), [lines, minLevel, query]);

  return (
    <div className="logcat">
      <div className="logcat-toolbar">
        <div className="segmented" role="radiogroup" aria-label="Source">
          <button className={mode === "app" ? "on" : ""} onClick={() => setMode("app")} title="Lines from the app started with Run">
            This app
          </button>
          <button className={mode === "device" ? "on" : ""} onClick={() => setMode("device")} title="Everything on the selected device">
            Whole device
          </button>
        </div>
        <div className="logcat-levels" role="radiogroup" aria-label="Minimum level">
          {LEVELS.map((l) => (
            <button
              key={l}
              role="radio"
              aria-checked={minLevel === l}
              className={`logcat-level-btn level-${l}${minLevel === l ? " active" : ""}`}
              title={`Show ${l} and above`}
              onClick={() => setMinLevel(l)}
            >
              {l}
            </button>
          ))}
        </div>
        <SearchField className="compact logcat-search" placeholder="Filter by tag or text" value={query} onValueChange={setQuery} />
        <button className="btn" onClick={() => setPaused(!paused)} title="Stop adding new lines while you read">
          {paused ? "Resume" : "Pause"}
        </button>
        <button
          className="btn"
          disabled={shown.length === 0}
          title="Copy the shown lines"
          onClick={() =>
            navigator.clipboard.writeText(shown.map((l) => `${l.time} ${l.pid} ${l.tid} ${l.level} ${l.tag}: ${l.message}`).join("\n"))
          }
        >
          Copy
        </button>
        <button className="btn" onClick={clear} disabled={lines.length === 0}>
          Clear
        </button>
      </div>
      {shown.length === 0 ? (
        <div className="panel-empty">
          {lines.length > 0
            ? "No lines match the filter"
            : mode === "device"
              ? deviceSerial
                ? `Waiting for Logcat from ${deviceSerial}…`
                : "Pick a running emulator or connected phone in the toolbar"
              : "Run the app (⌘R); its Logcat appears here"}
        </div>
      ) : (
        <VirtualLog className="build-log logcat-lines" items={shown} render={(l) => <Row line={l} />} />
      )}
    </div>
  );
}
