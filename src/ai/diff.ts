/** A line diff for previews: unchanged lines outside the hunks are collapsed. */
export interface DiffLine {
  kind: "same" | "del" | "ins" | "gap";
  text: string;
}

/** Longest-common-subsequence line diff (fine for file-sized inputs; large inputs fall back to a full replace). */
export function lineDiff(before: string, after: string, context = 3): DiffLine[] {
  const a = before.split("\n");
  const b = after.split("\n");
  // Trim the common prefix and suffix so the table only covers the changed middle.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) endA--, endB--;
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);

  let middle: DiffLine[];
  if (midA.length * midB.length > 4_000_000) {
    middle = [...midA.map((text) => ({ kind: "del" as const, text })), ...midB.map((text) => ({ kind: "ins" as const, text }))];
  } else {
    const n = midA.length;
    const m = midB.length;
    const table = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) table[i][j] = midA[i] === midB[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    middle = [];
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && midA[i] === midB[j]) middle.push({ kind: "same", text: midA[i++] }), j++;
      else if (j < m && (i === n || table[i][j + 1] >= table[i + 1][j])) middle.push({ kind: "ins", text: midB[j++] });
      else middle.push({ kind: "del", text: midA[i++] });
    }
  }
  const all: DiffLine[] = [...a.slice(0, start).map((text) => ({ kind: "same" as const, text })), ...middle, ...a.slice(endA).map((text) => ({ kind: "same" as const, text }))];

  // Keep `context` unchanged lines around each change.
  const keep = new Array(all.length).fill(false);
  all.forEach((l, k) => {
    if (l.kind !== "same") for (let d = Math.max(0, k - context); d <= Math.min(all.length - 1, k + context); d++) keep[d] = true;
  });
  const out: DiffLine[] = [];
  let skipped = 0;
  all.forEach((l, k) => {
    if (keep[k]) {
      if (skipped) out.push({ kind: "gap", text: `⋯ ${skipped} unchanged line${skipped === 1 ? "" : "s"}` });
      skipped = 0;
      out.push(l);
    } else skipped++;
  });
  if (skipped && out.length) out.push({ kind: "gap", text: `⋯ ${skipped} unchanged line${skipped === 1 ? "" : "s"}` });
  return out;
}
