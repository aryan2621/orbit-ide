import { invoke } from "@tauri-apps/api/core";
import { listen, UnlistenFn } from "@tauri-apps/api/event";

type Handler = (params: any) => void;

interface Pending {
  resolve: (v: any) => void;
  reject: (e: Error) => void;
}

/** Minimal JSON-RPC client for a language server running behind the Rust stdio bridge. */
export class LspClient {
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private handlers = new Map<string, Handler>();
  private unlisten: UnlistenFn[] = [];
  private closed = false;
  onExit: () => void = () => {};

  private constructor(readonly serverId: number) {}

  static async start(root: string): Promise<LspClient> {
    const id = await invoke<number>("lsp_start", { root });
    const client = new LspClient(id);
    client.unlisten.push(
      await listen<string>(`lsp://${id}/message`, (e) => client.receive(JSON.parse(e.payload))),
      await listen(`lsp://${id}/exit`, () => {
        client.dispose();
        client.onExit();
      }),
    );
    return client;
  }

  request<T = any>(method: string, params: unknown): Promise<T> {
    if (this.closed) return Promise.reject(new Error("Language server stopped"));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send({ jsonrpc: "2.0", id, method, params }).catch((e) => {
        this.pending.delete(id);
        reject(e);
      });
    });
  }

  notify(method: string, params: unknown) {
    if (!this.closed) this.send({ jsonrpc: "2.0", method, params }).catch(() => {});
  }

  onNotification(method: string, handler: Handler) {
    this.handlers.set(method, handler);
  }

  async stop() {
    if (this.closed) return;
    try {
      await Promise.race([this.request("shutdown", null), new Promise((r) => setTimeout(r, 1000))]);
      this.notify("exit", null);
    } finally {
      this.dispose();
      await invoke("lsp_stop", { id: this.serverId });
    }
  }

  private send(message: object) {
    return invoke<void>("lsp_send", { id: this.serverId, message: JSON.stringify(message) });
  }

  private receive(msg: any) {
    if (msg.id !== undefined && msg.method === undefined) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message));
      else p.resolve(msg.result);
    } else if (msg.id !== undefined) {
      // Server → client request. We support none of the optional ones, so acknowledge with a
      // neutral result (workspace/configuration expects one entry per requested item).
      const result = msg.method === "workspace/configuration" ? (msg.params?.items ?? []).map(() => null) : null;
      this.send({ jsonrpc: "2.0", id: msg.id, result }).catch(() => {});
    } else {
      this.handlers.get(msg.method)?.(msg.params);
    }
  }

  private dispose() {
    this.closed = true;
    this.unlisten.forEach((u) => u());
    this.unlisten = [];
    this.pending.forEach((p) => p.reject(new Error("Language server stopped")));
    this.pending.clear();
  }
}
