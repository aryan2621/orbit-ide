// Inline ghost-text completions through llama-server's /infill. Off by default; only runs when the
// chosen model supports fill-in-the-middle and is already loaded (it never loads a model by itself).
import * as monaco from "monaco-editor";
import { aiApi } from "../lib/ipc";
import { aiReady, useAi } from "../state/ai";
import { useChat } from "./agent";

const DEBOUNCE_MS = 350;
const PREFIX_CHARS = 4000;
const SUFFIX_CHARS = 1500;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

monaco.languages.registerInlineCompletionsProvider("*", {
  async provideInlineCompletions(model, position, _context, token) {
    const ai = useAi.getState();
    const installed = ai.models?.installed.find((m) => m.id === ai.settings.model);
    if (!ai.settings.inlineCompletions || !aiReady(ai) || !installed?.infill) return;
    // One request at a time on the server: don't queue behind a chat reply.
    if (ai.server.status !== "ready" || ai.server.model !== installed.id || useChat.getState().running) return;
    if (model.uri.scheme !== "file") return;

    await sleep(DEBOUNCE_MS);
    if (token.isCancellationRequested) return;

    const offset = model.getOffsetAt(position);
    const text = model.getValue();
    const prefix = text.slice(Math.max(0, offset - PREFIX_CHARS), offset);
    const suffix = text.slice(offset, offset + SUFFIX_CHARS);
    // Mid-word on the right: a completion would only fight the existing text.
    if (/^\w/.test(suffix)) return;

    const insert = await aiApi.infill(installed.id, ai.settings.ctx, prefix, suffix).catch(() => "");
    if (token.isCancellationRequested || !insert.trim()) return;
    return {
      items: [{ insertText: insert, range: new monaco.Range(position.lineNumber, position.column, position.lineNumber, position.column) }],
    };
  },
  disposeInlineCompletions() {},
});
