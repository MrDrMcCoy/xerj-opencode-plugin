import { describe, expect, test } from "bun:test";
import {
  AnomalyService,
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

describe("AnomalyService", () => {
  const logger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    entries: async () => [],
    flush: async () => {},
  } as never;

  function service(response: unknown): {
    service: AnomalyService;
    puts: Array<{ path: string; body: unknown }>;
    posts: Array<{ path: string; body: unknown }>;
  } {
    const puts: Array<{ path: string; body: unknown }> = [];
    const posts: Array<{ path: string; body: unknown }> = [];
    const client = {
      put: async (path: string, body: unknown) => {
        puts.push({ path, body });
      },
      post: async (path: string, body: unknown) => {
        posts.push({ path, body });
        return response;
      },
    } as never;
    return { service: new AnomalyService(client, logger), puts, posts };
  }

  test("creates a stable detector then scores it", async () => {
    const { service: subject, puts, posts } = service({
      anomaly_count: 1,
      bucket_count: 16,
      anomaly_threshold: 2,
      anomalies: [{ timestamp_iso: "2026-07-06T00:12:00.000Z", actual: 96 }],
    });

    const result = await subject.score({ index: "cpu_metrics", function: "count" });

    expect(puts[0]?.path).toContain("/_ml/anomaly_detectors/");
    expect(puts[0]?.body).toMatchObject({
      source_index: "cpu_metrics",
      time_field: "@timestamp",
      function: "count",
      anomaly_threshold: 3,
      bucket_span: "1h",
    });
    expect(posts[0]?.path.endsWith("/_score")).toBe(true);
    expect(result.anomalyCount).toBe(1);
    // The response's own threshold wins when it reports one.
    expect(result.threshold).toBe(2);
  });

  test("rejects an empty index and a field-requiring function without a field", async () => {
    const { service: subject } = service({});

    await expect(subject.score({ index: "  " })).rejects.toThrow("index is required");
    await expect(subject.score({ index: "cpu", function: "mean" })).rejects.toThrow(
      "needs a field",
    );
  });

  test("carries the field through for a field function", async () => {
    const { service: subject, puts } = service({ anomalies: [] });
    await subject.score({ index: "cpu", function: "mean", field: "load" });

    expect(puts[0]?.body).toMatchObject({ function: "mean", field: "load" });
  });

  test("an unknown function is an error, not a silent default", async () => {
    const { service: subject } = service({ anomalies: [] });

    await expect(subject.score({ index: "cpu", function: "median" })).rejects.toThrow(
      "must be one of",
    );
  });

  test("a non-positive threshold falls back to the default", async () => {
    const { service: subject, puts } = service({ anomalies: [] });
    const result = await subject.score({ index: "cpu", threshold: -5 });

    expect(puts[0]?.body).toMatchObject({ anomaly_threshold: 3 });
    expect(result.threshold).toBe(3);
  });

  test("accepts a custom time field and bucket span", async () => {
    const { service: subject, puts } = service({ anomalies: [] });
    await subject.score({
      index: "cpu",
      timeField: "ts",
      bucketSpan: "5m",
    });

    expect(puts[0]?.body).toMatchObject({ time_field: "ts", bucket_span: "5m" });
  });
});

describe("formatAnomalies limits", () => {
  test("prints ten buckets and counts the rest", () => {
    const points = Array.from({ length: 13 }, (_, index) => ({
      timestamp: `2026-07-06T00:${String(index).padStart(2, "0")}:00.000Z`,
      actual: 10 + index,
      expected: 10,
      zScore: 3,
      score: 50,
    }));

    const text = formatAnomalies({
      detector: "det",
      index: "cpu",
      anomalyCount: 13,
      buckets: 0,
      threshold: 3,
      points,
    });

    expect(text).toContain("the scored timeline");
    expect(text).toContain("… 3 more");
    expect(text.split("\n").filter((line) => line.includes("actual="))).toHaveLength(10);
  });

  test("a clean score says so", () => {
    const text = formatAnomalies({
      detector: "det",
      index: "cpu",
      anomalyCount: 0,
      buckets: 16,
      threshold: 3,
      points: [],
    });

    expect(text).toContain("16 buckets");
    expect(text.toLowerCase()).toContain("no anomalies");
  });
});
