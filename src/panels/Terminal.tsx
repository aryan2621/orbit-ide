import { useEffect, useRef, useState } from "react";
import { ITheme, Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { terminalApi } from "../lib/ipc";
import { useUi } from "../state/ui";
import { IconClose, IconPlus } from "../components/Icons";

const THEMES: Record<"light" | "dark", ITheme> = {
  light: {
    background: "#ffffff", // --bg-elev (light)
    foreground: "#141413",
    cursor: "#c6613f",
    selectionBackground: "#f0d6ca",
  },
  dark: {
    background: "#30302e", // --bg-elev (dark)
    foreground: "#f5f4ee",
    cursor: "#d97757",
    selectionBackground: "#5a3d32",
  },
};

/** One shell session. Hidden sessions stay mounted so their shells keep running. */
function Session({ cwd, theme, active, onTitle }: { cwd: string | null; theme: "light" | "dark"; active: boolean; onTitle: (title: string) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const idRef = useRef<number | null>(null);
  const activeRef = useRef(active);
  activeRef.current = active;

  useEffect(() => {
    const term = new XTerm({
      fontFamily: "ui-monospace, 'SF Mono', SFMono-Regular, Menlo, monospace",
      fontSize: 12,
      cursorBlink: true,
      theme: THEMES[theme],
    });
    termRef.current = term;
    const onTitleChange = term.onTitleChange((t) => t.trim() && onTitle(t.trim()));
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(ref.current!);
    fit.fit();

    let id: number | null = null;
    let disposed = false;
    const unlisteners: (() => void)[] = [];

    terminalApi.spawn(cwd, term.cols, term.rows).then(async (newId) => {
      if (disposed) {
        terminalApi.kill(newId);
        return;
      }
      id = newId;
      idRef.current = newId;
      if (activeRef.current) useUi.getState().setTerminalId(newId);
      unlisteners.push(await listen<string>(`terminal://${id}/data`, (e) => term.write(e.payload)));
      unlisteners.push(
        await listen(`terminal://${id}/exit`, () => term.write("\r\n[process exited]\r\n")),
      );
      // The shell's output is held back until we listen, so the first prompt isn't lost.
      if (!disposed) await invoke("terminal_attach", { id: newId });
    }, (e) => term.write(`Failed to start shell: ${e}\r\n`));

    const onData = term.onData((data) => id !== null && terminalApi.write(id, data));
    const onResize = term.onResize(({ cols, rows }) => id !== null && terminalApi.resize(id, cols, rows));
    const observer = new ResizeObserver(() => fit.fit());
    observer.observe(ref.current!);

    return () => {
      disposed = true;
      observer.disconnect();
      onData.dispose();
      onTitleChange.dispose();
      onResize.dispose();
      unlisteners.forEach((u) => u());
      if (id !== null) {
        terminalApi.kill(id);
        if (useUi.getState().terminalId === id) useUi.getState().setTerminalId(null);
      }
      term.dispose();
      termRef.current = null;
    };
    // Theme changes are applied below without restarting the shell.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cwd]);

  useEffect(() => {
    if (termRef.current) termRef.current.options.theme = THEMES[theme];
  }, [theme]);

  useEffect(() => {
    if (!active) return;
    if (idRef.current !== null) useUi.getState().setTerminalId(idRef.current);
    termRef.current?.focus();
  }, [active]);

  return <div className="terminal" ref={ref} style={active ? undefined : { display: "none" }} />;
}

let nextKey = 1;

/** Terminal tabs: several shells in the project folder. */
export default function Terminal({ cwd, theme }: { cwd: string | null; theme: "light" | "dark" }) {
  const [sessions, setSessions] = useState(() => [{ key: nextKey++, title: "" }]);
  const [active, setActive] = useState(sessions[0].key);

  // A new folder starts over with one fresh shell there.
  const lastCwd = useRef(cwd);
  useEffect(() => {
    if (lastCwd.current === cwd) return;
    lastCwd.current = cwd;
    const key = nextKey++;
    setSessions([{ key, title: "" }]);
    setActive(key);
  }, [cwd]);

  const add = () => {
    const key = nextKey++;
    setSessions((s) => [...s, { key, title: "" }]);
    setActive(key);
  };
  const close = (key: number) => {
    const idx = sessions.findIndex((s) => s.key === key);
    const rest = sessions.filter((s) => s.key !== key);
    if (rest.length === 0) {
      const fresh = nextKey++;
      setSessions([{ key: fresh, title: "" }]);
      setActive(fresh);
      return;
    }
    setSessions(rest);
    if (active === key) setActive(rest[Math.min(idx, rest.length - 1)].key);
  };

  return (
    <div className="terminal-tabs">
      {sessions.length > 1 || sessions[0].title ? (
        <div className="terminal-tabbar">
          {sessions.map((s, i) => (
            <div key={s.key} className={`terminal-tab${s.key === active ? " active" : ""}`} onClick={() => setActive(s.key)} title={s.title || undefined}>
              <span>{s.title || `Shell ${i + 1}`}</span>
              <button
                className="tab-close"
                title="Kill terminal"
                onClick={(e) => {
                  e.stopPropagation();
                  close(s.key);
                }}
              >
                <IconClose />
              </button>
            </div>
          ))}
          <button className="icon-btn" title="New terminal" onClick={add}>
            <IconPlus />
          </button>
        </div>
      ) : (
        <button className="icon-btn terminal-new" title="New terminal" onClick={add}>
          <IconPlus />
        </button>
      )}
      {sessions.map((s) => (
        <Session
          key={s.key}
          cwd={cwd}
          theme={theme}
          active={s.key === active}
          onTitle={(title) => setSessions((all) => all.map((x) => (x.key === s.key ? { ...x, title } : x)))}
        />
      ))}
    </div>
  );
}
