// Replays the local judge's captured samples through other keep questions and
// thresholds, so a change is decided by evidence instead of intuition.
//
// `bun run tune:local` writes `judge-samples.jsonl`. Add `"label": true` or
// `"label": false` to rows you have judged, then:
//
//   DISTILL_EVAL_JEVOS_URL=http://127.0.0.1:8017 bun run replay:judge
//
// Without labels it reports how a wording or threshold changes the current
// decisions and prints the flipped sentences for review. With labels it prints
// precision, recall, and F1. `--labeled` uses the built-in labelled set
// instead of the live file, which works with no local samples.

import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { JEVOS_KEEP_INSTRUCTIONS } from "../src/jev/judge.ts";
import { ACCEPT, REPORTS, REJECT } from "./distill-labels.ts";
import { parseSamples, type JudgeRecord } from "./tune-local.ts";

export interface Wording {
  readonly name: string;
  readonly instructions: string;
  /** A report question is inverted: a low score means keep. */
  readonly invert?: boolean;
}

export const WORDINGS: ReadonlyArray<Wording> = [
  {
    name: "current",
    instructions: JEVOS_KEEP_INSTRUCTIONS,
  },
  {
    name: "plain",
    instructions:
      "Is the sentence a durable fact about the project that will remain true?",
  },
  {
    name: "applies",
    instructions:
      "Is this a project rule or decision that applies to all future work?",
  },
  {
    name: "report",
    instructions: "Is this sentence a report of work just completed?",
    invert: true,
  },
];

export interface Confusion {
  readonly tp: number;
  readonly fp: number;
  readonly fn: number;
  readonly tn: number;
  readonly precision: number;
  readonly recall: number;
  readonly f1: number;
}

/** Confusion at one threshold; `invert` keeps a low score. */
export function confusion(
  scores: readonly (number | null)[],
  labels: readonly boolean[],
  threshold: number,
  invert = false,
): Confusion {
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let tn = 0;
  for (let index = 0; index < scores.length; index += 1) {
    const score = scores[index];
    const label = labels[index];
    if (score === null || score === undefined || label === undefined) continue;
    const keep = invert ? score <= threshold : score >= threshold;
    if (keep && label) tp += 1;
    else if (keep) fp += 1;
    else if (label) fn += 1;
    else tn += 1;
  }
  const precision = tp + fp === 0 ? 0 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 0 : tp / (tp + fn);
  const f1 =
    precision + recall === 0
      ? 0
      : (2 * precision * recall) / (precision + recall);
  return { tp, fp, fn, tn, precision, recall, f1 };
}

export interface SweepRow {
  readonly threshold: number;
  readonly confusion: Confusion;
}

export function sweep(
  scores: readonly (number | null)[],
  labels: readonly boolean[],
  thresholds: readonly number[],
  invert = false,
): SweepRow[] {
  return thresholds.map((threshold) => ({
    threshold,
    confusion: confusion(scores, labels, threshold, invert),
  }));
}

export function bestRow(rows: readonly SweepRow[]): SweepRow | null {
  let best: SweepRow | null = null;
  for (const row of rows) {
    if (best === null || row.confusion.f1 > best.confusion.f1) best = row;
  }
  return best;
}

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function flag(name: string): boolean {
  return process.argv.includes(name);
}

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function fmt(value: number): string {
  return value.toFixed(3);
}

/** A small concurrency pool so a replay does not flood a single-thread server. */
async function pool<T, R>(
  items: readonly T[],
  size: number,
  run: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(size, items.length) },
    async () => {
      while (next < items.length) {
        const index = next;
        next += 1;
        results[index] = await run(items[index]!);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

async function ask(
  url: string,
  text: string,
  instructions: string,
  timeoutMs: number,
): Promise<number | null> {
  try {
    const response = await fetch(`${url.replace(/\/$/, "")}/v1/systemone`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "jev-latest",
        state: text,
        questions: {
          keep: { type: "noul", instructions },
        },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as {
      answers?: { keep?: { noul?: unknown } };
    };
    const value = body.answers?.keep?.noul;
    return typeof value === "number"
      ? Math.min(1, Math.max(0, value))
      : null;
  } catch {
    return null;
  }
}

function labelledSamples(withNoise: boolean): JudgeRecord[] {
  const rows: JudgeRecord[] = [];
  for (const label of ACCEPT) {
    rows.push({ at: 0, prefix: "labeled", text: label.text, label: true });
  }
  for (const text of REPORTS) {
    rows.push({ at: 0, prefix: "labeled", text, label: false });
  }
  if (withNoise) {
    for (const text of REJECT) {
      rows.push({ at: 0, prefix: "labeled", text, label: false });
    }
  }
  return rows;
}

async function liveSamples(): Promise<JudgeRecord[]> {
  const file =
    arg("--samples") ??
    resolve(
      process.env.XDG_CACHE_HOME ?? join(process.env.HOME ?? ".", ".cache"),
      "opencode",
      "xerj-tune",
      "judge-samples.jsonl",
    );
  return parseSamples(await readFile(file, "utf8"));
}

function thresholdsFromArg(): number[] {
  const value = arg("--thresholds");
  if (value === undefined) {
    return [0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.5];
  }
  return value
    .split(",")
    .map((part) => Number(part))
    .filter((value) => Number.isFinite(value) && value >= 0 && value <= 1);
}

export async function run(): Promise<void> {
  const labeled = flag("--labeled");
  const records = labeled
    ? labelledSamples(flag("--noise"))
    : await liveSamples();
  const usable = records.filter(
    (record) => typeof record.text === "string" && record.text.length > 0,
  );
  const limit = Math.max(1, Number(arg("--limit") ?? 400));
  const sample = usable.slice(-limit);
  const hasLabels =
    sample.length > 0 &&
    sample.every((record) => typeof record.label === "boolean");

  const url =
    arg("--url") ??
    process.env.DISTILL_EVAL_JEVOS_URL?.trim() ??
    "http://127.0.0.1:8017";
  const timeoutMs = Math.max(1_000, Number(arg("--timeout") ?? 30_000));
  const thresholds = thresholdsFromArg();
  const only = arg("--wording");
  const wordings =
    only === undefined
      ? WORDINGS
      : WORDINGS.filter((wording) => wording.name === only);

  if (labeled) {
    console.log(
      `labelled set: ${sample.filter((r) => r.label === true).length} keep · ` +
        `${sample.filter((r) => r.label === false).length} drop` +
        (flag("--noise") ? " (noise included)" : " (reports only)"),
    );
  } else {
    console.log(
      `live samples ${sample.length}${hasLabels ? " with labels" : " without labels"}`,
    );
  }

  const scores = new Map<string, (number | null)[]>();
  for (const wording of wordings) {
    const parts = await pool(sample, 4, (record) =>
      ask(url, record.text ?? "", wording.instructions, timeoutMs),
    );
    scores.set(wording.name, parts);
  }

  for (const wording of wordings) {
    const values = scores.get(wording.name) ?? [];
    const answered = values.filter((score) => score !== null).length;
    if (answered === 0) {
      console.log(`${wording.name}: no answers from ${url}`);
      continue;
    }
    if (!hasLabels) {
      const current = sample.map((record) => record.verdict === "keep");
      const at = DEFAULT_CONFIG.memory.distill.local.threshold / 100;
      let agree = 0;
      let changed = 0;
      const flips: string[] = [];
      for (let index = 0; index < values.length; index += 1) {
        const value = values[index];
        if (value === null || value === undefined) continue;
        const keep = wording.invert ? value <= at : value >= at;
        if (keep === current[index]) agree += 1;
        else {
          changed += 1;
          if (flips.length < 8) {
            flips.push(
              `${keep ? "KEEP" : "drop"} ${fmt(value)} ` +
                `${(sample[index]?.text ?? "").slice(0, 80)}`,
            );
          }
        }
      }
      console.log(
        `${wording.name.padEnd(8)} answered ${answered}/${values.length} · ` +
          `agreement ${percent(agree / answered)} at ${at.toFixed(2)} · ` +
          `${changed} changes vs the current judge`,
      );
      for (const line of flips) console.log(`  ${line}`);
      continue;
    }

    const truth = sample.map((record) => record.label === true);
    const rows = sweep(values, truth, thresholds, wording.invert ?? false);
    const best = bestRow(rows);
    if (best === null) continue;
    console.log(
      `${wording.name.padEnd(8)} best t=${best.threshold.toFixed(2)} · ` +
        `P ${percent(best.confusion.precision)} R ${percent(best.confusion.recall)} ` +
        `F1 ${percent(best.confusion.f1)} · ` +
        `tp ${best.confusion.tp} fp ${best.confusion.fp} ` +
        `fn ${best.confusion.fn} tn ${best.confusion.tn}`,
    );
  }

  const single = wordings[0];
  if (hasLabels && only !== undefined && single !== undefined) {
    const values = scores.get(single.name) ?? [];
    const truth = sample.map((record) => record.label === true);
    console.log(`\n${single.name} by threshold`);
    for (const row of sweep(values, truth, thresholds, single.invert ?? false)) {
      console.log(
        `  ${row.threshold.toFixed(2)}  P ${percent(row.confusion.precision)} ` +
          `R ${percent(row.confusion.recall)} F1 ${percent(row.confusion.f1)} ` +
          `(${row.confusion.tp}/${row.confusion.fp}/${row.confusion.fn}/${row.confusion.tn})`,
      );
    }
  }
}

if (import.meta.main) {
  void run().catch((error: unknown) => {
    console.error(String(error));
    process.exitCode = 1;
  });
}
