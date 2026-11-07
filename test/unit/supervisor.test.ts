import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EmbedMode,
  NodeError,
  detectNode,
  ensureNode,
  firstPidOf,
  ownsNodeAt,
  persistPort,
  portOwnerInodes,
  probeNode,
  readNodePid,
  readPersistedPort,
  stopNode,
  type NodeHandle,
} from "../../src/node/supervisor.ts";
import type { Logger } from "../../src/log.ts";
import { NodeRuntime } from "../../src/node/runtime.ts";

const logger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  entries: async () => [],
  flush: async () => {},
};

const realFetch = globalThis.fetch;

function stubFetch(
  behavior: (url: string) => Response | Promise<Response> = () =>
    Response.json({ cluster_name: "xerj" }),
): void {
  globalThis.fetch = ((url: string | URL) => behavior(String(url))) as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "xerj-sup-"));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true }).catch(() => {});
});

/** Writes an executable that answers `GET /` like a XERJ node on `--port`. */
async function writeFakeNode(): Promise<string> {
  const script = join(root, "fake-xerj");
  await writeFile(
    script,
    [
      "#!/usr/bin/env bun",
      "const portIndex = process.argv.indexOf('--port');",
      "const port = Number(process.argv[portIndex + 1]);",
      "Bun.serve({ port, fetch: () => Response.json({ cluster_name: 'xerj' }) });",
      // A test that forgets to stop its fake node must not leave it running.
      "setTimeout(() => process.exit(0), 30_000).unref?.();",
      "setInterval(() => {}, 10_000);",
      "",
    ].join("\n"),
  );
  await chmod(script, 0o755);
  return script;
}

/**
 * Answers the xerj banner only once the test flips its gate: before that,
 * every port must look down so no attach path can fire spuriously. Tests flip
 * the gate from the `onPort` callback, which runs right after the spawn.
 */
function stubGated(gate: { open: boolean }): void {
  stubFetch(() => {
    if (!gate.open) throw new TypeError("down");
    return Response.json({ cluster_name: "xerj" });
  });
}

describe("probeNode", () => {
  test("identifies xerj by cluster name", async () => {
    stubFetch();
    expect(await probeNode("http://127.0.0.1:9200")).toBe("xerj");
  });

  test("calls an other cluster foreign", async () => {
    stubFetch(() => Response.json({ cluster_name: "elasticsearch" }));
    expect(await probeNode("http://127.0.0.1:9200")).toBe("foreign");

    stubFetch(() => new Response("bad", { status: 500 }));
    expect(await probeNode("http://127.0.0.1:9200")).toBe("foreign");

    stubFetch(() => new Response("not json"));
    expect(await probeNode("http://127.0.0.1:9200")).toBe("foreign");
  });

  test("calls an unreachable node down", async () => {
    stubFetch(() => {
      throw new TypeError("fetch failed");
    });
    expect(await probeNode("http://127.0.0.1:9200")).toBe("down");
  });
});

describe("port and pid files", () => {
  test("round-trips a persisted port", async () => {
    const dir = join(root, "files");
    expect(await readPersistedPort(dir)).toBeNull();

    await persistPort(dir, 9231);
    expect(await readPersistedPort(dir)).toBe(9231);

    await writeFile(join(dir, "port"), "not-a-port");
    expect(await readPersistedPort(dir)).toBeNull();
  });

  test("round-trips the pid file", async () => {
    const dir = join(root, "files");
    expect(await readNodePid(dir)).toBeNull();

    await writeFile(join(dir, "node.pid"), "42");
    expect(await readNodePid(dir)).toBe(42);

    await writeFile(join(dir, "node.pid"), "zero\n");
    expect(await readNodePid(dir)).toBeNull();
  });
});

describe("ownership proof", () => {
  let server: ReturnType<typeof Bun.serve>;
  let port: number;

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      fetch: () => new Response("listening"),
    });
    port = server.port as number;
  });

  afterAll(() => {
    server.stop(true);
  });

  test("matches the pid listening on the port", async () => {
    expect(await ownsNodeAt(port, process.pid)).toBe(true);
    expect(await ownsNodeAt(port, 999_999_999)).toBe(false);
  });

  test("falls back to pid liveness when the port owner is unknown", async () => {
    // No listener on this port, so /proc gives no owner; a live recorded pid
    // is accepted, a dead one is not.
    expect(await ownsNodeAt(1, process.pid)).toBe(true);
    expect(await ownsNodeAt(1, 999_999_999)).toBe(false);
  });

  test("needs a stored pid", async () => {
    expect(await ownsNodeAt(port, null)).toBe(false);
  });
});

describe("detectNode", () => {
  test("reports down without a port file", async () => {
    const detection = await detectNode(join(root, "nope"));
    expect(detection).toEqual({ running: false, port: null, pid: null, state: "down" });
  });

  test("reports down when the recorded pid is dead", async () => {
    const dir = join(root, "dead");
    await mkdir(dir, { recursive: true });
    await persistPort(dir, 9299);
    await writeFile(join(dir, "node.pid"), "999999998");

    const detection = await detectNode(dir);
    expect(detection.running).toBe(false);
    expect(detection.state).toBe("down");
    expect(detection.port).toBe(9299);
  });

  test("reports a live node another process started", async () => {
    const dir = join(root, "live");
    await mkdir(dir, { recursive: true });
    await persistPort(dir, 9298);
    await writeFile(join(dir, "node.pid"), String(process.pid));
    stubFetch();

    const detection = await detectNode(dir);
    expect(detection).toMatchObject({ running: true, port: 9298, state: "xerj" });
  });
});

describe("stopNode", () => {
  test("is a no-op without a pid file", async () => {
    expect(await stopNode(join(root, "nothing"))).toBe(false);
  });

  test("clears the pid file of a dead node", async () => {
    const dir = join(root, "dead-stop");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "node.pid"), "999999997");
    expect(await stopNode(dir)).toBe(false);
    expect(await readNodePid(dir)).toBeNull();
  });

  test("terminates a live process and clears the pid file", async () => {
    const dir = join(root, "live-stop");
    await mkdir(dir, { recursive: true });
    const child = spawn("sleep", ["30"], { stdio: "ignore" });
    await writeFile(join(dir, "node.pid"), String(child.pid));

    expect(await stopNode(dir, 2_000)).toBe(true);
    expect(await readNodePid(dir)).toBeNull();
  });

  // A stale pidfile can name a pid the kernel has since reused. The port
  // owner is the proof that the pid is still the node; without it, a
  // teardown used to SIGTERM an unrelated process.
  test("does not signal a pid that no longer owns the port", async () => {
    const dir = join(root, "stale-stop");
    await mkdir(dir, { recursive: true });
    const server = Bun.serve({ port: 0, fetch: () => new Response("x") });
    const child = spawn("sleep", ["30"], { stdio: "ignore" });
    try {
      await persistPort(dir, server.port as number);
      await writeFile(join(dir, "node.pid"), String(child.pid));

      expect(await stopNode(dir, 500)).toBe(false);
      expect(() => process.kill(child.pid!, 0)).not.toThrow();
      expect(await readNodePid(dir)).toBeNull();
    } finally {
      server.stop(true);
      child.kill("SIGKILL");
    }
  });

  test("does not signal a pid when the port has no listener", async () => {
    const dir = join(root, "gone-stop");
    await mkdir(dir, { recursive: true });
    const child = spawn("sleep", ["30"], { stdio: "ignore" });
    try {
      // The pidfile is only written after the node answers, so a free port
      // means the recorded node is gone.
      await persistPort(dir, 9799);
      await writeFile(join(dir, "node.pid"), String(child.pid));

      expect(await stopNode(dir, 500)).toBe(false);
      expect(() => process.kill(child.pid!, 0)).not.toThrow();
      expect(await readNodePid(dir)).toBeNull();
    } finally {
      child.kill("SIGKILL");
    }
  });
});

describe("ensureNode", () => {
  test("attaches only to a node this project owns", async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response("listening") });
    const ownedPort = server.port as number;
    try {
      const dir = join(root, "attach");
      await mkdir(dir, { recursive: true });
      await persistPort(dir, ownedPort);
      await writeFile(join(dir, "node.pid"), String(process.pid));
      stubFetch();

      const handle = await ensureNode({
        binaryPath: "/unused",
        binaryVersion: "1.0.0-rc.100",
        nodeDir: dir,
        projectRoot: root,
        preferredPort: 9200,
        persistedPort: ownedPort,
        logger,
      });

      expect(handle).toMatchObject({
        baseUrl: `http://127.0.0.1:${ownedPort}`,
        port: ownedPort,
        pid: process.pid,
        spawned: false,
      });
    } finally {
      server.stop(true);
    }
  });

  test("refuses to adopt a foreign node on the persisted port", async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response("listening") });
    const foreignPort = server.port as number;
    try {
      const dir = join(root, "foreign");
      const script = await writeFakeNode();
      await mkdir(dir, { recursive: true });
      await persistPort(dir, foreignPort);
      // The pidfile names a dead process, so the port owner cannot be ours.
      await writeFile(join(dir, "node.pid"), "999999996");
      // The probe answers xerj only once this run has spawned its own node, so
      // a foreign port cannot be adopted by the post-lock re-check either.
      const gate = { open: false };
      stubGated(gate);

      const handle = await ensureNode({
        binaryPath: script,
        binaryVersion: "1.0.0-rc.100",
        nodeDir: dir,
        projectRoot: root,
        portLockPath: join(root, "nodes", ".port-lock-foreign"),
        preferredPort: 9200,
        persistedPort: foreignPort,
        onPort: async () => {
          gate.open = true;
        },
        logger,
      });

      expect(handle.port).not.toBe(foreignPort);
      expect(handle.pid).not.toBe(999999996);
      await stopNode(dir, 2_000);
    } finally {
      server.stop(true);
    }
  });

  test("fails when another process holds the spawn lock", async () => {
    const dir = join(root, "locked");
    const lock = join(root, "nodes", ".port-lock");
    await mkdir(lock, { recursive: true });

    await expect(
      ensureNode({
        binaryPath: "/unused",
        binaryVersion: "1.0.0-rc.100",
        nodeDir: dir,
        projectRoot: root,
        portLockPath: lock,
        preferredPort: 9200,
        persistedPort: null,
        startupTimeoutMs: 400,
        logger,
      }),
    ).rejects.toBeInstanceOf(NodeError);

    await rm(lock, { recursive: true, force: true });
  });

  test("spawns a node and reports its pid", async () => {
    const dir = join(root, "spawn");
    const script = await writeFakeNode();
    const gate = { open: false };
    stubGated(gate);

    const picked = { port: 0 };
    const handle: NodeHandle = await ensureNode({
      binaryPath: script,
      binaryVersion: "1.0.0-rc.100",
      nodeDir: dir,
      projectRoot: root,
      portLockPath: join(root, "nodes", ".port-lock-spawn"),
      preferredPort: 9200,
      persistedPort: null,
      onPort: async (port) => {
        gate.open = true;
        picked.port = port;
      },
      logger,
    });

    expect(handle.spawned).toBe(true);
    expect(handle.pid).toBeGreaterThan(0);
    expect(picked.port).toBe(handle.port);
    expect(await readNodePid(dir)).toBe(handle.pid);

    await stopNode(dir, 2_000);
  });

  test("attaches to an explicit url without spawning", async () => {
    stubFetch();
    const handle = await ensureNode({
      binaryPath: "/unused",
      binaryVersion: "1.0.0-rc.100",
      nodeDir: join(root, "explicit"),
      projectRoot: root,
      preferredPort: 9200,
      persistedPort: null,
      explicitUrl: "http://127.0.0.1:9400/",
      logger,
    });

    expect(handle).toMatchObject({
      baseUrl: "http://127.0.0.1:9400",
      pid: null,
      spawned: false,
    });
  });

  test("refuses an explicit url that is not xerj", async () => {
    stubFetch(() => Response.json({ cluster_name: "elasticsearch" }));
    await expect(
      ensureNode({
        binaryPath: "/unused",
        binaryVersion: "1.0.0-rc.100",
        nodeDir: join(root, "explicit-bad"),
        projectRoot: root,
        preferredPort: 9200,
        persistedPort: null,
        explicitUrl: "http://127.0.0.1:9401",
        logger,
      }),
    ).rejects.toBeInstanceOf(NodeError);
  });
});

describe("port owner parsers", () => {
  // Two listening sockets on 9200 and one on 9300, one established connection.
  const table = [
    "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
    "   0: 0100007F:23F0 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 11111 1",
    "   1: 00000000:23F0 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 22222 1",
    "   2: 0100007F:2454 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 33333 1",
    "   3: 0100007F:23F0 0100007F:9C40 01 00000000:00000000 00:00000000 00000000  1000        0 44444 1",
  ].join("\n");

  test("collects the listening inodes for one port", () => {
    expect([...portOwnerInodes(table, 9200)]).toEqual(["11111", "22222"]);
    expect([...portOwnerInodes(table, 9300)]).toEqual(["33333"]);
  });

  test("ignores established sockets and other ports", () => {
    expect(portOwnerInodes(table, 40000).size).toBe(0);
  });

  test("the first pid of an lsof list, or null", () => {
    expect(firstPidOf("4242\n4243\n")).toBe(4242);
    expect(firstPidOf("  7 ")).toBe(7);
    expect(firstPidOf("")).toBeNull();
    expect(firstPidOf("not-a-pid")).toBeNull();
  });
});

describe("stopNode escalation", () => {
  test("kills a process that ignores SIGTERM after the grace period", async () => {
    const dir = await mkdtemp(join(tmpdir(), "xerj-stop-"));
    // Ignore SIGTERM so only the SIGKILL path can end it. The `wait` keeps the
    // shell alive as its own process instead of exec'ing sleep, which would
    // drop the trap.
    const child = Bun.spawn(["sh", "-c", 'trap "" TERM; sleep 30 & wait'], {
      stdout: "ignore",
      stderr: "ignore",
    });
    await writeFile(join(dir, "node.pid"), String(child.pid));

    const started = Date.now();
    await stopNode(dir, 200);
    const elapsed = Date.now() - started;

    await Bun.sleep(100);
    let alive = true;
    try {
      process.kill(child.pid, 0);
    } catch {
      alive = false;
    }

    expect(alive).toBe(false);
    expect(elapsed).toBeGreaterThanOrEqual(100);
    await rm(dir, { recursive: true, force: true });
  });

  test("a process that exits on SIGTERM is not escalated", async () => {
    const dir = await mkdtemp(join(tmpdir(), "xerj-stop-"));
    const child = Bun.spawn(["sleep", "30"], { stdout: "ignore", stderr: "ignore" });
    await writeFile(join(dir, "node.pid"), String(child.pid));

    const started = Date.now();
    await stopNode(dir, 5_000);

    expect(Date.now() - started).toBeLessThan(2_000);
    await rm(dir, { recursive: true, force: true });
  });
});

describe("spawn lock and port choice", () => {
  test("a held lock that never releases fails with a clear message", async () => {
    const nodeDir = await mkdtemp(join(root, "locked-"));
    const globalRoot = await mkdtemp(join(root, "global-"));
    const lock = join(globalRoot, "nodes", ".port-lock");
    await mkdir(lock, { recursive: true });

    const binary = await writeFakeNode();

    await expect(
      ensureNode({
        binaryPath: binary,
        binaryVersion: "1.0.0-rc.101",
        nodeDir,
        dataDir: join(nodeDir, "data"),
        projectRoot: nodeDir,
        preferredPort: 9600,
        persistedPort: null,
        portLockPath: lock,
        startupTimeoutMs: 300,
        logger,
      }),
    ).rejects.toThrow(/did not let go/);

    await rm(nodeDir, { recursive: true, force: true });
    await rm(globalRoot, { recursive: true, force: true });
  });

  test("a stale lock is taken over", async () => {
    const nodeDir = await mkdtemp(join(root, "stale-"));
    const globalRoot = await mkdtemp(join(root, "global-"));
    const lock = join(globalRoot, "nodes", ".port-lock");
    await mkdir(lock, { recursive: true });
    // Older than the staleness window, so the lock counts as abandoned.
    const old = new Date(Date.now() - 120_000);
    const { utimes } = await import("node:fs/promises");
    await utimes(lock, old, old);

    const binary = await writeFakeNode();
    const handle = await ensureNode({
      binaryPath: binary,
      binaryVersion: "1.0.0-rc.101",
      nodeDir,
      dataDir: join(nodeDir, "data"),
      projectRoot: nodeDir,
      preferredPort: 9610,
      persistedPort: null,
      portLockPath: lock,
      startupTimeoutMs: 20_000,
      logger,
    });

    expect(handle.spawned).toBe(true);
    await stopNode(nodeDir, 200);
    await rm(nodeDir, { recursive: true, force: true });
    await rm(globalRoot, { recursive: true, force: true });
  }, 60_000);

  test("a preferred port outside the scan range is honoured when free", async () => {
    const nodeDir = await mkdtemp(join(root, "explicit-"));
    const globalRoot = await mkdtemp(join(root, "global-"));
    const binary = await writeFakeNode();

    const handle = await ensureNode({
      binaryPath: binary,
      binaryVersion: "1.0.0-rc.101",
      nodeDir,
      dataDir: join(nodeDir, "data"),
      projectRoot: nodeDir,
      preferredPort: 12_345,
      persistedPort: null,
      portLockPath: join(globalRoot, "nodes", ".port-lock"),
      startupTimeoutMs: 20_000,
      logger,
    });

    expect(handle.port).toBe(12_345);
    await stopNode(nodeDir, 200);
    await rm(nodeDir, { recursive: true, force: true });
    await rm(globalRoot, { recursive: true, force: true });
  }, 60_000);
});

describe("NodeRuntime", () => {
  test("detect reports a stopped node without starting one", async () => {
    const nodeDir = await mkdtemp(join(root, "runtime-"));
    const runtime = new NodeRuntime({
      nodeDir,
      projectRoot: nodeDir,
      preferredPort: 9700,
      dataDir: null,
      portLockPath: join(nodeDir, "lock"),
      explicitUrl: null,
      embedMode: EmbedMode.Lexical,
      logger,
      binary: () => null,
    });

    const detection = await runtime.detect();
    expect(detection.running).toBe(false);
    expect(runtime.snapshot.state).toBe("stopped");
    await rm(nodeDir, { recursive: true, force: true });
  });

  test("ensure without a binary fails with a clear error", async () => {
    const nodeDir = await mkdtemp(join(root, "runtime-"));
    const runtime = new NodeRuntime({
      nodeDir,
      projectRoot: nodeDir,
      preferredPort: 9701,
      dataDir: null,
      portLockPath: join(nodeDir, "lock"),
      explicitUrl: null,
      embedMode: EmbedMode.Lexical,
      logger,
      binary: () => null,
    });

    await expect(runtime.ensure()).rejects.toThrow(/binary is not installed/);
    await rm(nodeDir, { recursive: true, force: true });
  });

  test("invalidate forgets the handle so the next ensure probes again", async () => {
    const nodeDir = await mkdtemp(join(root, "runtime-"));
    const runtime = new NodeRuntime({
      nodeDir,
      projectRoot: nodeDir,
      preferredPort: 9702,
      dataDir: null,
      portLockPath: join(nodeDir, "lock"),
      explicitUrl: null,
      embedMode: EmbedMode.Lexical,
      logger,
      binary: () => null,
    });

    runtime.invalidate();
    expect(runtime.snapshot.state).toBe("stopped");
    // Stopping a node this runtime never owned is a no-op.
    await expect(runtime.stop("test")).resolves.toBe(false);
    await rm(nodeDir, { recursive: true, force: true });
  });

  // A detached node dies without an exit event. Trusting the cached handle
  // kept `ensure()` returning a dead URL, so every request failed on the
  // socket until the plugin was reloaded.
  test("reaps a dead handle and starts a new node", async () => {
    const nodeDir = await mkdtemp(join(root, "runtime-"));
    const fake = await writeFakeNode();
    const runtime = new NodeRuntime({
      nodeDir,
      projectRoot: nodeDir,
      preferredPort: 9704,
      dataDir: join(nodeDir, "data"),
      portLockPath: join(nodeDir, "lock"),
      explicitUrl: null,
      embedMode: EmbedMode.Lexical,
      logger,
      binary: () => ({
        version: "1.0.0-rc.102",
        path: fake,
        upgraded: false,
      }),
    });

    try {
      const first = await runtime.ensure();
      expect(first.pid).not.toBeNull();
      process.kill(first.pid!, "SIGKILL");
      // Let the kernel deliver the signal before the liveness check.
      await Bun.sleep(100);

      const second = await runtime.ensure();
      expect(second.pid).not.toBeNull();
      expect(second.pid).not.toBe(first.pid);
      expect(runtime.snapshot.state).toBe("running");
    } finally {
      await runtime.stop("test");
      await rm(nodeDir, { recursive: true, force: true });
    }
  }, 30_000);

  test("an explicit url is never killed on stop", async () => {
    const nodeDir = await mkdtemp(join(root, "runtime-"));
    const runtime = new NodeRuntime({
      nodeDir,
      projectRoot: nodeDir,
      preferredPort: 9703,
      dataDir: null,
      portLockPath: join(nodeDir, "lock"),
      explicitUrl: "http://127.0.0.1:9999",
      embedMode: EmbedMode.Lexical,
      logger,
      binary: () => null,
    });

    await expect(runtime.stop("test")).resolves.toBe(false);
    await rm(nodeDir, { recursive: true, force: true });
  });
});
