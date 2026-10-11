import { useMemo, useState } from "react";
import { TestCase } from "../lib/ipc";
import { useProject } from "../state/project";
import { runAllTests, runCurrentFile, runTests, useTestPrefs } from "../state/tests";
import { useWorkspace } from "../state/workspace";
import { openAt } from "../editor/navigation";
import { IconChevronDown, IconChevronRight, IconPlay } from "../components/Icons";

const ICON: Record<TestCase["status"], string> = { passed: "✓", failed: "✕", skipped: "–" };
const seconds = (s: number) => (s >= 1 ? `${s.toFixed(2)} s` : `${Math.round(s * 1000)} ms`);

function open(c: TestCase) {
  if (c.file) openAt(c.file, { lineNumber: c.line ?? 1, column: 1 });
}

/** The Tests sidebar view: results as class → method, failures first; click to open the source, ▶ to rerun. */
export default function Tests() {
  const build = useProject((s) => s.build);
  const android = useProject((s) => s.info?.platform === "android");
  const hasFile = useWorkspace((s) => !!s.activePath);
  const { instrumented, setInstrumented } = useTestPrefs();
  const [failedOnly, setFailedOnly] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const running = build.status === "active";
  const tests = build.action === "test" ? build.tests : null;

  const suites = useMemo(() => {
    const groups = new Map<string, TestCase[]>();
    for (const c of tests ?? []) if (!failedOnly || c.status === "failed") groups.set(c.suiteId, [...(groups.get(c.suiteId) ?? []), c]);
    return [...groups.entries()].sort(([, a], [, b]) => Number(b.some((c) => c.status === "failed")) - Number(a.some((c) => c.status === "failed")));
  }, [tests, failedOnly]);

  const counts = { passed: 0, failed: 0, skipped: 0 };
  for (const c of tests ?? []) counts[c.status]++;
  const toggle = (id: string) =>
    setCollapsed((s) => {
      const next = new Set(s);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  return (
    <div className="sidebar-view">
      <div className="sidebar-header">
        <span className="sidebar-title">Tests</span>
      </div>
      <div className="tests-toolbar">
        <button className="btn primary" disabled={running} onClick={runAllTests} title="Run all tests (⌘U)">
          Run All
        </button>
        <button className="btn" disabled={running || !hasFile} onClick={runCurrentFile} title="Run the tests in the open file">
          Run File
        </button>
        {android && (
          <div className="segmented" role="radiogroup" aria-label="Test kind">
            <button className={!instrumented ? "on" : ""} onClick={() => setInstrumented(false)} title="JVM unit tests (src/test)">
              Unit
            </button>
            <button className={instrumented ? "on" : ""} onClick={() => setInstrumented(true)} title="On the selected device (src/androidTest)">
              Instrumented
            </button>
          </div>
        )}
        <label className="check">
          <input type="checkbox" checked={failedOnly} onChange={(e) => setFailedOnly(e.target.checked)} /> Failed only
        </label>
        {tests && (
          <span className="muted">
            {counts.passed} passed · {counts.failed} failed{counts.skipped ? ` · ${counts.skipped} skipped` : ""}
          </span>
        )}
      </div>
      {!tests ? (
        <div className="sidebar-empty">
          {running && build.action === "test" ? "Running tests…" : build.action === "test" && build.status === "failed" ? "The tests didn't run; see Build and Problems" : "Press ⌘U to run the tests"}
        </div>
      ) : tests.length === 0 ? (
        <div className="sidebar-empty">No tests ran</div>
      ) : (
        <div className="test-tree sidebar-body">
          {suites.map(([id, cases]) => {
            const failed = cases.some((c) => c.status === "failed");
            const open_ = !collapsed.has(id);
            return (
              <div key={id}>
                <div className={`test-row suite ${failed ? "failed" : "passed"}`} onClick={() => toggle(id)}>
                  <span className="tree-chevron">{open_ ? <IconChevronDown /> : <IconChevronRight />}</span>
                  <span className="test-status">{failed ? ICON.failed : ICON.passed}</span>
                  <span className="grow">{cases[0].suite}</span>
                  <span className="muted">{seconds(cases.reduce((t, c) => t + c.duration, 0))}</span>
                  <button className="icon-btn tiny" title="Run this class" disabled={running} onClick={(e) => (e.stopPropagation(), runTests({ suite: id }))}>
                    <IconPlay />
                  </button>
                </div>
                {open_ &&
                  cases.map((c) => (
                    <div key={c.name}>
                      <div className={`test-row case ${c.status}`} onClick={() => open(c)} title={c.file ?? undefined}>
                        <span className="test-status">{ICON[c.status]}</span>
                        <span className="grow">{c.name}</span>
                        <span className="muted">{seconds(c.duration)}</span>
                        <button className="icon-btn tiny" title="Run this test" disabled={running} onClick={(e) => (e.stopPropagation(), runTests({ suite: id, name: c.name }))}>
                          <IconPlay />
                        </button>
                      </div>
                      {c.message && (
                        <pre className="test-message" onClick={() => open(c)}>
                          {c.message.split("\n").slice(0, 12).join("\n")}
                        </pre>
                      )}
                    </div>
                  ))}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
