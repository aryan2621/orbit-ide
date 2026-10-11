import { useEffect, useState } from "react";
import { AppVersion, versionApi } from "../lib/ipc";
import { useGit } from "../state/git";
import { useProject } from "../state/project";
import { useMarkers } from "../state/markers";
import { useUi } from "../state/ui";

const ARCHIVED_KEY = "orbit.lastArchivedBuild";

/** Build numbers already archived per project, so the checklist can catch a repeat (stores reject it). */
function lastArchived(root: string): string | null {
  try {
    return localStorage.getItem(`${ARCHIVED_KEY}:${root}`);
  } catch {
    return null;
  }
}

let current: { root: string; build: string | null } | null = null;

/** Call when the archive starts, to remember its build number. */
export function rememberArchivedBuild(root: string) {
  if (current?.root !== root || !current.build) return;
  try {
    localStorage.setItem(`${ARCHIVED_KEY}:${root}`, current.build);
  } catch {}
}

type Item = { ok: boolean; text: string; action?: { label: string; run: () => void } };

/** Things worth checking before a release build. Advisory: nothing here blocks archiving. */
export default function ReleaseChecklist({ root, onLeave }: { root: string; onLeave: () => void }) {
  const [version, setVersion] = useState<AppVersion | null>(null);
  const changes = useGit((s) => s.status?.changes.length ?? 0);
  const buildErrors = useProject((s) => s.build.diagnostics.filter((d) => d.severity === "error").length);
  const lspErrors = useMarkers((s) => s.problems.filter((p) => p.severity === "error").length);

  useEffect(() => {
    versionApi.get(root).then((v) => {
      setVersion(v);
      current = { root, build: v.build };
    });
  }, [root]);

  const open = (fn: () => void) => () => {
    onLeave();
    fn();
  };
  const ui = useUi.getState();
  const editVersion = { label: "Edit", run: open(() => ui.setShowVersion(true)) };
  const archived = lastArchived(root);
  const items: Item[] = [];
  if (version) {
    if (version.error || !version.build) {
      items.push({ ok: false, text: version.error ?? "Couldn't read the version and build number", action: editVersion });
    } else if (archived === version.build) {
      items.push({ ok: false, text: `Build ${version.build} was already archived. Stores need a higher build number.`, action: editVersion });
    } else {
      items.push({ ok: true, text: `Version ${version.version ?? "?"} (build ${version.build})`, action: editVersion });
    }
  }
  items.push(
    changes > 0
      ? { ok: false, text: `${changes} uncommitted change${changes === 1 ? "" : "s"}`, action: { label: "Review", run: open(() => ui.setActivity("git")) } }
      : { ok: true, text: "Working tree is clean" },
  );
  const errors = buildErrors + lspErrors;
  items.push(
    errors > 0
      ? { ok: false, text: `${errors} error${errors === 1 ? "" : "s"} in Problems`, action: { label: "Show", run: open(() => ui.showActivity("problems")) } }
      : { ok: true, text: "No known errors" },
  );

  return (
    <div className="field">
      <span>Before you release</span>
      <ul className="checklist">
        {items.map((i) => (
          <li key={i.text} className={i.ok ? "ok" : "warn"}>
            <span className="check-mark">{i.ok ? "✓" : "!"}</span>
            <span className="grow">{i.text}</span>
            {i.action && (
              <button className="link" onClick={i.action.run}>
                {i.action.label}
              </button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
