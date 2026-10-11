import { useEffect, useState } from "react";
import { useProject } from "../state/project";
import { useWorkspace } from "../state/workspace";
import { useUi } from "../state/ui";
import { IconArchive, IconBug, IconHammer, IconKey, IconMonitor, IconPhone, IconPlay, IconStopSquare } from "../components/Icons";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { androidApi, isWirelessSerial } from "../lib/ipc";
import { aiAvailable, useAi } from "../state/ai";
import { fixBuild } from "../ai/actions";

function elapsed(from: number, to: number) {
  const s = Math.round((to - from) / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Run/Stop/Build buttons, scheme, device and configuration pickers, and activity status. */
/** Actions with a plain "doing… / done" status (no device, no run phase). */
const SIMPLE_ACTIONS = {
  test: { active: "Testing", noun: "Tests" },
  clean: { active: "Cleaning", noun: "Clean" },
  resolve: { active: "Resolving packages", noun: "Package resolution" },
  pods: { active: "Installing pods", noun: "pod install" },
};

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
  const ai = useAi(aiAvailable);

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
  if (!info?.project) {
    // Not an Xcode/Gradle project, or reading it failed (e.g. the app restarted mid-read): say so.
    return (
      <button className="status-pill state-incomplete" title={info?.error ?? "Read the folder again"} onClick={() => load(root)}>
        <span className="dot" />
        {info?.error ? "Couldn't read the project · Retry" : "No iOS or Android project found · Retry"}
      </button>
    );
  }

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
        {info.project.name}: no {info.platform === "android" ? "modules" : "schemes"} · Retry
      </button>
    );
  }

  const errors = build.diagnostics.filter((d) => d.severity === "error").length;
  const warnings = build.diagnostics.length - errors;
  const on = build.deviceName ? ` on ${build.deviceName}` : "";
  let status: string | null = null;
  const simple = SIMPLE_ACTIONS[build.action as keyof typeof SIMPLE_ACTIONS];
  if (simple) {
    const tests = build.tests;
    const failed = tests?.filter((c) => c.status === "failed").length ?? 0;
    status = active
      ? `${simple.active}…${progressText(build.progress)} ${elapsed(build.startedAt!, now)}`
      : build.status === "cancelled"
        ? `${simple.noun} stopped`
        : tests && tests.length > 0
          ? failed
            ? `${failed} of ${plural(tests.length, "test")} failed`
            : `${plural(tests.length, "test")} passed`
          : `${simple.noun} ${build.status === "succeeded" ? "succeeded" : "failed"}${errors ? ` · ${plural(errors, "error")}` : ""}`;
  } else if (active) {
    const t = elapsed(build.startedAt!, now);
    status =
      build.action === "archive"
        ? build.phase === "installing"
          ? "Exporting…"
          : `Archiving… ${t}`
        : build.phase === "installing"
        ? `Installing${on}… ${t}`
        : build.phase === "running"
          ? `Running${on}`
          : `Building…${progressText(build.progress)} ${t}`;
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
  const isDevice = devices.find((d) => d.kind === "device" && d.id === deviceId) !== undefined;
  const android = info.platform === "android";
  const simulators = devices.filter((d) => d.kind === "simulator" || d.kind === "emulator");
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
          {/* Android debugs on emulators and phones; iOS only on Simulators (and Mac packages). */}
          <button className="icon-btn" title="Debug (⌘Y)" onClick={startDebug} disabled={!canRun || (isDevice && !android)}>
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
        {devices.length === 0 && (
          <option value="">
            {android ? "No devices: create an Android emulator (Setup)" : "No Simulators: install a runtime or create a Simulator (Setup)"}
          </option>
        )}
        {mac.map((d) => (
          <option key={d.id} value={d.id}>
            {d.name}
          </option>
        ))}
        {physical.length > 0 && (
          <optgroup label="Devices">
            {physical.map((d) => (
              <option key={d.id} value={d.id}>
                {deviceLabel(d.name, d.os)}
                {android ? (isWirelessSerial(d.id) ? " · Wi-Fi" : " · USB") : ""}
                {d.booted ? "" : " (not ready)"}
              </option>
            ))}
          </optgroup>
        )}
        {simulators.length > 0 && (
          <optgroup label={android ? "Emulators" : "Simulators"}>
            {simulators.map((d) => (
              <option key={d.id} value={d.id}>
                {deviceLabel(d.name, d.os)}
                {d.booted ? " ●" : android ? " (off)" : ""}
              </option>
            ))}
          </optgroup>
        )}
      </select>
      {info.platform !== "mac" && (
        <>
          <button className="icon-btn" title={android ? "Manage emulators" : "Manage Simulators"} onClick={() => useUi.getState().setShowDevices(true)}>
            <IconPhone />
          </button>
          <button className="icon-btn" title="Show device screen" onClick={() => useUi.getState().toggleDevicePane()}>
            <IconMonitor />
          </button>
        </>
      )}
      {android && !active && deviceId?.startsWith("emulator-") && (
        <button
          className="icon-btn"
          title="Shut down this emulator"
          onClick={() =>
            androidApi
              .stopEmulator(deviceId)
              .then(() => setTimeout(loadDevices, 1500))
              .catch((e) => useWorkspace.setState({ error: String(e) }))
          }
        >
          <IconStopSquare />
        </button>
      )}
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
      {info.platform !== "mac" && (
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
          {build.status === "failed" && build.action !== "archive" && errors > 0 && ai && (
            <button className="link" onClick={fixBuild}>
              Fix with AI
            </button>
          )}
        </span>
      )}
    </div>
  );
}

/** " 42/80" with a known total, else " 42 steps". */
function progressText(p: { done: number; total: number | null } | null) {
  if (!p) return "";
  return p.total ? ` ${p.done}/${p.total}` : ` ${plural(p.done, "step")}`;
}

/** "Pixel 8 (Android 16)", or just the name when the OS isn't known (offline/unauthorized phones). */
function deviceLabel(name: string, os: string) {
  return os ? `${name} (${os})` : name;
}
