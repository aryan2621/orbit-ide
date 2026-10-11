import { useEffect, useMemo } from "react";
import { useUi } from "../state/ui";
import { getCommands } from "../palette/commands";

/** Monaco's own bindings worth knowing (they aren't palette commands). */
const EDITOR: [string, string][] = [
  ["Find / Replace", "⌘F / ⌥⌘F"],
  ["Go to Definition", "F12 or ⌘-click"],
  ["Peek References", "⇧F12"],
  ["Rename Symbol", "F2"],
  ["Quick Fix", "⌥↩"],
  ["Trigger Suggestions", "⌃Space"],
  ["Parameter Hints", "⇧⌘Space"],
  ["Toggle Line Comment", "⌘/"],
  ["Move Line Up / Down", "⌥↑ / ⌥↓"],
  ["Copy Line Up / Down", "⇧⌥↑ / ⇧⌥↓"],
  ["Add Cursor Above / Below", "⌥⌘↑ / ⌥⌘↓"],
  ["Select Next Occurrence", "⌘D"],
  ["Select All Occurrences", "⇧⌘L"],
  ["Fold / Unfold", "⌥⌘[ / ⌥⌘]"],
  ["Go to Line", "⌃G"],
];

const APP: [string, string][] = [
  ["Command Palette", "⇧⌘P"],
  ["Quick Open File", "⌘P"],
  ["Go to Symbol in File", "⇧⌘O"],
  ["Workspace Symbols", "⌘T"],
  ["Explorer / Search / Source Control", "⇧⌘E / ⇧⌘F / ⌃⇧G"],
  ["Run and Debug", "⇧⌘D"],
  ["Toggle Panel", "⌘J"],
  ["Settings", "⌘,"],
  ["Save / Save All", "⌘S / ⌥⌘S"],
  ["Reopen Closed Tab", "⇧⌘T"],
  ["Next / Previous Tab", "⌃Tab / ⇧⌘] ⇧⌘["],
  ["Split Editor / Switch Group", "⌘\\"],
  ["AI Chat", "⌘I"],
  ["Edit Selection with AI", "⌘K"],
  ["Continue / Step Over / Into / Out", "F5 / F6 / F7 / F8"],
];

/** Shortcut rows grouped by section, filtered by `query` (name or keys). */
export function ShortcutList({ query }: { query: string }) {
  const sections = useMemo(() => {
    const seen = new Set(APP.map(([t]) => t));
    const commands = getCommands()
      .filter((c) => c.shortcut && !seen.has(c.title))
      .map((c) => [c.title, c.shortcut!] as [string, string]);
    const q = query.trim().toLowerCase();
    const match = (rows: [string, string][]) => rows.filter(([t, k]) => !q || t.toLowerCase().includes(q) || k.toLowerCase().includes(q));
    return [
      ["General", match(APP)],
      ["Commands", match(commands)],
      ["Editor", match(EDITOR)],
    ] as const;
  }, [query]);
  const empty = sections.every(([, rows]) => rows.length === 0);
  return (
    <>
      {sections.map(
        ([title, rows]) =>
          rows.length > 0 && (
            <section className="settings-section" key={title}>
              <h3>{title}</h3>
              <div className="settings-card">
                {rows.map(([t, k]) => (
                  <div className="setting-row" key={t}>
                    <div>{t}</div>
                    <kbd className="shortcut-keys">{k}</kbd>
                  </div>
                ))}
              </div>
            </section>
          ),
      )}
      {empty && <p className="muted">No shortcuts match “{query}”.</p>}
    </>
  );
}

/** "Help: Keyboard Shortcuts": opens Settings on the Keyboard page. */
export default function Shortcuts({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    onClose();
    useUi.getState().setSettingsPage("keyboard");
    useUi.getState().setShowSettings(true);
  }, [onClose]);
  return null;
}
