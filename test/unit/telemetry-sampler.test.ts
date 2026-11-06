import { describe, expect, test } from "bun:test";
import type { Logger } from "../../src/log.ts";
import {
  cpuPercentSince,
  parsePs,
  type ProcessCounters,
} from "../../src/process-stats.ts";
import { ProcessSampler } from "../../src/telemetry/sampler.ts";
import type { TelemetryStore } from "../../src/telemetry/store.ts";
import type { SampleRecord } from "../../src/telemetry/types.ts";

const logger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  entries: async () => [],
  flush: async () => {},
};

/** The sampler only needs `sample`, `setLoadProvider`, and `enabled`. */
function fakeStore(): { store: TelemetryStore; samples: SampleRecord[] } {
  const samples: SampleRecord[] = [];
  const store = {
    enabled: true,
    sample: (record: SampleRecord) => samples.push(record),
    setLoadProvider: () => {},
  } as unknown as TelemetryStore;
  return { store, samples };
}

describe("cpuPercentSince", () => {
  test("converts a tick delta over the real interval", () => {
    expect(
      cpuPercentSince({ ticks: 100, at: 0 }, { ticks: 250, at: 1_000 }),
    ).toBe(150);
  });

  test("returns null with no elapsed time", () => {
    expect(
      cpuPercentSince({ ticks: 100, at: 5 }, { ticks: 200, at: 5 }),
    ).toBeNull();
  });
});

describe("parsePs", () => {
  test("reads pcpu and rss in KB", () => {
    expect(parsePs("  12.5 2048\n")).toEqual({
      cpuPercent: 12.5,
      memoryBytes: 2_097_152,
    });
  });

  test("rejects empty or malformed output", () => {
    expect(parsePs("")).toBeNull();
    expect(parsePs("no numbers here")).toBeNull();
  });
});

describe("ProcessSampler", () => {
  test("the first sample has a null CPU share and a real RSS", async () => {
    const { store, samples } = fakeStore();
    const sampler = new ProcessSampler({
      store,
      logger,
      intervalMs: 0,
      targets: () => [{ kind: "node", pid: 42 }],
      load: () => 0,
      read: async () => counters(500, 64),
      now: () => 1_000,
    });

    await sampler.sampleOnce();
    expect(samples.length).toBe(1);
    expect(samples[0]?.cpuPct).toBeNull();
    expect(samples[0]?.rssBytes).toBe(64);
  });

  test("consecutive samples of one pid use consecutive deltas", async () => {
    const { store, samples } = fakeStore();
    let ticks = 100;
    let now = 1_000;
    const sampler = new ProcessSampler({
      store,
      logger,
      intervalMs: 0,
      targets: () => [{ kind: "node", pid: 42 }],
      load: () => 2,
      read: async () => counters((ticks += 100), 64),
      now: () => now,
    });

    await sampler.sampleOnce();
    now += 1_000;
    await sampler.sampleOnce();

    expect(samples[1]?.cpuPct).toBe(100);
    expect(samples[1]?.load).toBe(2);
  });

  test("a vanished pid is skipped without throwing", async () => {
    const { store, samples } = fakeStore();
    const sampler = new ProcessSampler({
      store,
      logger,
      intervalMs: 0,
      targets: () => [
        { kind: "watcher", pid: 7 },
        { kind: "node", pid: 42 },
      ],
      load: () => 0,
      read: async (pid) => (pid === 42 ? counters(100, 32) : null),
      now: () => 1_000,
    });

    await sampler.sampleOnce();
    expect(samples.map((sample) => sample.pid)).toEqual([42]);
  });

  test("ps-style percentages pass through unchanged", async () => {
    const { store, samples } = fakeStore();
    const sampler = new ProcessSampler({
      store,
      logger,
      intervalMs: 0,
      targets: () => [{ kind: "node", pid: 42 }],
      load: () => 0,
      read: async () => ({
        ticks: null,
        cpuPercent: 12.5,
        memoryBytes: 1_024,
        threads: null,
      }),
      now: () => 1_000,
    });

    await sampler.sampleOnce();
    expect(samples[0]?.cpuPct).toBe(12.5);
  });

  test("Windows warns once and samples nothing", async () => {
    const warnings: string[] = [];
    const { store, samples } = fakeStore();
    const sampler = new ProcessSampler({
      store,
      logger: { ...logger, warn: (message: string) => warnings.push(message) },
      intervalMs: 15_000,
      targets: () => [{ kind: "node", pid: 42 }],
      load: () => 0,
      platform: "win32",
      read: async () => counters(1, 1),
      now: () => 1_000,
    });

    sampler.start();
    sampler.start();
    await sampler.sampleOnce();
    sampler.stop();

    expect(samples).toEqual([]);
    expect(warnings.length).toBe(1);
  });
});

function counters(ticks: number, memoryBytes: number): ProcessCounters {
  return { ticks, cpuPercent: null, memoryBytes, threads: 4 };
}
