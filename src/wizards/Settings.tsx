import { useSettings } from "../state/settings";
import { ThemePref, useThemePref } from "../state/theme";
import { useUi } from "../state/ui";
import { IconClose } from "../components/Icons";

function Toggle({ label, detail, value, onChange }: { label: string; detail?: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="setting-row">
      <div>
        <div>{label}</div>
        {detail && <small className="muted">{detail}</small>}
      </div>
      <input type="checkbox" className="switch" checked={value} onChange={(e) => onChange(e.target.checked)} />
    </label>
  );
}

export default function Settings() {
  const setShowSettings = useUi((s) => s.setShowSettings);
  const s = useSettings();
  const { pref, set: setTheme } = useThemePref();

  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-labelledby="settings-title" onMouseDown={(e) => e.target === e.currentTarget && setShowSettings(false)}>
      <div className="setup settings">
        <header className="setup-header">
          <div>
            <h1 id="settings-title">Settings</h1>
            <p className="muted">Saved on this Mac and applied immediately.</p>
          </div>
          <button className="icon-btn" title="Close" onClick={() => setShowSettings(false)}>
            <IconClose />
          </button>
        </header>

        <section className="settings-section">
          <h2>Appearance</h2>
          <div className="setting-row">
            <div>Theme</div>
            <div className="segmented">
              {(["system", "light", "dark"] as ThemePref[]).map((t) => (
                <button key={t} className={pref === t ? "on" : ""} onClick={() => setTheme(t)}>
                  {t[0].toUpperCase() + t.slice(1)}
                </button>
              ))}
            </div>
          </div>
        </section>

        <section className="settings-section">
          <h2>Editor</h2>
          <label className="setting-row">
            <div>Font size</div>
            <div className="stepper-input">
              <button className="btn" onClick={() => s.update({ fontSize: Math.max(9, s.fontSize - 1) })}>−</button>
              <span>{s.fontSize}px</span>
              <button className="btn" onClick={() => s.update({ fontSize: Math.min(28, s.fontSize + 1) })}>+</button>
            </div>
          </label>
          <label className="setting-row">
            <div>Tab size</div>
            <div className="segmented">
              {[2, 4].map((n) => (
                <button key={n} className={s.tabSize === n ? "on" : ""} onClick={() => s.update({ tabSize: n })}>
                  {n} spaces
                </button>
              ))}
            </div>
          </label>
          <Toggle label="Word wrap" value={s.wordWrap} onChange={(wordWrap) => s.update({ wordWrap })} />
          <Toggle label="Minimap" value={s.minimap} onChange={(minimap) => s.update({ minimap })} />
          <Toggle
            label="Format on save"
            detail="Runs swift-format through the language server when you press ⌘S."
            value={s.formatOnSave}
            onChange={(formatOnSave) => s.update({ formatOnSave })}
          />
        </section>

        <footer className="setup-footer">
          <button className="btn subtle" onClick={s.reset}>
            Reset to defaults
          </button>
          <span className="grow" />
          <button className="btn primary" onClick={() => setShowSettings(false)}>
            Done
          </button>
        </footer>
      </div>
    </div>
  );
}
