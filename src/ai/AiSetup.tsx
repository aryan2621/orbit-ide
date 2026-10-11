import { useEffect, useState } from "react";
import { open as openDialog, ask } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { CatalogModel, aiApi } from "../lib/ipc";
import { CONTEXT_SIZES, useAi } from "../state/ai";

const gb = (bytes: number) => `${(bytes / 2 ** 30).toFixed(1)} GB`;

/** One catalog model: license, download with progress / pause / resume, use, delete. */
function ModelRow({ model, recommended }: { model: CatalogModel; recommended: boolean }) {
  const { models, downloads, settings, update } = useAi();
  const [error, setError] = useState<string | null>(null);
  const installed = models?.installed.some((m) => m.id === model.id);
  const progress = downloads[model.id];
  const running = models?.downloading.includes(model.id) || progress?.status === "downloading" || progress?.status === "verifying";
  const partial = models?.partial[model.id] ?? (progress?.status === "paused" ? progress.received : 0);
  const accepted = settings.accepted.includes(model.id);
  const inUse = settings.model === model.id;
  const received = progress?.received ?? partial;

  const act = (fn: () => Promise<unknown>) => {
    setError(null);
    fn().catch((e) => setError(String(e)));
  };
  const download = () => act(() => aiApi.download(model.id));

  return (
    <div className="ai-model">
      <div className="ai-model-head">
        <div>
          <strong>{model.name}</strong> {recommended && <span className="pill">Recommended for this Mac</span>} {inUse && installed && <span className="pill on">In use</span>}
          <div className="muted small">
            {model.description} {gb(model.size)} · needs {model.minMemoryGb} GB memory.
          </div>
          <div className="muted small">
            License: {model.license} ·{" "}
            <button className="link" onClick={() => openUrl(model.licenseUrl)}>
              Read
            </button>
          </div>
        </div>
      </div>

      {running ? (
        <div className="ai-progress">
          <progress value={received} max={model.size} />
          <span className="muted small">{progress?.status === "verifying" ? "Verifying checksum…" : `${gb(received)} of ${gb(model.size)}`}</span>
          <button className="btn" onClick={() => aiApi.stopDownload(model.id, false)}>
            Pause
          </button>
          <button className="btn subtle" onClick={() => aiApi.stopDownload(model.id, true)}>
            Cancel
          </button>
        </div>
      ) : installed ? (
        <div className="row-actions">
          {!inUse && (
            <button className="btn primary" onClick={() => update({ model: model.id })}>
              Use
            </button>
          )}
          <button
            className="btn subtle"
            onClick={async () => {
              if (await ask(`Delete ${model.name} (${gb(model.size)})?`, { title: "Delete model", kind: "warning" })) act(async () => (await aiApi.deleteModel(model.id), await useAi.getState().refresh()));
            }}
          >
            Delete
          </button>
        </div>
      ) : (
        <div className="row-actions">
          {!accepted ? (
            <label className="check">
              <input type="checkbox" checked={accepted} onChange={() => update({ accepted: [...settings.accepted, model.id] })} /> I accept the {model.license} license
            </label>
          ) : partial > 0 ? (
            <>
              <button className="btn primary" onClick={download}>
                Resume ({gb(partial)} of {gb(model.size)})
              </button>
              <button className="btn subtle" onClick={() => act(async () => (await aiApi.stopDownload(model.id, true), await useAi.getState().refresh()))}>
                Discard
              </button>
            </>
          ) : (
            <button className="btn primary" onClick={download}>
              Download ({gb(model.size)})
            </button>
          )}
        </div>
      )}
      {(error || progress?.error) && <div className="check-error">{error ?? progress?.error?.message}</div>}
    </div>
  );
}

/** Settings → AI and the panel's first-use flow: hardware check, models, options. */
export default function AiSetup({ compact = false }: { compact?: boolean }) {
  const { hardware, models, settings, update, refresh } = useAi();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    refresh().catch(() => {});
  }, [refresh]);

  if (!hardware) return <div className="setup-step skeleton" />;
  if (!hardware.supported) {
    return (
      <div className="ai-unsupported">
        <strong>The built-in AI isn't available on this Mac</strong>
        <p className="muted">{hardware.reason}</p>
      </div>
    );
  }

  const custom = models?.installed.filter((m) => m.custom) ?? [];
  const importModel = async () => {
    const path = await openDialog({ multiple: false, filters: [{ name: "GGUF model", extensions: ["gguf"] }] });
    if (typeof path !== "string") return;
    setError(null);
    try {
      const id = await aiApi.importModel(path);
      await refresh();
      update({ model: id });
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <div className="ai-setup">
      {!compact && (
        <div className="setting-row">
          <div>
            <div>AI features</div>
            <small className="muted">Chat, Fix with AI and inline completions. Models run on this Mac; nothing is sent anywhere.</small>
          </div>
          <input type="checkbox" className="switch" checked={settings.enabled} onChange={(e) => update({ enabled: e.target.checked })} />
        </div>
      )}
      {settings.enabled && (
        <>
          <p className="muted small">
            This Mac has {hardware.memoryGb.toFixed(0)} GB of memory. Models are stored in {models?.dir.replace(/^\/Users\/[^/]+/, "~")}.
          </p>
          {models?.catalog.map((m) => <ModelRow key={m.id} model={m} recommended={m.id === hardware.recommendedModel} />)}
          {custom.map((m) => (
            <div className="ai-model" key={m.id}>
              <div className="ai-model-head">
                <div>
                  <strong>{m.name}</strong> <span className="muted small">custom · {gb(m.size)}</span> {settings.model === m.id && <span className="pill on">In use</span>}
                </div>
              </div>
              <div className="row-actions">
                {settings.model !== m.id && (
                  <button className="btn primary" onClick={() => update({ model: m.id })}>
                    Use
                  </button>
                )}
                <button className="btn subtle" onClick={async () => (await aiApi.deleteModel(m.id), await refresh())}>
                  Delete
                </button>
              </div>
            </div>
          ))}
          <button className="btn" onClick={importModel}>
            Import GGUF model…
          </button>
          {error && <div className="check-error">{error}</div>}

          {!compact && (
            <>
              <div className="setting-row">
                <div>
                  <div>Context size</div>
                  <small className="muted">How much of the conversation and code the model sees. Larger uses more memory.</small>
                </div>
                <div className="segmented">
                  {CONTEXT_SIZES.map((c) => (
                    <button key={c} className={settings.ctx === c ? "on" : ""} onClick={() => update({ ctx: c })}>
                      {c / 1024}K
                    </button>
                  ))}
                </div>
              </div>
              <div className="setting-row">
                <div>
                  <div>Unload when idle</div>
                  <small className="muted">Frees the model's memory after this long without use.</small>
                </div>
                <select value={settings.idleMinutes} onChange={(e) => update({ idleMinutes: Number(e.target.value) })}>
                  {[5, 10, 30, 60, 0].map((m) => (
                    <option key={m} value={m}>
                      {m === 0 ? "Never" : `${m} minutes`}
                    </option>
                  ))}
                </select>
              </div>
              <div className="setting-row">
                <div>
                  <div>Inline completions</div>
                  <small className="muted">Ghost-text suggestions while typing (Tab accepts). Uses the loaded model; Qwen2.5 Coder models only.</small>
                </div>
                <input type="checkbox" className="switch" checked={settings.inlineCompletions} onChange={(e) => update({ inlineCompletions: e.target.checked })} />
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
