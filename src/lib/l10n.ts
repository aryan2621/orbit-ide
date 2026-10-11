// String Catalogs (.xcstrings) and Android values*/strings.xml as one table model: rows of keys,
// a value per language. Edits are written back with minimal changes to the file's formatting.
import { filesApi, fsApi } from "./ipc";

export interface Catalog {
  kind: "xcstrings" | "android";
  /** The .xcstrings file, or the module's res/ folder. */
  path: string;
  label: string;
}

export interface Row {
  key: string;
  comment?: string;
  /** language → value; missing languages are untranslated. */
  values: Record<string, string>;
  /** language → why the cell can't be edited here (plural variations, inline markup). */
  readOnly: Record<string, string>;
  /** language → needs review (xcstrings state "needs_review" / "new"). */
  review: Record<string, boolean>;
  /** Marked "don't translate". */
  skip: boolean;
}

export interface Table {
  source: string;
  languages: string[];
  rows: Row[];
}

export function languageName(code: string) {
  try {
    const name = new Intl.DisplayNames(["en"], { type: "language" }).of(code.replace("_", "-"));
    return name && name !== code ? `${name} (${code})` : code;
  } catch {
    return code;
  }
}

/** All String Catalogs and Android string resource folders in the project. */
export async function findCatalogs(root: string): Promise<Catalog[]> {
  const files = await filesApi.list(root);
  const out: Catalog[] = [];
  for (const f of files) {
    if (f.endsWith(".xcstrings")) out.push({ kind: "xcstrings", path: `${root}/${f}`, label: f });
    const m = /^(.*\/res)\/values\/strings\.xml$/.exec(f);
    if (m) out.push({ kind: "android", path: `${root}/${m[1]}`, label: `${m[1]}/values*/strings.xml` });
  }
  return out.sort((a, b) => a.label.localeCompare(b.label));
}

// ---------------------------------------------------------------- .xcstrings

interface StringUnit {
  state?: string;
  value: string;
}
interface XcEntry {
  comment?: string;
  shouldTranslate?: boolean;
  localizations?: Record<string, { stringUnit?: StringUnit; variations?: unknown; substitutions?: unknown }>;
}
interface XcFile {
  sourceLanguage: string;
  strings: Record<string, XcEntry>;
  version?: string;
  [k: string]: unknown;
}

/** Xcode writes `"key" : value` with two-space indents; matching it keeps diffs to the edited lines. */
const xcodeJson = (v: unknown) => JSON.stringify(v, null, 2).replace(/^(\s*"(?:[^"\\]|\\.)*"): /gm, "$1 : ") + "\n";

function xcTable(file: XcFile, extra: string[]): Table {
  const source = file.sourceLanguage || "en";
  const langs = new Set<string>([source, ...extra]);
  for (const e of Object.values(file.strings ?? {})) for (const l of Object.keys(e.localizations ?? {})) langs.add(l);
  const languages = [source, ...[...langs].filter((l) => l !== source).sort()];
  const rows = Object.entries(file.strings ?? {}).map(([key, e]): Row => {
    const values: Record<string, string> = {};
    const readOnly: Record<string, string> = {};
    const review: Record<string, boolean> = {};
    for (const [lang, loc] of Object.entries(e.localizations ?? {})) {
      if (loc.stringUnit) {
        values[lang] = loc.stringUnit.value;
        if (loc.stringUnit.state === "needs_review" || loc.stringUnit.state === "new") review[lang] = true;
      } else if (loc.variations || loc.substitutions) {
        values[lang] = "";
        readOnly[lang] = "Plural or device variations: edit in Xcode";
      }
    }
    // The key is the source text unless the source language has its own value.
    if (values[source] === undefined) values[source] = key;
    return { key, comment: e.comment, values, readOnly, review, skip: e.shouldTranslate === false };
  });
  return { source, languages, rows };
}

// ---------------------------------------------------------------- strings.xml

const STRING_RE = /<string\s+name="([^"]+)"([^>]*?)(?:\/>|>([\s\S]*?)<\/string>)/g;

function unescapeAndroid(raw: string) {
  return raw
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\\(['"@?n t\\])/g, (_, c: string) => (c === "n" ? "\n" : c === "t" ? "\t" : c));
}

function escapeAndroid(value: string) {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/'/g, "\\'")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/^([@?])/, "\\$1");
}

function parseStrings(xml: string) {
  const out = new Map<string, { value: string; readOnly?: string; translatable: boolean }>();
  for (const m of xml.matchAll(STRING_RE)) {
    const inner = m[3] ?? "";
    const markup = /<|CDATA/.test(inner);
    out.set(m[1], {
      value: markup ? inner : unescapeAndroid(inner),
      readOnly: markup ? "Contains markup: edit in strings.xml" : undefined,
      translatable: !/translatable\s*=\s*"false"/.test(m[2]),
    });
  }
  return out;
}

const valuesDir = (res: string, lang: string) => (lang === "default" ? `${res}/values` : `${res}/values-${lang}`);
/** values-fr → fr, values-pt-rBR → pt-BR. */
const qualifierToLang = (q: string) => q.replace(/-r([A-Z]{2})$/, "-$1");
const langToQualifier = (l: string) => l.replace(/-([A-Z]{2})$/, "-r$1");

async function androidLanguages(res: string): Promise<string[]> {
  const entries = await fsApi.readDir(res);
  const langs: string[] = [];
  for (const e of entries) {
    // Only language qualifiers (values-fr, values-zh-rCN, values-b+sr+Latn), not values-night / values-v31.
    const m = /^values-([a-z]{2,3}(?:-r[A-Z]{2})?|b\+[\w+]+)$/.exec(e.name);
    if (m && e.is_dir) {
      const has = (await fsApi.readDir(`${res}/${e.name}`).catch(() => [])).some((f) => f.name === "strings.xml");
      if (has) langs.push(qualifierToLang(m[1]));
    }
  }
  return langs.sort();
}

// ---------------------------------------------------------------- load / save

export async function loadTable(c: Catalog, extra: string[] = []): Promise<Table> {
  if (c.kind === "xcstrings") return xcTable(JSON.parse(await fsApi.readFile(c.path)), extra);
  const langs = [...new Set([...(await androidLanguages(c.path)), ...extra])].sort();
  const base = parseStrings(await fsApi.readFile(`${valuesDir(c.path, "default")}/strings.xml`));
  const per = new Map<string, ReturnType<typeof parseStrings>>();
  for (const l of langs) per.set(l, parseStrings(await fsApi.readFile(`${valuesDir(c.path, langToQualifier(l))}/strings.xml`).catch(() => "")));
  const rows = [...base.entries()].map(([key, b]): Row => {
    const values: Record<string, string> = { default: b.value };
    const readOnly: Record<string, string> = b.readOnly ? { default: b.readOnly } : {};
    for (const l of langs) {
      const t = per.get(l)!.get(key);
      if (t) {
        values[l] = t.value;
        if (t.readOnly) readOnly[l] = t.readOnly;
      }
    }
    return { key, values, readOnly, review: {}, skip: !b.translatable };
  });
  return { source: "default", languages: ["default", ...langs], rows };
}

/** Writes one cell. An empty translation removes it (the source value can't be emptied). Returns the files written. */
export async function saveCell(c: Catalog, table: Table, key: string, lang: string, value: string): Promise<string[]> {
  if (c.kind === "xcstrings") {
    const file: XcFile = JSON.parse(await fsApi.readFile(c.path));
    const entry = (file.strings[key] ??= {});
    entry.localizations ??= {};
    if (value === "" && lang !== table.source) delete entry.localizations[lang];
    else entry.localizations[lang] = { ...entry.localizations[lang], stringUnit: { state: "translated", value } };
    if (Object.keys(entry.localizations).length === 0) delete entry.localizations;
    await fsApi.writeFile(c.path, xcodeJson(file));
    return [c.path];
  }

  const dir = valuesDir(c.path, lang === "default" ? "default" : langToQualifier(lang));
  const path = `${dir}/strings.xml`;
  let xml = await fsApi.readFile(path).catch(() => null);
  if (xml === null) {
    await filesApi.create(dir, true).catch(() => {});
    xml = `<?xml version="1.0" encoding="utf-8"?>\n<resources>\n</resources>\n`;
  }
  const name = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const existing = new RegExp(`([ \\t]*)<string\\s+name="${name}"([^>]*?)(?:/>|>[\\s\\S]*?</string>)(\\r?\\n)?`);
  const m = existing.exec(xml);
  if (value === "" && lang !== "default") {
    if (m) xml = xml.slice(0, m.index) + xml.slice(m.index + m[0].length);
  } else if (m) {
    xml = xml.slice(0, m.index) + `${m[1]}<string name="${key}"${m[2]}>${escapeAndroid(value)}</string>${m[3] ?? ""}` + xml.slice(m.index + m[0].length);
  } else {
    const end = xml.lastIndexOf("</resources>");
    if (end === -1) throw new Error(`${path} has no </resources> element`);
    xml = xml.slice(0, end) + `    <string name="${key}">${escapeAndroid(value)}</string>\n` + xml.slice(end);
  }
  await fsApi.writeFile(path, xml);
  return [path];
}
