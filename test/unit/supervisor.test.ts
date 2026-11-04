import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  detectNode,
  ensureNode,
  NodeError,
  ownsNodeAt,
  persistPort,
  probeNode,
  readNodePid,
  readPersistedPort,
  stopNode,
  type NodeHandle,
} from "../../src/node/supervisor.ts";
import type { Logger } from "../../src/log.ts";

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
