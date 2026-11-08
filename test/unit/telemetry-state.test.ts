import { describe, expect, test } from "bun:test";
import {
  JobRegistry,
  serviceState,
  stateBadge,
  stateGlyph,
  StateTracker,
  type StateSink,
} from "../../src/telemetry/state.ts";
import { JobKind, type JobView } from "../../src/telemetry/types.ts";

const corpora = [
  { name: "project", state: "watching", docs: 12, records: 40, error: null },
];

const ready = {
  nodePhase: "ready" as const,
  nodeState: "running" as const,
  corpora,
  memoryState: "present" as const,
  jobs: [],
};

describe("serviceState", () => {
  test("starting outranks every other condition", () => {
    const result = serviceState({
      ...ready,
      nodePhase: "starting",
      nodeState: "stopped",
      corpora: [{ ...corpora[0]!, error: "broken" }],
    });
    expect(result.name).toBe("starting");
  });

  test("a stopped node reports stopped, not degraded", () => {
    expect(serviceState({ ...ready, nodeState: "stopped" }).name).toBe(
      "stopped",
    );
  });

  test("a broken corpus reports degraded and names the error", () => {
    const result = serviceState({
      ...ready,
      corpora: [{ ...corpora[0]!, error: "timed out" }],
    });
    expect(result).toEqual({ name: "degraded", detail: "timed out" });
  });

  test("a pass that wrote records but lost its index is missing", () => {
    const result = serviceState({
      ...ready,
      corpora: [{ ...corpora[0]!, docs: 0, records: 12 }],
    });
    expect(result.name).toBe("degraded");
    expect(result.detail).toContain("index missing");
  });

  test("a lost memory index degrades only when corpora exist", () => {
    expect(
      serviceState({ ...ready, memoryState: "lost" }).name,
    ).toBe("degraded");
    expect(
      serviceState({ ...ready, memoryState: "lost", corpora: [] }).name,
    ).toBe("ready");
  });

  test("a memory store that was never populated is not a fault", () => {
    expect(serviceState({ ...ready, memoryState: "empty" }).name).toBe("ready");
  });

  test("a running job reports busy with its label", () => {
    const result = serviceState({
      ...ready,
      jobs: [{ kind: JobKind.Index, label: "indexing", startedAt: 1 }],
    });
    expect(result).toEqual({ name: "busy", detail: "indexing" });
  });

  test("a disabled node is degraded", () => {
    expect(serviceState({ ...ready, nodePhase: "disabled" }).name).toBe(
      "degraded",
    );
  });
});

describe("JobRegistry", () => {
  test("overlapping jobs keep the state busy until both end", () => {
    const registry = new JobRegistry();
    const first = registry.begin(JobKind.Index, "indexing");
    const second = registry.begin(JobKind.Web, "web index");

    expect(registry.load).toBe(2);
    first();
    expect(registry.load).toBe(1);
    expect(registry.detail()).toBe("web index");
    second();
    expect(registry.load).toBe(0);
  });

  test("ending a job twice releases it once", () => {
    const registry = new JobRegistry();
    const end = registry.begin(JobKind.Index, "indexing");
    end();
    end();
    expect(registry.load).toBe(0);
  });

  test("a job past its deadline stops counting and warns once", () => {
    let now = 1_000;
    const stale: JobView[] = [];
    const registry = new JobRegistry({
      now: () => now,
      onStale: (job) => stale.push(job),
    });
    registry.begin(JobKind.Hidden, "hidden docs");

    now += 5 * 60_000 + 1;
    expect(registry.load).toBe(0);
    expect(registry.load).toBe(0);
    expect(stale.length).toBe(1);
  });
});

describe("StateTracker", () => {
  function sink(): { calls: string[]; write: StateSink } {
    const calls: string[] = [];
    return {
      calls,
      write: {
        noteState: (from, to, at, detail) =>
          calls.push(`${from}->${to}@${at}:${detail ?? ""}`),
      },
    };
  }

  test("a deferred view records nothing", () => {
    const log = sink();
    const tracker = new StateTracker(log.write, "starting", 1_000);

    const view = tracker.view({ name: "ready", detail: null }, 1_500);
    expect(view).toEqual({ name: "ready", since: 1_500, detail: null });
    expect(log.calls).toEqual([]);
  });

  test("settling the same state twice records one transition", () => {
    const log = sink();
    const tracker = new StateTracker(log.write, "starting", 1_000);

    tracker.settle({ name: "ready", detail: null }, 1_500);
    tracker.settle({ name: "ready", detail: null }, 2_000);

    expect(log.calls).toEqual(["starting->ready@1500:"]);
  });

  test("a disagreeing first pass cannot log a transition pair", () => {
    const log = sink();
    const tracker = new StateTracker(log.write, "starting", 1_000);

    // One snapshot: the base pass lacks the node, then the full pass finds a
    // corpus whose index is gone and settles on degraded.
    tracker.view({ name: "ready", detail: null }, 1_500);
    tracker.settle({ name: "degraded", detail: "web index missing" }, 1_505);
    expect(log.calls).toEqual(["starting->degraded@1505:web index missing"]);

    // The next snapshot sees the same disagreement and records nothing.
    tracker.view({ name: "ready", detail: null }, 2_000);
    tracker.settle({ name: "degraded", detail: "web index missing" }, 2_005);
    expect(log.calls).toHaveLength(1);
  });

  test("a settled view keeps the original timestamp", () => {
    const log = sink();
    const tracker = new StateTracker(log.write, "starting", 1_000);
    tracker.settle({ name: "ready", detail: null }, 1_500);

    expect(tracker.view({ name: "ready", detail: null }, 9_000)).toEqual({
      name: "ready",
      since: 1_500,
      detail: null,
    });
  });
});

describe("stateBadge", () => {
  test("includes the detail when there is one", () => {
    expect(stateBadge({ name: "ready", detail: null })).toBe("ready");
    expect(stateBadge({ name: "busy", detail: "indexing" })).toBe(
      "busy · indexing",
    );
  });

  test("every state has a glyph", () => {
    for (const name of [
      "starting",
      "ready",
      "busy",
      "degraded",
      "stopped",
    ] as const) {
      expect(stateGlyph(name).length).toBe(1);
    }
  });
});
