import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { useWorkspace } from "../state/workspace";
import { IconClose } from "../components/Icons";

interface AndroidSigningInfo {
  config: { keystore: string; alias: string } | null;
  hasPasswords: boolean;
  projectSigning: boolean;
  suggestedKeystore: string;
  error: string | null;
}

type Mode = "existing" | "create";

/**
 * Release signing for Android. Debug builds need nothing (Android's debug keystore is used).
 * Passwords go to the macOS Keychain; the keystore path and alias are remembered per project.
 */
export default function AndroidSigning({ onClose }: { onClose: () => void }) {
  const root = useWorkspace((s) => s.root)!;
  const [info, setInfo] = useState<AndroidSigningInfo | null>(null);
  const [mode, setMode] = useState<Mode>("existing");
  const [keystore, setKeystore] = useState("");
  const [alias, setAlias] = useState("upload");
  const [storePassword, setStorePassword] = useState("");
  const [keyPassword, setKeyPassword] = useState("");
  const [samePassword, setSamePassword] = useState(true);
  const [confirm, setConfirm] = useState("");
  const [certName, setCertName] = useState("");
  const [organization, setOrganization] = useState("");
  const [country, setCountry] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    invoke<AndroidSigningInfo>("android_signing_info", { root }).then((i) => {
      setInfo(i);
      if (i.config) {
        setKeystore(i.config.keystore);
        setAlias(i.config.alias);
      } else {
        setMode("create");
        setKeystore(i.suggestedKeystore);
      }
    });
  }, [root]);

  const chooseExisting = async () => {
    const file = await open({ multiple: false, filters: [{ name: "Keystore", extensions: ["jks", "keystore", "p12", "pfx"] }] });
    if (typeof file === "string") setKeystore(file);
  };
  const chooseNew = async () => {
    const file = await save({ defaultPath: keystore || undefined, filters: [{ name: "Keystore", extensions: ["jks"] }] });
    if (file) setKeystore(file);
  };

  const valid =
    keystore &&
    alias.trim() &&
    storePassword &&
    (mode === "create"
      ? storePassword.length >= 6 && storePassword === confirm && certName.trim()
      : samePassword || keyPassword);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      if (mode === "create") {
        await invoke("android_create_keystore", {
          root,
          keystore,
          alias: alias.trim(),
          password: storePassword,
          certificate: { name: certName.trim(), organization: organization.trim() || null, country: country.trim() || null },
        });
      } else {
        await invoke("android_save_signing", {
          root,
          keystore,
          alias: alias.trim(),
          storePassword,
          keyPassword: samePassword ? storePassword : keyPassword,
        });
      }
      setSaved(true);
      setStorePassword("");
      setKeyPassword("");
      setConfirm("");
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-labelledby="android-signing-title">
      <div className="setup">
        <header className="setup-header">
          <div>
            <h1 id="android-signing-title">Android signing</h1>
            <p className="muted">
              Release builds for Google Play are signed with your upload key. Debug builds don't need anything here.
            </p>
          </div>
          <button className="icon-btn" title="Close" onClick={onClose}>
            <IconClose />
          </button>
        </header>

        {info?.config && info.hasPasswords && !saved && (
          <div className="notice">
            Signing with <strong>{info.config.alias}</strong> from {info.config.keystore}. Passwords are in your Keychain.
          </div>
        )}
        {info?.projectSigning && !info.config && (
          <div className="notice">
            This project's build script already has a signingConfig; it's used unless you set a keystore here.
          </div>
        )}
        {info?.error && <div className="notice warning">{info.error}</div>}

        <fieldset className="field choice-group">
          <span>Upload key</span>
          <label className="choice">
            <input type="radio" checked={mode === "create"} onChange={() => setMode("create")} />
            <div>
              <div>Create a new upload keystore</div>
              <small className="muted">For a new app. Keep the file and password safe: Play needs the same key for every update.</small>
            </div>
          </label>
          <label className="choice">
            <input type="radio" checked={mode === "existing"} onChange={() => setMode("existing")} />
            <div>
              <div>Use an existing keystore</div>
              <small className="muted">A .jks or .keystore file you already sign with.</small>
            </div>
          </label>
        </fieldset>

        <div className="field">
          <span>Keystore file</span>
          <div className="row gap">
            <input className="text-input" value={keystore} onChange={(e) => setKeystore(e.target.value)} />
            <button className="btn" onClick={mode === "create" ? chooseNew : chooseExisting}>
              Choose…
            </button>
          </div>
          {mode === "create" && <small className="muted">Keep it outside the project so it never gets committed.</small>}
        </div>
        <label className="field">
          <span>Key alias</span>
          <input className="text-input" value={alias} onChange={(e) => setAlias(e.target.value)} />
        </label>
        <label className="field">
          <span>{mode === "create" ? "Password (at least 6 characters)" : "Keystore password"}</span>
          <input className="text-input" type="password" value={storePassword} onChange={(e) => setStorePassword(e.target.value)} />
        </label>

        {mode === "create" ? (
          <>
            <label className="field">
              <span>Confirm password</span>
              <input className="text-input" type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
              {confirm && confirm !== storePassword && <small className="field-error">Passwords don't match</small>}
            </label>
            <label className="field">
              <span>Your name or company (on the certificate)</span>
              <input className="text-input" value={certName} onChange={(e) => setCertName(e.target.value)} />
            </label>
            <div className="row gap">
              <label className="field grow">
                <span>Organization (optional)</span>
                <input className="text-input" value={organization} onChange={(e) => setOrganization(e.target.value)} />
              </label>
              <label className="field">
                <span>Country code (optional)</span>
                <input className="text-input" value={country} maxLength={2} onChange={(e) => setCountry(e.target.value.toUpperCase())} />
              </label>
            </div>
          </>
        ) : (
          <>
            <label className="choice">
              <input type="checkbox" checked={samePassword} onChange={(e) => setSamePassword(e.target.checked)} />
              <div>The key uses the same password as the keystore</div>
            </label>
            {!samePassword && (
              <label className="field">
                <span>Key password</span>
                <input className="text-input" type="password" value={keyPassword} onChange={(e) => setKeyPassword(e.target.value)} />
              </label>
            )}
          </>
        )}

        {error && <div className="check-error">{error}</div>}
        {saved && <div className="notice">Saved. Release builds and Archive now sign with this key.</div>}

        <footer className="setup-footer">
          <span className="muted setup-hint">Passwords are stored in the macOS Keychain, never in the project.</span>
          <button className="btn" onClick={onClose}>
            {saved ? "Done" : "Cancel"}
          </button>
          <button className="btn primary" onClick={submit} disabled={busy || !valid}>
            {busy ? <span className="spinner" /> : mode === "create" ? "Create keystore" : "Save"}
          </button>
        </footer>
      </div>
    </div>
  );
}
