import { useEffect, useState } from "react";
import { Check } from "../lib/ipc";
import { isReady, useSetup } from "../state/setup";
import { useUi } from "../state/ui";
import { IconCheck, IconChevronDown, IconChevronRight, IconClose, IconCopy } from "../components/Icons";

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
  open,
  onToggle,
}: {
  check: Check;
  index: number;
  current: boolean;
  open: boolean;
  onToggle: () => void;
}) {
  const expandable = check.status !== "ok" && check.steps.length > 0;
  return (
    <li className={`setup-step status-${check.status}${current ? " current" : ""}${open ? " open" : ""}`}>
      <button className="setup-step-head" onClick={onToggle} disabled={!expandable}>
        <StepMarker check={check} index={index} current={current} />
        <span className="setup-step-text">
          <span className="setup-step-label">{check.label}</span>
          <span className="setup-step-detail">{check.detail}</span>
        </span>
        {current && <span className="setup-step-tag">Next</span>}
        {expandable && (
          <span className="setup-step-chevron">{open ? <IconChevronDown /> : <IconChevronRight />}</span>
        )}
      </button>
      {open && expandable && (
        <ol className="setup-instructions">
          {check.steps.map((s, i) => (
            <li key={i}>
              <p>{s.text}</p>
              {s.command && <CommandBlock command={s.command} />}
            </li>
          ))}
        </ol>
      )}
    </li>
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
  const next = checks?.find((c) => c.status === "missing")?.id ?? null;
  const [openId, setOpenId] = useState<string | null>(null);

  // Follow the user's progress: whenever the next step changes, expand it.
  useEffect(() => setOpenId(next), [next]);

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

  const done = checks?.filter((c) => c.status === "ok").length ?? 0;
  const total = checks?.length ?? 7;

  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-labelledby="setup-title">
      <div className="setup">
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
            {(checks ?? Array.from({ length: total }, () => null)).map((c, i) => (
              <li key={i} className={c?.status === "ok" ? "done" : c?.id === next ? "current" : ""} />
            ))}
          </ol>
          <span className="setup-progress-text">
            {checks === null ? "Checking your Mac…" : `${done} of ${total} complete`}
            {checking && checks !== null && <span className="spinner" />}
          </span>
        </div>

        <ol className="setup-steps">
          {checks === null
            ? Array.from({ length: total }, (_, i) => <li key={i} className="setup-step skeleton" />)
            : checks.map((c, i) => (
                <CheckRow
                  key={c.id}
                  check={c}
                  index={i}
                  current={c.id === next}
                  open={openId === c.id}
                  onToggle={() => setOpenId(openId === c.id ? null : c.id)}
                />
              ))}
        </ol>

        <footer className="setup-footer">
          {ready && platform === "android" ? (
            <button className="btn primary" onClick={() => setShowSetup(false)}>
              Close
            </button>
          ) : ready ? (
            <>
              <button className="btn" onClick={() => setShowSetup(false)}>
                Close
              </button>
              <button
                className="btn primary"
                onClick={() => {
                  setShowSetup(false);
                  setShowNewProject(true);
                }}
              >
                Create an iOS app
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
