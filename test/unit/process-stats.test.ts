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
