import { DragEvent, useState } from "react";
import Editor, { OnMount } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import { fileText, isDirty, useWorkspace } from "../state/workspace";
import { editorFont, useSettings } from "../state/settings";
import { languageForPath, modelUri } from "./monaco-setup";
import { openContextMenu } from "../components/ContextMenu";
import { IconClose, IconFile } from "../components/Icons";
import Welcome from "../app/Welcome";
import { closeTab } from "./unsaved";
import { groupEditors } from "./navigation";
import { installEditorActions } from "../ai/actions";
import { errorText, logWrite } from "../lib/log";

/** Saves the active file, formatting it first when "Format on save" is on. */
export async function saveActiveWithFormat() {
  const { activePath, saveActive } = useWorkspace.getState();
  if (useSettings.getState().formatOnSave && activePath) {
    const uri = modelUri(activePath).toString();
    const editor = monaco.editor.getEditors().find((e) => e.getModel()?.uri.toString() === uri);
    await editor
      ?.getAction("editor.action.formatDocument")
      ?.run()
      .catch((e) => logWrite("warn", `format on save ${activePath}: ${errorText(e)}`));
  }
  await saveActive();
}

const TAB_MIME = "application/x-orbit-tab";

function EditorGroupView({ index, theme }: { index: number; theme: "light" | "dark" }) {
  const { root, files, groups, focused, setCursor, focusGroup, moveToGroup } = useWorkspace();
  const settings = useSettings();
  const [dropping, setDropping] = useState(false);
  const group = groups[index];
  const split = groups.length > 1;
  const active = group.active ? files.find((f) => f.path === group.active) : undefined;
  const tabs = group.paths.map((p) => files.find((f) => f.path === p)).filter((f): f is NonNullable<typeof f> => !!f);
  const other = index === 0 ? 1 : 0;

  const activate = (path: string) => {
    focusGroup(index);
    useWorkspace.getState().setActive(path);
  };
  const close = (path: string) => {
    focusGroup(index);
    closeTab(path);
  };

  const onMount: OnMount = (editor) => {
    groupEditors[index] = editor;
    editor.onDidDispose(() => {
      if (groupEditors[index] === editor) groupEditors[index] = null;
    });
    const report = () => {
      if (useWorkspace.getState().focused !== index) return;
      const p = editor.getPosition();
      setCursor(p ? { line: p.lineNumber, column: p.column } : null);
    };
    editor.onDidChangeCursorPosition(report);
    editor.onDidChangeModel(report);
    editor.onDidFocusEditorText(() => {
      focusGroup(index);
      report();
    });
    report();
    installEditorActions(editor);
  };

  const onDragOver = (e: DragEvent) => {
    if (!e.dataTransfer.types.includes(TAB_MIME)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = e.altKey ? "copy" : "move";
    setDropping(true);
  };
  const onDrop = (e: DragEvent) => {
    setDropping(false);
    const data = e.dataTransfer.getData(TAB_MIME);
    if (!data) return;
    e.preventDefault();
    const { path, from } = JSON.parse(data) as { path: string; from: number };
    if (from !== index) moveToGroup(path, from, index, e.altKey);
  };

  const rel = (p: string) => (root && p.startsWith(root + "/") ? p.slice(root.length + 1) : p);

  return (
    <div
      className={`editor-group${split && focused === index ? " focused" : ""}${dropping ? " dropping" : ""}`}
      onMouseDown={() => focusGroup(index)}
      onDragOver={onDragOver}
      onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node) && setDropping(false)}
      onDrop={onDrop}
    >
      {tabs.length > 0 && (
        <div className="tabstrip">
          {tabs.map((f) => (
            <div
              key={f.path}
              className={`tab${f.path === group.active ? " active" : ""}`}
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData(TAB_MIME, JSON.stringify({ path: f.path, from: index }));
                e.dataTransfer.effectAllowed = "copyMove";
              }}
              onClick={() => activate(f.path)}
              onAuxClick={(e) => e.button === 1 && close(f.path)}
              onContextMenu={(e) =>
                openContextMenu(e, [
                  { label: "Close", shortcut: "⌘W", onSelect: () => close(f.path) },
                  { label: "Close Others", onSelect: () => tabs.filter((o) => o.path !== f.path && !isDirty(o)).forEach((o) => close(o.path)) },
                  { label: "Close Saved", onSelect: () => tabs.filter((o) => !isDirty(o)).forEach((o) => close(o.path)) },
                  null,
                  { label: split ? "Open in Other Group" : "Split Right", shortcut: split ? undefined : "⌘\\", onSelect: () => moveToGroup(f.path, index, other, true) },
                  { label: split ? "Move to Other Group" : "Move to New Group", onSelect: () => moveToGroup(f.path, index, other) },
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
          path={modelUri(active.path).toString()}
          // The model already exists (workspace.openFile creates it); this is only a fallback.
          defaultValue={fileText(active.path) ?? ""}
          language={languageForPath(active.path)}
          theme={theme === "dark" ? "orbit-dark" : "orbit-light"}
          onMount={onMount}
          // Models are owned by the workspace (closeTab disposes them); another group may still show this one.
          keepCurrentModel
          options={{
            fontFamily: editorFont(settings.fontFamily),
            fontLigatures: !!settings.fontFamily,
            fontSize: settings.fontSize,
            tabSize: settings.tabSize,
            wordWrap: settings.wordWrap ? "on" : "off",
            minimap: { enabled: settings.minimap && !split },
            inlayHints: { enabled: settings.inlayHints ? "on" : "off" },
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

export default function EditorArea({ theme }: { theme: "light" | "dark" }) {
  const root = useWorkspace((s) => s.root);
  const count = useWorkspace((s) => s.files.length);
  const groups = useWorkspace((s) => s.groups.length);
  if (!root && count === 0) return <Welcome />;
  return (
    <div className="editor-area">
      <div className="editor-groups">
        {Array.from({ length: groups }, (_, i) => (
          <EditorGroupView key={i} index={i} theme={theme} />
        ))}
      </div>
    </div>
  );
}
