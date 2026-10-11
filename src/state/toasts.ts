import { create } from "zustand";

export interface Toast {
  id: number;
  kind: "info" | "warning" | "error";
  message: string;
}

let next = 1;

/** Short-lived notices (language-server messages and the like); errors that need action use the error bar. */
export const useToasts = create<{ toasts: Toast[]; dismiss: (id: number) => void }>((set) => ({
  toasts: [],
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

export function toast(message: string, kind: Toast["kind"] = "info") {
  const id = next++;
  useToasts.setState((s) => ({ toasts: [...s.toasts.slice(-3), { id, kind, message }] }));
  setTimeout(() => useToasts.getState().dismiss(id), kind === "error" ? 10_000 : 6_000);
}
