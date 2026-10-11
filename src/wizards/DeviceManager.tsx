import { useEffect, useState } from "react";
import { ask } from "@tauri-apps/plugin-dialog";
import { Choice, Device, deviceManagerApi } from "../lib/ipc";
import { useProject } from "../state/project";
import { useSetup } from "../state/setup";
import { useUi } from "../state/ui";
import { IconClose } from "../components/Icons";
import DeviceTools from "./DeviceTools";

type Platform = "ios" | "android";

/** Create, start, stop, wipe and delete Simulators (iOS) and emulators (Android). */
export default function DeviceManager({ onClose }: { onClose: () => void }) {
  const projectPlatform = useProject((s) => s.info?.platform);
  const setupPlatform = useSetup((s) => s.platform);
  const platform: Platform = projectPlatform === "android" ? "android" : projectPlatform === "ios" ? "ios" : setupPlatform;
  const { devices, loadDevices } = useProject();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    loadDevices();
    // Emulators boot in the background; keep the list fresh while the dialog is open.
    const timer = setInterval(() => loadDevices(), 4000);
    return () => clearInterval(timer);
  }, [loadDevices]);

  const virtual = devices.filter((d) => (platform === "android" ? d.kind === "emulator" : d.kind === "simulator"));

  const act = async (d: Device, action: string, confirm?: string) => {
    if (confirm && !(await ask(confirm, { title: d.name, kind: "warning" }))) return;
    setBusy(`${d.id}:${action}`);
    setError(null);
    try {
      if (platform === "android") await deviceManagerApi.avdAction(d.avd ?? d.name.replace(/ /g, "_"), action as never);
      else await deviceManagerApi.simulatorAction(d.id, action as never);
      await loadDevices();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  };

  const button = (d: Device, action: string, label: string, confirm?: string) => (
    <button className="btn" disabled={busy !== null} onClick={() => act(d, action, confirm)}>
      {busy === `${d.id}:${action}` ? "…" : label}
    </button>
  );

  return (
    <div className="overlay" role="dialog" aria-modal="true" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="setup settings">
        <header className="setup-header">
          <div>
            <h1>{platform === "android" ? "Emulators" : "Simulators"}</h1>
            <p className="muted">Create and manage virtual devices to run your app on.</p>
          </div>
          <button className="icon-btn" title="Close" onClick={onClose}>
            <IconClose />
          </button>
        </header>

        <section className="settings-section">
          {virtual.length === 0 && <p className="muted">No {platform === "android" ? "emulators" : "Simulators"} yet. Create one below.</p>}
          {virtual.map((d) => (
            <div className="setting-row" key={d.id}>
              <div>
                <div>
                  {d.name} {d.booted && <span className="muted">● running</span>}
                </div>
                <small className="muted">{d.os}</small>
              </div>
              <div className="row-actions">
                {d.booted ? button(d, platform === "android" ? "stop" : "shutdown", "Shut down") : button(d, platform === "android" ? "start" : "boot", "Start")}
                {platform === "android" && !d.booted && button(d, "coldboot", "Cold boot")}
                {button(
                  d,
                  platform === "android" ? "wipe" : "erase",
                  "Wipe data",
                  "Erase all apps, data and settings on this device?",
                )}
                {button(d, "delete", "Delete", "Delete this device? This can't be undone.")}
              </div>
            </div>
          ))}
        </section>

        {(projectPlatform === "ios" || projectPlatform === "android") && <DeviceTools platform={platform} />}

        {creating ? (
          <CreateForm
            platform={platform}
            onDone={async () => {
              setCreating(false);
              await loadDevices();
            }}
          />
        ) : null}

        {error && <div className="check-error">{error}</div>}

        <footer className="setup-footer">
          {!creating && (
            <button className="btn" onClick={() => setCreating(true)}>
              New {platform === "android" ? "emulator" : "Simulator"}…
            </button>
          )}
          {platform === "android" && (
            <button className="btn" onClick={() => useUi.getState().setShowWirelessPair(true)}>
              Pair phone over Wi-Fi…
            </button>
          )}
          <span className="grow" />
          <button className="btn primary" onClick={onClose}>
            Done
          </button>
        </footer>
      </div>
    </div>
  );
}

function CreateForm({ platform, onDone }: { platform: Platform; onDone: () => void }) {
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

  if (models === null) return <div className="setup-step skeleton" />;
  const noSystems = systems.length === 0;
  return (
    <section className="settings-section">
      <h2>New {platform === "android" ? "emulator" : "Simulator"}</h2>
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
        <button className="btn primary" disabled={busy || noSystems || !model || !name.trim()} onClick={create}>
          {busy ? "Creating…" : "Create"}
        </button>
      </div>
    </section>
  );
}
