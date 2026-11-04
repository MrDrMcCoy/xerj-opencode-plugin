// Project lifecycle: idle deadline, activity touches, and peer heartbeats.

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { heartbeatAlive, ProjectLifecycle } from "../../src/lifecycle.ts";
import { nodeClientsDir } from "../../src/paths.ts";

const roots: string[] = [];
const logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  entries: async () => [],
  flush: async () => {},
};

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

async function scratch(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "xerj-life-"));
  roots.push(root);
  return join(root, "nodes", "xop-demo-00000000");
}

/** Writes a heartbeat as another instance would, named by pid plus suffix. */
async function peerHeartbeat(nodeDir: string, name: string, pid: number): Promise<void> {
  const directory = nodeClientsDir(nodeDir);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, `${name}.json`), JSON.stringify({ pid }));
}

function lifecycle(
  nodeDir: string,
  overrides: { enabled?: boolean; idleMs?: number; checkMs?: number } = {},
  onIdle = async (): Promise<void> => {},
): ProjectLifecycle {
  return new ProjectLifecycle({
    nodeDir,
    idleMs: overrides.idleMs ?? 60_000,
    enabled: overrides.enabled ?? true,
    checkMs: overrides.checkMs ?? 60_000,
    logger,
    onIdle,
  });
}

describe("idle deadline", () => {
  test("is last activity plus the timeout while enabled", async () => {
    const idle = lifecycle(await scratch());
    idle.touch();
    const snapshot = idle.snapshot();

    expect(snapshot.idleAt).toBe(snapshot.lastActivityAt + 60_000);
    await idle.stop();
  });

  test("is null when disabled and never fires", async () => {
    const nodeDir = await scratch();
    let fired = 0;
    const idle = lifecycle(nodeDir, { enabled: false, idleMs: 10, checkMs: 5 }, async () => {
      fired += 1;
    });

    idle.start();
    idle.touch();
    await Bun.sleep(60);
    await idle.stop();

    expect(idle.snapshot().idleAt).toBeNull();
    expect(fired).toBe(0);
    expect(await idle.peers()).toBe(0);
  });

  test("fires once the deadline passes", async () => {
    const nodeDir = await scratch();
    let fired = 0;
    const idle = lifecycle(nodeDir, { idleMs: 20, checkMs: 5 }, async () => {
      fired += 1;
    });

    idle.start();
    await Bun.sleep(80);
    await idle.stop();

    expect(fired).toBeGreaterThan(0);
  });

  test("a touch postpones the deadline", async () => {
    const nodeDir = await scratch();
    let fired = 0;
    const idle = lifecycle(nodeDir, { idleMs: 120, checkMs: 10 }, async () => {
      fired += 1;
    });

    idle.start();
    for (let index = 0; index < 5; index += 1) {
      await Bun.sleep(40);
      idle.touch();
    }
    await idle.stop();

    expect(fired).toBe(0);
  });
});

describe("peer heartbeats", () => {
  test("counts a fresh heartbeat from another instance", async () => {
    const nodeDir = await scratch();
    await peerHeartbeat(nodeDir, `other-${process.pid}`, process.pid);
    const idle = lifecycle(nodeDir);

    expect(await idle.peers()).toBe(1);
    await idle.stop();
  });

  test("ignores a heartbeat whose pid is dead", async () => {
    const nodeDir = await scratch();
    await peerHeartbeat(nodeDir, "dead", 2_147_483_647);
    const idle = lifecycle(nodeDir);

    expect(await idle.peers()).toBe(0);
    await idle.stop();
  });

  test("ignores its own heartbeat", async () => {
    const nodeDir = await scratch();
    const idle = lifecycle(nodeDir);
    idle.start();
    await Bun.sleep(10);

    expect(await idle.peers()).toBe(0);
    await idle.stop();
  });

  test("does not fire while a live peer exists", async () => {
    const nodeDir = await scratch();
    await peerHeartbeat(nodeDir, "peer", process.pid);
    let fired = 0;
    const idle = lifecycle(nodeDir, { idleMs: 10, checkMs: 5 }, async () => {
      fired += 1;
    });

    idle.start();
    await Bun.sleep(60);
    await idle.stop();

    expect(fired).toBe(0);
  });
});

describe("last session closed", () => {
  test("stops when the only recorded session closes", async () => {
    const nodeDir = await scratch();
    let fired = 0;
    const idle = lifecycle(nodeDir, {}, async () => {
      fired += 1;
    });

    idle.touch("ses_one");
    expect(await idle.closeSession("ses_one")).toBe(true);
    expect(fired).toBe(1);
    await idle.stop();
  });

  test("waits while another session is still recorded", async () => {
    const nodeDir = await scratch();
    let fired = 0;
    const idle = lifecycle(nodeDir, {}, async () => {
      fired += 1;
    });

    idle.touch("ses_one");
    idle.touch("ses_two");
    expect(await idle.closeSession("ses_one")).toBe(false);
    expect(fired).toBe(0);
    await idle.stop();
  });

  test("defers to a live peer process", async () => {
    const nodeDir = await scratch();
    await peerHeartbeat(nodeDir, "peer", process.pid);
    let fired = 0;
    const idle = lifecycle(nodeDir, {}, async () => {
      fired += 1;
    });

    idle.touch("ses_one");
    expect(await idle.closeSession("ses_one")).toBe(false);
    expect(fired).toBe(0);
    await idle.stop();
  });

  test("treats a close with no recorded sessions as the last one", async () => {
    const nodeDir = await scratch();
    let fired = 0;
    const idle = lifecycle(nodeDir, {}, async () => {
      fired += 1;
    });

    expect(await idle.closeSession("ses_unknown")).toBe(true);
    expect(fired).toBe(1);
    await idle.stop();
  });
});

describe("heartbeatAlive", () => {
  test("is true for this process and false for an unused pid", () => {
    expect(heartbeatAlive(process.pid)).toBe(true);
    expect(heartbeatAlive(2_147_483_647)).toBe(false);
  });
});

test("stop removes the heartbeat file", async () => {
  const nodeDir = await scratch();
  const idle = lifecycle(nodeDir);
  idle.start();
  await Bun.sleep(10);
  await idle.stop();

  expect(await idle.peers()).toBe(0);
});
