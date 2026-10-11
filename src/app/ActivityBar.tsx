import type { ReactElement } from "react";
import { Activity, useUi } from "../state/ui";
import { useGit } from "../state/git";
import { useDebug } from "../state/debug";
import { useProject } from "../state/project";
import { useWorkspace } from "../state/workspace";
import { IconBug, IconFiles, IconFlask, IconGitBranch, IconOutput, IconPackage, IconProblems, IconSearch, IconSettings } from "../components/Icons";
import { useMarkers } from "../state/markers";

const ITEMS: { id: Activity; title: string; icon: () => ReactElement }[] = [
  { id: "explorer", title: "Explorer (⇧⌘E)", icon: IconFiles },
  { id: "search", title: "Search (⇧⌘F)", icon: IconSearch },
  { id: "git", title: "Source Control (⌃⇧G)", icon: IconGitBranch },
  { id: "packages", title: "Packages", icon: IconPackage },
  { id: "problems", title: "Problems", icon: IconProblems },
  { id: "debug", title: "Run and Debug (⇧⌘D)", icon: IconBug },
  { id: "tests", title: "Tests (⌘U runs them)", icon: IconFlask },
  { id: "output", title: "Output (language server logs)", icon: IconOutput },
];

const PROJECT_ONLY: Activity[] = ["problems", "debug", "tests", "output"];

export default function ActivityBar() {
  const { activity, showSidebar, setActivity, setShowSettings } = useUi();
  const changes = useGit((s) => s.status?.changes.length ?? 0);
  const debugging = useDebug((s) => s.status === "paused" || s.status === "running");
  const failedTests = useProject((s) => (s.build.action === "test" ? (s.build.tests ?? []).filter((t) => t.status === "failed").length : 0));
  const hasRoot = useWorkspace((s) => !!s.root);
  const problems = useProject((s) => s.build.diagnostics.length) + useMarkers((s) => s.problems.length);

  return (
    <nav className="activity-bar" aria-label="Views">
      {ITEMS.filter((i) => hasRoot || !PROJECT_ONLY.includes(i.id)).map(({ id, title, icon: Icon }) => (
        <button
          key={id}
          className={`activity-btn${showSidebar && activity === id ? " active" : ""}`}
          title={title}
          onClick={() => setActivity(id)}
        >
          <Icon />
          {id === "git" && changes > 0 && <span className="activity-badge">{changes > 99 ? "99+" : changes}</span>}
          {id === "problems" && problems > 0 && <span className="activity-badge">{problems > 99 ? "99+" : problems}</span>}
          {id === "tests" && failedTests > 0 && <span className="activity-badge">{failedTests > 99 ? "99+" : failedTests}</span>}
          {id === "debug" && debugging && <span className="activity-dot" />}
        </button>
      ))}
      <span className="grow" />
      <button className="activity-btn" title="Settings (⌘,)" onClick={() => setShowSettings(true)}>
        <IconSettings />
      </button>
    </nav>
  );
}
