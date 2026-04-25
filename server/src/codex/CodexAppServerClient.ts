import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import readline from "node:readline";

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  method: string;
  timeout: NodeJS.Timeout;
}

export interface JsonRpcMessage {
  id?: number | string;
  method?: string;
  params?: JsonObject;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

export class CodexAppServerClient extends EventEmitter {
  private proc?: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private pending = new Map<number | string, PendingRequest>();
  private readyPromise?: Promise<void>;

  async ensureReady() {
    if (this.readyPromise) return this.readyPromise;
    this.readyPromise = this.start();
    return this.readyPromise;
  }

  async request<T = unknown>(method: string, params?: JsonObject, timeoutMs = 120_000): Promise<T> {
    await this.ensureReady();
    const id = this.nextId++;
    const payload: JsonRpcMessage = { id, method };
    if (params) payload.params = params;

    const promise = new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex app-server request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        method,
        timeout
      });
    });

    this.write(payload);
    return promise;
  }

  notify(method: string, params?: JsonObject) {
    this.write(params ? { method, params } : { method });
  }

  respond(id: number | string, result: JsonObject) {
    this.write({ id, result });
  }

  respondError(id: number | string, message: string, code = -32000) {
    this.write({ id, error: { code, message } });
  }

  private async start() {
    this.proc = spawn("codex", ["app-server"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env
    });

    this.proc.once("exit", (code, signal) => {
      const error = new Error(`codex app-server exited (${code ?? signal ?? "unknown"})`);
      this.readyPromise = undefined;
      for (const [id, pending] of this.pending.entries()) {
        clearTimeout(pending.timeout);
        pending.reject(error);
        this.pending.delete(id);
      }
      this.emit("diagnostic", { level: "error", message: error.message });
    });

    this.proc.stderr.on("data", (chunk) => {
      const message = chunk.toString().trim();
      if (message) this.emit("diagnostic", { level: "info", message });
    });

    const rl = readline.createInterface({ input: this.proc.stdout });
    rl.on("line", (line) => this.handleLine(line));

    await this.requestWithoutReady("initialize", {
      clientInfo: {
        name: "codex_mobile_console",
        title: "Codex Mobile Console",
        version: "0.1.0"
      },
      capabilities: {
        experimentalApi: true
      }
    });
    this.notify("initialized", {});
  }

  private requestWithoutReady(method: string, params?: JsonObject, timeoutMs = 30_000) {
    if (!this.proc) throw new Error("codex app-server process is not running");
    const id = this.nextId++;
    const payload: JsonRpcMessage = { id, method };
    if (params) payload.params = params;

    const promise = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex app-server request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, method, timeout });
    });
    this.write(payload);
    return promise;
  }

  private handleLine(line: string) {
    if (!line.trim()) return;

    let message: JsonRpcMessage;
    try {
      message = JSON.parse(line) as JsonRpcMessage;
    } catch {
      this.emit("diagnostic", { level: "warn", message: `Non-JSON app-server line: ${line}` });
      return;
    }

    if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
      const pending = this.pending.get(message.id);
      if (!pending) {
        this.emit("diagnostic", { level: "warn", message: `Unexpected response id: ${String(message.id)}` });
        return;
      }
      clearTimeout(pending.timeout);
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(message.error.message ?? `Codex request failed: ${pending.method}`));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (message.id !== undefined && message.method) {
      this.emit("serverRequest", message);
      return;
    }

    if (message.method) {
      this.emit("notification", message);
      return;
    }

    this.emit("diagnostic", { level: "warn", message: `Unknown app-server message: ${line}` });
  }

  private write(payload: JsonRpcMessage) {
    if (!this.proc) throw new Error("codex app-server process is not running");
    this.proc.stdin.write(`${JSON.stringify(payload)}\n`);
  }
}
