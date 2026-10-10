import React from "react";
import ReactDOM from "react-dom/client";
import "./editor/monaco-setup";
import "./editor/model-sync";
import "./lsp/swift";
import "./debug/editor-breakpoints";
import "@xterm/xterm/css/xterm.css";
import "./styles.css";
import Layout from "./app/Layout";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <Layout />
  </React.StrictMode>,
);
