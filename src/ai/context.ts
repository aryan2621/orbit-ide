// Context management for the agent: untrusted-data wrapping, truncation and compaction.

/** Rough token estimate (code averages ~3.5 characters per token; err on the high side). */
export const estimateTokens = (text: string) => Math.ceil(text.length / 3.2);

/**
 * Wraps file, log and tool content so the model treats it as data. A closing tag inside the
 * content is neutralized so it can't end the block early.
 */
export function untrusted(source: string, text: string) {
  const safe = text.replace(/<\/?untrusted/gi, (m) => m.replace("<", "‹"));
  return `<untrusted source="${source.replace(/"/g, "'")}">\n${safe}\n</untrusted>`;
}

/** Keeps the start and end of long output, which is where errors and summaries usually are. */
export function truncate(text: string, maxTokens: number) {
  const maxChars = Math.floor(maxTokens * 3.2);
  if (text.length <= maxChars) return text;
  const head = Math.floor(maxChars * 0.4);
  const tail = maxChars - head;
  const dropped = text.length - head - tail;
  return `${text.slice(0, head)}\n…[${dropped} characters omitted]…\n${text.slice(-tail)}`;
}

export interface ApiMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}

const messageTokens = (m: ApiMessage) => estimateTokens(m.content) + (m.tool_calls ? estimateTokens(JSON.stringify(m.tool_calls)) : 0) + 4;

/**
 * Fits the conversation in `budget` tokens: first old tool outputs are replaced by a stub, then the
 * oldest exchanges are dropped (the system prompt and the latest user message always stay).
 */
export function compact(messages: ApiMessage[], budget: number): ApiMessage[] {
  const out = messages.map((m) => ({ ...m }));
  const total = () => out.reduce((n, m) => n + messageTokens(m), 0);
  for (let i = 1; i < out.length && total() > budget; i++) {
    if (out[i].role === "tool" && i < out.length - 2 && out[i].content.length > 200) out[i].content = "[Earlier tool output removed to save context. Call the tool again if you need it.]";
  }
  // Drop the oldest messages after the system prompt (tool results go with their call), never
  // the latest user message or what follows it.
  while (total() > budget) {
    if (out.map((m) => m.role).lastIndexOf("user") <= 1) break;
    out.splice(1, 1);
    while (out[1]?.role === "tool") out.splice(1, 1);
  }
  return out;
}
