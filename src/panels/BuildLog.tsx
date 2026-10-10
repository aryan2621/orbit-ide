import { useEffect, useRef } from "react";
import { useProject } from "../state/project";

function lineClass(line: string) {
  if (line.includes(" error: ") || line.startsWith("error: ") || line.includes("BUILD FAILED")) return "log-error";
  if (line.includes(" warning: ") || line.startsWith("warning: ")) return "log-warning";
  if (line.includes("BUILD SUCCEEDED")) return "log-ok";
  if (line.startsWith("▸")) return "log-step";
  return "";
}

export default function BuildLog() {
  const build = useProject((s) => s.build);
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  useEffect(() => {
    if (stick.current && ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [build.log.length]);

  const onScroll = () => {
    const el = ref.current!;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  };

  if (build.status === "idle") return <div className="panel-empty">Press ⌘B to build or ⌘R to run</div>;

  return (
    <div className="build-log" ref={ref} onScroll={onScroll}>
      {build.log.map((line, i) => (
        <div key={i} className={lineClass(line)}>
          {line}
        </div>
      ))}
      {build.status === "active" && <div className="log-step">…</div>}
    </div>
  );
}
