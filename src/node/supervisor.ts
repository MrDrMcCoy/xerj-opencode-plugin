// Node lifecycle: attach when a XERJ node already answers, otherwise spawn one
// detached so it outlives the OpenCode server and the index survives restarts.
// Verified on v1.0.0-rc.100: `--port` claims PORT, PORT+1 (native REST) and
// PORT+2 (gRPC), and startup fails if any is taken.

import { spawn } from "node:child_process";
import { mkdir, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { join } from "node:path";
import type { Logger } from "../log.ts";
import { nodeDataDir, nodeLogPath, nodePidPath } from "../paths.ts";

export type NodeState = "xerj" | "foreign" | "down";

export interface NodeHandle {
  readonly baseUrl: string;
  readonly port: number;
  readonly pid: number | null;
  readonly spawned: boolean;
  readonly version: string;
}

export interface EnsureNodeOptions {
  readonly binaryPath: string;
  /** XERJ release the binary reports; the banner only carries the wire version. */
  readonly binaryVersion: string;
  readonly root: string;
  readonly dataDir?: string | null;
  readonly preferredPort: number;
  readonly persistedPort: number | null;
  readonly onPort?: (port: number) => Promise<void>;
  readonly logger: Logger;
  readonly explicitUrl?: string | null;
  readonly startupTimeoutMs?: number;
}

export class NodeError extends Error {
  constructor(message: string, override readonly cause?: unknown) {
    super(message);
    this.name = "NodeError";
  }
}

const PORT_SCAN_START = 9200;
const PORT_SCAN_END = 9399;
const PORT_STRIDE = 3;
const HEALTH_POLL_MS = 250;
const SPAWN_LOCK_MS = 60_000;

/** Identifies a node by `GET /`, so an Elasticsearch on 9200 is not mistaken for XERJ. */
export async function probeNode(baseUrl: string, timeoutMs = 800): Promise<NodeState> {
  try {
    const response = await fetch(`${baseUrl}/`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return "foreign";

    const body = await response.json().catch(() => null);
    if (isRecord(body) && body.cluster_name === "xerj") return "xerj";
    return "foreign";
  } catch {
    return "down";
  }
}

export async function ensureNode(options: EnsureNodeOptions): Promise<NodeHandle> {
  const { logger } = options;

  if (options.explicitUrl) {
    const url = options.explicitUrl.replace(/\/+$/, "");
    if ((await probeNode(url)) !== "xerj") {
      throw new NodeError(`XERJ is not answering at ${url}`);
    }
    return {
      baseUrl: url,
      port: Number(new URL(url).port || 9200),
      pid: null,
      spawned: false,
      version: options.binaryVersion,
    };
  }

  const dataDir = options.dataDir ?? nodeDataDir(options.root);
  await mkdir(dataDir, { recursive: true, mode: 0o700 });

  const candidate = options.persistedPort ?? options.preferredPort;
  const attached = await attach(candidate, options.binaryVersion);
  if (attached) return attached;

  const port = await choosePort(candidate);
  if (port === null) {
    throw new NodeError(`no free port for XERJ between ${PORT_SCAN_START} and ${PORT_SCAN_END}`);
  }

  const lock = join(dataDir, ".spawn-lock");
  if (!(await acquireLock(lock))) {
    // Another process is spawning; wait for it rather than starting a second node.
    const existing = await waitForNode(port, options.startupTimeoutMs ?? 30_000, options.binaryVersion);
    if (existing) return existing;
    throw new NodeError("another process is starting the XERJ node and it did not come up");
  }

  try {
    const second = await attach(port, options.binaryVersion);
    if (second) return second;

    const pid = await spawnNode(options.binaryPath, dataDir, port, options.root);
    await options.onPort?.(port);

    const node = await waitForNode(port, options.startupTimeoutMs ?? 30_000, options.binaryVersion);
    if (!node) {
      throw new NodeError(`xerj did not answer on port ${port} within 30s`);
    }

    await writeFile(nodePidPath(options.root), String(pid), { mode: 0o600 }).catch(() => {});
    logger.info("started the xerj node", { port, pid });
    return { ...node, pid, spawned: true };
  } finally {
    await rm(lock, { recursive: true, force: true }).catch(() => {});
  }
}

async function attach(port: number, binaryVersion: string): Promise<NodeHandle | null> {
  const baseUrl = `http://127.0.0.1:${port}`;
  if ((await probeNode(baseUrl)) !== "xerj") return null;

  return {
    baseUrl,
    port,
    pid: null,
    spawned: false,
    version: binaryVersion,
  };
}

async function waitForNode(
  port: number,
  timeoutMs: number,
  binaryVersion: string,
): Promise<NodeHandle | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = await attach(port, binaryVersion);
    if (found) return found;
    await sleep(HEALTH_POLL_MS);
  }
  return null;
}

/** A base port is usable only when PORT, PORT+1 and PORT+2 are all free. */
async function choosePort(preferred: number): Promise<number | null> {
  if (preferred >= PORT_SCAN_START && (await portTripleFree(preferred))) return preferred;

  const start = Math.max(PORT_SCAN_START, Math.ceil(preferred / PORT_STRIDE) * PORT_STRIDE);
  for (let port = start; port + 2 <= PORT_SCAN_END; port += PORT_STRIDE) {
    if (await portTripleFree(port)) return port;
  }

  for (let port = PORT_SCAN_START; port + 2 <= PORT_SCAN_END; port += PORT_STRIDE) {
    if (await portTripleFree(port)) return port;
  }

  return null;
}

async function portTripleFree(base: number): Promise<boolean> {
  for (let offset = 0; offset < 3; offset++) {
    if (!(await portFree(base + offset))) return false;
  }
  return true;
}

function portFree(port: number): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const socket = connect({ host: "127.0.0.1", port });
    const finish = (free: boolean): void => {
      socket.destroy();
      resolvePromise(free);
    };

    socket.setTimeout(400);
    socket.once("connect", () => finish(false));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(true));
  });
}

async function spawnNode(
  binary: string,
  dataDir: string,
  port: number,
  root: string,
): Promise<number> {
  await mkdir(dataDir, { recursive: true, mode: 0o700 });

  const log = await open(nodeLogPath(root), "a", 0o600);
  const child = spawn(
    binary,
    [
      "--insecure",
      "--port",
      String(port),
      "--data-dir",
      dataDir,
      "--disable-feedback",
    ],
    {
      detached: true,
      stdio: ["ignore", log.fd, log.fd],
      env: { ...process.env, XERJ_DISABLE_FEEDBACK: "true" },
    },
  );

  child.unref();
  await log.close().catch(() => {});
  if (child.pid === undefined) throw new NodeError("xerj exited before it had a pid");
  return child.pid;
}

/** `mkdir` is the atomic primitive; a lock older than a minute is stale. */
async function acquireLock(path: string): Promise<boolean> {
  try {
    await mkdir(path, { recursive: false });
    return true;
  } catch {
    const info = await stat(path).catch(() => null);
    if (info && Date.now() - info.mtimeMs > SPAWN_LOCK_MS) {
      await rm(path, { recursive: true, force: true }).catch(() => {});
      return acquireLock(path);
    }
    return false;
  }
}

export async function readPersistedPort(root: string): Promise<number | null> {
  const raw = await readFile(join(nodeDataDir(root), "port"), "utf8").catch(() => null);
  if (raw === null) return null;
  const port = Number(raw.trim());
  return Number.isInteger(port) && port > 0 && port < 65_536 ? port : null;
}

export async function persistPort(root: string, port: number): Promise<void> {
  await mkdir(nodeDataDir(root), { recursive: true, mode: 0o700 });
  await writeFile(join(nodeDataDir(root), "port"), String(port), { mode: 0o600 });
}

export async function stopNode(root: string): Promise<boolean> {
  const pid = Number(await readFile(nodePidPath(root), "utf8").catch(() => ""));
  if (!Number.isInteger(pid) || pid <= 0) return false;

  try {
    process.kill(pid, "SIGTERM");
    await rm(nodePidPath(root), { force: true });
    return true;
  } catch {
    await rm(nodePidPath(root), { force: true }).catch(() => {});
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
