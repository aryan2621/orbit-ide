import { useWorkspace } from "../state/workspace";
import { useGit } from "../state/git";
import { useProject } from "../state/project";
import { useUi } from "../state/ui";
import { isReady, useSetup } from "../state/setup";
import { useDebug } from "../state/debug";
import { useSettings } from "../state/settings";
import { languageForPath } from "../editor/monaco-setup";
import { IconError, IconGitBranch, IconWarning } from "../components/Icons";

const LANGUAGE_NAMES: Record<string, string> = {
  swift: "Swift",
  "objective-c": "Objective-C",
  kotlin: "Kotlin",
  java: "Java",
  typescript: "TypeScript",
  javascript: "JavaScript",
  json: "JSON",
  xml: "XML",
  yaml: "YAML",
  markdown: "Markdown",
  plaintext: "Plain Text",
};

export default function StatusBar() {
  const { root, activePath, cursor } = useWorkspace();
  const git = useGit((s) => s.status);
  const diagnostics = useProject((s) => s.build.diagnostics);
  const { showBottomTab, setActivity, setShowSetup, setPalette } = useUi();
  const { checks, platform } = useSetup();
  const debugStatus = useDebug((s) => s.status);
  const tabSize = useSettings((s) => s.tabSize);
  const errors = diagnostics.filter((d) => d.severity === "error").length;
  const warnings = diagnostics.length - errors;
  const lang = activePath ? languageForPath(activePath) : null;
  const ready = isReady(checks);

  return (
    <footer className={`status-bar${debugStatus === "paused" || debugStatus === "running" ? " debugging" : ""}`}>
      {root && git?.repo_root && (
        <button className="status-item" title="Source Control" onClick={() => setActivity("git")}>
          <IconGitBranch />
          {git.branch ?? "detached"}
          {git.changes.length > 0 && "*"}
          {(git.ahead > 0 || git.behind > 0) && (
            <span className="muted">
              {" "}
              ↑{git.ahead} ↓{git.behind}
            </span>
          )}
        </button>
      )}
      {root && (
        <button className="status-item" title="Problems" onClick={() => showBottomTab("problems")}>
          <IconError /> {errors}
          <IconWarning /> {warnings}
        </button>
      )}
      {(debugStatus === "paused" || debugStatus === "running") && (
        <button className="status-item" onClick={() => showBottomTab("debug")}>
          {debugStatus === "paused" ? "⏸ Paused" : "● Debugging"}
        </button>
      )}
      <span className="grow" />
      {activePath && cursor && (
        <span className="status-item static">
          Ln {cursor.line}, Col {cursor.column}
        </span>
      )}
      {activePath && <span className="status-item static">Spaces: {tabSize}</span>}
      {lang && <span className="status-item static">{LANGUAGE_NAMES[lang] ?? lang}</span>}
      <button className="status-item" title="Toolchain setup" onClick={() => setShowSetup(true)}>
        <span className={`dot ${checks === null ? "" : ready ? "dot-ok" : "dot-warn"}`} />
        {platform === "android" ? "Android" : "iOS"} {checks === null ? "…" : ready ? "ready" : "setup needed"}
      </button>
      <button className="status-item" title="Command palette (⇧⌘P)" onClick={() => setPalette("commands")}>
        ⌘⇧P
      </button>
    </footer>
  );
}
