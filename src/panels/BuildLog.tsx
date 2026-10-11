import { useProject } from "../state/project";
import VirtualLog from "../components/VirtualLog";

function lineClass(line: string) {
  // xcodebuild prints "** BUILD FAILED **", Gradle "BUILD FAILED in 1s".
  if (line.includes(" error: ") || line.startsWith("error: ") || line.includes("BUILD FAILED")) return "log-error";
  if (line.includes(" warning: ") || line.startsWith("warning: ")) return "log-warning";
  if (line.includes("BUILD SUCCEEDED") || line.includes("BUILD SUCCESSFUL")) return "log-ok";
  if (line.startsWith("▸")) return "log-step";
  return "";
}

export default function BuildLog() {
  const build = useProject((s) => s.build);

  if (build.status === "idle") return <div className="panel-empty">Press ⌘B to build or ⌘R to run</div>;

  return (
    <VirtualLog
      items={build.log}
      render={(line) => <span className={lineClass(line)}>{line}</span>}
      footer={build.status === "active" && <div className="log-step">…</div>}
    />
  );
}
