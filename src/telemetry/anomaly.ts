// On-demand anomaly scoring. XERJ has no datafeed: creating a detector and
// scoring it returns the whole timeline, and only the flagged buckets are
// formatted for the model.
//
// Verified against v1.0.0-rc.100: PUT creates or replaces a detector;
// POST /_score accepts `anomaly_threshold`; the response carries
// `anomaly_count` and an `anomalies` array with timestamp, actual, expected,
// z-score, and score.

import { createHash } from "node:crypto";
import type { Logger } from "../log.ts";
import type { XerjClient } from "../node/client.ts";

export type AnomalyFunction = "count" | "mean" | "min" | "max" | "sum";

const FUNCTIONS: ReadonlySet<string> = new Set(["count", "mean", "min", "max", "sum"]);
const DEFAULT_TIME_FIELD = "@timestamp";
const DEFAULT_BUCKET_SPAN = "1h";
const DEFAULT_THRESHOLD = 3;
const MAX_POINTS = 10;

export interface AnomalyRequest {
  readonly index: string;
  readonly timeField?: string;
  readonly function?: string;
  readonly field?: string;
  readonly bucketSpan?: string;
  readonly threshold?: number;
}

export interface AnomalyPoint {
  readonly timestamp: string;
  readonly actual: number | null;
  readonly expected: number | null;
  readonly zScore: number | null;
  readonly score: number | null;
}

export interface AnomalyResult {
  readonly detector: string;
  readonly index: string;
  readonly anomalyCount: number;
  readonly buckets: number;
  readonly threshold: number;
  readonly points: ReadonlyArray<AnomalyPoint>;
}

export class AnomalyService {
  constructor(
    private readonly client: XerjClient,
    private readonly logger: Logger,
  ) {}

  async score(request: AnomalyRequest): Promise<AnomalyResult> {
    const index = request.index.trim();
    if (index.length === 0) throw new Error("anomaly index is required");

    const fn = normalizeFunction(request.function);
    if (fn !== "count" && (request.field ?? "").trim().length === 0) {
      throw new Error(`anomaly function ${fn} needs a field`);
    }

    const timeField = request.timeField?.trim() || DEFAULT_TIME_FIELD;
    const bucketSpan = request.bucketSpan?.trim() || DEFAULT_BUCKET_SPAN;
    const threshold = normalizeThreshold(request.threshold);
    const detector = detectorId({ index, timeField, fn, field: request.field, bucketSpan });

    const config = {
      source_index: index,
      time_field: timeField,
      function: fn,
      ...(fn === "count" ? {} : { field: request.field }),
      bucket_span: bucketSpan,
      anomaly_threshold: threshold,
      description: `opencode-xerj anomaly detector for ${index}`,
    };

    await this.client.put(
      `/_ml/anomaly_detectors/${encodeURIComponent(detector)}`,
      config,
      "could not create the anomaly detector",
    );

    const response = await this.client.post(
      `/_ml/anomaly_detectors/${encodeURIComponent(detector)}/_score`,
      { anomaly_threshold: threshold },
      "anomaly scoring failed",
    );

    this.logger.debug("scored an anomaly detector", { detector, index });
    return parseAnomalyScore(detector, index, response, threshold);
  }
}

/** Stable per configuration so repeated calls replace one detector. */
export function detectorId(input: {
  index: string;
  timeField: string;
  fn: string;
  field?: string;
  bucketSpan: string;
}): string {
  const parts = [
    input.index,
    input.timeField,
    input.fn,
    input.field ?? "",
    input.bucketSpan,
  ];
  const key = parts.join("|");
  return `xop-${createHash("sha256").update(key).digest("hex").slice(0, 12)}`;
}

export function parseAnomalyScore(
  detector: string,
  index: string,
  response: unknown,
  fallbackThreshold: number,
): AnomalyResult {
  if (!isRecord(response)) throw new Error("malformed anomaly response");

  const raw = Array.isArray(response.anomalies) ? response.anomalies : [];
  const points = raw.flatMap((entry): AnomalyPoint[] => {
    if (!isRecord(entry)) return [];
    const timestamp = stringValue(entry.timestamp_iso) ?? stringValue(entry.timestamp);
    if (timestamp === null) return [];

    return [
      {
        timestamp,
        actual: numberValue(entry.actual),
        expected: numberValue(entry.expected),
        zScore: numberValue(entry.z_score),
        score: numberValue(entry.anomaly_score),
      },
    ];
  });

  return {
    detector,
    index,
    anomalyCount: numberValue(response.anomaly_count) ?? points.length,
    buckets: numberValue(response.bucket_count) ?? numberValue(response.buckets) ?? 0,
    threshold: numberValue(response.anomaly_threshold) ?? fallbackThreshold,
    points,
  };
}

export function formatAnomalies(result: AnomalyResult): string {
  if (result.anomalyCount === 0) {
    return `No anomalies in ${describeBuckets(result.buckets)} (threshold ${result.threshold}).`;
  }

  const summary =
    `${result.anomalyCount} ` +
    `${result.anomalyCount === 1 ? "anomaly" : "anomalies"} in ` +
    `${describeBuckets(result.buckets)} (threshold ${result.threshold}).`;
  const lines = [summary, `detector ${result.detector} over ${result.index}`];

  for (const point of result.points.slice(0, MAX_POINTS)) {
    lines.push(
      [
        point.timestamp,
        `actual=${formatNumber(point.actual)}`,
        `expected=${formatNumber(point.expected)}`,
        `z=${formatNumber(point.zScore, 1)}`,
        `score=${formatNumber(point.score, 1)}`,
      ].join("  "),
    );
  }

  if (result.points.length > MAX_POINTS) {
    lines.push(`… ${result.points.length - MAX_POINTS} more`);
  }
  return lines.join("\n");
}

function describeBuckets(buckets: number): string {
  return buckets > 0 ? `${buckets} buckets` : "the scored timeline";
}

function normalizeFunction(value: string | undefined): AnomalyFunction {
  const fn = (value ?? "count").trim().toLowerCase();
  if (!FUNCTIONS.has(fn)) {
    throw new Error(`anomaly function must be one of ${[...FUNCTIONS].join(", ")}`);
  }
  return fn as AnomalyFunction;
}

function normalizeThreshold(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_THRESHOLD;
  }
  return value;
}

function formatNumber(value: number | null, digits = 2): string {
  return value === null ? "-" : value.toFixed(digits);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
