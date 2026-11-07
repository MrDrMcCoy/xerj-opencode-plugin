// Turns the local judge's telemetry into a tuning corpus.
//
// Every judgement lands in `<data root>/telemetry/ops.ndjson` as
// `memory.distill.judge` with the model's score, verdict, the heuristic's
// score, the kind, and the outcome. This script reads every rotated ops file,
// prints a summary, and writes one JSONL line per judgement so a later run can
// re-label the borderline cases and measure a wording or threshold change.
//
//   bun run tune:local
//   bun run tune:local --prefix xop-xerj-opencode-plugin-6f7bb383
//   bun run tune:local --out ~/judge-samples.jsonl

import { readdir, readFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { dataRoot, environmentFrom } from "../src/paths.ts";

export interface JudgeRecord {
  readonly at: number;
  readonly prefix: string;
  readonly judge?: string;
  readonly configured?: string;
  readonly verdict?: string;
  readonly score?: number | null;
  readonly heuristicKind?: string;
  readonly heuristicScore?: number;
  readonly kind?: string;
  readonly outcome?: string;
  readonly origin?: string;
  readonly text?: string;
  readonly threshold?: number;
  readonly session?: string;
}

const BUCKETS = 10;

/** Parses every `memory.distill.judge` line from one ops file. */
export function parseOps(text: string, prefix?: string): JudgeRecord[] {
  const records: JudgeRecord[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof value !== "object" || value === null) continue;
    const record = value as Record<string, unknown>;
    if (record.op !== "memory.distill.judge") continue;
    if (prefix !== undefined && record.prefix !== prefix) continue;
    const meta =
      typeof record.meta === "object" && record.meta !== null
        ? (record.meta as Record<string, unknown>)
        : {};
    records.push({
      at: typeof record.at === "number" ? record.at : 0,
      prefix: typeof record.prefix === "string" ? record.prefix : "",
      judge: textOf(meta.judge),
      configured: textOf(meta.configured),
      verdict: textOf(meta.verdict),
      score: typeof meta.score === "number" ? meta.score : null,
      heuristicKind: textOf(meta.heuristicKind),
      heuristicScore:
        typeof meta.heuristicScore === "number" ? meta.heuristicScore : undefined,
      kind: textOf(meta.kind),
      outcome: textOf(meta.outcome),
      origin: textOf(meta.origin),
      text: textOf(meta.text),
      threshold: typeof meta.threshold === "number" ? meta.threshold : undefined,
      session: textOf(meta.session),
    });
  }
  return records;
}

export function summarize(records: readonly JudgeRecord[]): LocalSummary {
  const kept = records.filter((r) => r.verdict === "keep").length;
  const failed = records.filter((r) => r.verdict === "fallback").length;
  const dropped = records.length - kept - failed;
  const keptScores = scores(records, "keep");
  const droppedScores = scores(records, "drop");
  return {
    total: records.length,
    kept,
    dropped,
    fallback: failed,
    promoted: records.filter((r) => r.outcome === "promoted").length,
    duplicates: records.filter((r) => r.outcome === "duplicate").length,
    rejected: records.filter((r) => r.outcome === "rejected").length,
    keptMean: mean(keptScores),
    droppedMean: mean(droppedScores),
    buckets: buckets(records),
  };
}

export interface LocalSummary {
  readonly total: number;
  readonly kept: number;
  readonly dropped: number;
  readonly fallback: number;
  readonly promoted: number;
  readonly duplicates: number;
  readonly rejected: number;
  readonly keptMean: number;
  readonly droppedMean: number;
  readonly buckets: ReadonlyArray<{
    readonly from: number;
    readonly kept: number;
    readonly dropped: number;
  }>;
}

function scores(
  records: readonly JudgeRecord[],
  verdict: string,
): number[] {
  return records
    .filter((record) => record.verdict === verdict)
    .map((record) => record.score)
    .filter((score): score is number => typeof score === "number");
}

function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function buckets(
  records: readonly JudgeRecord[],
): LocalSummary["buckets"] {
  const counts = Array.from({ length: BUCKETS }, (_, index) => ({
    from: index / BUCKETS,
    kept: 0,
    dropped: 0,
  }));
  for (const record of records) {
    if (typeof record.score !== "number") continue;
    const index = Math.min(
      BUCKETS - 1,
      Math.max(0, Math.floor(record.score * BUCKETS)),
    );
    if (record.verdict === "keep") counts[index]!.kept += 1;
    else if (record.verdict === "drop") counts[index]!.dropped += 1;
  }
  return counts;
}

function textOf(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

/** Prints what the store holds and where the tuning corpus went. */
export async function run(): Promise<void> {
  const directory =
    arg("--dir") ?? join(dataRoot(environmentFrom(process.env)), "telemetry");
  const prefix = arg("--prefix");
  const out =
    arg("--out") ??
    resolve(
      process.env.XDG_CACHE_HOME ?? join(process.env.HOME ?? ".", ".cache"),
      "opencode",
      "xerj-tune",
      "judge-samples.jsonl",
    );
  const borderline = Number(arg("--borderline") ?? 10);

  let files: string[];
  try {
    files = (await readdir(directory))
      .filter((name) => /^ops(?:\.\d+)?\.ndjson$/.test(name))
      .sort();
  } catch {
    console.log(`no telemetry directory at ${directory}`);
    return;
  }

  const records: JudgeRecord[] = [];
  for (const file of files) {
    records.push(...parseOps(await readFile(join(directory, file), "utf8"), prefix));
  }
  records.sort((left, right) => left.at - right.at);
  const summary = summarize(records);

  if (records.length === 0) {
    console.log(`no local judge samples in ${directory}${prefix ? ` for ${prefix}` : ""}`);
    return;
  }

  console.log(`samples      ${summary.total}${prefix ? ` · ${prefix}` : ""}`);
  console.log(
    `verdicts     keep ${summary.kept} (${percent(summary.kept / summary.total)}) · ` +
      `drop ${summary.dropped} · fallback ${summary.fallback}`,
  );
  console.log(
    `outcomes     promoted ${summary.promoted} · duplicate ${summary.duplicates} · ` +
      `rejected ${summary.rejected}`,
  );
  console.log(
    `mean score   keep ${summary.keptMean.toFixed(3)} · drop ${summary.droppedMean.toFixed(3)}`,
  );
  console.log("score        kept / dropped");
  for (const bucket of summary.buckets) {
    if (bucket.kept + bucket.dropped === 0) continue;
    console.log(
      `  ${bucket.from.toFixed(1)}-${(bucket.from + 0.1).toFixed(1)}   ${bucket.kept} / ${bucket.dropped}`,
    );
  }

  const near = records
    .filter(
      (record) =>
        typeof record.score === "number" &&
        record.score >= 0.05 &&
        record.score <= 0.25 &&
        record.verdict !== "fallback",
    )
    .slice(-borderline);
  if (near.length > 0) {
    console.log(`\nborderline (last ${near.length})`);
    for (const record of near) {
      console.log(
        `  ${record.verdict} ${record.score?.toFixed(3)} ${(record.kind ?? "-").padEnd(10)} ` +
          `${(record.text ?? "").slice(0, 100)}`,
      );
    }
  }

  await mkdir(dirname(out), { recursive: true, mode: 0o700 });
  await writeFile(
    out,
    `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
    { mode: 0o600 },
  );
  console.log(`\nwrote ${records.length} rows to ${out}`);
}

if (import.meta.main) {
  void run().catch((error: unknown) => {
    console.error(String(error));
    process.exitCode = 1;
  });
}
