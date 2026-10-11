import { invoke } from "@tauri-apps/api/core";
import { listen, UnlistenFn } from "@tauri-apps/api/event";

type EventHandler = (body: any) => void;

/** Minimal Debug Adapter Protocol client for lldb-dap, over the Rust stdio bridge. */
export class DapClient {
  private seq = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private handlers = new Map<string, EventHandler[]>();
  private unlisten: UnlistenFn[] = [];
  private closed = false;
  onExit: () => void = () => {};

  private constructor(readonly bridgeId: number) {}

  /** Starts lldb-dap, or `adapter` (e.g. kotlin-debug-adapter) when given. */
  static async start(cwd: string, adapter?: { program: string; args: string[] }): Promise<DapClient> {
    const id = await invoke<number>("dap_start", { root: cwd, program: adapter?.program, args: adapter?.args });
    const client = new DapClient(id);
    client.unlisten.push(
      await listen<string>(`lsp://${id}/message`, (e) => client.receive(JSON.parse(e.payload))),
      await listen(`lsp://${id}/exit`, () => {
        client.dispose();
        client.onExit();
      }),
    );
    // Output is held back until we listen, so nothing (not even an immediate crash) is missed.
    await invoke("lsp_attach", { id });
    return client;
  }

  request<T = any>(command: string, args?: unknown): Promise<T> {
    if (this.closed) return Promise.reject(new Error("Debugger stopped"));
    const seq = this.seq++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(seq, { resolve, reject });
      this.send({ seq, type: "request", command, arguments: args }).catch((e) => {
        this.pending.delete(seq);
        reject(e);
      });
    });
  }

  on(event: string, handler: EventHandler) {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
  }

  /** Resolves with the next `event`'s body. */
  once(event: string): Promise<any> {
    return new Promise((resolve) => {
      const h: EventHandler = (body) => {
        this.handlers.set(event, (this.handlers.get(event) ?? []).filter((x) => x !== h));
        resolve(body);
      };
      this.on(event, h);
    });
  }

  async stop() {
    if (this.closed) return;
    try {
      await Promise.race([this.request("disconnect", { terminateDebuggee: true }), new Promise((r) => setTimeout(r, 1500))]);
    } catch {}
    this.dispose();
    await invoke("lsp_stop", { id: this.bridgeId }).catch(() => {});
  }

  private send(message: object) {
    return invoke<void>("lsp_send", { id: this.bridgeId, message: JSON.stringify(message) });
  }

  private receive(msg: any) {
    if (msg.type === "response") {
      const p = this.pending.get(msg.request_seq);
      if (!p) return;
      this.pending.delete(msg.request_seq);
      if (msg.success) p.resolve(msg.body);
      else p.reject(new Error(msg.message || `${msg.command} failed`));
    } else if (msg.type === "event") {
      (this.handlers.get(msg.event) ?? []).forEach((h) => h(msg.body ?? {}));
    } else if (msg.type === "request") {
      // Reverse requests (runInTerminal, startDebugging) aren't used with our launch config.
      this.send({ seq: this.seq++, type: "response", request_seq: msg.seq, command: msg.command, success: false }).catch(() => {});
    }
  }

  private dispose() {
    this.closed = true;
    this.unlisten.forEach((u) => u());
    this.unlisten = [];
    this.pending.forEach((p) => p.reject(new Error("Debugger stopped")));
    this.pending.clear();
  }
}
