import { useState } from "react";
import { IconClose } from "../components/Icons";
import { useAi } from "../state/ai";

const DONE_KEY = "orbit.tourDone";

export function tourDone() {
  try {
    return localStorage.getItem(DONE_KEY) === "1";
  } catch {
    return true;
  }
}

const ALL_STEPS: { title: string; body: string; keys?: string; ai?: boolean }[] = [
  {
    title: "Run your app",
    body: "Pick the app (scheme or module), build configuration and device in the toolbar, then Run. Build progress shows in the status pill; the Build panel has the full log.",
    keys: "⌘R run · ⌘B build · ⌘Y debug · ⌘. stop",
  },
  {
    title: "Devices",
    body: "Start or create Simulators and emulators from the phone icon in the toolbar. Android phones can be paired over Wi-Fi from there too.",
  },
  {
    title: "Find anything",
    body: "The palette opens files, runs commands, and jumps to symbols or lines. Type > for commands, @ for symbols in the file, # for symbols in the project, : for a line.",
    keys: "⌘P files · ⇧⌘P commands · ⇧⌘O symbols · ⌘T workspace · ⌃G line",
  },
  {
    title: "Problems",
    body: "Errors from the last build and from the language server, grouped by file. Click one to jump to it. ⌃- goes back to where you were.",
  },
  {
    title: "On-device AI",
    body: "Chat about your code, Fix with AI on errors and crashes, or rewrite a selection. Models run on this Mac and nothing leaves it; the assistant asks before every file change, build or run.",
    keys: "⌘I chat · ⌘K edit selection",
    ai: true,
  },
  {
    title: "Ship it",
    body: "Signing, version & build number, app icons and Archive are in the toolbar and the palette. Archive checks a short release list first and can upload to TestFlight or Google Play.",
  },
];

/** A short first-run walkthrough, shown once after the first folder opens. */
export default function Tour({ onClose }: { onClose: () => void }) {
  const [step, setStep] = useState(0);
  const aiSupported = useAi((a) => !!a.hardware?.supported);
  const STEPS = ALL_STEPS.filter((t) => !t.ai || aiSupported);
  const finish = () => {
    try {
      localStorage.setItem(DONE_KEY, "1");
    } catch {}
    onClose();
  };
  const s = STEPS[step];
  const last = step === STEPS.length - 1;

  return (
    <div className="tour" role="dialog" aria-label="Orbit tour">
      <header>
        <small className="muted">
          Tour · {step + 1} of {STEPS.length}
        </small>
        <button className="icon-btn" title="Skip tour" onClick={finish}>
          <IconClose />
        </button>
      </header>
      <h2>{s.title}</h2>
      <p>{s.body}</p>
      {s.keys && <p className="tour-keys">{s.keys}</p>}
      <footer>
        {step > 0 && (
          <button className="btn" onClick={() => setStep(step - 1)}>
            Back
          </button>
        )}
        <span className="grow" />
        <button className="btn primary" onClick={() => (last ? finish() : setStep(step + 1))}>
          {last ? "Done" : "Next"}
        </button>
      </footer>
    </div>
  );
}
