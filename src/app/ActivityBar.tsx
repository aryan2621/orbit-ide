import type { ReactElement } from "react";
import { Activity, useUi } from "../state/ui";
import { useGit } from "../state/git";
import { IconFiles, IconGitBranch, IconPackage, IconSearch, IconSettings } from "../components/Icons";

const ITEMS: { id: Activity; title: string; icon: () => ReactElement }[] = [
  { id: "explorer", title: "Explorer (⇧⌘E)", icon: IconFiles },
  { id: "search", title: "Search (⇧⌘F)", icon: IconSearch },
  { id: "git", title: "Source Control (⌃⇧G)", icon: IconGitBranch },
  { id: "packages", title: "Packages", icon: IconPackage },
];

export default function ActivityBar() {
  const { activity, showSidebar, setActivity, setShowSettings } = useUi();
  const changes = useGit((s) => s.status?.changes.length ?? 0);

  return (
    <nav className="activity-bar" aria-label="Views">
      {ITEMS.map(({ id, title, icon: Icon }) => (
        <button
          key={id}
          className={`activity-btn${showSidebar && activity === id ? " active" : ""}`}
          title={title}
          onClick={() => setActivity(id)}
        >
          <Icon />
          {id === "git" && changes > 0 && <span className="activity-badge">{changes > 99 ? "99+" : changes}</span>}
        </button>
      ))}
      <span className="grow" />
      <button className="activity-btn" title="Settings (⌘,)" onClick={() => setShowSettings(true)}>
        <IconSettings />
      </button>
    </nav>
  );
}
