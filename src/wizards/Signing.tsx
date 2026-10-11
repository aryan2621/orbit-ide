import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { signingApi, SigningInfo } from "../lib/ipc";
import { useUi } from "../state/ui";
import { useWorkspace } from "../state/workspace";
import { useProject } from "../state/project";
import { loadSigning, saveSigning } from "../state/signing";
import { IconClose } from "../components/Icons";

const OTHER = "__other__";
const API_KEYS_URL = "https://appstoreconnect.apple.com/access/integrations/api";
const MEMBERSHIP_URL = "https://developer.apple.com/account#MembershipDetailsCard";

export default function Signing() {
  const setShowSigning = useUi((s) => s.setShowSigning);
  const root = useWorkspace((s) => s.root)!;
  const { scheme, configuration, load } = useProject();
  const [info, setInfo] = useState<SigningInfo | null>(null);
  const saved = loadSigning(root);

  const [teamChoice, setTeamChoice] = useState<string>("");
  const [otherTeam, setOtherTeam] = useState("");
  const [bundleId, setBundleId] = useState("");
  const [useApiKey, setUseApiKey] = useState(!!saved.apiKey);
  const [keyPath, setKeyPath] = useState(saved.apiKey?.path ?? "");
  const [keyId, setKeyId] = useState(saved.apiKey?.keyId ?? "");
  const [issuerId, setIssuerId] = useState(saved.apiKey?.issuerId ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    setLoadError(null);
    if (!scheme) {
      setLoadError("Choose a scheme in the toolbar first.");
      return;
    }
    signingApi.info(root, scheme, configuration).then((i) => {
      setInfo(i);
      setBundleId(i.bundleId ?? "");
      const team = saved.teamId ?? i.projectTeam ?? i.teams[0]?.id ?? "";
      if (!team || i.teams.some((t) => t.id === team)) setTeamChoice(team);
      else {
        setTeamChoice(OTHER);
        setOtherTeam(team);
      }
    }, (e) => setLoadError(`Couldn't read the project's signing settings: ${e}`));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root, scheme, configuration]);

  const teamId = (teamChoice === OTHER ? otherTeam : teamChoice).trim();
  const teamValid = teamId === "" || /^[A-Z0-9]{10}$/.test(teamId);
  const keyValid = !useApiKey || (keyPath && keyId.trim() && issuerId.trim());
  const projectChanged = !!info?.target && (bundleId !== (info.bundleId ?? "") || teamId !== (info.projectTeam ?? ""));

  const chooseKey = async () => {
    const file = await open({ multiple: false, filters: [{ name: "App Store Connect API key", extensions: ["p8"] }] });
    if (typeof file === "string") {
      setKeyPath(file);
      // Keys download as AuthKey_<KEYID>.p8.
      const match = /AuthKey_([A-Z0-9]+)\.p8$/.exec(file);
      if (match && !keyId) setKeyId(match[1]);
    }
  };

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      saveSigning(root, {
        teamId: teamId || null,
        apiKey: useApiKey ? { path: keyPath, keyId: keyId.trim(), issuerId: issuerId.trim() } : null,
      });
      if (projectChanged) {
        // Choosing a team means Xcode-managed signing; keep a manual setup only when no team changed.
        const style = teamId && teamId !== (info!.projectTeam ?? "") ? "Automatic" : null;
        await signingApi.save(root, info!.target!, bundleId.trim(), teamId, style);
        await load(root);
      }
      setShowSigning(false);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-labelledby="signing-title">
      <div className="setup">
        <header className="setup-header">
          <div>
            <h1 id="signing-title">Signing</h1>
            <p className="muted">
              Needed to run on a real iPhone and to ship. Simulator runs don't need signing.
              {info?.target && <> Target: <strong>{info.target}</strong></>}
            </p>
          </div>
          <button className="icon-btn" title="Close" onClick={() => setShowSigning(false)}>
            <IconClose />
          </button>
        </header>

        {!info && loadError ? (
          <div className="check-error">{loadError}</div>
        ) : !info ? (
          <div className="setup-steps">
            <div className="setup-step skeleton" />
            <div className="setup-step skeleton" />
          </div>
        ) : (
          <>
            {info.error && <div className="notice warning">{info.error}</div>}

            <label className="field">
              <span>Team</span>
              <select className="text-input" value={teamChoice} onChange={(e) => setTeamChoice(e.target.value)}>
                <option value="">None (use the project's setting)</option>
                {info.teams.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name} ({t.id})
                  </option>
                ))}
                <option value={OTHER}>Other team ID…</option>
              </select>
              {teamChoice === OTHER && (
                <input
                  className="text-input"
                  placeholder="10-character Team ID, e.g. A1B2C3D4E5"
                  value={otherTeam}
                  onChange={(e) => setOtherTeam(e.target.value.toUpperCase())}
                />
              )}
              {!teamValid && <small className="field-error">A Team ID is 10 letters and numbers</small>}
              <small className="muted">
                {info.teams.length === 0 ? "No Apple signing certificates in your Keychain yet. " : ""}
                Find your Team ID under{" "}
                <button className="link" onClick={() => openUrl(MEMBERSHIP_URL)}>
                  Membership details
                </button>
                .
              </small>
            </label>

            <label className="field">
              <span>Bundle identifier</span>
              <input
                className="text-input"
                value={bundleId}
                onChange={(e) => setBundleId(e.target.value.trim())}
                readOnly={!info.target}
              />
              <small className="muted">
                Must be unique on the App Store, e.g. com.yourname.appname. Saved to{" "}
                {info.xcodegen ? "project.yml" : "the Xcode project (all configurations of the app target)"}.
              </small>
            </label>

            <fieldset className="field choice-group">
              <span>How Orbit gets certificates and profiles</span>
              <label className="choice">
                <input type="radio" checked={!useApiKey} onChange={() => setUseApiKey(false)} />
                <div>
                  <div>Apple account signed into Xcode</div>
                  <small className="muted">Works with free Apple IDs. Sign in once in Xcode → Settings → Accounts.</small>
                </div>
              </label>
              <label className="choice">
                <input type="radio" checked={useApiKey} onChange={() => setUseApiKey(true)} />
                <div>
                  <div>App Store Connect API key</div>
                  <small className="muted">
                    No Xcode needed. Requires a paid developer account.{" "}
                    <button className="link" onClick={() => openUrl(API_KEYS_URL)}>
                      Create a key
                    </button>{" "}
                    with the Developer role.
                  </small>
                </div>
              </label>
              {useApiKey && (
                <div className="api-key">
                  <div className="row gap">
                    <input className="text-input" value={keyPath} readOnly placeholder="AuthKey_XXXXXXXXXX.p8" />
                    <button className="btn" onClick={chooseKey}>
                      Choose…
                    </button>
                  </div>
                  <div className="row gap">
                    <input className="text-input" placeholder="Key ID" value={keyId} onChange={(e) => setKeyId(e.target.value)} />
                    <input
                      className="text-input"
                      placeholder="Issuer ID"
                      value={issuerId}
                      onChange={(e) => setIssuerId(e.target.value)}
                    />
                  </div>
                </div>
              )}
            </fieldset>
          </>
        )}

        {error && <div className="check-error">{error}</div>}

        <footer className="setup-footer">
          <span className="muted setup-hint">
            {projectChanged ? "Bundle ID and team will be written to project.yml." : "Saved on this Mac only."}
          </span>
          <button className="btn" onClick={() => setShowSigning(false)} disabled={busy}>
            Cancel
          </button>
          <button className="btn primary" onClick={save} disabled={busy || !info || !teamValid || !keyValid}>
            {busy ? <span className="spinner" /> : "Save"}
          </button>
        </footer>
      </div>
    </div>
  );
}
