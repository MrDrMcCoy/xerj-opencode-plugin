// Project session activity and idle shutdown.
//
// OpenCode gives no reliable "all sessions closed" signal, and several server
// processes can hold the same project. So the node is kept alive by activity:
// every prompt, tool call and RPC touch resets a deadline, and when nothing has
// touched the project for `idleMs` the node stops. Processes announce
// themselves with a heartbeat file, so the last one to go idle cannot kill the
// node out from under a peer that is still answering requests.

import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Logger } from "./log.ts";
import { nodeClientsDir } from "./paths.ts";

export interface ProjectLifecycleOptions {
  readonly nodeDir: string;
  readonly idleMs: number;
  readonly enabled: boolean;
  readonly logger: Logger;
  /** Stops the indexers and the node; must be idempotent. */
  readonly onIdle: () => Promise<void>;
  /** Overrides the idle check interval; tests use this to avoid a 5 s wait. */
  readonly checkMs?: number;
}

export interface LifecycleSnapshot {
  readonly enabled: boolean;
  readonly idleMs: number;
  readonly lastActivityAt: number;
  /** Epoch millis when the node will be stopped, or null when disabled. */
  readonly idleAt: number | null;
  readonly sessions: number;
  readonly peers: number;
}

const HEARTBEAT_MS = 15_000;
/** A heartbeat older than this belongs to a dead process. */
const HEARTBEAT_STALE_MS = 90_000;
const MIN_CHECK_MS = 5_000;
const MAX_CHECK_MS = 60_000;

export class ProjectLifecycle {
  // One plugin instance per open location, so a process can host several of
  // these. The id is per instance, not per process, or they would overwrite
  // each other's heartbeat and each see no peers.
  private readonly instanceId = `${process.pid}-${randomUUID().slice(0, 8)}`;
  private lastActivityAt = Date.now();
  private readonly sessions = new Map<string, number>();
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private checker: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private idleRunning = false;

  constructor(private readonly options: ProjectLifecycleOptions) {}

  start(): void {
    if (!this.options.enabled || this.stopped) return;

    void this.writeHeartbeat();
    this.heartbeat = setInterval(() => void this.writeHeartbeat(), HEARTBEAT_MS);

    const interval =
      this.options.checkMs ??
      Math.min(Math.max(Math.round(this.options.idleMs / 4), MIN_CHECK_MS), MAX_CHECK_MS);
    this.checker = setInterval(() => void this.checkIdle(), interval);
  }

  /** Records activity for a session; the node stays up while this is fresh. */
  touch(sessionID?: string): void {
    this.lastActivityAt = Date.now();
    if (sessionID) this.sessions.set(sessionID, this.lastActivityAt);
    this.pruneSessions();
  }

  snapshot(peers = 0): LifecycleSnapshot {
    this.pruneSessions();
    return {
      enabled: this.options.enabled,
      idleMs: this.options.idleMs,
      lastActivityAt: this.lastActivityAt,
      idleAt: this.options.enabled ? this.lastActivityAt + this.options.idleMs : null,
      sessions: this.sessions.size,
      peers,
    };
  }

  /** Counts live peer processes; excludes this one. */
  async peers(): Promise<number> {
    const directory = nodeClientsDir(this.options.nodeDir);
    const entries = await readdir(directory).catch(() => [] as string[]);
    const now = Date.now();
    let live = 0;

    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      if (entry === this.heartbeatName()) continue;

      const info = await stat(join(directory, entry)).catch(() => null);
      if (!info || now - info.mtimeMs > HEARTBEAT_STALE_MS) continue;

      const body = await readFile(join(directory, entry), "utf8").catch(() => null);
      const pid = body === null ? null : readPid(body);
      if (pid !== null && !heartbeatAlive(pid)) continue;
      live += 1;
    }

    return live;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.checker) clearInterval(this.checker);
    this.heartbeat = null;
    this.checker = null;
    await rm(join(nodeClientsDir(this.options.nodeDir), this.heartbeatName()), {
      force: true,
    }).catch(() => {});
  }

  /**
   * Drops a closed session. When it was the last known one, the node has no
   * user left and stops now instead of waiting out the idle period.
   */
  async closeSession(sessionID: string): Promise<boolean> {
    this.sessions.delete(sessionID);
    if (this.sessions.size > 0) return false;
    return this.shutdownIfUnused("last session closed");
  }

  private async checkIdle(): Promise<void> {
    if (this.stopped || this.idleRunning) return;
    if (Date.now() - this.lastActivityAt < this.options.idleMs) return;
    await this.shutdownIfUnused("idle");
  }

  /** Stops the node unless a peer process is still serving this project. */
  private async shutdownIfUnused(reason: string): Promise<boolean> {
    if (this.stopped || !this.options.enabled || this.idleRunning) return false;

    this.idleRunning = true;
    try {
      if ((await this.peers()) > 0) {
        // Another OpenCode process is still serving this project. It owns its
        // own deadline; stopping here would break its next request.
        this.lastActivityAt = Date.now();
        return false;
      }

      this.options.logger.info("stopping the xerj node", { reason });
      await this.options.onIdle();
      return true;
    } catch (error) {
      this.options.logger.warn("idle shutdown failed", String(error));
      return false;
    } finally {
      this.idleRunning = false;
    }
  }

  private async writeHeartbeat(): Promise<void> {
    if (this.stopped) return;
    const directory = nodeClientsDir(this.options.nodeDir);
    await mkdir(directory, { recursive: true, mode: 0o700 }).catch(() => {});

    const body = JSON.stringify({
      pid: process.pid,
      updatedAt: Date.now(),
    });
    await writeFile(join(directory, this.heartbeatName()), body, { mode: 0o600 }).catch(
      () => {},
    );
  }

  private heartbeatName(): string {
    return `${this.instanceId}.json`;
  }

  private pruneSessions(): void {
    const cutoff = this.lastActivityAt - this.options.idleMs;
    for (const [id, at] of this.sessions) {
      if (at < cutoff) this.sessions.delete(id);
    }
  }
}

/** Reads the heartbeat files without owning a lifecycle (used by tests/tools). */
export async function readPeerHeartbeats(nodeDir: string): Promise<string[]> {
  const directory = nodeClientsDir(nodeDir);
  return readdir(directory).catch(() => [] as string[]);
}

/** True when the pid in a heartbeat file is still alive. */
export function heartbeatAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readPid(body: string): number | null {
  try {
    const value = JSON.parse(body) as { pid?: unknown };
    return typeof value.pid === "number" && Number.isInteger(value.pid)
      ? value.pid
      : null;
  } catch {
    return null;
  }
}

type SessionDeleted = "session.deleted";

interface SessionEvents {
  subscribe(options?: {
    readonly types?: ReadonlyArray<SessionDeleted>;
    readonly signal?: AbortSignal;
  }): AsyncIterable<unknown>;
}

/**
 * Watches `session.deleted` so the node stops when this project's last session
 * goes away, rather than only when its idle timer elapses. Returns immediately;
 * the subscription ends when `signal` aborts.
 */
export function startSessionTracking(
  events: SessionEvents,
  lifecycle: ProjectLifecycle,
  signal: AbortSignal,
  logger: Logger,
): void {
  void (async () => {
    try {
      const source = events.subscribe({ types: ["session.deleted"], signal });
      for await (const raw of source) {
        if (typeof raw !== "object" || raw === null) continue;
        const event = raw as { type?: unknown; data?: unknown };
        if (event.type !== "session.deleted") continue;

        const data = event.data as { sessionID?: unknown } | undefined;
        const sessionID = typeof data?.sessionID === "string" ? data.sessionID : null;
        if (sessionID === null) continue;

        if (await lifecycle.closeSession(sessionID)) {
          logger.info("stopped the xerj node because the last session closed");
        }
      }
    } catch (error) {
      if (!signal.aborted) {
        logger.debug("session tracking stopped", String(error));
      }
    }
  })();
}
