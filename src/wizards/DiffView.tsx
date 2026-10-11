import { useEffect, useState } from "react";
import { DiffEditor } from "@monaco-editor/react";
import { fsApi, gitApi } from "../lib/ipc";
import { useGit } from "../state/git";
import { useUi } from "../state/ui";
import { useWorkspace } from "../state/workspace";
import { languageForPath } from "../editor/monaco-setup";
import { IconClose } from "../components/Icons";

const revLabel = (rev: string) =>
  rev === "working" ? "working copy" : rev === ":" ? "staged" : /^[0-9a-f]{40}\^$/.test(rev) ? `${rev.slice(0, 8)}^` : /^[0-9a-f]{40}$/.test(rev) ? rev.slice(0, 8) : rev;

/** Side-by-side diff of a file between two revisions (HEAD ↔ working copy by default). */
export default function DiffView({ theme }: { theme: "light" | "dark" }) {
  const { diffPath, diffRevs, setDiffPath } = useUi();
  const repo = useGit((s) => s.status?.repo_root);
  const openFile = useWorkspace((s) => s.openFile);
  const [texts, setTexts] = useState<{ before: string; after: string } | null>(null);

  useEffect(() => {
    if (!diffPath || !repo) return;
    const read = (rev: string) =>
      rev === "working" ? fsApi.readFile(`${repo}/${diffPath}`).catch(() => "") : gitApi.fileAt(repo, rev, diffPath).catch(() => "");
    setTexts(null);
    Promise.all([read(diffRevs.left), read(diffRevs.right)]).then(([before, after]) => setTexts({ before, after }));
  }, [diffPath, diffRevs, repo]);

  if (!diffPath || !repo) return null;
  return (
    <div className="overlay" role="dialog" aria-modal="true" onMouseDown={(e) => e.target === e.currentTarget && setDiffPath(null)}>
      <div className="diff-window">
        <header className="diff-header">
          <strong>{diffPath.split("/").pop()}</strong>
          <span className="muted">
            {diffPath} · {revLabel(diffRevs.left)} ↔ {revLabel(diffRevs.right)}
          </span>
          <span className="grow" />
          <button
            className="btn"
            onClick={() => {
              openFile(`${repo}/${diffPath}`);
              setDiffPath(null);
            }}
          >
            Open File
          </button>
          <button className="icon-btn" title="Close (Esc)" onClick={() => setDiffPath(null)}>
            <IconClose />
          </button>
        </header>
        {texts && (
          <DiffEditor
            original={texts.before}
            modified={texts.after}
            language={languageForPath(diffPath)}
            // Own scheme so language servers never sync these models (they only take file: URIs).
            originalModelPath={`orbit-diff:/${encodeURIComponent(diffRevs.left)}/${diffPath}`}
            modifiedModelPath={`orbit-diff:/${encodeURIComponent(diffRevs.right)}/${diffPath}`}
            theme={theme === "dark" ? "orbit-dark" : "orbit-light"}
            options={{ readOnly: true, renderSideBySide: true, minimap: { enabled: false }, fontSize: 12.5, automaticLayout: true }}
          />
        )}
      </div>
    </div>
  );
}
