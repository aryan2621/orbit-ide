import { useEffect, useState } from "react";
import { DiffEditor } from "@monaco-editor/react";
import { fsApi, gitApi } from "../lib/ipc";
import { useGit } from "../state/git";
import { useUi } from "../state/ui";
import { useWorkspace } from "../state/workspace";
import { languageForPath } from "../editor/monaco-setup";
import { IconClose } from "../components/Icons";

/** Side-by-side diff of a file against HEAD. */
export default function DiffView({ theme }: { theme: "light" | "dark" }) {
  const { diffPath, setDiffPath } = useUi();
  const repo = useGit((s) => s.status?.repo_root);
  const openFile = useWorkspace((s) => s.openFile);
  const [texts, setTexts] = useState<{ before: string; after: string } | null>(null);

  useEffect(() => {
    if (!diffPath || !repo) return;
    const abs = `${repo}/${diffPath}`;
    Promise.all([gitApi.headContent(repo, diffPath), fsApi.readFile(abs).catch(() => "")]).then(([before, after]) =>
      setTexts({ before, after }),
    );
  }, [diffPath, repo]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setDiffPath(null);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setDiffPath]);

  if (!diffPath || !repo) return null;
  return (
    <div className="overlay" role="dialog" aria-modal="true" onMouseDown={(e) => e.target === e.currentTarget && setDiffPath(null)}>
      <div className="diff-window">
        <header className="diff-header">
          <strong>{diffPath.split("/").pop()}</strong>
          <span className="muted">{diffPath} · HEAD ↔ working copy</span>
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
            theme={theme === "dark" ? "orbit-dark" : "orbit-light"}
            options={{ readOnly: true, renderSideBySide: true, minimap: { enabled: false }, fontSize: 12.5, automaticLayout: true }}
          />
        )}
      </div>
    </div>
  );
}
