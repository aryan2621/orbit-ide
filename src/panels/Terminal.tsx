import { useEffect, useRef } from "react";
import { ITheme, Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { listen } from "@tauri-apps/api/event";
import { terminalApi } from "../lib/ipc";
import { useUi } from "../state/ui";

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

export default function Terminal({ cwd, theme }: { cwd: string | null; theme: "light" | "dark" }) {
  const ref = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);

  useEffect(() => {
    const term = new XTerm({
      fontFamily: "ui-monospace, 'SF Mono', SFMono-Regular, Menlo, monospace",
      fontSize: 12,
      cursorBlink: true,
      theme: THEMES[theme],
    });
    termRef.current = term;
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
      useUi.getState().setTerminalId(newId);
      unlisteners.push(await listen<string>(`terminal://${id}/data`, (e) => term.write(e.payload)));
      unlisteners.push(
        await listen(`terminal://${id}/exit`, () => term.write("\r\n[process exited]\r\n")),
      );
    }, (e) => term.write(`Failed to start shell: ${e}\r\n`));

    const onData = term.onData((data) => id !== null && terminalApi.write(id, data));
    const onResize = term.onResize(({ cols, rows }) => id !== null && terminalApi.resize(id, cols, rows));
    const observer = new ResizeObserver(() => fit.fit());
    observer.observe(ref.current!);

    return () => {
      disposed = true;
      observer.disconnect();
      onData.dispose();
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

  return <div className="terminal" ref={ref} />;
}
