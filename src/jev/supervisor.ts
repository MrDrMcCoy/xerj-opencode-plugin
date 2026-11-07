// One resident jevos server for this installation.
//
// The model load costs a second or two and about 1 GB of memory, so the server
// starts on the first judgement and stops after `idleMs` without one. A second
// plugin instance that finds a healthy server on the port attaches to it
// instead of spawning another.

import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { createServer } from "node:net";
import { dirname } from "node:path";
import type { Logger } from "../log.ts";
import type { JevosInstall } from "./manager.ts";

export interface JevosSupervisorOptions {
  readonly install: () => Promise<JevosInstall>;
  /** 0 asks for the first free port from 8017. */
  readonly port: number;
  readonly threads: number | null;
  readonly logger: Logger;
  readonly logPath: string;
  readonly idleMs: number;
  readonly startupTimeoutMs: number;
  readonly probeTimeoutMs: number;
  readonly stopGraceMs: number;
}

const FIRST_PORT = 8017;
const LAST_PORT = 8099;
const FAILURE_COOLDOWN_MS = 60_000;
const IDLE_CHECK_MS = 30_000;

export class JevosSupervisor {
  private base: string | null = null;
  private child: ChildProcess | null = null;
  private pending: Promise<string | null> | null = null;
  private failedAt = 0;
  private lastUse = 0;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly options: JevosSupervisorOptions) {}

  get url(): string | null {
    return this.base;
  }

  /** The base URL, starting the server when needed; null when unavailable. */
  async ensure(): Promise<string | null> {
    if (this.base !== null) {
      this.lastUse = Date.now();
      return this.base;
    }
    if (this.pending !== null) return this.pending;
    if (Date.now() - this.failedAt < FAILURE_COOLDOWN_MS) return null;

    this.pending = this.start().finally(() => {
      this.pending = null;
    });
    return this.pending;
  }

  touch(): void {
    this.lastUse = Date.now();
  }

  /**
   * Forgets a server that stopped answering, so the next `ensure` starts a
   * new one. The cooldown prevents a crash loop from spawning per turn.
   */
  async invalidate(): Promise<void> {
    this.failedAt = Date.now();
    await this.stop();
  }

  async stop(): Promise<void> {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    const child = this.child;
    this.child = null;
    this.base = null;
    if (child === null) return;

    await new Promise<void>((resolvePromise) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolvePromise();
      }, this.options.stopGraceMs);
      timer.unref?.();
      child.once("close", () => {
        clearTimeout(timer);
        resolvePromise();
      });
      child.kill("SIGTERM");
    });
  }

  private async start(): Promise<string | null> {
    // Another instance may already serve the port; attach rather than spawn.
    const requested = this.options.port > 0 ? this.options.port : null;
    if (requested !== null && (await healthy(requested, this.options.probeTimeoutMs))) {
      return this.attach(requested);
    }

    let install: JevosInstall;
    try {
      install = await this.options.install();
    } catch (error) {
      this.failedAt = Date.now();
      this.options.logger.warn(
        "jevos is not installed; using the heuristic judge",
        String(error),
      );
      return null;
    }

    // A configured port may belong to another program; fall back to the
    // server's own scan range rather than failing every judgement.
    const port =
      requested !== null && (await portFree(requested))
        ? requested
        : await freePort(requested);
    if (port === null) {
      this.failedAt = Date.now();
      this.options.logger.warn(
        "no free port for the jevos server; using the heuristic judge",
      );
      return null;
    }

    mkdirSync(dirname(this.options.logPath), { recursive: true, mode: 0o700 });
    const log = openSync(this.options.logPath, "a", 0o600);
    // One sentence is the whole state. The default 8192-token context and
    // 16-slot state cache only cost memory here, so both are kept small.
    const args = [
      "serve",
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--model-dir",
      install.modelDir,
      "--ctx",
      "512",
      "--state-cache",
      "0",
    ];
    if (this.options.threads !== null && this.options.threads > 0) {
      args.push("--threads", String(this.options.threads));
    }

    let child: ChildProcess;
    try {
      child = spawn(install.binary, args, {
        cwd: install.root,
        stdio: ["ignore", log, log],
        windowsHide: true,
      });
    } catch (error) {
      closeSync(log);
      this.failedAt = Date.now();
      this.options.logger.warn("could not start the jevos server", String(error));
      return null;
    } finally {
      closeSync(log);
    }
    this.child = child;

    const ready = await waitForHealth(
      port,
      this.options.startupTimeoutMs,
      this.options.probeTimeoutMs,
    );
    if (!ready) {
      this.failedAt = Date.now();
      this.options.logger.warn(
        "the jevos server did not answer",
        `see ${this.options.logPath}`,
      );
      await this.stop();
      return null;
    }

    this.options.logger.info("the jevos server is ready", { port });
    return this.attach(port);
  }

  private attach(port: number): string {
    this.base = `http://127.0.0.1:${port}`;
    this.lastUse = Date.now();
    if (this.timer === null) {
      this.timer = setInterval(() => this.expire(), IDLE_CHECK_MS);
      this.timer.unref?.();
    }
    return this.base;
  }

  private expire(): void {
    if (this.base === null) return;
    if (Date.now() - this.lastUse < this.options.idleMs) return;
    this.options.logger.info("stopping the idle jevos server");
    void this.stop();
  }
}

async function healthy(port: number, timeoutMs: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return false;
    const body = (await response.json()) as { status?: unknown; model_files?: unknown };
    return body.status === "ready" && typeof body.model_files === "object";
  } catch {
    return false;
  }
}

async function waitForHealth(
  port: number,
  timeoutMs: number,
  probeTimeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await healthy(port, probeTimeoutMs)) return true;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

/** First free loopback port in the server's range, skipping `taken`. */
async function freePort(taken: number | null): Promise<number | null> {
  for (let port = FIRST_PORT; port <= LAST_PORT; port += 1) {
    if (port === taken) continue;
    if (await portFree(port)) return port;
  }
  return null;
}

function portFree(port: number): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const server = createServer();
    server.once("error", () => resolvePromise(false));
    server.listen(port, "127.0.0.1", () => {
      server.close(() => resolvePromise(true));
    });
  });
}
