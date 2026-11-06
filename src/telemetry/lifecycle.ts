// Boot, crash, and restart records. They share a boot id so a reader can replay
// one startup: how long setup took, when the node first answered, when the
// index became usable, and what died on the way.

import { stat } from "node:fs/promises";
import { readNodePid } from "../node/supervisor.ts";
import { nodePidPath } from "../paths.ts";
import type { Logger } from "../log.ts";
import { BOOT_AT, bootMs } from "./boot-clock.ts";
import type { TelemetryStore } from "./store.ts";

export interface BootTrackerOptions {
  readonly store: TelemetryStore;
  readonly bootId: string;
  readonly logger: Logger;
  /** Called once if the previous run left a marker behind. */
  readonly onCrashedBoot?: () => void;
}

/** A death the plugin did not ask for. */
export enum CrashKind {
  Plugin = "plugin",
  Node = "node",
  Watcher = "watcher",
}

export class BootTracker {
  private booted = false;
  private readyRecorded = false;
  private indexRecorded = false;

  constructor(private readonly options: BootTrackerOptions) {}

  get bootAt(): number {
    return BOOT_AT;
  }

  /**
   * Records this boot, then a crash left by an earlier process. The boot record
   * goes first so a reader never sees `ready` before the boot that caused it;
   * the marker is written before the scan so our own pid is found alive.
   */
  async start(
    meta: Readonly<Record<string, number | string | boolean | null>> = {},
  ): Promise<void> {
    if (this.booted) return;
    this.booted = true;

    try {
      this.options.store.record("lifecycle.boot", bootMs(), true, {
        bootId: this.options.bootId,
        bootAt: BOOT_AT,
        ...meta,
      });
      await this.options.store.writeMarker("setup");

      const crashed = await this.options.store.takeCrashedBoot();
      if (crashed === null) return;
      const at = Date.now() - crashed.at;
      this.options.store.record("lifecycle.crash", at, true, {
        bootId: crashed.bootId,
        bootAt: crashed.at,
        kind: CrashKind.Plugin,
        phase: crashed.phase,
        pid: crashed.pid,
      });
      this.options.onCrashedBoot?.();
    } catch (error) {
      this.options.logger.debug("could not record the boot", String(error));
    }
  }

  /** The node first answered; a later restart does not rewrite this figure. */
  async ready(
    meta: Readonly<Record<string, number | string | boolean | null>> = {},
  ): Promise<void> {
    if (this.readyRecorded) return;
    this.readyRecorded = true;
    await this.note("lifecycle.ready", "ready", meta);
  }

  /** The first corpus run document of this boot; recorded once. */
  async indexed(
    meta: Readonly<Record<string, number | string | boolean | null>> = {},
  ): Promise<void> {
    if (this.indexRecorded) return;
    this.indexRecorded = true;
    await this.note("lifecycle.indexed", "indexed", meta);
  }

  /** A death the plugin did not ask for. `uptimeMs` is how long it lived. */
  async crash(
    kind: CrashKind,
    uptimeMs: number,
    meta: Readonly<Record<string, number | string | boolean | null>> = {},
  ): Promise<void> {
    this.options.store.record("lifecycle.crash", uptimeMs, true, {
      bootId: this.options.bootId,
      bootAt: BOOT_AT,
      kind,
      ...meta,
    });
  }

  /** The service answers again; `afterMs` is time from the death. */
  async restart(
    reason: "crash" | "idle" | "manual",
    afterMs: number,
    meta: Readonly<Record<string, number | string | boolean | null>> = {},
  ): Promise<void> {
    this.options.store.record("lifecycle.restart", afterMs, true, {
      bootId: this.options.bootId,
      bootAt: BOOT_AT,
      reason,
      ...meta,
    });
  }

  /** Clean shutdown: the marker goes away, so the next start is not a crash. */
  async shutdown(): Promise<void> {
    await this.options.store.clearMarker();
  }

  private async note(
    op: "lifecycle.ready" | "lifecycle.indexed",
    phase: string,
    meta: Readonly<Record<string, number | string | boolean | null>>,
  ): Promise<void> {
    try {
      this.options.store.record(op, bootMs(), true, {
        bootId: this.options.bootId,
        bootAt: BOOT_AT,
        ...meta,
      });
      await this.options.store.writeMarker(phase);
    } catch (error) {
      this.options.logger.debug(
        "could not record a lifecycle milestone",
        String(error),
      );
    }
  }
}

/** Pids recorded as crashed, so a second ensure does not repeat the record. */
const recordedNodeCrashes = new Set<string>();

/**
 * A detached node produces no exit event, so a pidfile whose process is gone is
 * the only evidence it died. `stopNode` removes the pidfile on every path it
 * owns, so a surviving pidfile plus a dead pid is an unrequested death.
 */
export async function noteNodeCrash(
  store: TelemetryStore,
  nodeDir: string,
  logger: Logger,
): Promise<number | null> {
  const pid = await readNodePid(nodeDir).catch(() => null);
  if (pid === null || isAlive(pid)) return null;

  const key = `${nodeDir}:${pid}`;
  if (recordedNodeCrashes.has(key)) return null;
  recordedNodeCrashes.add(key);

  // The pidfile's age is the closest thing to an uptime: it is written once,
  // at spawn, and removed on every stop this plugin asks for.
  const written = await stat(nodePidPath(nodeDir)).catch(() => null);
  const uptime =
    written === null ? 0 : Math.max(0, Date.now() - written.mtimeMs);

  store.record("lifecycle.crash", uptime, true, {
    kind: CrashKind.Node,
    phase: "running",
    pid,
  });
  logger.debug("the xerj node died without being asked", { pid });
  return pid;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
