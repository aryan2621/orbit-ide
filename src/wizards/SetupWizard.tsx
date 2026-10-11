import { useEffect, useState } from "react";
import { Check } from "../lib/ipc";
import { isReady, useSetup } from "../state/setup";
import { useUi } from "../state/ui";
import { IconCheck, IconClose, IconCopy } from "../components/Icons";

/** How often to re-check while the window is open, so steps tick off as commands finish. */
const POLL_MS = 5000;

async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Fallback for webviews without async clipboard access.
    const el = document.createElement("textarea");
    el.value = text;
    document.body.appendChild(el);
    el.select();
    document.execCommand("copy");
    el.remove();
  }
}

function CommandBlock({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await copyText(command);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div className="command">
      <span className="command-prompt">$</span>
      <code>{command}</code>
      <button className={`command-copy${copied ? " copied" : ""}`} onClick={copy}>
        {copied ? <IconCheck /> : <IconCopy />}
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

function StepMarker({ check, index, current }: { check: Check; index: number; current: boolean }) {
  if (check.status === "ok") {
    return (
      <span className="step-marker done">
        <IconCheck />
      </span>
    );
  }
  return <span className={`step-marker${current ? " current" : ""}`}>{index + 1}</span>;
}

function CheckRow({
  check,
  index,
  current,
  selected,
  onSelect,
}: {
  check: Check;
  index: number;
  current: boolean;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <li
      className={`setup-step status-${check.status}${current ? " current" : ""}${selected ? " selected" : ""}${check.optional ? " optional" : ""}`}
    >
      <button className="setup-step-head" onClick={onSelect} aria-current={selected}>
        <StepMarker check={check} index={index} current={current} />
        <span className="setup-step-text">
          <span className="setup-step-label">{check.label}</span>
          <span className="setup-step-detail">{check.detail}</span>
        </span>
        {current && <span className="setup-step-tag">Next</span>}
        {check.optional && check.status !== "ok" && <span className="setup-step-tag optional">Optional</span>}
      </button>
    </li>
  );
}

/** The selected step in full: what it is, and the commands that fix it. */
function CheckDetail({ check }: { check: Check }) {
  return (
    <div className="setup-detail">
      <div className="setup-detail-head">
        <h2>{check.label}</h2>
        {check.optional && <span className="setup-step-tag optional">Optional</span>}
      </div>
      <p className="muted">{check.detail}</p>
      {check.status === "ok" ? (
        <p className="setup-detail-done">
          <IconCheck /> Installed. Nothing to do here.
        </p>
      ) : check.status === "blocked" ? (
        <p className="muted">This step unlocks once the steps before it are done.</p>
      ) : (
        <ol className="setup-instructions">
          {check.steps.map((s, i) => (
            <li key={i}>
              <p>{s.text}</p>
              {s.command && <CommandBlock command={s.command} />}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

const COPY = {
  ios: {
    title: "Set up iOS development",
    intro:
      "Orbit drives Apple's build tools for you, so you never have to open Xcode. Copy each command into Terminal; steps tick off automatically when they're done.",
    done: "Everything Orbit needs to build and run iOS apps is installed.",
    hint: "Commands with sudo ask for your Mac password.",
  },
  android: {
    title: "Set up Android development",
    intro:
      "Orbit drives the Android SDK and Gradle for you, so you never have to open Android Studio. Copy each command into Terminal; steps tick off automatically when they're done.",
    done: "Everything Orbit needs to build and run Android apps is installed.",
    hint: "Downloads can take a few minutes.",
  },
} as const;

export default function SetupWizard() {
  const { checks, checking, refresh, platform, setPlatform } = useSetup();
  const copy = COPY[platform];
  const setShowSetup = useUi((s) => s.setShowSetup);
  const setShowNewProject = useUi((s) => s.setShowNewProject);
  const ready = isReady(checks);
  // The next step to highlight is the first required one that's missing.
  const next = checks?.find((c) => c.status === "missing" && !c.optional)?.id ?? null;
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Follow the user's progress: whenever the next step changes, show it.
  useEffect(() => setSelectedId(next), [next]);
  const selected =
    checks?.find((c) => c.id === selectedId) ??
    checks?.find((c) => c.status === "missing") ??
    checks?.[0] ??
    null;

  // Re-check on open, periodically, and when the user comes back from Terminal.
  useEffect(() => {
    refresh();
    if (ready) return;
    const tick = () => !useSetup.getState().checking && refresh();
    const timer = setInterval(tick, POLL_MS);
    window.addEventListener("focus", tick);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", tick);
    };
  }, [refresh, ready, platform]);

  const required = checks?.filter((c) => !c.optional) ?? [];
  const done = required.filter((c) => c.status === "ok").length;
  const total = checks ? required.length : 7;
  const optionalCount = (checks?.length ?? 0) - required.length;

  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-labelledby="setup-title">
      <div className="setup setup-wide">
        <header className="setup-header">
          <div>
            <h1 id="setup-title">{ready ? "You're all set" : copy.title}</h1>
            <p className="muted">{ready ? copy.done : copy.intro}</p>
          </div>
          <div className="segmented" role="tablist" aria-label="Platform">
            {(["ios", "android"] as const).map((p) => (
              <button key={p} role="tab" aria-selected={platform === p} className={platform === p ? "on" : ""} onClick={() => setPlatform(p)}>
                {p === "ios" ? "iOS" : "Android"}
              </button>
            ))}
          </div>
          <button className="icon-btn" title="Close" onClick={() => setShowSetup(false)}>
            <IconClose />
          </button>
        </header>

        <div className="setup-progress">
          <ol className="stepper" aria-hidden="true">
            {(checks ? required : Array.from({ length: total }, () => null)).map((c, i) => (
              <li key={i} className={c?.status === "ok" ? "done" : c?.id === next ? "current" : ""} />
            ))}
          </ol>
          <span className="setup-progress-text">
            {checks === null
              ? "Checking your Mac…"
              : `${done} of ${total} complete${optionalCount ? ` · ${optionalCount} optional` : ""}`}
            {checking && checks !== null && <span className="spinner" />}
          </span>
        </div>

        <div className="setup-body">
          <ol className="setup-steps">
            {checks === null
              ? Array.from({ length: total }, (_, i) => <li key={i} className="setup-step skeleton" />)
              : checks.map((c, i) => (
                  <CheckRow
                    key={c.id}
                    check={c}
                    index={i}
                    current={c.id === next}
                    selected={selected?.id === c.id}
                    onSelect={() => setSelectedId(c.id)}
                  />
                ))}
          </ol>
          {selected ? <CheckDetail check={selected} /> : <div className="setup-detail skeleton" />}
        </div>

        <footer className="setup-footer">
          {ready ? (
            <>
              <button className="btn" onClick={() => setShowSetup(false)}>
                Close
              </button>
              <button
                className="btn primary"
                onClick={() => {
                  setShowSetup(false);
                  setShowNewProject(platform);
                }}
              >
                {platform === "android" ? "Create an Android app" : "Create an iOS app"}
              </button>
            </>
          ) : (
            <>
              <span className="muted setup-hint">{copy.hint}</span>
              <button className="btn" disabled={checking} onClick={() => refresh()}>
                Re-check now
              </button>
              <button className="btn primary" onClick={() => setShowSetup(false)}>
                Finish later
              </button>
            </>
          )}
        </footer>
      </div>
    </div>
  );
}
