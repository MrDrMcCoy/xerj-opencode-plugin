import { describe, expect, test } from "bun:test";
import {
  Priority,
  applyPriority,
  ioniceArgs,
  niceValue,
  windowsPriorityClass,
  type PriorityRunner,
} from "../../src/node/priority.ts";

interface Recorded {
  readonly nice: Array<{ pid: number; value: number }>;
  readonly runs: Array<{ command: string; args: string[] }>;
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
