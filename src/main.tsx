import React from "react";
import "./lib/log";
import ReactDOM from "react-dom/client";
import "./editor/monaco-setup";
import "./editor/model-sync";
import "./editor/autosave";
import "./lsp/swift";
import "./lsp/android";
import "./debug/editor-breakpoints";
import "./editor/conflicts";
import "./ai/completions";
import "./state/fswatch";
import { restoreLastFolder } from "./state/session";
import "@xterm/xterm/css/xterm.css";
import "./styles.css";
import Layout from "./app/Layout";
import ErrorBoundary from "./app/ErrorBoundary";

restoreLastFolder();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary>
      <Layout />
    </ErrorBoundary>
  </React.StrictMode>,
);
