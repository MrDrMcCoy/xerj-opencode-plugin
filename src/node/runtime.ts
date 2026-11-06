// One project's node handle, kept across stop/start cycles. The client calls
// `ensure()` before every request: a running node returns immediately, a
// stopped one is spawned (or attached when it is already up), so an idle
// shutdown costs nothing until something actually asks for the index.

import type { InstalledBinary } from "../binary/manager.ts";
import type { Logger } from "../log.ts";
import { nodeDataDir } from "../paths.ts";
import {
  detectNode,
  EmbedMode,
  ensureNode,
  NodeError,
  persistPort,
  readPersistedPort,
  stopNode,
  type NodeDetection,
  type NodeHandle,
} from "./supervisor.ts";
import type { Priority } from "./priority.ts";

export type RuntimeNodeState = "stopped" | "starting" | "running" | "error";

export interface NodeRuntimeOptions {
  /** This project's node directory (port, pid, data dir, log). */
  readonly nodeDir: string;
  readonly projectRoot: string;
  readonly preferredPort: number;
  readonly dataDir: string | null;
  /** Global lock covering port selection and spawn for every project. */
  readonly portLockPath: string;
  /** Attach to this URL and never spawn or stop anything. */
  readonly explicitUrl: string | null;
  readonly embedMode: EmbedMode;
  /** Size at which the node log is rotated aside; 0 disables it. */
  readonly logMaxBytes?: number;
  /** CPU and I/O priority for a spawned node; omitted leaves it alone. */
  readonly priority?: Priority;
  readonly logger: Logger;
  readonly binary: () => InstalledBinary | null;
  readonly onSpawned?: () => void;
  /** Runs after every successful start, including a restart from idle. */
  readonly onStart?: (handle: NodeHandle) => void | Promise<void>;
}

export class NodeRuntime {
  private handle: NodeHandle | null = null;
  private pending: Promise<NodeHandle> | null = null;
  private state: RuntimeNodeState = "stopped";
  private lastError: string | null = null;

  constructor(private readonly options: NodeRuntimeOptions) {}

  get current(): NodeHandle | null {
    return this.handle;
  }

  get snapshot(): {
    readonly state: RuntimeNodeState;
    readonly lastError: string | null;
  } {
    return { state: this.state, lastError: this.lastError };
  }

  /** Cheap when the node is up: no probe, no filesystem work. */
  async ensure(): Promise<NodeHandle> {
    if (this.handle) return this.handle;
    if (this.pending) return this.pending;

    this.pending = this.start().finally(() => {
      this.pending = null;
    });
    return this.pending;
  }

  /** Drops the cached handle after a transport failure so the next call probes. */
  invalidate(): void {
    this.handle = null;
    this.state = "stopped";
  }

  /** Probes this project's recorded node without starting one. */
  async detect(): Promise<NodeDetection> {
    if (this.handle) {
      return {
        running: true,
        port: this.handle.port,
        pid: this.handle.pid,
        state: "xerj",
      };
    }
    return detectNode(this.options.nodeDir);
  }

  async stop(reason: string): Promise<boolean> {
    const handle = this.handle;
    this.handle = null;
    this.state = "stopped";

    // An explicitly configured URL belongs to somebody else; never kill it.
    if (this.options.explicitUrl) return false;

    const stopped = await stopNode(this.options.nodeDir);
    this.options.logger.info(
      stopped ? "stopped the xerj node" : "xerj node was already stopped",
      { reason, port: handle?.port ?? null },
    );
    return stopped;
  }

  private async start(): Promise<NodeHandle> {
    const binary = this.options.binary();
    if (!binary) throw new NodeError("the xerj binary is not installed yet");

    this.state = "starting";
    try {
      const handle = await ensureNode({
        binaryPath: binary.path,
        binaryVersion: binary.version,
        nodeDir: this.options.nodeDir,
        projectRoot: this.options.projectRoot,
        dataDir: this.options.dataDir ?? nodeDataDir(this.options.nodeDir),
        portLockPath: this.options.portLockPath,
        preferredPort: this.options.preferredPort,
        persistedPort: await readPersistedPort(this.options.nodeDir),
        explicitUrl: this.options.explicitUrl,
        embedMode: this.options.embedMode,
        logMaxBytes: this.options.logMaxBytes,
        priority: this.options.priority,
        onPort: (port) => persistPort(this.options.nodeDir, port),
        logger: this.options.logger,
      });

      if (handle.spawned) this.options.onSpawned?.();
      this.handle = handle;
      this.state = "running";
      this.lastError = null;
      await this.options.onStart?.(handle);
      return handle;
    } catch (error) {
      this.state = "error";
      this.lastError = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }
}
