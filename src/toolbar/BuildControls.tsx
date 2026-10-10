import { useEffect, useState } from "react";
import { useProject } from "../state/project";
import { useWorkspace } from "../state/workspace";
import { useUi } from "../state/ui";
import { IconArchive, IconBug, IconHammer, IconKey, IconPlay, IconStopSquare } from "../components/Icons";
import { revealItemInDir } from "@tauri-apps/plugin-opener";

function elapsed(from: number, to: number) {
  const s = Math.round((to - from) / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Run/Stop/Build buttons, scheme, device and configuration pickers, and activity status. */
export default function BuildControls() {
  const root = useWorkspace((s) => s.root);
  const {
    info,
    loading,
    scheme,
    configuration,
    build,
    devices,
    deviceId,
    setScheme,
    setConfiguration,
    setDevice,
    loadDevices,
    startBuild,
    startRun,
    startDebug,
    cancelBuild,
    load,
  } = useProject();
  const setShowSetup = useUi((s) => s.setShowSetup);
  const setShowSigning = useUi((s) => s.setShowSigning);
  const setShowArchive = useUi((s) => s.setShowArchive);
  const [now, setNow] = useState(Date.now());
  const active = build.status === "active";

  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);

  const hasSchemes = (info?.schemes.length ?? 0) > 0;
  useEffect(() => {
    if (hasSchemes) loadDevices();
  }, [hasSchemes, info?.platform, loadDevices]);

  if (!root) return null;
  if (loading) return <span className="status-pill state-loading"><span className="dot" />Reading project…</span>;
  if (!info?.project) return null;

  if (!hasSchemes) {
    if (info.error?.includes("Xcode is required")) {
      return (
        <button className="status-pill state-incomplete" title={info.error} onClick={() => setShowSetup(true)}>
          <span className="dot" />
          Install Xcode to build {info.project.name}
        </button>
      );
    }
    return (
      <button className="status-pill state-incomplete" title={info.error ?? undefined} onClick={() => load(root)}>
        <span className="dot" />
        {info.project.name}: no schemes · Retry
      </button>
    );
  }

  const errors = build.diagnostics.filter((d) => d.severity === "error").length;
  const warnings = build.diagnostics.length - errors;
  const on = build.deviceName ? ` on ${build.deviceName}` : "";
  let status: string | null = null;
  if (active) {
    const t = elapsed(build.startedAt!, now);
    status =
      build.action === "archive"
        ? build.phase === "installing"
          ? "Exporting…"
          : `Archiving… ${t}`
        : build.phase === "installing"
        ? `Installing${on}…`
        : build.phase === "running"
          ? `Running${on}`
          : `Building… ${t}`;
  } else if (build.status === "succeeded" && build.action === "archive") {
    status = "Archive succeeded";
  } else if (build.status === "succeeded") {
    status = build.action !== "build" ? `Finished running${on}` : `Build succeeded${warnings ? ` · ${plural(warnings, "warning")}` : ""}`;
  } else if (build.status === "failed") {
    status = `${build.action === "archive" ? "Archive" : build.action !== "build" && build.phase !== "building" ? "Run" : "Build"} failed${errors ? ` · ${plural(errors, "error")}` : ""}`;
  } else if (build.status === "cancelled") {
    status = build.action !== "build" ? "Stopped" : "Build cancelled";
  }
  const stateClass = active ? (build.phase === "running" ? "state-ready" : "state-loading") : build.status === "succeeded" ? "state-ready" : "state-error";

  const canRun = !!deviceId && !!scheme && info.runnable.includes(scheme);
  const isDevice = devices.find((d) => d.id === deviceId)?.kind === "device";
  const simulators = devices.filter((d) => d.kind === "simulator");
  const mac = devices.filter((d) => d.kind === "mac");
  const physical = devices.filter((d) => d.kind === "device");

  return (
    <div className="build-controls">
      {active ? (
        <button className="icon-btn" title="Stop (⌘.)" onClick={cancelBuild}>
          <IconStopSquare />
        </button>
      ) : (
        <>
          <button className="icon-btn run-btn" title="Run (⌘R)" onClick={startRun} disabled={!canRun}>
            <IconPlay />
          </button>
          <button className="icon-btn" title="Debug (⌘Y)" onClick={startDebug} disabled={!canRun || isDevice}>
            <IconBug />
          </button>
        </>
      )}
      <button className="icon-btn" title="Build (⌘B)" onClick={startBuild} disabled={active}>
        <IconHammer />
      </button>
      <select className="picker" value={scheme ?? ""} onChange={(e) => setScheme(e.target.value)} title="Scheme">
        {info.schemes.map((s) => (
          <option key={s}>{s}</option>
        ))}
      </select>
      <span className="picker-sep">›</span>
      <select
        className="picker"
        value={deviceId ?? ""}
        onChange={(e) => setDevice(e.target.value)}
        onFocus={() => loadDevices()}
        title="Run destination"
      >
        {devices.length === 0 && <option value="">No devices: install a Simulator runtime</option>}
        {mac.map((d) => (
          <option key={d.id} value={d.id}>
            {d.name}
          </option>
        ))}
        {physical.length > 0 && (
          <optgroup label="Devices">
            {physical.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name} ({d.os})
              </option>
            ))}
          </optgroup>
        )}
        {simulators.length > 0 && (
          <optgroup label="Simulators">
            {simulators.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name} ({d.os}){d.booted ? " ●" : ""}
              </option>
            ))}
          </optgroup>
        )}
      </select>
      <select
        className="picker narrow"
        value={configuration}
        onChange={(e) => setConfiguration(e.target.value)}
        title="Build configuration"
      >
        {info.configurations.map((c) => (
          <option key={c}>{c}</option>
        ))}
      </select>
      {info.platform === "ios" && (
        <>
          <button className="icon-btn" title="Signing" onClick={() => setShowSigning(true)} disabled={!scheme}>
            <IconKey />
          </button>
          <button className="icon-btn" title="Archive & distribute" onClick={() => setShowArchive(true)} disabled={!scheme || active}>
            <IconArchive />
          </button>
        </>
      )}
      {status && (
        <span className={`status-pill ${stateClass}`}>
          <span className="dot" />
          {status}
          {build.artifact && !active && (
            <button className="link" onClick={() => revealItemInDir(build.artifact!)}>
              Show in Finder
            </button>
          )}
        </span>
      )}
    </div>
  );
}
