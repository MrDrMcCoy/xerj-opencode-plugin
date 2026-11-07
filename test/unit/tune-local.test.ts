import { describe, expect, test } from "bun:test";
import { mergeSamples, parseOps, summarize } from "../../scripts/tune-local.ts";

function line(meta: Record<string, unknown>, op = "memory.distill.judge"): string {
  return JSON.stringify({
    at: 1,
    op,
    ms: 0,
    ok: true,
    load: 0,
    prefix: "xop-demo-1a2b3c4d",
    meta,
  });
}

describe("local judge telemetry", () => {
  test("reads judge rows and skips every other op", () => {
    const text = [
      line({ verdict: "keep", score: 0.7, outcome: "promoted", text: "a" }),
      line({ verdict: "drop", score: 0.1, outcome: "rejected", text: "b" }),
      line({ verdict: "keep" }, "memory.distill"),
      line({ verdict: "keep" }, "memory.recall"),
      "not json",
      "",
    ].join("\n");

    const records = parseOps(text);
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      verdict: "keep",
      score: 0.7,
      outcome: "promoted",
      text: "a",
    });
  });

  test("filters by project prefix", () => {
    const text = line({ verdict: "keep", score: 0.5 });
    expect(parseOps(text, "xop-other-00000000")).toHaveLength(0);
    expect(parseOps(text, "xop-demo-1a2b3c4d")).toHaveLength(1);
  });

  test("merging keeps history and a human label", () => {
    const merged = mergeSamples(
      [
        { at: 1, prefix: "p", text: "a", label: true },
        { at: 2, prefix: "p", text: "b", label: false },
      ],
      [
        { at: 1, prefix: "p", text: "a", verdict: "keep" },
        { at: 3, prefix: "p", text: "c", verdict: "drop" },
      ],
    );

    expect(merged).toHaveLength(3);
    expect(merged[0]).toMatchObject({ text: "a", label: true, verdict: "keep" });
    expect(merged[2]).toMatchObject({ text: "c", verdict: "drop" });
  });

  test("summarizes verdicts, outcomes, means, and score buckets", () => {
    const records = parseOps(
      [
        line({ verdict: "keep", score: 0.8, outcome: "promoted" }),
        line({ verdict: "keep", score: 0.4, outcome: "duplicate" }),
        line({ verdict: "drop", score: 0.2, outcome: "rejected" }),
        line({ verdict: "fallback", score: 0.3, outcome: "rejected" }),
      ].join("\n"),
    );
    const summary = summarize(records);

    expect(summary).toMatchObject({
      total: 4,
      kept: 2,
      dropped: 1,
      fallback: 1,
      promoted: 1,
      duplicates: 1,
      rejected: 2,
    });
    expect(summary.keptMean).toBeCloseTo(0.6);
    expect(summary.droppedMean).toBeCloseTo(0.2);
    expect(summary.buckets[8]).toEqual({ from: 0.8, kept: 1, dropped: 0 });
    expect(summary.buckets[2]).toEqual({ from: 0.2, kept: 0, dropped: 1 });
  });
});
