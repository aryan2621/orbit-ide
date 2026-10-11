import { useOutput } from "../state/output";
import VirtualLog from "../components/VirtualLog";

/** Language servers' stderr and log messages, one channel per server. */
export default function Output() {
  const { channels, active, setActive, clear } = useOutput();
  const names = Object.keys(channels);
  const lines = active ? (channels[active] ?? []) : [];

  return (
    <div className="sidebar-view">
      <div className="sidebar-header">
        <span className="sidebar-title">Output</span>
      </div>
      {names.length === 0 ? (
        <div className="sidebar-empty">Language server logs appear here once a server starts</div>
      ) : (
        <>
      <div className="tests-toolbar">
        <select value={active ?? ""} onChange={(e) => setActive(e.target.value)} aria-label="Channel">
          {names.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
        <button className="btn" disabled={lines.length === 0} onClick={() => navigator.clipboard.writeText(lines.join("\n"))}>
          Copy
        </button>
        <button className="btn" disabled={!active || lines.length === 0} onClick={() => active && clear(active)}>
          Clear
        </button>
      </div>
      <VirtualLog items={lines} render={(line) => line} />
        </>
      )}
    </div>
  );
}
