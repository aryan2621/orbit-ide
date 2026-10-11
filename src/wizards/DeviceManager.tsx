import { MouseEvent, useEffect, useState } from "react";
import { ask } from "@tauri-apps/plugin-dialog";
import { Choice, Device, androidApi, deviceManagerApi, isWirelessSerial } from "../lib/ipc";
import { useProject } from "../state/project";
import { useSetup } from "../state/setup";
import { useUi } from "../state/ui";
import { openContextMenu } from "../components/ContextMenu";
import { IconClose, IconMonitor, IconMore, IconPhone, IconPlus, IconRefresh } from "../components/Icons";
import DeviceTools from "./DeviceTools";

type Platform = "ios" | "android";
type Tab = "phones" | "virtual" | "tools";

/** Phones, emulators / Simulators and app tools, in one dialog. */
export default function DeviceManager({ onClose }: { onClose: () => void }) {
  const projectPlatform = useProject((s) => s.info?.platform);
  const setupPlatform = useSetup((s) => s.platform);
  const platform: Platform = projectPlatform === "android" ? "android" : projectPlatform === "ios" ? "ios" : setupPlatform;
  const { devices, deviceId, setDevice, loadDevices } = useProject();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const virtualLabel = platform === "android" ? "Emulators" : "Simulators";
  const virtual = devices.filter((d) => (platform === "android" ? d.kind === "emulator" : d.kind === "simulator"));
  const phones = devices.filter((d) => d.kind === "device");
  const hasProject = projectPlatform === "ios" || projectPlatform === "android";
  const [tab, setTab] = useState<Tab>(() => (phones.length > 0 && platform === "android" ? "phones" : "virtual"));

  useEffect(() => {
    loadDevices();
    // Emulators boot in the background; keep the list fresh while the dialog is open.
    const timer = setInterval(() => loadDevices(), 4000);
    return () => {
      clearInterval(timer);
    };
  }, [loadDevices, onClose]);

  const guard = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    setError(null);
    try {
      await fn();
      await loadDevices();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  };

  const act = async (d: Device, action: string, confirm?: string) => {
    if (confirm && !(await ask(confirm, { title: d.name, kind: "warning" }))) return;
    guard(`${d.id}:${action}`, () =>
      platform === "android" ? deviceManagerApi.avdAction(d.avd ?? d.name.replace(/ /g, "_"), action as never) : deviceManagerApi.simulatorAction(d.id, action as never),
    );
  };

  const refresh = async () => {
    setRefreshing(true);
    await loadDevices();
    setRefreshing(false);
  };

  const moreMenu = (e: MouseEvent, d: Device) =>
    openContextMenu(e, [
      platform === "android" && !d.booted && { label: "Cold Boot", onSelect: () => act(d, "coldboot") },
      { label: "Wipe Data…", onSelect: () => act(d, platform === "android" ? "wipe" : "erase", "Erase all apps, data and settings on this device?") },
      null,
      { label: "Delete…", danger: true, onSelect: () => act(d, "delete", "Delete this device? This can't be undone.") },
    ]);

  const useButton = (d: Device) =>
    d.id === deviceId ? (
      <span className="pill on" title="The toolbar's run destination">
        Selected
      </span>
    ) : (
      <button className="btn subtle" title="Make this the run destination in the toolbar" onClick={() => setDevice(d.id)}>
        Use
      </button>
    );

  const status = (d: Device) => (d.booted ? "on" : d.name.includes("(") ? "warn" : "off");

  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-label="Devices" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="devices-window">
        <header className="devices-header">
          <div>
            <h1>Devices</h1>
            <p className="muted">Where your app runs: {platform === "android" ? "phones and emulators" : "Simulators and iPhones"}.</p>
          </div>
          <span className="grow" />
          <button className="icon-btn" title="Refresh the list" onClick={refresh} disabled={refreshing}>
            <IconRefresh />
          </button>
          <button className="icon-btn" title="Close (Esc)" onClick={onClose}>
            <IconClose />
          </button>
        </header>

        <div className="devices-tabs" role="tablist">
          {(
            [
              ["phones", platform === "android" ? "Phones" : "iPhones", phones.length],
              ["virtual", virtualLabel, virtual.length],
              ...(hasProject ? [["tools", "App tools", null]] : []),
            ] as [Tab, string, number | null][]
          ).map(([id, label, count]) => (
            <button key={id} role="tab" aria-selected={tab === id} className={`devices-tab${tab === id ? " active" : ""}`} onClick={() => setTab(id)}>
              {label}
              {count !== null && <span className="devices-count">{count}</span>}
            </button>
          ))}
        </div>

        <div className="devices-body">
          {error && <div className="check-error">{error}</div>}

          {tab === "phones" &&
            (phones.length === 0 ? (
              <div className="devices-empty">
                <IconPhone />
                <strong>No {platform === "android" ? "phones" : "iPhones"} connected</strong>
                <p className="muted">
                  {platform === "android"
                    ? "Plug one in with USB debugging on (Settings → Developer options) and tap Allow on the phone, or pair over Wi-Fi."
                    : "Connect an iPhone with a cable, unlock it and tap Trust. Turn on Developer Mode in Settings → Privacy & Security."}
                </p>
                {platform === "android" && (
                  <button className="btn primary" onClick={() => useUi.getState().setShowWirelessPair(true)}>
                    Pair over Wi-Fi…
                  </button>
                )}
              </div>
            ) : (
              <>
                <div className="device-list">
                  {phones.map((d) => {
                    const wireless = platform === "android" && isWirelessSerial(d.id);
                    return (
                      <div className="device-row" key={d.id}>
                        <span className="device-icon">
                          <IconPhone />
                        </span>
                        <div className="device-info">
                          <div className="device-name">
                            <span className={`device-dot ${status(d)}`} />
                            {d.name}
                          </div>
                          <small className="muted">
                            {[d.os, platform === "android" ? (wireless ? "Wi-Fi" : "USB") : null].filter(Boolean).join(" · ")}
                          </small>
                        </div>
                        <div className="device-actions">
                          {d.booted && useButton(d)}
                          {wireless && (
                            <button
                              className="btn"
                              title="Disconnect; the phone stays paired (tap Forget on the phone to unpair)"
                              disabled={busy !== null}
                              onClick={() => guard(`${d.id}:disconnect`, () => androidApi.disconnect(d.id))}
                            >
                              {busy === `${d.id}:disconnect` ? "…" : "Disconnect"}
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
                {platform === "android" && (
                  <div className="devices-foot">
                    <span className="muted small">USB phones disconnect when unplugged.</span>
                    <span className="grow" />
                    <button className="btn" onClick={() => useUi.getState().setShowWirelessPair(true)}>
                      Pair over Wi-Fi…
                    </button>
                  </div>
                )}
              </>
            ))}

          {tab === "virtual" && (
            <>
              {creating && (
                <CreateForm
                  platform={platform}
                  onCancel={() => setCreating(false)}
                  onDone={async () => {
                    setCreating(false);
                    await loadDevices();
                  }}
                />
              )}
              {virtual.length === 0 && !creating ? (
                <div className="devices-empty">
                  <IconMonitor />
                  <strong>No {virtualLabel.toLowerCase()} yet</strong>
                  <p className="muted">Create a virtual {platform === "android" ? "Android device" : "iPhone or iPad"} to run your app without hardware.</p>
                  <button className="btn primary" onClick={() => setCreating(true)}>
                    New {platform === "android" ? "emulator" : "Simulator"}…
                  </button>
                </div>
              ) : (
                <>
                  <div className="device-list">
                    {virtual.map((d) => {
                      const starting = busy === `${d.id}:start` || busy === `${d.id}:boot` || busy === `${d.id}:coldboot`;
                      return (
                        <div className="device-row" key={d.id}>
                          <span className="device-icon">
                            <IconMonitor />
                          </span>
                          <div className="device-info">
                            <div className="device-name">
                              <span className={`device-dot ${starting ? "warn" : status(d)}`} />
                              {d.name}
                            </div>
                            <small className="muted">{[d.os, d.booted ? "Running" : starting ? "Starting…" : "Off"].filter(Boolean).join(" · ")}</small>
                          </div>
                          <div className="device-actions">
                            {d.booted && useButton(d)}
                            {d.booted ? (
                              <button className="btn" disabled={busy !== null} onClick={() => act(d, platform === "android" ? "stop" : "shutdown")}>
                                {busy?.startsWith(`${d.id}:`) ? "…" : "Shut Down"}
                              </button>
                            ) : (
                              <button className="btn primary" disabled={busy !== null} onClick={() => act(d, platform === "android" ? "start" : "boot")}>
                                {starting ? "Starting…" : "Start"}
                              </button>
                            )}
                            <button className="icon-btn" title="More actions" disabled={busy !== null} onClick={(e) => moreMenu(e, d)}>
                              <IconMore />
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  {!creating && (
                    <div className="devices-foot">
                      <span className="grow" />
                      <button className="btn" onClick={() => setCreating(true)}>
                        <IconPlus /> New {platform === "android" ? "emulator" : "Simulator"}…
                      </button>
                    </div>
                  )}
                </>
              )}
            </>
          )}

          {tab === "tools" && hasProject && <DeviceTools platform={platform} />}
        </div>
      </div>
    </div>
  );
}

function CreateForm({ platform, onDone, onCancel }: { platform: Platform; onDone: () => void; onCancel: () => void }) {
  const [models, setModels] = useState<Choice[] | null>(null);
  const [systems, setSystems] = useState<Choice[]>([]);
  const [model, setModel] = useState("");
  const [system, setSystem] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const load =
      platform === "android"
        ? deviceManagerApi.avdOptions().then((o) => ({ models: o.devices, systems: o.images }))
        : deviceManagerApi.simulatorOptions().then((o) => ({ models: o.deviceTypes, systems: o.runtimes }));
    load.then(
      (o) => {
        setModels(o.models);
        setSystems(o.systems);
        setModel(o.models[0]?.id ?? "");
        setSystem(o.systems[0]?.id ?? "");
        setName(o.models[0]?.name ?? "");
      },
      (e) => {
        setModels([]);
        setError(String(e));
      },
    );
  }, [platform]);

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      if (platform === "android") await deviceManagerApi.createAvd(name, model, system);
      else await deviceManagerApi.createSimulator(name, model, system);
      onDone();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  if (models === null) return <div className="device-create skeleton-block" />;
  const noSystems = systems.length === 0;
  return (
    <section className="device-create">
      <h3>New {platform === "android" ? "emulator" : "Simulator"}</h3>
      <label className="field">
        <span>Device</span>
        <select
          className="text-input"
          value={model}
          onChange={(e) => {
            const prevName = models.find((m) => m.id === model)?.name;
            setModel(e.target.value);
            // Follow the model in the name until the user types their own.
            if (!name || name === prevName) setName(models.find((m) => m.id === e.target.value)?.name ?? "");
          }}
        >
          {models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span>{platform === "android" ? "System image" : "iOS version"}</span>
        <select className="text-input" value={system} onChange={(e) => setSystem(e.target.value)} disabled={noSystems}>
          {noSystems && <option>None installed — install one from Setup</option>}
          {systems.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span>Name</span>
        <input className="text-input" value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      {error && <div className="check-error">{error}</div>}
      <div className="row-actions">
        <button className="btn" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
        <button className="btn primary" disabled={busy || noSystems || !model || !name.trim()} onClick={create}>
          {busy ? "Creating…" : "Create"}
        </button>
      </div>
    </section>
  );
}
