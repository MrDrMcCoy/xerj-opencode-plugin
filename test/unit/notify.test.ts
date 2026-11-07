import { describe, expect, test } from "bun:test";
import type { StatusSnapshot } from "../../src/rpc.ts";
import {
  completionNotices,
  EMPTY_NOTICE_STATE,
} from "../../src/ui/notify.ts";

function snapshot(overrides: {
  lastRunAt?: number | null;
  lastFiles?: number | null;
  lastRecords?: number | null;
  prjdocs?: number | null;
  sysdocs?: number | null;
} = {}): StatusSnapshot {
  return {
    index: {
      lastRunAt: overrides.lastRunAt ?? 1_000,
      lastFiles: overrides.lastFiles ?? 177,
      lastRecords: overrides.lastRecords ?? 2_331,
    },
    docs: {
      prjdocs: { lastRunAt: overrides.prjdocs ?? 2_000, pages: 2_099 },
      sysdocs: { lastRunAt: overrides.sysdocs ?? 3_000, pages: 3_648 },
    },
  } as unknown as StatusSnapshot;
}

describe("completionNotices", () => {
  test("the first status is the baseline, not a notice", () => {
    const result = completionNotices(snapshot(), EMPTY_NOTICE_STATE, null);

    expect(result.notices).toEqual([]);
    expect(result.state).toMatchObject({
      baselined: true,
      project: 1_000,
      prjdocs: 2_000,
      sysdocs: 3_000,
    });
  });

  test("an initial index that finishes after the baseline is announced", () => {
    const baseline = completionNotices(snapshot({ lastRunAt: 500 }), EMPTY_NOTICE_STATE, null);
    const result = completionNotices(snapshot({ lastRunAt: 1_500 }), baseline.state, null);

    expect(result.notices).toEqual([
      { kind: "project", message: "XERJ indexed · 177 files · 2,331 records" },
    ]);
  });

  test("a command's own text wins over the default message", () => {
    const baseline = completionNotices(snapshot(), EMPTY_NOTICE_STATE, null);
    const result = completionNotices(
      snapshot({ prjdocs: 2_500 }),
      baseline.state,
      { kind: "prjdocs", message: "XERJ project docs · 3 technologies · 40 pages indexed" },
    );

    expect(result.notices).toEqual([
      {
        kind: "prjdocs",
        message: "XERJ project docs · 3 technologies · 40 pages indexed",
      },
    ]);
    expect(result.pending).toBeNull();
  });

  test("an unchanged status emits nothing", () => {
    const baseline = completionNotices(snapshot(), EMPTY_NOTICE_STATE, null);
    const result = completionNotices(snapshot(), baseline.state, null);

    expect(result.notices).toEqual([]);
  });

  test("an agent-triggered docs run is announced with the default text", () => {
    const baseline = completionNotices(snapshot(), EMPTY_NOTICE_STATE, null);
    const result = completionNotices(snapshot({ sysdocs: 3_500 }), baseline.state, null);

    expect(result.notices).toEqual([
      { kind: "sysdocs", message: "XERJ system docs · 3,648 pages" },
    ]);
  });
});
