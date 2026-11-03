import { describe, expect, test } from "bun:test";
import {
  detectorId,
  formatAnomalies,
  parseAnomalyScore,
} from "../../src/telemetry/anomaly.ts";

const base = { index: "cpu_metrics", timeField: "@timestamp", fn: "mean", field: "cpu", bucketSpan: "1m" };

describe("detectorId", () => {
  test("is stable for one configuration", () => {
    expect(detectorId(base)).toBe(detectorId(base));
    expect(detectorId(base)).toMatch(/^xop-[0-9a-f]{12}$/);
  });

  test("changes when the metric or span changes", () => {
    expect(detectorId(base)).not.toBe(detectorId({ ...base, field: "load" }));
    expect(detectorId(base)).not.toBe(detectorId({ ...base, bucketSpan: "5m" }));
  });
});

describe("parseAnomalyScore", () => {
  test("reads the flagged buckets", () => {
    const response = {
      anomaly_count: 1,
      bucket_count: 16,
      anomaly_threshold: 3,
      anomalies: [
        {
          timestamp_iso: "2026-07-06T00:12:00.000Z",
          actual: 96,
          expected: 20.25,
          z_score: 65.09,
          anomaly_score: 100,
          is_anomaly: true,
        },
      ],
    };

    const result = parseAnomalyScore("det", "cpu_metrics", response, 3);
    expect(result.anomalyCount).toBe(1);
    expect(result.buckets).toBe(16);
    expect(result.points[0]?.timestamp).toContain("00:12");
    expect(result.points[0]?.actual).toBe(96);
  });

  test("falls back to the point count and supplied threshold", () => {
    const result = parseAnomalyScore(
      "det",
      "idx",
      { anomalies: [{ timestamp: "2026-07-06T00:00:00Z", actual: 4 }] },
      5,
    );

    expect(result.anomalyCount).toBe(1);
    expect(result.threshold).toBe(5);
    expect(result.buckets).toBe(0);
  });

  test("rejects a malformed response", () => {
    expect(() => parseAnomalyScore("det", "idx", null, 3)).toThrow();
  });
});

describe("formatAnomalies", () => {
  test("lists flagged buckets compactly", () => {
    const text = formatAnomalies({
      detector: "xop-44bc65022004",
      index: "cpu_metrics",
      anomalyCount: 1,
      buckets: 16,
      threshold: 3,
      points: [
        {
          timestamp: "2026-07-06T00:12:00.000Z",
          actual: 96,
          expected: 20.25,
          zScore: 65.09,
          score: 100,
        },
      ],
    });

    expect(text).toContain("1 anomaly in 16 buckets");
    expect(text).toContain("2026-07-06T00:12:00.000Z");
    expect(text).toContain("actual=96.00");
    expect(text).toContain("score=100.0");
  });

  test("says so when nothing is flagged", () => {
    const text = formatAnomalies({
      detector: "det",
      index: "idx",
      anomalyCount: 0,
      buckets: 16,
      threshold: 3,
      points: [],
    });

    expect(text).toContain("No anomalies");
    expect(text).toContain("threshold 3");
  });
});
