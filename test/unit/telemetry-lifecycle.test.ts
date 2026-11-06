import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Logger } from "../../src/log.ts";
import { BootTracker, CrashKind } from "../../src/telemetry/lifecycle.ts";
import { TelemetryStore } from "../../src/telemetry/store.ts";

const logger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  entries: async () => [],
  flush: async () => {},
};

const scratch: string[] = [];

afterEach(async () => {
  for (const directory of scratch.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

async function makeStore(instance: string): Promise<{
  store: TelemetryStore;
  directory: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "xerj-life-"));
  scratch.push(root);
  const store = new TelemetryStore({
    directory: join(root, "telemetry"),
    prefix: "xop-demo-12345678",
    instance,
    enabled: true,
    maxBytes: 1024 * 1024,
    samplesPerType: 32,
    rotateBytes: 1024 * 1024,
    rotations: 1,
    flushMs: 60_000,
    maxText: 160,
    logger,
    bootMs: () => 7,
  });
  await store.init();
  return { store, directory: join(root, "telemetry") };
}

describe("BootTracker", () => {
  test("records boot, ready, and indexed with one boot id", async () => {
    const { store, directory } = await makeStore("boot-a");
    const tracker = new BootTracker({ store, bootId: "boot-a", logger });

    await tracker.start({ phase: "setup" });
    await tracker.ready({ port: 9200 });
    await tracker.indexed({ records: 12 });
    await store.flush();

    const text = await readFile(join(directory, "ops.ndjson"), "utf8");
    const records = text
      .split("\n")
      .filter((line) => line.length > 0)
      .map(
        (line) =>
          JSON.parse(line) as { op: string; meta: { bootId: string } },
      );

    expect(records.map((record) => record.op)).toEqual([
      "lifecycle.boot",
      "lifecycle.ready",
      "lifecycle.indexed",
    ]);
    expect(new Set(records.map((record) => record.meta.bootId))).toEqual(
      new Set(["boot-a"]),
    );

    const marker = JSON.parse(
      await readFile(join(directory, "state", "boot-boot-a.json"), "utf8"),
    ) as { phase: string };
    expect(marker.phase).toBe("indexed");
    await tracker.shutdown();
    await store.close();
  });

  test("ready records once even after a restart", async () => {
    const { store, directory } = await makeStore("boot-a");
    const tracker = new BootTracker({ store, bootId: "boot-a", logger });

    await tracker.start();
    await tracker.ready({ port: 9200 });
    await tracker.ready({ port: 9201 });
    await store.flush();

    const text = await readFile(join(directory, "ops.ndjson"), "utf8");
    expect(text.match(/lifecycle\.ready/g)?.length).toBe(1);
    await store.close();
  });

  test("a clean shutdown removes the marker", async () => {
    const { store, directory } = await makeStore("boot-a");
    const tracker = new BootTracker({ store, bootId: "boot-a", logger });
    await tracker.start();
    await tracker.shutdown();

    expect(await readdir(join(directory, "state"))).toEqual([]);
    await store.close();
  });

  test("a dead marker reports a crash on the next boot", async () => {
    const { store, directory } = await makeStore("boot-b");
    const state = join(directory, "state");
    await mkdir(state, { recursive: true });
    await writeFile(
      join(state, "boot-dead.json"),
      JSON.stringify({
        bootId: "dead",
        pid: 999_999,
        prefix: "xop-demo-12345678",
        at: Date.now() - 60_000,
        phase: "ready",
      }),
    );

    let notified = 0;
    const tracker = new BootTracker({
      store,
      bootId: "boot-b",
      logger,
      onCrashedBoot: () => {
        notified += 1;
      },
    });
    await tracker.start();
    await store.flush();

    const text = await readFile(join(directory, "ops.ndjson"), "utf8");
    expect(text).toContain("\"kind\":\"plugin\"");
    expect(text).toContain("\"bootId\":\"dead\"");
    expect(notified).toBe(1);
    expect(await readdir(state)).toEqual(["boot-boot-b.json"]);
    await store.close();
  });

  test("a marker whose pid is alive is left alone", async () => {
    const { store, directory } = await makeStore("boot-b");
    const state = join(directory, "state");
    await mkdir(state, { recursive: true });
    await writeFile(
      join(state, "boot-live.json"),
      JSON.stringify({
        bootId: "live",
        pid: process.pid,
        prefix: "xop-demo-12345678",
        at: Date.now(),
        phase: "ready",
      }),
    );

    expect(await store.takeCrashedBoot()).toBeNull();
    expect(await readdir(state)).toEqual(["boot-live.json"]);
    await store.close();
  });

  test("an unrequested death records its kind and uptime", async () => {
    const { store, directory } = await makeStore("boot-a");
    const tracker = new BootTracker({ store, bootId: "boot-a", logger });
    await tracker.start();
    await tracker.crash(CrashKind.Watcher, 4_000, { attempt: 1 });
    await tracker.restart("crash", 0, { attempt: 1 });
    await store.flush();

    const text = await readFile(join(directory, "ops.ndjson"), "utf8");
    expect(text).toContain("\"kind\":\"watcher\"");
    expect(text).toContain("\"op\":\"lifecycle.crash\"");
    expect(text).toContain("\"op\":\"lifecycle.restart\"");
    await store.close();
  });
});
