import { useProject } from "../state/project";
import VirtualLog from "../components/VirtualLog";

/** The running app's output (print, NSLog, crashes). */
export default function Console() {
  const { action, console: lines, status, phase } = useProject((s) => s.build);

  if (action === "build" || (lines.length === 0 && phase !== "running")) {
    return <div className="panel-empty">Press ⌘R to run the app; its output appears here</div>;
  }

  return (
    <VirtualLog
      items={lines}
      render={(line) => line}
      footer={status !== "active" && <div className="log-step">— app exited —</div>}
    />
  );
}
