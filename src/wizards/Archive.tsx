import { useState } from "react";
import { ArchiveMethod } from "../lib/ipc";
import { useProject } from "../state/project";
import { useUi } from "../state/ui";
import { useWorkspace } from "../state/workspace";
import { loadSigning } from "../state/signing";
import { IconClose } from "../components/Icons";

const METHODS: { id: ArchiveMethod; title: string; detail: string }[] = [
  { id: "app-store-connect", title: "App Store Connect", detail: "For TestFlight and the App Store." },
  { id: "release-testing", title: "Release testing (Ad Hoc)", detail: "Install on devices registered to your team." },
  { id: "debugging", title: "Development", detail: "Development-signed build for your own devices." },
];

export default function Archive() {
  const setShowArchive = useUi((s) => s.setShowArchive);
  const setShowSigning = useUi((s) => s.setShowSigning);
  const root = useWorkspace((s) => s.root)!;
  const { scheme, startArchive } = useProject();
  const [method, setMethod] = useState<ArchiveMethod>("app-store-connect");
  const [upload, setUpload] = useState(true);
  const signing = loadSigning(root);
  const canUpload = method === "app-store-connect";

  const go = () => {
    startArchive({ method, upload: canUpload && upload });
    setShowArchive(false);
  };

  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-labelledby="archive-title">
      <div className="setup">
        <header className="setup-header">
          <div>
            <h1 id="archive-title">Archive & distribute</h1>
            <p className="muted">
              Builds <strong>{scheme}</strong> in Release for iOS devices, signs it, and exports an .ipa or uploads it.
            </p>
          </div>
          <button className="icon-btn" title="Close" onClick={() => setShowArchive(false)}>
            <IconClose />
          </button>
        </header>

        <fieldset className="field choice-group">
          <span>Distribution</span>
          {METHODS.map((m) => (
            <label key={m.id} className="choice">
              <input type="radio" checked={method === m.id} onChange={() => setMethod(m.id)} />
              <div>
                <div>{m.title}</div>
                <small className="muted">{m.detail}</small>
              </div>
            </label>
          ))}
        </fieldset>

        {canUpload && (
          <label className="choice">
            <input type="checkbox" checked={upload} onChange={(e) => setUpload(e.target.checked)} />
            <div>
              <div>Upload to App Store Connect</div>
              <small className="muted">The build shows up in TestFlight once Apple finishes processing it.</small>
            </div>
          </label>
        )}

        {!signing.teamId && (
          <div className="notice warning">
            No team selected, so the project's own signing settings are used.{" "}
            <button
              className="link"
              onClick={() => {
                setShowArchive(false);
                setShowSigning(true);
              }}
            >
              Open Signing
            </button>
          </div>
        )}
        {canUpload && upload && !signing.apiKey && (
          <div className="notice warning">
            Uploading needs an App Store Connect API key in Signing, or an Apple account signed into Xcode.
          </div>
        )}

        <footer className="setup-footer">
          <span className="muted setup-hint">Output goes to build/ inside the project.</span>
          <button className="btn" onClick={() => setShowArchive(false)}>
            Cancel
          </button>
          <button className="btn primary" onClick={go} disabled={!scheme}>
            {canUpload && upload ? "Archive & upload" : "Archive & export"}
          </button>
        </footer>
      </div>
    </div>
  );
}
