// A small, safe Markdown renderer for chat replies: everything becomes React elements (no HTML
// injection), links open in the browser only for http(s), and code blocks get Copy / Insert.
import { ReactNode } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { activeEditor } from "../editor/navigation";

/** Inserts text at the cursor (replacing the selection) in the active editor, undoably. */
export function insertIntoEditor(text: string) {
  const editor = activeEditor();
  const selection = editor?.getSelection();
  if (!editor || !selection) return false;
  editor.pushUndoStop();
  editor.executeEdits("orbit-ai", [{ range: selection, text, forceMoveMarkers: true }]);
  editor.pushUndoStop();
  editor.focus();
  return true;
}

function CodeBlock({ lang, code }: { lang: string; code: string }) {
  return (
    <div className="md-code">
      <div className="md-code-bar">
        <span>{lang || "code"}</span>
        <span className="grow" />
        <button className="link" onClick={() => navigator.clipboard.writeText(code)}>
          Copy
        </button>
        <button className="link" title="Insert at the cursor in the editor" onClick={() => insertIntoEditor(code)}>
          Insert
        </button>
      </div>
      <pre>
        <code>{code}</code>
      </pre>
    </div>
  );
}

/** `code`, **bold**, *italic*, [links](https://…). */
function inline(text: string, key = 0): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\*[^*\n]+\*|_[^_\n]+_)|(\[[^\]\n]+\]\([^)\s]+\))/g;
  let last = 0;
  let k = key;
  for (const m of text.matchAll(re)) {
    if (m.index! > last) out.push(text.slice(last, m.index));
    const t = m[0];
    if (m[1]) out.push(<code key={k++}>{t.slice(1, -1)}</code>);
    else if (m[2]) out.push(<strong key={k++}>{inline(t.slice(2, -2), k * 100)}</strong>);
    else if (m[3]) out.push(<em key={k++}>{t.slice(1, -1)}</em>);
    else {
      const [, label, url] = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(t)!;
      out.push(
        /^https?:\/\//i.test(url) ? (
          <a key={k++} href={url} onClick={(e) => (e.preventDefault(), openUrl(url).catch(() => {}))}>
            {label}
          </a>
        ) : (
          label
        ),
      );
    }
    last = m.index! + t.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function Markdown({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  const lines = text.split("\n");
  let i = 0;
  let key = 0;
  while (i < lines.length) {
    const line = lines[i];
    const fence = /^\s*```(\S*)/.exec(line);
    if (fence) {
      const code: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) code.push(lines[i++]);
      i++; // closing fence (or end of a still-streaming reply)
      blocks.push(<CodeBlock key={key++} lang={fence[1]} code={code.join("\n")} />);
      continue;
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      blocks.push(level <= 2 ? <h3 key={key++}>{inline(heading[2])}</h3> : <h4 key={key++}>{inline(heading[2])}</h4>);
      i++;
      continue;
    }
    if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
      const ordered = /^\s*\d+[.)]/.test(line);
      const items: ReactNode[] = [];
      while (i < lines.length && /^\s*([-*+]|\d+[.)])\s+/.test(lines[i])) {
        items.push(<li key={items.length}>{inline(lines[i].replace(/^\s*([-*+]|\d+[.)])\s+/, ""))}</li>);
        i++;
      }
      blocks.push(ordered ? <ol key={key++}>{items}</ol> : <ul key={key++}>{items}</ul>);
      continue;
    }
    if (/^>\s?/.test(line)) {
      const quote: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) quote.push(lines[i++].replace(/^>\s?/, ""));
      blocks.push(<blockquote key={key++}>{inline(quote.join(" "))}</blockquote>);
      continue;
    }
    if (!line.trim()) {
      i++;
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^\s*(```|#{1,4}\s|[-*+]\s|\d+[.)]\s|>)/.test(lines[i])) para.push(lines[i++]);
    if (!para.length) para.push(lines[i++]); // never stall on a line no rule consumed
    blocks.push(<p key={key++}>{inline(para.join("\n"))}</p>);
  }
  return <div className="markdown">{blocks}</div>;
}
