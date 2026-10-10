import { useProject } from "../state/project";
import { useWorkspace } from "../state/workspace";
import { openAt } from "../editor/navigation";
import { IconError, IconWarning } from "../components/Icons";
import { useUi } from "../state/ui";

export default function Problems() {
  const diagnostics = useProject((s) => s.build.diagnostics);
  const root = useWorkspace((s) => s.root);
  const setShowSigning = useUi((s) => s.setShowSigning);

  if (diagnostics.length === 0) return <div className="panel-empty">No problems from the last build</div>;

  const relative = (file: string) => (root && file.startsWith(root + "/") ? file.slice(root.length + 1) : file);
  // Errors first, then warnings, keeping compiler order within each group.
  const sorted = [...diagnostics].sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "error" ? -1 : 1));

  return (
    <ul className="problems">
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
            {d.message}
            {d.hint && (
              <span className="problem-hint">
                {d.hint}{" "}
                <button
                  className="link"
                  onClick={(e) => {
                    e.stopPropagation();
                    setShowSigning(true);
                  }}
                >
                  Open Signing
                </button>
              </span>
            )}
          </span>
          {d.file && (
            <span className="problem-location">
              {relative(d.file)}
              {d.line ? `:${d.line}` : ""}
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}
