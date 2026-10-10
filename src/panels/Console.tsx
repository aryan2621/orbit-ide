import { useEffect, useRef } from "react";
import { useProject } from "../state/project";

/** The running app's output (print, NSLog, crashes). */
export default function Console() {
  const { action, console: lines, status, phase } = useProject((s) => s.build);
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  useEffect(() => {
    if (stick.current && ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [lines.length]);

  const onScroll = () => {
    const el = ref.current!;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  };

  if (action === "build" || (lines.length === 0 && phase !== "running")) {
    return <div className="panel-empty">Press ⌘R to run the app; its output appears here</div>;
  }

  return (
    <div className="build-log" ref={ref} onScroll={onScroll}>
      {lines.map((line, i) => (
        <div key={i}>{line}</div>
      ))}
      {status !== "active" && <div className="log-step">— app exited —</div>}
    </div>
  );
}
