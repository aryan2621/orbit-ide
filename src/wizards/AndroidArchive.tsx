import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { useProject } from "../state/project";
import { useWorkspace } from "../state/workspace";
import { IconClose } from "../components/Icons";
import ReleaseChecklist, { rememberArchivedBuild } from "./ReleaseChecklist";

export type AndroidFormat = "aab" | "apk";

export interface PlayUpload {
  track: string;
  serviceAccountJson: string;
  draft: boolean;
}

export interface AndroidArchiveOptions {
  /** Release variant, e.g. "release" or "freeRelease". */
  variant: string;
  format: AndroidFormat;
  upload: PlayUpload | null;
}

const TRACKS = [
  { id: "internal", title: "Internal testing", detail: "Up to 100 testers, available within minutes." },
  { id: "alpha", title: "Closed testing", detail: "Testers you invite by email or Google Group." },
  { id: "beta", title: "Open testing", detail: "Anyone can join from the Play Store listing." },
  { id: "production", title: "Production", detail: "Everyone on Google Play." },
];
const KEY_STORAGE = "orbit.android.playKey";

function recall(key: string) {
  try {
    return localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}

/**
 * Builds a signed release .aab (for Google Play) or .apk (for sideloading), and optionally uploads
 * the bundle to a Play track. `onArchive` starts the `android_archive` job.
 */
export default function AndroidArchive({
  onClose,
  onArchive,
  onOpenSigning,
}: {
  onClose: () => void;
  onArchive: (options: AndroidArchiveOptions) => void;
  onOpenSigning: () => void;
}) {
  const root = useWorkspace((s) => s.root)!;
  const { scheme, info } = useProject();
  const variants = (info?.configurations ?? []).filter((c) => /release$/i.test(c));
  const [variant, setVariant] = useState(variants[0] ?? "release");
  const [format, setFormat] = useState<AndroidFormat>("aab");
  const [upload, setUpload] = useState(false);
  const [track, setTrack] = useState("internal");
  const [keyPath, setKeyPath] = useState(() => recall(`${KEY_STORAGE}:${root}`));
  const [draft, setDraft] = useState(false);

  const chooseKey = async () => {
    const file = await open({ multiple: false, filters: [{ name: "Service account key", extensions: ["json"] }] });
    if (typeof file === "string") setKeyPath(file);
  };

  const canUpload = format === "aab";
  const go = () => {
    const doUpload = canUpload && upload;
    if (doUpload) {
      try {
        localStorage.setItem(`${KEY_STORAGE}:${root}`, keyPath);
      } catch {}
    }
    rememberArchivedBuild(root);
    onArchive({ variant, format, upload: doUpload ? { track, serviceAccountJson: keyPath, draft } : null });
    onClose();
  };

  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-labelledby="android-archive-title">
      <div className="setup">
        <header className="setup-header">
          <div>
            <h1 id="android-archive-title">Build for release</h1>
            <p className="muted">
              Builds <strong>{scheme}</strong> with R8 shrinking, signs it with your upload key, and optionally uploads it to
              Google Play.
            </p>
          </div>
          <button className="icon-btn" title="Close" onClick={onClose}>
            <IconClose />
          </button>
        </header>

        {variants.length > 1 && (
          <label className="field">
            <span>Variant</span>
            <select className="text-input" value={variant} onChange={(e) => setVariant(e.target.value)}>
              {variants.map((v) => (
                <option key={v}>{v}</option>
              ))}
            </select>
          </label>
        )}

        <fieldset className="field choice-group">
          <span>Format</span>
          <label className="choice">
            <input type="radio" checked={format === "aab"} onChange={() => setFormat("aab")} />
            <div>
              <div>App Bundle (.aab)</div>
              <small className="muted">What Google Play requires. Play builds optimized APKs for each device.</small>
            </div>
          </label>
          <label className="choice">
            <input type="radio" checked={format === "apk"} onChange={() => setFormat("apk")} />
            <div>
              <div>APK (.apk)</div>
              <small className="muted">A single installable file for other stores or direct sharing.</small>
            </div>
          </label>
        </fieldset>

        {canUpload && (
          <label className="choice">
            <input type="checkbox" checked={upload} onChange={(e) => setUpload(e.target.checked)} />
            <div>
              <div>Upload to Google Play</div>
              <small className="muted">Uploads directly through the Google Play Developer API with a service-account key. The app must already exist in Play Console.</small>
            </div>
          </label>
        )}

        {canUpload && upload && (
          <>
            <fieldset className="field choice-group">
              <span>Track</span>
              {TRACKS.map((t) => (
                <label key={t.id} className="choice">
                  <input type="radio" checked={track === t.id} onChange={() => setTrack(t.id)} />
                  <div>
                    <div>{t.title}</div>
                    <small className="muted">{t.detail}</small>
                  </div>
                </label>
              ))}
            </fieldset>
            <div className="field">
              <span>Service account key (JSON)</span>
              <div className="row gap">
                <input className="text-input" value={keyPath} readOnly placeholder="Choose the key file…" />
                <button className="btn" onClick={chooseKey}>
                  Choose…
                </button>
              </div>
              <small className="muted">Create one in Google Cloud and grant it access in Play Console → Users and permissions.</small>
            </div>
            <label className="choice">
              <input type="checkbox" checked={draft} onChange={(e) => setDraft(e.target.checked)} />
              <div>Upload as a draft (review and roll out in Play Console)</div>
            </label>
          </>
        )}

        <ReleaseChecklist root={root} onLeave={onClose} />

        <div className="notice">
          Signing uses the keystore from{" "}
          <button className="link" onClick={onOpenSigning}>
            Android Signing
          </button>
          , or the project's own signingConfig.
        </div>

        <footer className="setup-footer">
          <span className="muted setup-hint">Output goes to app/build/outputs inside the project.</span>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={go} disabled={!scheme || (canUpload && upload && !keyPath)}>
            {canUpload && upload ? "Build & upload" : "Build"}
          </button>
        </footer>
      </div>
    </div>
  );
}
