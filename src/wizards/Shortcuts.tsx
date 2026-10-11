import { useMemo, useState } from "react";
import { getCommands } from "../palette/commands";
import { IconClose } from "../components/Icons";

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

/** "Help: Keyboard Shortcuts": every bound command, searchable. */
export default function Shortcuts({ onClose }: { onClose: () => void }) {
  const [query, setQuery] = useState("");
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

  return (
    <div className="overlay" role="dialog" aria-modal="true" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="setup settings">
        <header className="setup-header">
          <div>
            <h1>Keyboard Shortcuts</h1>
            <p className="muted">Everything else is in the Command Palette (⇧⌘P).</p>
          </div>
          <button className="icon-btn" title="Close" onClick={onClose}>
            <IconClose />
          </button>
        </header>
        <input className="text-input" autoFocus placeholder="Search shortcuts" value={query} onChange={(e) => setQuery(e.target.value)} />
        {sections.map(
          ([title, rows]) =>
            rows.length > 0 && (
              <section className="settings-section" key={title}>
                <h2>{title}</h2>
                {rows.map(([t, k]) => (
                  <div className="setting-row" key={t}>
                    <div>{t}</div>
                    <kbd className="shortcut-keys">{k}</kbd>
                  </div>
                ))}
              </section>
            ),
        )}
        <footer className="setup-footer">
          <span className="grow" />
          <button className="btn primary" onClick={onClose}>
            Done
          </button>
        </footer>
      </div>
    </div>
  );
}
