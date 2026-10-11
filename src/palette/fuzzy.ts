/** Subsequence match with a score that favours contiguous runs and word starts. */
export function fuzzy(query: string, text: string): { score: number; hits: number[] } | null {
  if (!query) return { score: 0, hits: [] };
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  const hits: number[] = [];
  let score = 0;
  let last = -2;
  for (let i = 0, j = 0; i < q.length; i++) {
    const at = t.indexOf(q[i], j);
    if (at < 0) return null;
    hits.push(at);
    score += at === last + 1 ? 5 : 1;
    if (at === 0 || "/_-. ".includes(t[at - 1])) score += 3;
    last = at;
    j = at + 1;
  }
  return { score: score - t.length * 0.01, hits };
}
