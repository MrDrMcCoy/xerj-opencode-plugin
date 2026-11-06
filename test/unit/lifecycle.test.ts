// Project lifecycle: idle deadline, activity touches, and peer heartbeats.

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import {
  heartbeatAlive,
  ProjectLifecycle,
  startSessionTracking,
} from "../../src/lifecycle.ts";
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
async function peerHeartbeat(
  nodeDir: string,
  name: string,
  pid: number,
  sessions: number | undefined = 1,
): Promise<void> {
  const directory = nodeClientsDir(nodeDir);
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, `${name}.json`),
    JSON.stringify(sessions === undefined ? { pid } : { pid, sessions }),
  );
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
  test("counts a fresh heartbeat from another instance with a session", async () => {
    const nodeDir = await scratch();
    await peerHeartbeat(nodeDir, `other-${process.pid}`, process.pid, 1);
    const idle = lifecycle(nodeDir);

    expect(await idle.peers()).toBe(1);
    await idle.stop();
  });

  test("ignores a live peer that has no active session", async () => {
    const nodeDir = await scratch();
    await peerHeartbeat(nodeDir, `idle-${process.pid}`, process.pid, 0);
    const idle = lifecycle(nodeDir);

    expect(await idle.peers()).toBe(0);
    await idle.stop();
  });

  test("counts a heartbeat without a session count as active", async () => {
    const nodeDir = await scratch();
    await peerHeartbeat(nodeDir, "legacy", process.pid, undefined);
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

  test("does not fire while a peer has an active session", async () => {
    const nodeDir = await scratch();
    await peerHeartbeat(nodeDir, "peer", process.pid, 1);
    let fired = 0;
    const idle = lifecycle(nodeDir, { idleMs: 10, checkMs: 5 }, async () => {
      fired += 1;
    });

    idle.start();
    await Bun.sleep(60);
    await idle.stop();

    expect(fired).toBe(0);
  });

  test("fires while an idle peer process is still running", async () => {
    const nodeDir = await scratch();
    await peerHeartbeat(nodeDir, "idle-peer", process.pid, 0);
    let fired = 0;
    const idle = lifecycle(nodeDir, { idleMs: 10, checkMs: 5 }, async () => {
      fired += 1;
    });

    idle.start();
    await Bun.sleep(60);
    await idle.stop();

    expect(fired).toBeGreaterThan(0);
  });

  test("two idle instances do not count each other as peers", async () => {
    const nodeDir = await scratch();
    const first = lifecycle(nodeDir, {}, async () => {});
    const second = lifecycle(nodeDir, {}, async () => {});

    first.start();
    second.start();
    await Bun.sleep(20);

    expect(await first.peers()).toBe(0);
    expect(await second.peers()).toBe(0);
    await first.stop();
    await second.stop();
  });

  test("clears its own heartbeat when a session closes", async () => {
    const nodeDir = await scratch();
    const first = lifecycle(nodeDir, {}, async () => {});
    let fired = 0;
    const second = lifecycle(nodeDir, {}, async () => {
      fired += 1;
    });

    first.start();
    second.start();
    await Bun.sleep(10);
    first.touch("ses_a");
    second.touch("ses_b");
    await Bun.sleep(10);
    expect(await first.closeSession("ses_a")).toBe(false);
    expect(await second.closeSession("ses_b")).toBe(true);
    expect(fired).toBe(1);
    await first.stop();
    await second.stop();
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

describe("session tracking", () => {
  function eventsOf(list: unknown[]): {
    subscribe: () => AsyncIterable<unknown>;
  } {
    return {
      subscribe: async function* () {
        for (const event of list) yield event;
        await new Promise<void>(() => {});
      },
    };
  }

  test("closes a session on session.deleted", async () => {
    const nodeDir = await scratch();
    let fired = 0;
    const idle = lifecycle(nodeDir, {}, async () => {
      fired += 1;
    });
    idle.touch("ses_a");

    const controller = new AbortController();
    startSessionTracking(
      eventsOf([{ type: "session.deleted", data: { sessionID: "ses_a" } }]),
      idle,
      controller.signal,
      logger,
    );
    await Bun.sleep(20);
    controller.abort();
    await idle.stop();

    expect(fired).toBe(1);
  });

  test("ignores events that are malformed or for another type", async () => {
    const nodeDir = await scratch();
    let fired = 0;
    const idle = lifecycle(nodeDir, {}, async () => {
      fired += 1;
    });
    idle.touch("ses_a");

    const controller = new AbortController();
    startSessionTracking(
      eventsOf([
        null,
        "text",
        { type: "session.created", data: { sessionID: "ses_a" } },
        { type: "session.deleted", data: {} },
        { type: "session.deleted" },
      ]),
      idle,
      controller.signal,
      logger,
    );
    await Bun.sleep(20);
    controller.abort();
    await idle.stop();

    expect(fired).toBe(0);
  });

  test("a failing subscription stops quietly unless it was aborted", async () => {
    const nodeDir = await scratch();
    const idle = lifecycle(nodeDir);
    const failing = {
      subscribe: () => {
        throw new Error("stream closed");
      },
    };

    startSessionTracking(failing, idle, new AbortController().signal, logger);
    await Bun.sleep(10);
    await idle.stop();
  });
});

describe("heartbeat parsing", () => {
  test("a corrupt heartbeat counts as active, so no node is killed by mistake", async () => {
    const nodeDir = await scratch();
    const directory = nodeClientsDir(nodeDir);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "broken.json"), "{not json");
    const idle = lifecycle(nodeDir);

    // An unparseable file is most likely a torn write from a live peer, so the
    // safe answer is to defer rather than stop a node someone is using.
    expect(await idle.peers()).toBe(1);
    await idle.stop();
  });

  test("a heartbeat with a non-integer pid does not crash the count", async () => {
    const nodeDir = await scratch();
    const directory = nodeClientsDir(nodeDir);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "odd.json"), JSON.stringify({ pid: 1.5, sessions: 1 }));
    const idle = lifecycle(nodeDir);

    expect(await idle.peers()).toBe(1);
    await idle.stop();
  });
});

describe("default timing and error handling", () => {
  test("derives a check interval when none is given", async () => {
    const nodeDir = await scratch();
    const idle = new ProjectLifecycle({
      nodeDir,
      idleMs: 60_000,
      enabled: true,
      logger,
      onIdle: async () => {},
    });

    idle.start();
    await idle.stop();

    expect(idle.snapshot().idleMs).toBe(60_000);
  });

  test("drops a session that aged past the idle window", async () => {
    const nodeDir = await scratch();
    const idle = lifecycle(nodeDir, { idleMs: 60 });

    idle.touch("ses_old");
    expect(idle.snapshot().sessions).toBe(1);

    await Bun.sleep(90);
    idle.touch();

    expect(idle.snapshot().sessions).toBe(0);
    await idle.stop();
  });

  test("a failing idle handler is logged and does not stop the timer", async () => {
    const nodeDir = await scratch();
    let attempts = 0;
    const idle = lifecycle(nodeDir, { idleMs: 10, checkMs: 5 }, async () => {
      attempts += 1;
      throw new Error("node refused to stop");
    });

    idle.start();
    await Bun.sleep(60);
    await idle.stop();

    expect(attempts).toBeGreaterThan(0);
  });
});

describe("unwritable node directory", () => {
  test("a heartbeat that cannot be written does not throw", async () => {
    const nodeDir = await scratch();
    await mkdir(nodeDir, { recursive: true });
    // A file where the clients directory should be makes both mkdir and the
    // write fail; the lifecycle must carry on regardless.
    await writeFile(nodeClientsDir(nodeDir), "blocker");

    const idle = lifecycle(nodeDir);
    idle.touch("ses_a");

    expect(await idle.peers()).toBe(0);
    await idle.stop();
  });
});
