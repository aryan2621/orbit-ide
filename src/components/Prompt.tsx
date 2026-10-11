import { useEffect, useRef, useState } from "react";
import { create } from "zustand";

interface PromptRequest {
  title: string;
  detail?: string;
  initial: string;
  placeholder?: string;
  resolve: (value: string | null) => void;
}

const usePrompt = create<{ request: PromptRequest | null }>(() => ({ request: null }));

/** Asks for one line of text (the WebView has no `window.prompt`). Resolves null on cancel. */
export function promptText(title: string, options: { detail?: string; initial?: string; placeholder?: string } = {}): Promise<string | null> {
  usePrompt.getState().request?.resolve(null);
  return new Promise((resolve) => usePrompt.setState({ request: { title, initial: options.initial ?? "", detail: options.detail, placeholder: options.placeholder, resolve } }));
}

/** Mount once at the app root. */
export function PromptHost() {
  const request = usePrompt((s) => s.request);
  const [value, setValue] = useState("");
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!request) return;
    setValue(request.initial);
    requestAnimationFrame(() => input.current?.select());
  }, [request]);

  if (!request) return null;
  const finish = (result: string | null) => {
    usePrompt.setState({ request: null });
    request.resolve(result);
  };

  return (
    <div className="overlay" role="dialog" aria-modal="true" onMouseDown={(e) => e.target === e.currentTarget && finish(null)}>
      <div className="prompt">
        <label className="field">
          <span>{request.title}</span>
          <input
            ref={input}
            className="text-input"
            value={value}
            placeholder={request.placeholder}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") finish(value);
              else if (e.key === "Escape") (e.preventDefault(), finish(null));
            }}
          />
          {request.detail && <small className="muted">{request.detail}</small>}
        </label>
        <div className="prompt-actions">
          <button className="btn" onClick={() => finish(null)}>
            Cancel
          </button>
          <button className="btn primary" onClick={() => finish(value)}>
            OK
          </button>
        </div>
      </div>
    </div>
  );
}
