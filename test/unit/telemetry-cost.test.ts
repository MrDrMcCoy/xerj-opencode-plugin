import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { costFields, featureOf, withCost } from "../../src/telemetry/cost.ts";
import { TelemetryStore } from "../../src/telemetry/store.ts";

const logger = {
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

async function store(): Promise<TelemetryStore> {
  const directory = await mkdtemp(join(tmpdir(), "xerj-cost-"));
  scratch.push(directory);
  const instance = new TelemetryStore({
    directory,
    prefix: "xop-demo-12345678",
    instance: "boot-a",
    enabled: true,
    maxBytes: 128 * 1024 * 1024,
    samplesPerType: 256,
    rotateBytes: 8 * 1024 * 1024,
    rotations: 4,
    flushMs: 60_000,
    maxText: 160,
    logger,
    bootMs: () => 0,
  });
  await instance.init();
  return instance;
}

describe("feature cost", () => {
  test("maps operations and tools to feature groups", () => {
    expect(featureOf("tool.search")).toBe("retrieval");
    expect(featureOf("tool.complexity")).toBe("analysis");
    expect(featureOf("tool.ask")).toBe("hub");
    expect(featureOf("index.project")).toBe("index");
    expect(featureOf("memory.distill.judge")).toBe("memory");
    expect(featureOf("hook.context")).toBe("retrieval");
    expect(featureOf("unmapped.op")).toBe("other");
  });

  test("merges cost under caller metadata without overwriting it", () => {
    const fields = costFields(
      { user: 0, system: 0, rss: 100, peakRss: 100 },
      { user: 2_000, system: 1_000, rss: 250, peakRss: 300 },
    );
    expect(fields.cpuMs).toBe(3);
    expect(fields.rssDelta).toBe(150);
    expect(withCost({ hits: 4 }, fields)).toMatchObject({ hits: 4, cpuMs: 3 });
  });

  test("a span carries CPU, RSS, and benefit into the report", async () => {
    const telemetry = await store();
    await telemetry.span(
      "tool.search",
      async () => 42,
      () => ({ hits: 2, bytes: 128 }),
    );
    await telemetry.flush();
    const report = await telemetry.report({ window: "all" });

    const row = report.rows.find((entry) => entry.op === "tool.search");
    expect(row).toBeDefined();
    expect(row?.returnedBytes).toBe(128);
    expect(row?.hits).toBe(2);
    expect(row?.rssPeak).toBeGreaterThan(0);
    const feature = report.features.find((entry) => entry.feature === "retrieval");
    expect(feature).toMatchObject({ count: 1, hits: 2, returnedBytes: 128 });
    await telemetry.close();
  });

  test("process summaries separate node and language servers", async () => {
    const telemetry = await store();
    const at = Date.now();
    telemetry.sample({
      at,
      kind: "node",
      pid: 10,
      load: 0,
      cpuPct: 5,
      rssBytes: 100 * 1024 * 1024,
      threads: 8,
    });
    telemetry.sample({
      at,
      kind: "lsp",
      pid: 20,
      load: 0,
      cpuPct: 20,
      rssBytes: 50 * 1024 * 1024,
      threads: 4,
    });
    await telemetry.flush();
    const report = await telemetry.report({ window: "all" });

    expect(report.processes.map((entry) => entry.kind)).toEqual(["lsp", "node"]);
    expect(report.processes.find((entry) => entry.kind === "lsp")?.cpuPct).toBe(20);
    await telemetry.close();
  });
});
