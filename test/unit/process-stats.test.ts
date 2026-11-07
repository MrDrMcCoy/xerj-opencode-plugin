import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { sampleProcess } from "../../src/process-stats.ts";

describe("sampleProcess", () => {
  test("the running process reports CPU and resident memory", async () => {
    const usage = await sampleProcess(process.pid);

    expect(usage).not.toBeNull();
    expect(usage?.memoryBytes).toBeGreaterThan(0);
    expect(usage?.cpuPercent).toBeGreaterThanOrEqual(0);
  });

  test("a missing process is null, not an error", async () => {
    expect(await sampleProcess(999_999)).toBeNull();
  });

  test("a stat line with a spaced command name parses", async () => {
    const stat = `1234 (weird (name)) S ${Array.from({ length: 20 }, (_, index) => index + 1).join(" ")}`;
    const read = (async (path: string) => {
      if (path.endsWith("stat")) return stat;
      return "VmRSS:\t2048 kB\n";
    }) as unknown as typeof readFile;

    const usage = await sampleProcess(1234, { sampleMs: 1, read });

    expect(usage?.memoryBytes).toBe(2048 * 1024);
  });

  test("a status file without VmRSS is null", async () => {
    const stat = `1 (x) S ${Array.from({ length: 20 }, () => 0).join(" ")}`;
    const read = (async (path: string) => {
      if (path.endsWith("stat")) return stat;
      return "Name:\tx\n";
    }) as unknown as typeof readFile;

    expect(await sampleProcess(1, { sampleMs: 1, read })).toBeNull();
  });

  test("a stat file without numbers is null", async () => {
    const read = (async () => "1 (x) S a b c") as unknown as typeof readFile;

    expect(await sampleProcess(1, { sampleMs: 1, read })).toBeNull();
  });
});

describe("readProcessCounters", () => {
  const stat = "100 (cmd with space) S 1 2 3 4 5 6 7 8 9 10 11 12\n";
  const status = "Name:\txerj\nVmRSS:\t 2048 kB\nThreads:\t7\n";

  test("reads ticks, RSS, and threads from /proc", async () => {
    const { readProcessCounters } = await import("../../src/process-stats.ts");
    const read = async (path: string) => {
      if (path.endsWith("/stat")) return stat;
      if (path.endsWith("/status")) return status;
      throw new Error(`unexpected ${path}`);
    };

    const counters = await readProcessCounters(42, {
      platform: "linux",
      read: read as never,
    });
    expect(counters).toEqual({
      ticks: 23,
      cpuPercent: null,
      memoryBytes: 2_097_152,
      threads: 7,
    });
  });

  test("a missing /proc entry is null", async () => {
    const { readProcessCounters } = await import("../../src/process-stats.ts");
    const read = async () => {
      throw new Error("gone");
    };
    expect(
      await readProcessCounters(42, { platform: "linux", read: read as never }),
    ).toBeNull();
  });

  test("the ps reader reports a percentage and no ticks", async () => {
    const { readProcessCounters } = await import("../../src/process-stats.ts");
    const counters = await readProcessCounters(42, {
      platform: "darwin",
      ps: async () => "  12.5 2048\n",
    });
    expect(counters).toEqual({
      ticks: null,
      cpuPercent: 12.5,
      memoryBytes: 2_097_152,
      threads: null,
    });
  });

  test("Windows has no reader", async () => {
    const { readProcessCounters } = await import("../../src/process-stats.ts");
    expect(await readProcessCounters(42, { platform: "win32" })).toBeNull();
  });
});
