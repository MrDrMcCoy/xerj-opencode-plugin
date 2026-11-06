import { describe, expect, test } from "bun:test";
import type { Logger } from "../../src/log.ts";
import {
  Priority,
  applyCpuAffinity,
  applyPriority,
  availableCpuIndexes,
  formatCpuList,
  ioniceArgs,
  niceValue,
  parseCpuSpec,
  resolveCpuIndexes,
  windowsAffinityMask,
  windowsAffinityValue,
  windowsPriorityClass,
  type AffinityRunner,
  type PriorityRunner,
} from "../../src/node/priority.ts";

interface Recorded {
  readonly nice: Array<{ pid: number; value: number }>;
  readonly runs: Array<{ command: string; args: string[] }>;
}

function affinityRunner(
  platform: NodeJS.Platform,
  allowed: ReadonlyArray<number>,
  options: { fail?: boolean } = {},
): { runner: AffinityRunner; runs: Array<{ command: string; args: string[] }> } {
  const runs: Array<{ command: string; args: string[] }> = [];
  return {
    runs,
    runner: {
      platform,
      allowedCpus: () => allowed,
      run: async (command, args) => {
        if (options.fail === true) throw new Error("ENOENT");
        runs.push({ command, args });
      },
    },
  };
}

function recallLogger(): { logger: Logger; warnings: string[] } {
  const warnings: string[] = [];
  return {
    warnings,
    logger: {
      debug: () => {},
      info: () => {},
      warn: (message) => warnings.push(message),
      error: () => {},
      entries: async () => [],
      flush: async () => {},
    },
  };
}

function runner(
  platform: NodeJS.Platform,
  options: { failNice?: boolean; failRun?: boolean } = {},
): { runner: PriorityRunner; recorded: Recorded } {
  const recorded: Recorded = { nice: [], runs: [] };
  return {
    recorded,
    runner: {
      platform,
      setNice: async (pid, value) => {
        if (options.failNice === true) throw new Error("EPERM");
        recorded.nice.push({ pid, value });
      },
      run: async (command, args) => {
        if (options.failRun === true) throw new Error("ENOENT");
        recorded.runs.push({ command, args });
      },
    },
  };
}

describe("priority values", () => {
  test("maps each level to a nice value", () => {
    expect(niceValue(Priority.Low)).toBe(19);
    expect(niceValue(Priority.Normal)).toBe(0);
    expect(niceValue(Priority.High)).toBe(-10);
  });

  test("idle I/O only for the low level", () => {
    expect(ioniceArgs(Priority.Low, 42)).toEqual(["-c", "3", "-p", "42"]);
    expect(ioniceArgs(Priority.Normal, 42)).toEqual(["-c", "2", "-p", "42"]);
    expect(ioniceArgs(Priority.High, 42)).toEqual(["-c", "2", "-p", "42"]);
  });

  test("maps each level to a Windows class", () => {
    expect(windowsPriorityClass(Priority.Low)).toBe("Idle");
    expect(windowsPriorityClass(Priority.Normal)).toBe("Normal");
    expect(windowsPriorityClass(Priority.High)).toBe("High");
  });
});

describe("applyPriority", () => {
  test("lowers CPU and I/O priority on Linux", async () => {
    const { runner: stub, recorded } = runner("linux");

    await applyPriority({ pid: 1234, priority: Priority.Low, runner: stub });

    expect(recorded.nice).toEqual([{ pid: 1234, value: 19 }]);
    expect(recorded.runs).toEqual([
      { command: "ionice", args: ["-c", "3", "-p", "1234"] },
    ]);
  });

  test("sets only nice on macOS", async () => {
    const { runner: stub, recorded } = runner("darwin");

    await applyPriority({ pid: 7, priority: Priority.Normal, runner: stub });

    expect(recorded.nice).toEqual([{ pid: 7, value: 0 }]);
    expect(recorded.runs).toEqual([]);
  });

  test("uses the process priority class on Windows", async () => {
    const { runner: stub, recorded } = runner("win32");

    await applyPriority({ pid: 99, priority: Priority.High, runner: stub });

    expect(recorded.nice).toEqual([]);
    expect(recorded.runs).toHaveLength(1);
    expect(recorded.runs[0]?.command).toBe("powershell.exe");
    expect(recorded.runs[0]?.args.join(" ")).toContain("'High'");
    expect(recorded.runs[0]?.args.join(" ")).toContain("-Id 99");
  });

  test("does nothing without a pid", async () => {
    const { runner: stub, recorded } = runner("linux");

    await applyPriority({ pid: undefined, priority: Priority.Low, runner: stub });

    expect(recorded.nice).toEqual([]);
    expect(recorded.runs).toEqual([]);
  });

  test("a denied or missing tool never throws", async () => {
    const { runner: stub } = runner("linux", { failNice: true, failRun: true });

    await applyPriority({ pid: 5, priority: Priority.Low, runner: stub });
  });
});

describe("parseCpuSpec", () => {
  test("reads indices and inclusive ranges", () => {
    expect(parseCpuSpec("0-3,8,10-11")).toEqual({
      spec: { kind: "list", indexes: [0, 1, 2, 3, 8, 10, 11] },
      error: null,
    });
  });

  test("deduplicates and sorts", () => {
    expect(parseCpuSpec("8,0-1,0")).toEqual({
      spec: { kind: "list", indexes: [0, 1, 8] },
      error: null,
    });
  });

  test("accepts odd, even and percentages", () => {
    expect(parseCpuSpec("odd")).toEqual({ spec: { kind: "odd" }, error: null });
    expect(parseCpuSpec("EVEN")).toEqual({ spec: { kind: "even" }, error: null });
    expect(parseCpuSpec("50%")).toEqual({
      spec: { kind: "percent", percent: 50 },
      error: null,
    });
    expect(parseCpuSpec("1%")).toEqual({
      spec: { kind: "percent", percent: 1 },
      error: null,
    });
    expect(parseCpuSpec("100%")).toEqual({
      spec: { kind: "percent", percent: 100 },
      error: null,
    });
  });

  test("treats empty and all as no affinity", () => {
    expect(parseCpuSpec("  ")).toEqual({ spec: null, error: null });
    expect(parseCpuSpec("ALL")).toEqual({ spec: null, error: null });
  });

  test("a one-element range is a single index", () => {
    expect(parseCpuSpec("10-10")).toEqual({
      spec: { kind: "list", indexes: [10] },
      error: null,
    });
  });

  test("refuses malformed values with a reason", () => {
    const values = [
      "101%",
      "0%",
      "3-1",
      "1,,2",
      "1.5%",
      "-1",
      "cpu0",
      "0-65536",
      "65536",
    ];
    for (const value of values) {
      const parsed = parseCpuSpec(value);
      expect(parsed.spec).toBeNull();
      expect(parsed.error).not.toBeNull();
    }
  });
});

describe("formatCpuList", () => {
  test("compresses consecutive runs", () => {
    expect(formatCpuList([0, 1, 2, 3, 8, 10, 11])).toBe("0-3,8,10-11");
    expect(formatCpuList([5])).toBe("5");
    expect(formatCpuList([3, 1, 2, 2])).toBe("1-3");
    expect(formatCpuList([])).toBe("");
  });
});

describe("resolveCpuIndexes", () => {
  test("keeps only the CPUs this process may use", () => {
    expect(
      resolveCpuIndexes({ kind: "list", indexes: [0, 1, 2, 8] }, [0, 1, 2, 4, 8]),
    ).toEqual([0, 1, 2, 8]);
    expect(resolveCpuIndexes({ kind: "list", indexes: [0, 1, 2, 8] }, [1, 2])).toEqual([
      1, 2,
    ]);
  });

  test("odd and even follow the CPU index, not its position", () => {
    expect(resolveCpuIndexes({ kind: "odd" }, [0, 1, 2, 3, 4])).toEqual([1, 3]);
    expect(resolveCpuIndexes({ kind: "even" }, [0, 1, 2, 3, 4])).toEqual([0, 2, 4]);
    expect(resolveCpuIndexes({ kind: "even" }, [9, 10, 12])).toEqual([10, 12]);
  });

  test("a percentage rounds down and keeps at least one CPU", () => {
    expect(
      resolveCpuIndexes({ kind: "percent", percent: 50 }, [0, 1, 2, 3, 4, 5, 6, 7]),
    ).toEqual([0, 1, 2, 3]);
    expect(resolveCpuIndexes({ kind: "percent", percent: 50 }, [0, 1, 2])).toEqual([0]);
    expect(resolveCpuIndexes({ kind: "percent", percent: 1 }, [0, 1, 2])).toEqual([0]);
    expect(resolveCpuIndexes({ kind: "percent", percent: 100 }, [0, 1, 2])).toEqual([
      0, 1, 2,
    ]);
    expect(resolveCpuIndexes({ kind: "percent", percent: 50 }, [])).toEqual([]);
  });
});

describe("availableCpuIndexes", () => {
  test("returns a sorted, non-empty set on Linux", () => {
    const indexes = availableCpuIndexes("linux");
    expect(indexes.length).toBeGreaterThan(0);
    expect(indexes).toEqual([...indexes].sort((a, b) => a - b));
  });

  test("falls back to the visible count elsewhere", () => {
    const indexes = availableCpuIndexes("win32");
    expect(indexes[0]).toBe(0);
    expect(indexes.length).toBeGreaterThan(0);
  });
});

describe("Windows affinity", () => {
  test("builds a bitmask", () => {
    expect(windowsAffinityMask([0, 1, 2])).toBe(7n);
    expect(windowsAffinityMask([63])).toBe(1n << 63n);
    expect(windowsAffinityMask([64])).toBeNull();
  });

  test("emits bit 63 as a negative IntPtr", () => {
    expect(windowsAffinityValue(7n)).toBe("7");
    expect(windowsAffinityValue(1n << 62n)).toBe("4611686018427387904");
    expect(windowsAffinityValue(1n << 63n)).toBe("-9223372036854775808");
  });
});

describe("applyCpuAffinity", () => {
  test("confines every thread with taskset on Linux", async () => {
    const { runner: stub, runs } = affinityRunner("linux", [0, 1, 2, 3, 8]);

    await applyCpuAffinity({
      pid: 1234,
      spec: { kind: "list", indexes: [0, 1, 2, 8] },
      runner: stub,
    });

    expect(runs).toEqual([
      { command: "taskset", args: ["-a", "-pc", "0-2,8", "1234"] },
    ]);
  });

  test("warns when part of the set is unavailable", async () => {
    const { runner: stub, runs } = affinityRunner("linux", [0, 1]);
    const { logger, warnings } = recallLogger();

    await applyCpuAffinity({
      pid: 4,
      spec: { kind: "list", indexes: [0, 1, 8] },
      runner: stub,
      logger,
    });

    expect(runs[0]?.args[2]).toBe("0-1");
    expect(warnings).toEqual(["node.cpus dropped 1 unavailable CPU(s)"]);
  });

  test("leaves affinity alone when no CPU matches", async () => {
    const { runner: stub, runs } = affinityRunner("linux", [0, 1]);
    const { logger, warnings } = recallLogger();

    await applyCpuAffinity({
      pid: 5,
      spec: { kind: "list", indexes: [8] },
      runner: stub,
      logger,
    });

    expect(runs).toEqual([]);
    expect(warnings[0]).toContain("matched no available CPU");
  });

  test("sets ProcessorAffinity on Windows", async () => {
    const { runner: stub, runs } = affinityRunner("win32", [0, 2]);

    await applyCpuAffinity({
      pid: 9,
      spec: { kind: "list", indexes: [0, 2] },
      runner: stub,
    });

    expect(runs[0]?.command).toBe("powershell.exe");
    expect(runs[0]?.args.join(" ")).toContain("ProcessorAffinity");
    expect(runs[0]?.args.join(" ")).toContain("[IntPtr]5");
  });

  test("refuses a Windows set above the first processor group", async () => {
    const { runner: stub, runs } = affinityRunner("win32", [0, 64]);
    const { logger, warnings } = recallLogger();

    await applyCpuAffinity({
      pid: 9,
      spec: { kind: "list", indexes: [0, 64] },
      runner: stub,
      logger,
    });

    expect(runs).toEqual([]);
    expect(warnings[0]).toContain("processor groups");
  });

  test("warns once where the platform cannot pin", async () => {
    const { runner: stub, runs } = affinityRunner("darwin", [0, 1]);
    const { logger, warnings } = recallLogger();

    await applyCpuAffinity({ pid: 6, spec: { kind: "odd" }, runner: stub, logger });
    await applyCpuAffinity({ pid: 7, spec: { kind: "odd" }, runner: stub, logger });

    expect(runs).toEqual([]);
    expect(warnings).toHaveLength(1);
  });

  test("does nothing without a pid and never throws", async () => {
    const { runner: stub, runs } = affinityRunner("linux", [0], { fail: true });

    await applyCpuAffinity({ pid: undefined, spec: { kind: "odd" }, runner: stub });
    await applyCpuAffinity({ pid: 1, spec: { kind: "odd" }, runner: stub });

    expect(runs).toEqual([]);
  });
});
