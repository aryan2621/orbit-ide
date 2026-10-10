import { useCallback, useEffect, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { depsApi, Dependency } from "../lib/ipc";
import { useProject } from "../state/project";
import { IconRefresh } from "../components/Icons";

type DepsResult = Awaited<ReturnType<typeof depsApi.list>>;

/** Swift package dependencies: list, and add for Swift packages and XcodeGen projects. */
export default function PackagesView({ root }: { root: string }) {
  const [deps, setDeps] = useState<DepsResult | null>(null);
  const [url, setUrl] = useState("");
  const [version, setVersion] = useState("1.0.0");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = useProject((s) => s.load);

  const refresh = useCallback(() => {
    setDeps(null);
    depsApi.list(root).then(setDeps, (e) => setError(String(e)));
  }, [root]);

  useEffect(refresh, [refresh]);

  const add = async () => {
    setBusy(true);
    setError(null);
    try {
      await depsApi.add(root, url.trim(), version.trim(), null);
      setUrl("");
      refresh();
      load(root);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const validUrl = /^(https?:\/\/|git@).+/.test(url.trim());
  const validVersion = /^\d+\.\d+\.\d+$/.test(version.trim());

  return (
    <div className="sidebar-view">
      <div className="sidebar-header">
        <span className="sidebar-title">Packages</span>
        <button className="icon-btn small" title="Refresh" onClick={refresh}>
          <IconRefresh />
        </button>
      </div>
      {deps?.editable && (
        <div className="scm-top">
          <input
            className="text-input"
            placeholder="https://github.com/owner/package"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
          <div className="row gap">
            <input
              className="text-input"
              placeholder="From version"
              value={version}
              onChange={(e) => setVersion(e.target.value)}
              title="Minimum version (up to the next major)"
            />
            <button className="btn primary" onClick={add} disabled={busy || !validUrl || !validVersion}>
              {busy ? <span className="spinner" /> : "Add"}
            </button>
          </div>
          <small className="muted">
            {deps.source === "xcodegen" ? "Added to project.yml and linked to the app target." : "Added to Package.swift."}{" "}
            <button className="link" onClick={() => openUrl("https://swiftpackageindex.com")}>
              Browse packages
            </button>
          </small>
        </div>
      )}
      {error && <pre className="check-error scm-error">{error}</pre>}
      <div className="sidebar-body">
        {deps === null ? (
          <div className="var-empty">Loading…</div>
        ) : deps.error && deps.items.length === 0 ? (
          <div className="var-empty">{deps.error}</div>
        ) : deps.items.length === 0 ? (
          <div className="var-empty">No dependencies yet</div>
        ) : (
          deps.items.map((d: Dependency) => (
            <div
              key={d.name}
              className="dep-row"
              title={d.url}
              onClick={() => d.url.startsWith("http") && openUrl(d.url.replace(/\.git$/, ""))}
            >
              <span className="change-name">{d.name}</span>
              <span className="change-dir">{d.version}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
