import { useEffect } from "react";
import { useWorkspace } from "../state/workspace";
import { useGit } from "../state/git";
import { useProject } from "../state/project";
import { useUi } from "../state/ui";
import { Platform, useSetup } from "../state/setup";
import { useDebug } from "../state/debug";
import { useMarkers } from "../state/markers";
import { serverFor, useLspStatus } from "../lsp/servers";
import { useSettings } from "../state/settings";
import { blameText, useBlame } from "../state/blame";
import { languageForPath } from "../editor/monaco-setup";
import { IconError, IconGitBranch, IconWarning } from "../components/Icons";
import { installUpdate, useUpdates } from "../state/updates";

const PLATFORMS: { id: Platform; label: string }[] = [
  { id: "ios", label: "iOS" },
  { id: "android", label: "Android" },
];

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
  const { showActivity, setActivity, showSetup, setShowSetup, setPalette } = useUi();
  const { ready, setPlatform, refreshAll } = useSetup();
  const debugStatus = useDebug((s) => s.status);
  const tabSize = useSettings((s) => s.tabSize);
  const lsp = useMarkers((s) => s.problems);
  const all = [...diagnostics, ...lsp];
  const errors = all.filter((d) => d.severity === "error").length;
  const warnings = all.length - errors;
  const lang = activePath ? languageForPath(activePath) : null;
  const servers = useLspStatus((s) => s.states);
  const blame = useBlame((s) => (s.path === activePath && cursor ? blameText(s.lines[cursor.line - 1]) : null));
  const progress = useLspStatus((s) => Object.values(s.progress).find(Boolean));

  // Check both toolchains at startup and again whenever the setup wizard closes.
  useEffect(() => {
    if (!showSetup) refreshAll();
  }, [showSetup, refreshAll]);

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
        <button className="status-item" title="Problems" onClick={() => showActivity("problems")}>
          <IconError /> {errors}
          <IconWarning /> {warnings}
        </button>
      )}
      {(debugStatus === "paused" || debugStatus === "running") && (
        <button className="status-item" onClick={() => showActivity("debug")}>
          {debugStatus === "paused" ? "⏸ Paused" : "● Debugging"}
        </button>
      )}
      <span className="grow" />
      {blame && (
        <button className="status-item blame" title={`${blame}\n(click for file history)`} onClick={() => activePath && useGit.getState().showHistory(activePath)}>
          {blame.length > 60 ? blame.slice(0, 60) + "…" : blame}
        </button>
      )}
      {activePath && cursor && (
        <span className="status-item static">
          Ln {cursor.line}, Col {cursor.column}
        </span>
      )}
      {activePath && <span className="status-item static">Spaces: {tabSize}</span>}
      {lang && <span className="status-item static">{LANGUAGE_NAMES[lang] ?? lang}</span>}
      {progress && (
        <button className="status-item state-loading" title={progress} onClick={() => showActivity("output")}>
          <span className="dot" />
          {progress.length > 40 ? progress.slice(0, 40) + "…" : progress}
        </button>
      )}
      <UpdateItem />
      {Object.entries(servers).map(([language, state]) => {
        const server = serverFor(language);
        const label = server?.label ?? language;
        return (
          <button
            key={language}
            className={`status-item ${state === "starting" ? "state-loading" : state === "ready" ? "state-ok" : "state-error"}`}
            title={
              state === "crashed"
                ? `${label} language server stopped unexpectedly. Click to restart.`
                : `${label} language server ${state === "starting" ? "starting…" : "ready"} (click to restart)`
            }
            onClick={() => server?.restart()}
          >
            <span className="dot" />
            {label} LSP
          </button>
        );
      })}
      {PLATFORMS.map(({ id, label }) => {
        const state = ready[id];
        return (
          <button
            key={id}
            className={`status-item ${state === null ? "state-loading" : state ? "state-ok" : "state-error"}`}
            title={`${label}: ${state === null ? "checking…" : state ? "ready" : "setup needed"} (click for setup)`}
            onClick={() => {
              setPlatform(id);
              setShowSetup(true);
            }}
          >
            <span className="dot" />
            {label}
          </button>
        );
      })}
      <button className="status-item" title="Command palette (⇧⌘P)" onClick={() => setPalette("commands")}>
        ⌘⇧P
      </button>
    </footer>
  );
}

function UpdateItem() {
  const { available, progress } = useUpdates();
  if (!available) return null;
  if (progress) {
    const pct = progress.total ? ` ${Math.round((progress.received / progress.total) * 100)}%` : "";
    return (
      <span className="status-item static state-loading">
        <span className="dot" />
        Updating{pct}…
      </span>
    );
  }
  return (
    <button className="status-item state-ok" title={`Orbit ${available.version} is available`} onClick={installUpdate}>
      <span className="dot" />
      Update to {available.version}
    </button>
  );
}
