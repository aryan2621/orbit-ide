import Editor, { OnMount } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import { isDirty, useWorkspace } from "../state/workspace";
import { useSettings } from "../state/settings";
import { languageForPath } from "./monaco-setup";
import { openContextMenu } from "../components/ContextMenu";
import { IconClose, IconFile } from "../components/Icons";
import Welcome from "../app/Welcome";

/** Saves the active file, formatting it first when "Format on save" is on. */
export async function saveActiveWithFormat() {
  const { activePath, saveActive } = useWorkspace.getState();
  if (useSettings.getState().formatOnSave && activePath) {
    const uri = monaco.Uri.parse(activePath).toString();
    const editor = monaco.editor.getEditors().find((e) => e.getModel()?.uri.toString() === uri);
    await editor
      ?.getAction("editor.action.formatDocument")
      ?.run()
      .catch(() => {});
  }
  await saveActive();
}

export default function EditorArea({ theme }: { theme: "light" | "dark" }) {
  const { root, files, activePath, setActive, closeFile, setCursor } = useWorkspace();
  const settings = useSettings();
  const active = files.find((f) => f.path === activePath);

  const close = (path: string) => {
    // Dispose the model so reopening the file reloads it from disk instead of showing stale content.
    monaco.editor.getModel(monaco.Uri.parse(path))?.dispose();
    closeFile(path);
  };

  const onMount: OnMount = (editor) => {
    const report = () => {
      const p = editor.getPosition();
      setCursor(p ? { line: p.lineNumber, column: p.column } : null);
    };
    editor.onDidChangeCursorPosition(report);
    editor.onDidChangeModel(report);
    report();
  };

  if (!root && files.length === 0) return <Welcome />;

  const rel = (p: string) => (root && p.startsWith(root + "/") ? p.slice(root.length + 1) : p);

  return (
    <div className="editor-area">
      {files.length > 0 && (
        <div className="tabstrip">
          {files.map((f) => (
            <div
              key={f.path}
              className={`tab${f.path === activePath ? " active" : ""}`}
              onClick={() => setActive(f.path)}
              onAuxClick={(e) => e.button === 1 && close(f.path)}
              onContextMenu={(e) =>
                openContextMenu(e, [
                  { label: "Close", shortcut: "⌘W", onSelect: () => close(f.path) },
                  { label: "Close Others", onSelect: () => files.filter((o) => o.path !== f.path && !isDirty(o)).forEach((o) => close(o.path)) },
                  { label: "Close Saved", onSelect: () => files.filter((o) => !isDirty(o)).forEach((o) => close(o.path)) },
                  null,
                  { label: "Copy Path", onSelect: () => navigator.clipboard.writeText(f.path) },
                ])
              }
              title={f.path}
            >
              <span className="tab-icon">
                <IconFile />
              </span>
              <span className="tab-title">{f.path.split("/").pop()}</span>
              <button
                className="tab-close"
                title="Close"
                onClick={(e) => {
                  e.stopPropagation();
                  close(f.path);
                }}
              >
                {isDirty(f) && <span className="tab-dirty" />}
                <IconClose />
              </button>
            </div>
          ))}
        </div>
      )}
      {active && (
        <div className="breadcrumbs" title={active.path}>
          {rel(active.path)
            .split("/")
            .map((part, i, all) => (
              <span key={i} className={i === all.length - 1 ? "crumb last" : "crumb"}>
                {part}
              </span>
            ))}
        </div>
      )}
      {active ? (
        <Editor
          // `path` gives each file its own Monaco model, preserving undo history and cursor per tab.
          path={active.path}
          defaultValue={active.content}
          language={languageForPath(active.path)}
          theme={theme === "dark" ? "orbit-dark" : "orbit-light"}
          onMount={onMount}
          options={{
            fontFamily: "ui-monospace, 'SF Mono', SFMono-Regular, Menlo, Consolas, monospace",
            fontSize: settings.fontSize,
            tabSize: settings.tabSize,
            wordWrap: settings.wordWrap ? "on" : "off",
            minimap: { enabled: settings.minimap },
            automaticLayout: true,
            padding: { top: 8 },
            smoothScrolling: true,
            cursorSmoothCaretAnimation: "on",
            renderLineHighlight: "all",
            scrollBeyondLastLine: false,
            bracketPairColorization: { enabled: true },
            guides: { bracketPairs: "active" },
          }}
        />
      ) : (
        <div className="empty-editor">
          <h1>{root?.split("/").pop()}</h1>
          <div className="empty-hints">
            <span>Go to file</span>
            <kbd>⌘P</kbd>
            <span>Command palette</span>
            <kbd>⇧⌘P</kbd>
            <span>Search in files</span>
            <kbd>⇧⌘F</kbd>
            <span>Build / Run</span>
            <kbd>⌘B ⌘R</kbd>
          </div>
        </div>
      )}
    </div>
  );
}
