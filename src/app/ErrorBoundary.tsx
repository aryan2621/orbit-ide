import { Component, ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { errorText, logWrite, openLogs } from "../lib/log";

/** Last line of defence: a render crash shows this instead of a blank window that can't be quit. */
export default class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: { componentStack?: string | null }) {
    logWrite("error", `render crash: ${errorText(error)}\n${info.componentStack ?? ""}`);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="crash">
        <h2>Something went wrong</h2>
        <pre>{this.state.error.message}</pre>
        <div className="crash-actions">
          <button className="btn primary" onClick={() => location.reload()}>Reload</button>
          <button className="btn" onClick={() => invoke("app_quit")}>Quit</button>
          <button className="btn" onClick={() => openLogs()}>Open Logs</button>
        </div>
      </div>
    );
  }
}
