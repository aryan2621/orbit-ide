// Bundle Monaco locally (the default loader pulls it from a CDN, which won't work offline in Tauri).
import * as monaco from "monaco-editor";
import { loader } from "@monaco-editor/react";
import EditorWorker from "monaco-editor/editor/editor.worker.js?worker";
import JsonWorker from "monaco-editor/language/json/json.worker.js?worker";
import TsWorker from "monaco-editor/language/typescript/ts.worker.js?worker";

self.MonacoEnvironment = {
  getWorker(_id, label) {
    if (label === "json") return new JsonWorker();
    if (label === "typescript" || label === "javascript") return new TsWorker();
    return new EditorWorker();
  },
};

loader.config({ monaco });

const EXT_LANG: Record<string, string> = {
  swift: "swift",
  m: "objective-c",
  h: "objective-c",
  kt: "kotlin",
  kts: "kotlin",
  java: "java",
  dart: "dart",
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  json: "json",
  plist: "xml",
  xml: "xml",
  storyboard: "xml",
  xib: "xml",
  entitlements: "xml",
  yml: "yaml",
  yaml: "yaml",
  md: "markdown",
  rs: "rust",
  sh: "shell",
  rb: "ruby",
  css: "css",
  html: "html",
  gradle: "groovy",
};

export function languageForPath(path: string): string {
  const name = path.split("/").pop() ?? "";
  if (name === "Podfile" || name === "Fastfile" || name === "Gemfile") return "ruby";
  const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
  return EXT_LANG[ext] ?? "plaintext";
}

// Editor themes matching the app palette (see styles.css tokens).
monaco.editor.defineTheme("orbit-light", {
  base: "vs",
  inherit: true,
  rules: [
    { token: "comment", foreground: "8a877d", fontStyle: "italic" },
    { token: "keyword", foreground: "b4532f" },
    { token: "string", foreground: "3c7a3f" },
    { token: "number", foreground: "8a5a00" },
    { token: "type", foreground: "5a4fa0" },
  ],
  colors: {
    "editor.background": "#faf9f5",
    "editor.foreground": "#141413",
    "editorLineNumber.foreground": "#b5b2a7",
    "editorLineNumber.activeForeground": "#6b6a64",
    "editor.lineHighlightBackground": "#f0eee6",
    "editor.selectionBackground": "#f0d6ca",
    "editorCursor.foreground": "#c6613f",
    "editorIndentGuide.background1": "#e8e6dc",
    "editorWidget.background": "#ffffff",
    "editorWidget.border": "#e0ddd2",
    "minimap.background": "#faf9f5",
  },
});

monaco.editor.defineTheme("orbit-dark", {
  base: "vs-dark",
  inherit: true,
  rules: [
    { token: "comment", foreground: "7d7a72", fontStyle: "italic" },
    { token: "keyword", foreground: "e0896a" },
    { token: "string", foreground: "8cc28a" },
    { token: "number", foreground: "e8bf6a" },
    { token: "type", foreground: "b3a6f0" },
  ],
  colors: {
    "editor.background": "#262624",
    "editor.foreground": "#f5f4ee",
    "editorLineNumber.foreground": "#5e5c56",
    "editorLineNumber.activeForeground": "#a6a39a",
    "editor.lineHighlightBackground": "#30302e",
    "editor.selectionBackground": "#5a3d32",
    "editorCursor.foreground": "#d97757",
    "editorIndentGuide.background1": "#3a3935",
    "editorWidget.background": "#30302e",
    "editorWidget.border": "#3d3c38",
    "minimap.background": "#262624",
  },
});
