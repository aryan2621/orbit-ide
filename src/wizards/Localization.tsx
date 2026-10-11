import { useEffect, useMemo, useState } from "react";
import { fsApi } from "../lib/ipc";
import { Catalog, Table, findCatalogs, languageName, loadTable, saveCell } from "../lib/l10n";
import { ensureFileModel, isDirty, markSaved, useWorkspace } from "../state/workspace";
import { promptText } from "../components/Prompt";
import { IconClose } from "../components/Icons";
import SearchField from "../components/SearchField";

/** One editable translation; saves on blur or ⌘↩ / ↩ (⇧↩ for a new line). */
function Cell({ value, missing, review, readOnly, onSave }: { value: string | undefined; missing: boolean; review: boolean; readOnly?: string; onSave: (v: string) => void }) {
  const [draft, setDraft] = useState(value ?? "");
  useEffect(() => setDraft(value ?? ""), [value]);
  if (readOnly) {
    return (
      <td className="l10n-cell readonly" title={readOnly}>
        {value || <span className="muted">{readOnly}</span>}
      </td>
    );
  }
  const commit = () => draft !== (value ?? "") && onSave(draft);
  return (
    <td className={`l10n-cell${missing ? " missing" : ""}${review ? " review" : ""}`}>
      <textarea
        rows={1}
        value={draft}
        placeholder={missing ? "Missing" : ""}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            (e.target as HTMLTextAreaElement).blur();
          } else if (e.key === "Escape") {
            setDraft(value ?? "");
            e.preventDefault();
          }
        }}
      />
    </td>
  );
}

/** Localization editor: a table of keys × languages for a String Catalog or Android strings.xml. */
export default function Localization({ root, onClose }: { root: string; onClose: () => void }) {
  const [catalogs, setCatalogs] = useState<Catalog[] | null>(null);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [table, setTable] = useState<Table | null>(null);
  const [extra, setExtra] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [onlyMissing, setOnlyMissing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    findCatalogs(root)
      .then((c) => {
        setCatalogs(c);
        setCatalog(c[0] ?? null);
      })
      .catch((e) => setError(String(e)));
  }, [root]);

  useEffect(() => {
    if (!catalog) return;
    setTable(null);
    setError(null);
    loadTable(catalog, extra)
      .then(setTable)
      .catch((e) => setError(`Couldn't read ${catalog.label}: ${e}`));
  }, [catalog, extra]);

  const isMissing = (t: Table, r: Table["rows"][number], l: string) => l !== t.source && !r.skip && !r.readOnly[l] && !r.values[l];

  const rows = useMemo(() => {
    if (!table) return [];
    const q = query.toLowerCase();
    return table.rows.filter(
      (r) =>
        (!q || r.key.toLowerCase().includes(q) || Object.values(r.values).some((v) => v.toLowerCase().includes(q))) &&
        (!onlyMissing || table.languages.some((l) => isMissing(table, r, l) || r.review[l])),
    );
  }, [table, query, onlyMissing]);

  const missingCount = (lang: string) => table?.rows.filter((r) => isMissing(table, r, lang)).length ?? 0;

  const save = async (key: string, lang: string, value: string) => {
    if (!catalog || !table) return;
    setError(null);
    // Don't overwrite unsaved edits in an open editor tab.
    const open = useWorkspace.getState().files.filter(isDirty).map((f) => f.path);
    const target = catalog.kind === "xcstrings" ? catalog.path : `${catalog.path}/values${lang === "default" ? "" : "-" + lang.replace(/-([A-Z]{2})$/, "-r$1")}/strings.xml`;
    if (open.includes(target)) return setError(`${target.split("/").slice(-2).join("/")} has unsaved changes in the editor. Save or revert it first.`);
    try {
      const written = await saveCell(catalog, table, key, lang, value);
      // Keep an open (clean) editor tab in step with the file.
      for (const path of written) {
        if (useWorkspace.getState().files.some((f) => f.path === path)) {
          const text = await fsApi.readFile(path);
          ensureFileModel(path, text);
          markSaved(path, text);
        }
      }
      setTable(await loadTable(catalog, extra));
    } catch (e) {
      setError(`Couldn't save: ${e}`);
    }
  };

  const addLanguage = async () => {
    const code = await promptText("Add language", { placeholder: "Language code, e.g. fr, de, pt-BR, zh-Hans" });
    const c = code?.trim();
    if (!c || !table) return;
    if (!/^[a-z]{2,3}([-_][A-Za-z]{2,4})?$/.test(c)) return setError(`"${c}" isn't a language code.`);
    if (catalog?.kind === "android" && /-[A-Z][a-z]{3}$/.test(c)) return setError("Android uses region codes (e.g. zh-CN) rather than scripts in folder names.");
    if (!table.languages.includes(c)) setExtra((x) => [...x, c]);
  };

  return (
    <div className="overlay" role="dialog" aria-modal="true" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="l10n-window">
        <header className="diff-header">
          <strong>Localization</strong>
          {catalogs && catalogs.length > 0 && (
            <select className="picker" value={catalog?.path ?? ""} onChange={(e) => (setExtra([]), setCatalog(catalogs.find((c) => c.path === e.target.value) ?? null))}>
              {catalogs.map((c) => (
                <option key={c.path} value={c.path}>
                  {c.label}
                </option>
              ))}
            </select>
          )}
          <span className="grow" />
          <button className="icon-btn" title="Close (Esc)" onClick={onClose}>
            <IconClose />
          </button>
        </header>

        {catalogs && catalogs.length === 0 ? (
          <div className="panel-empty">
            No String Catalogs (.xcstrings) or Android strings.xml found in this project.
            <br />
            In Xcode, add one with File → New → File → String Catalog.
          </div>
        ) : (
          <>
            <div className="l10n-toolbar">
              <SearchField className="l10n-search" placeholder="Filter keys and text" value={query} onValueChange={setQuery} />
              <label className="check">
                <input type="checkbox" checked={onlyMissing} onChange={(e) => setOnlyMissing(e.target.checked)} /> Only missing or needing review
              </label>
              <span className="grow" />
              {table && (
                <span className="muted small">
                  {table.rows.length} keys ·{" "}
                  {table.languages
                    .filter((l) => l !== table.source)
                    .map((l) => `${l}: ${missingCount(l)} missing`)
                    .join(" · ") || "no translations yet"}
                </span>
              )}
              <button className="btn" onClick={addLanguage} disabled={!table}>
                Add Language…
              </button>
            </div>
            {error && <div className="check-error">{error}</div>}
            {!table ? (
              !error && <div className="setup-step skeleton" />
            ) : (
              <div className="l10n-scroll">
                <table className="l10n-table">
                  <thead>
                    <tr>
                      <th>Key</th>
                      {table.languages.map((l) => (
                        <th key={l}>
                          {l === "default" ? "Default" : languageName(l)}
                          {l === table.source && <span className="pill">source</span>}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.key} className={r.skip ? "skip" : undefined}>
                        <th title={r.comment ?? r.key}>
                          <code>{r.key}</code>
                          {r.comment && <div className="muted small">{r.comment}</div>}
                          {r.skip && <div className="muted small">Not translated</div>}
                        </th>
                        {table.languages.map((l) => (
                          <Cell
                            key={l}
                            value={r.values[l]}
                            missing={isMissing(table, r, l)}
                            review={!!r.review[l]}
                            readOnly={r.readOnly[l] ?? (r.skip && l !== table.source ? "Marked as not translatable" : undefined)}
                            onSave={(v) => save(r.key, l, v)}
                          />
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
                {rows.length === 0 && <div className="panel-empty">{onlyMissing ? "Everything is translated." : "No matching keys."}</div>}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
