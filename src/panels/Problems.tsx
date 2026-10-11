import { useProject } from "../state/project";
import { useWorkspace } from "../state/workspace";
import { useMarkers, LspProblem } from "../state/markers";
import { openAt } from "../editor/navigation";
import { IconError, IconWarning } from "../components/Icons";
import { useUi } from "../state/ui";
import { aiAvailable, useAi } from "../state/ai";
import { explainProblem, fixProblem } from "../ai/actions";

/** "Fix with AI" / "Explain" links on a problem row. */
function AiLinks({ problem }: { problem: Parameters<typeof fixProblem>[0] }) {
  const crash = problem.message.includes("\n\n");
  const run = (fn: typeof fixProblem) => (e: { stopPropagation: () => void }) => {
    e.stopPropagation();
    fn(problem);
  };
  return (
    <span className="problem-ai">
      {!crash && (
        <button className="link" onClick={run(fixProblem)}>
          Fix with AI
        </button>
      )}
      <button className="link" onClick={run(explainProblem)}>
        Explain
      </button>
    </span>
  );
}

const bySeverity = <T extends { severity: "error" | "warning" }>(a: T, b: T) =>
  a.severity === b.severity ? 0 : a.severity === "error" ? -1 : 1;

export default function Problems() {
  const diagnostics = useProject((s) => s.build.diagnostics);
  const lsp = useMarkers((s) => s.problems);
  const root = useWorkspace((s) => s.root);
  const setShowSigning = useUi((s) => s.setShowSigning);
  const pods = useProject((s) => s.pods);
  const busy = useProject((s) => s.build.status === "active");
  const ai = useAi(aiAvailable);

  const podsBanner = pods?.needsInstall && (
    <div className="problems-banner">
      <IconWarning />
      <span className="grow">{pods.reason}. Run pod install before building.</span>
      <button className="btn primary" disabled={busy} onClick={() => useProject.getState().startTool("pods")}>
        pod install
      </button>
    </div>
  );

  if (diagnostics.length === 0 && lsp.length === 0) return podsBanner || <div className="panel-empty">No problems</div>;

  const relative = (file: string) => (root && file.startsWith(root + "/") ? file.slice(root.length + 1) : file);
  // Errors first, then warnings, keeping compiler order within each group.
  const sorted = [...diagnostics].sort(bySeverity);

  // Language-server problems grouped by file; files with errors first.
  const groups = new Map<string, LspProblem[]>();
  for (const p of lsp) groups.set(p.file, [...(groups.get(p.file) ?? []), p]);
  const files = [...groups.entries()]
    .map(([file, list]) => [file, list.sort((a, b) => bySeverity(a, b) || a.line - b.line)] as const)
    .sort(([fa, a], [fb, b]) => bySeverity(a[0], b[0]) || relative(fa).localeCompare(relative(fb)));

  return (
    <div className="sidebar-view">
    <div className="sidebar-header">
      <span className="sidebar-title">Problems</span>
    </div>
    {podsBanner}
    <ul className="problems sidebar-body">
      {sorted.length > 0 && (
        <li className="problem-group">
          Last build<span className="count">{sorted.length}</span>
        </li>
      )}
      {sorted.map((d, i) => (
        <li
          key={i}
          className={`problem ${d.severity}${d.file ? " clickable" : ""}`}
          onClick={() =>
            d.file && openAt(d.file, d.line ? { lineNumber: d.line, column: d.column ?? 1 } : undefined)
          }
        >
          <span className="problem-icon">{d.severity === "error" ? <IconError /> : <IconWarning />}</span>
          <span className="problem-message">
            {d.message.split("\n\n")[0]}
            {/* Crash reports carry the crashing thread's frames after a blank line. */}
            {d.message.includes("\n\n") && (
              <details className="problem-trace" onClick={(e) => e.stopPropagation()}>
                <summary>Stack trace</summary>
                <pre>{d.message.split("\n\n").slice(1).join("\n\n")}</pre>
              </details>
            )}
            {d.hint && (
              <span className="problem-hint">
                {d.hint}{" "}
                {/* Link to the (iOS or Android) signing dialog only for signing problems. */}
                {(/signing|team|certificate|profile|keystore/i.test(d.hint) || d.hint.includes("Signing")) && (
                <button
                  className="link"
                  onClick={(e) => {
                    e.stopPropagation();
                    setShowSigning(true);
                  }}
                >
                  Open Signing
                </button>
                )}
              </span>
            )}
            {ai && d.severity === "error" && <AiLinks problem={d} />}
          </span>
          {d.file && (
            <span className="problem-location">
              {relative(d.file)}
              {d.line ? `:${d.line}` : ""}
            </span>
          )}
        </li>
      ))}
      {files.map(([file, list]) => [
        <li key={file} className="problem-group file" title={file}>
          {relative(file)}
          <span className="count">{list.length}</span>
        </li>,
        ...list.map((p, i) => (
          <li
            key={`${file}:${i}`}
            className={`problem ${p.severity} clickable`}
            onClick={() => openAt(p.file, { lineNumber: p.line, column: p.column })}
          >
            <span className="problem-icon">{p.severity === "error" ? <IconError /> : <IconWarning />}</span>
            <span className="problem-message">
              {p.message}
              {p.source && <span className="problem-location"> {p.source}</span>}
              {ai && p.severity === "error" && <AiLinks problem={p} />}
            </span>
            <span className="problem-location">
              {p.line}:{p.column}
            </span>
          </li>
        )),
      ])}
    </ul>
    </div>
  );
}
