// A small JSON-RPC client for one language server over stdio.
//
// It speaks the subset the plugin uses: initialize/initialized, didOpen,
// definitions, references, call hierarchy, workspace symbols, and
// publishDiagnostics. A server request gets a benign answer so the handshake
// cannot stall; a request past its deadline rejects rather than delaying a turn.

import { spawn, type ChildProcess } from "node:child_process";
import type { Logger } from "../../log.ts";

export interface LspCommand {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
}

export interface LspPosition {
  readonly line: number;
  readonly character: number;
}

export interface LspRange {
  readonly start: LspPosition;
  readonly end: LspPosition;
}

export interface LspLocation {
  readonly uri: string;
  readonly range: LspRange;
}

export interface LspDiagnostic {
  readonly range: LspRange;
  readonly severity?: number;
  readonly message: string;
  readonly source?: string;
}

export interface LspClientOptions {
  readonly command: LspCommand;
  readonly cwd: string;
  readonly rootPath: string;
  readonly logger: Logger;
  readonly timeoutMs: number;
  readonly onDiagnostics?: (uri: string, diagnostics: ReadonlyArray<LspDiagnostic>) => void;
}

interface Pending {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

const INITIALIZE_TIMEOUT_MS = 20_000;
const SHUTDOWN_TIMEOUT_MS = 2_000;

export class LspClient {
  private child: ChildProcess | null = null;
  private buffer = Buffer.alloc(0);
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private stopped = false;

  constructor(private readonly options: LspClientOptions) {}

  get pid(): number | null {
    return this.child?.pid ?? null;
  }

  async start(): Promise<void> {
    if (this.child !== null) return;
    const child = spawn(this.options.command.command, [...this.options.command.args], {
      cwd: this.options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child = child;
    child.stdout?.on("data", (chunk: Buffer) => this.receive(chunk));
    child.stderr?.on("data", (chunk: Buffer) => {
      this.options.logger.debug("lsp stderr", chunk.toString("utf8").slice(0, 200));
    });
    child.once("error", (error) => this.failAll(error));
    child.once("close", () => {
      this.stopped = true;
      this.failAll(new Error("the language server exited"));
    });

    const rootUri = pathToUri(this.options.rootPath);
    await this.request(
      "initialize",
      {
        processId: process.pid,
        rootUri,
        workspaceFolders: [{ uri: rootUri, name: "project" }],
        capabilities: {
          textDocument: {
            definition: {},
            references: {},
            callHierarchy: {},
            documentSymbol: {},
            publishDiagnostics: {},
          },
          workspace: { symbol: {} },
        },
      },
      INITIALIZE_TIMEOUT_MS,
    );
    this.notify("initialized", {});
  }

  async request(method: string, params: unknown, timeoutMs = this.options.timeoutMs): Promise<unknown> {
    if (this.stopped || this.child === null) throw new Error("the language server is not running");
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params: unknown): void {
    if (this.stopped) return;
    this.send({ jsonrpc: "2.0", method, params });
  }

  didOpen(uri: string, languageId: string, text: string): void {
    this.notify("textDocument/didOpen", {
      textDocument: { uri, languageId, version: 1, text },
    });
  }

  didClose(uri: string): void {
    this.notify("textDocument/didClose", { textDocument: { uri } });
  }

  async stop(): Promise<void> {
    if (this.child === null) return;
    try {
      await this.request("shutdown", null, SHUTDOWN_TIMEOUT_MS);
    } catch {
      // A server that already died has nothing to shut down.
    }
    this.notify("exit", null);
    this.stopped = true;
    const child = this.child;
    this.child = null;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, SHUTDOWN_TIMEOUT_MS);
      timer.unref?.();
      child.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
      setTimeout(() => child.kill("SIGTERM"), 200).unref?.();
    });
  }

  private send(message: unknown): void {
    const body = JSON.stringify(message);
    this.child?.stdin?.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  }

  private receive(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (true) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;
      const header = this.buffer.subarray(0, headerEnd).toString("utf8");
      const match = /Content-Length:\s*(\d+)/i.exec(header);
      if (match === null) {
        this.buffer = this.buffer.subarray(headerEnd + 4);
        continue;
      }
      const length = Number(match[1]);
      const start = headerEnd + 4;
      if (this.buffer.length < start + length) return;
      const raw = this.buffer.subarray(start, start + length).toString("utf8");
      this.buffer = this.buffer.subarray(start + length);
      this.dispatch(raw);
    }
  }

  private dispatch(raw: string): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }
    const id = typeof message.id === "number" ? message.id : null;
    const method = typeof message.method === "string" ? message.method : null;
    if (id !== null && method === null) {
      const pending = this.pending.get(id);
      if (pending === undefined) return;
      clearTimeout(pending.timer);
      this.pending.delete(id);
      if (message.error !== undefined) {
        pending.reject(new Error(JSON.stringify(message.error).slice(0, 300)));
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (id !== null && method !== null) {
      this.answerServerRequest(id, method);
      return;
    }
    if (method === "textDocument/publishDiagnostics") {
      const params = message.params as { uri?: unknown; diagnostics?: unknown };
      if (typeof params.uri === "string" && Array.isArray(params.diagnostics)) {
        this.options.onDiagnostics?.(
          params.uri,
          params.diagnostics as ReadonlyArray<LspDiagnostic>,
        );
      }
    }
  }

  private answerServerRequest(id: number, method: string): void {
    let result: unknown = null;
    if (method === "workspace/configuration") result = [];
    else if (method === "workspace/workspaceFolders") {
      result = [{ uri: pathToUri(this.options.rootPath), name: "project" }];
    }
    this.send({ jsonrpc: "2.0", id, result });
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

export function pathToUri(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  return `file://${normalized.startsWith("/") ? "" : "/"}${encodeURI(normalized)}`;
}

export function uriToPath(uri: string): string {
  if (!uri.startsWith("file://")) return uri;
  return decodeURI(uri.slice("file://".length));
}
