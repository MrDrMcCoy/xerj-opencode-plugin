// Node lifecycle for one project: attach when that project's node already
// answers, otherwise spawn one detached so the index survives plugin reloads.
// Verified on v1.0.0-rc.100: `--port` claims PORT, PORT+1 (native REST) and
// PORT+2 (gRPC), and startup fails if any is taken.

import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import {
  mkdir,
  open,
  readFile,
  readdir,
  readlink,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { connect } from "node:net";
import { join, dirname } from "node:path";
import { promisify } from "node:util";
import type { Logger } from "../log.ts";
import {
  nodeDataDir,
  nodeLogPath,
  nodePidPath,
  nodePortPath,
} from "../paths.ts";
import { rotateNodeLog } from "./log-file.ts";
import {
  applyCpuAffinity,
  applyPriority,
  type CpuSpec,
  type Priority,
} from "./priority.ts";

export type NodeState = "xerj" | "foreign" | "down";

/** Passed as `--embed-mode`; the node fixes it at startup and never re-embeds. */
export enum EmbedMode {
  Neural = "neural",
  Lexical = "lexical",
}

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
  /** This project's node directory; its port, pid and data dir live inside. */
  readonly nodeDir: string;
  /** Working directory for the spawned process. */
  readonly projectRoot: string;
  readonly dataDir?: string | null;
  /** Shared lock covering port selection and spawn across all projects. */
  readonly portLockPath?: string;
  readonly preferredPort: number;
  readonly persistedPort: number | null;
  readonly onPort?: (port: number) => Promise<void>;
  readonly logger: Logger;
  readonly explicitUrl?: string | null;
  /** How long a spawn waits for the node to answer. */
  readonly startupTimeoutMs?: number;
  /** Deadline for one health probe. */
  readonly probeTimeoutMs?: number;
  readonly embedMode?: EmbedMode;
  /** Size at which the node log is rotated aside; 0 disables it. */
  readonly logMaxBytes?: number;
  /** CPU and I/O priority for the spawned process; omitted leaves it alone. */
  readonly priority?: Priority;
  /** CPU set for the spawned process; null or omitted leaves affinity alone. */
  readonly cpus?: CpuSpec | null;
}

/** What the pidfile and port file say, without trusting either. */
export interface NodeDetection {
  readonly running: boolean;
  readonly port: number | null;
  readonly pid: number | null;
  readonly state: NodeState;
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
const PORT_LOCK_POLL_MS = 100;
const DEFAULT_PROBE_TIMEOUT_MS = 800;
const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;

/** Identifies a node by `GET /`, so an Elasticsearch on 9200 is not mistaken for XERJ. */
export async function probeNode(
  baseUrl: string,
  timeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
): Promise<NodeState> {
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
  const probeTimeoutMs = options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const startupTimeoutMs =
    options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;

  if (options.explicitUrl) {
    const url = options.explicitUrl.replace(/\/+$/, "");
    if ((await probeNode(url, probeTimeoutMs)) !== "xerj") {
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

  const dataDir = options.dataDir ?? nodeDataDir(options.nodeDir);
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  // The port, pid, lock and log live here; a first run must create it.
  await mkdir(options.nodeDir, { recursive: true, mode: 0o700 });

  // Only this project's recorded port is a candidate. Scanning would attach to
  // a node another project owns, and then one idle shutdown would kill it.
  const candidate = options.persistedPort ?? options.preferredPort;
  const storedPid = await readNodePid(options.nodeDir);
  // Attaching is only safe when the port is proven to belong to this project's
  // recorded process. Another project may legitimately hold this port after
  // our node stopped, and adopting it would read that project's corpus and then
  // kill its node on our next idle shutdown.
  const detected =
    options.persistedPort !== null &&
    (await ownsNodeAt(options.persistedPort, storedPid))
      ? await attach(
          options.persistedPort,
          options.binaryVersion,
          storedPid,
          probeTimeoutMs,
        )
      : null;
  if (detected) return detected;

  // Port selection and spawn are shared resources across every project in this
  // data root, so they take one lock there. Per-project locking would still let
  // two first starts race onto the same free port and share one node.
  const portLock = options.portLockPath ?? join(dirname(options.nodeDir), ".port-lock");
  if (!(await acquirePortLock(portLock, startupTimeoutMs))) {
    throw new NodeError("another process is starting a XERJ node and did not let go");
  }

  try {
    const storedPidAgain = await readNodePid(options.nodeDir);
    const adopted =
      options.persistedPort !== null &&
      (await ownsNodeAt(options.persistedPort, storedPidAgain))
        ? await attach(
            options.persistedPort,
            options.binaryVersion,
            storedPidAgain,
            probeTimeoutMs,
          )
        : null;
    if (adopted) return adopted;

    const chosen = await choosePort(candidate);
    if (chosen === null) {
      throw new NodeError(
        `no free port for XERJ between ${PORT_SCAN_START} and ${PORT_SCAN_END}`,
      );
    }

    const second = await attach(
      chosen,
      options.binaryVersion,
      storedPidAgain,
      probeTimeoutMs,
    );
    if (second) {
      await options.onPort?.(chosen);
      return second;
    }

    const pid = await spawnNode(
      options.binaryPath,
      dataDir,
      chosen,
      options.projectRoot,
      options.nodeDir,
      options.embedMode ?? EmbedMode.Neural,
      options.priority,
      options.cpus,
      options.logMaxBytes ?? 0,
      logger,
    );
    await options.onPort?.(chosen);

    const node = await waitForNode(
      chosen,
      startupTimeoutMs,
      options.binaryVersion,
      probeTimeoutMs,
    );
    if (!node) {
      const seconds = Math.round(startupTimeoutMs / 1000);
      throw new NodeError(
        `xerj did not answer on port ${chosen} within ${seconds}s`,
      );
    }

    await writeFile(nodePidPath(options.nodeDir), String(pid), { mode: 0o600 }).catch(() => {});
    logger.info("started the xerj node", { port: chosen, pid });
    return { ...node, pid, spawned: true };
  } finally {
    await rm(portLock, { recursive: true, force: true }).catch(() => {});
  }
}

async function attach(
  port: number,
  binaryVersion: string,
  pid: number | null,
  probeTimeoutMs: number,
): Promise<NodeHandle | null> {
  const baseUrl = `http://127.0.0.1:${port}`;
  if ((await probeNode(baseUrl, probeTimeoutMs)) !== "xerj") return null;

  return {
    baseUrl,
    port,
    pid,
    spawned: false,
    version: binaryVersion,
  };
}

async function waitForNode(
  port: number,
  timeoutMs: number,
  binaryVersion: string,
  probeTimeoutMs: number,
): Promise<NodeHandle | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = await attach(port, binaryVersion, null, probeTimeoutMs);
    if (found) return found;
    await sleep(HEALTH_POLL_MS);
  }
  return null;
}

/** A base port is usable only when PORT, PORT+1 and PORT+2 are all free. */
async function choosePort(preferred: number): Promise<number | null> {
  // An explicitly configured port outside the default range is still honoured
  // when it is free; the range only bounds automatic scanning.
  if (preferred >= 1024 && preferred + 2 <= 65_535 && (await portTripleFree(preferred))) {
    return preferred;
  }

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
  projectRoot: string,
  nodeDir: string,
  embedMode: EmbedMode,
  priority: Priority | undefined,
  cpus: CpuSpec | null | undefined,
  logMaxBytes: number,
  logger: Logger,
): Promise<number> {
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  await mkdir(nodeDir, { recursive: true, mode: 0o700 });

  // The node never rotates its own log, so bound it before it grows.
  await rotateNodeLog(nodeDir, logMaxBytes);

  const log = await open(nodeLogPath(nodeDir), "a", 0o600);
  const child = spawn(
    binary,
    [
      "--insecure",
      "--port",
      String(port),
      "--data-dir",
      dataDir,
      "--disable-feedback",
      "--embed-mode",
      embedMode,
    ],
    {
      detached: true,
      cwd: projectRoot,
      stdio: ["ignore", log.fd, log.fd],
      env: { ...process.env, XERJ_DISABLE_FEEDBACK: "true" },
    },
  );

  child.unref();
  await log.close().catch(() => {});
  if (child.pid === undefined) throw new NodeError("xerj exited before it had a pid");

  // Priority and affinity are best effort and never block startup.
  if (priority !== undefined) {
    await applyPriority({ pid: child.pid, priority, logger });
  }
  if (cpus !== null && cpus !== undefined) {
    await applyCpuAffinity({ pid: child.pid, spec: cpus, logger });
  }
  return child.pid;
}

/** Retries the spawn lock so a concurrent project's start is waited out. */
async function acquirePortLock(path: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await acquireLock(path)) return true;
    await sleep(PORT_LOCK_POLL_MS);
  }
  return false;
}

/** `mkdir` is the atomic primitive; a lock older than a minute is stale. */
async function acquireLock(path: string): Promise<boolean> {
  try {
    // The lock lives beside the project node directories, which may not exist
    // on a first run in a fresh storage root.
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
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

export async function readPersistedPort(nodeDir: string): Promise<number | null> {
  const raw = await readFile(nodePortPath(nodeDir), "utf8").catch(() => null);
  if (raw === null) return null;
  const port = Number(raw.trim());
  return Number.isInteger(port) && port > 0 && port < 65_536 ? port : null;
}

export async function persistPort(nodeDir: string, port: number): Promise<void> {
  await mkdir(nodeDir, { recursive: true, mode: 0o700 });
  await writeFile(nodePortPath(nodeDir), String(port), { mode: 0o600 });
}

/** Reads the pidfile without signalling anything. */
export async function readNodePid(nodeDir: string): Promise<number | null> {
  const raw = await readFile(nodePidPath(nodeDir), "utf8").catch(() => null);
  if (raw === null) return null;
  const pid = Number(raw.trim());
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

/**
 * Reports whether this project's node is up. The port file and pidfile say what
 * was started; `GET /` is the only proof it still answers.
 */
export async function detectNode(
  nodeDir: string,
  probeTimeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
): Promise<NodeDetection> {
  const port = await readPersistedPort(nodeDir);
  const pid = await readNodePid(nodeDir);
  if (port === null) return { running: false, port: null, pid, state: "down" };

  if (!(await ownsNodeAt(port, pid))) return { running: false, port, pid, state: "down" };

  const state = await probeNode(`http://127.0.0.1:${port}`, probeTimeoutMs);
  return { running: state === "xerj", port, pid, state };
}

/**
 * True when the process listening on `port` is the one in this project's
 * pidfile. Where the port owner cannot be read, a live recorded pid is the best
 * available evidence; a mismatched owner is decisive.
 */
export async function ownsNodeAt(
  port: number,
  storedPid: number | null,
): Promise<boolean> {
  if (storedPid === null) return false;

  const owner = await portOwnerPid(port);
  return owner === null ? isAlive(storedPid) : owner === storedPid;
}

/**
 * Best-effort pid of the process listening on a local TCP port. Returns null
 * when the platform offers no cheap lookup (or the port is not listening), in
 * which case callers fall back to pid liveness.
 */
export async function portOwnerPid(port: number): Promise<number | null> {
  if (process.platform === "linux") return linuxPortOwner(port);
  if (process.platform === "darwin") return darwinPortOwner(port);
  return null;
}

/**
 * Socket inodes listening on `port`, read from a `/proc/net/tcp` table. Pure
 * so the parser can be tested on any platform without that platform's /proc.
 */
export function portOwnerInodes(table: string, port: number): Set<string> {
  const inodes = new Set<string>();
  const suffix = `:${portHex(port)}`;

  for (const row of table.split("\n").slice(1)) {
    const fields = row.trim().split(/\s+/);
    if (fields.length < 10) continue;
    const local = fields[1] ?? "";
    // "0A" is LISTEN; the local address ends with the port in uppercase hex.
    if (fields[3] !== "0A" || !local.toUpperCase().endsWith(suffix)) continue;
    inodes.add(fields[9] ?? "");
  }

  return inodes;
}

async function linuxPortOwner(port: number): Promise<number | null> {
  const inodes = new Set<string>();

  for (const file of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    const table = await readFile(file, "utf8").catch(() => null);
    if (table === null) continue;
    for (const inode of portOwnerInodes(table, port)) inodes.add(inode);
  }

  if (inodes.size === 0) return null;

  const pids = await readdir("/proc").catch(() => [] as string[]);
  for (const entry of pids) {
    if (!/^\d+$/.test(entry)) continue;
    const fds = await readdir(`/proc/${entry}/fd`).catch(() => [] as string[]);

    for (const fd of fds) {
      const target = await readlink(`/proc/${entry}/fd/${fd}`).catch(() => null);
      if (target === null || !target.startsWith("socket:[")) continue;
      if (inodes.has(target.slice(8, -1))) return Number(entry);
    }
  }

  return null;
}

/** First pid in `lsof -t` output, or null when the list is empty or unusable. */
export function firstPidOf(output: string): number | null {
  const pid = Number(output.trim().split("\n")[0]);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function darwinPortOwner(port: number): Promise<number | null> {
  return promisify(execFile)("lsof", [
    "-nP",
    `-iTCP:${port}`,
    "-sTCP:LISTEN",
    "-t",
  ])
    .then(({ stdout }) => firstPidOf(stdout))
    .catch(() => null);
}

function portHex(port: number): string {
  return port.toString(16).toUpperCase().padStart(4, "0");
}

export async function stopNode(nodeDir: string, graceMs = 5_000): Promise<boolean> {
  const pid = await readNodePid(nodeDir);
  if (pid === null) return false;

  // The pidfile is written only after the node answers, so a missing listener
  // (or a different owner) means the pid is stale and the kernel may have
  // reused it. Signalling that pid could hit an unrelated process. On Windows
  // the port owner cannot be read, so the pidfile stays the best evidence.
  const port = await readPersistedPort(nodeDir);
  if (port !== null && process.platform !== "win32") {
    const owner = await portOwnerPid(port);
    if (owner !== pid) {
      await rm(nodePidPath(nodeDir), { force: true }).catch(() => {});
      return false;
    }
  }

  if (!isAlive(pid)) {
    await rm(nodePidPath(nodeDir), { force: true }).catch(() => {});
    return false;
  }

  try {
    process.kill(pid, "SIGTERM");
  } catch {
    await rm(nodePidPath(nodeDir), { force: true }).catch(() => {});
    return false;
  }

  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline && isAlive(pid)) {
    await sleep(100);
  }
  if (isAlive(pid)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone between the check and the signal.
    }
  }

  await rm(nodePidPath(nodeDir), { force: true }).catch(() => {});
  return true;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
