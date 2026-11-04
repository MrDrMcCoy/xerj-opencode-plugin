// Opt-in second brain. `autoindex --brain` writes documents under the brain
// prefix and edges to `.xerj-memory-<name>-edges`; it cannot run in watch mode
// (watch requires --no-graph), so brains are one-shot runs after the project
// index and on explicit reindex.

import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "../config.ts";
import type { Logger } from "../log.ts";
import { XerjClient, type ClientObserver } from "../node/client.ts";
import type { BrainSpec } from "../paths.ts";

export interface BrainRun {
  readonly name: string;
  readonly prefix: string;
  /** Epoch ms of the last attempt; 0 means it has not run yet. */
  readonly at: number;
  readonly docs: number;
  readonly edges: number;
  readonly error: string | null;
}

export interface BrainRunSummary {
  readonly docs: number;
  readonly edges: number;
}

export interface BrainIndexerOptions {
  readonly binaryPath: string;
  readonly nodeUrl: string;
  /** Directory holding the engine data; graph journals live under it. */
  readonly stateRoot: string;
  readonly config: Config;
  readonly specs: ReadonlyArray<BrainSpec>;
  readonly logger: Logger;
  readonly observer?: ClientObserver;
  readonly onChange?: () => void;
  readonly onRun?: () => void;
}

const MIN_TIMEOUT_MS = 60_000;

export class BrainIndexer {
  private readonly runs = new Map<string, BrainRun>();
  private readonly client: XerjClient;
  private running = false;

  constructor(private readonly options: BrainIndexerOptions) {
    this.client = new XerjClient(options.nodeUrl, undefined, options.observer);
  }

  /** Configured brains, with zeros for the ones that have not run yet. */
  snapshot(): ReadonlyArray<BrainRun> {
    return this.options.specs.map(
      (spec) =>
        this.runs.get(spec.name) ?? {
          name: spec.name,
          prefix: spec.prefix,
          at: 0,
          docs: 0,
          edges: 0,
          error: null,
        },
    );
  }

  async runAll(): Promise<void> {
    if (this.running) {
      this.options.logger.debug("brain indexing is already running");
      return;
    }

    this.running = true;
    try {
      for (const spec of this.options.specs) await this.run(spec);
    } finally {
      this.running = false;
    }
  }

  private async run(spec: BrainSpec): Promise<void> {
    const info = await stat(spec.directory).catch(() => null);
    if (!info?.isDirectory()) {
      this.record(spec, {
        at: Date.now(),
        docs: 0,
        edges: 0,
        error: `${spec.label} is not a directory`,
      });
      return;
    }

    const args = [
      "autoindex",
      spec.directory,
      "--url",
      this.options.nodeUrl,
      "--prefix",
      spec.prefix,
      "--brain",
      spec.name,
      "--state-dir",
      join(this.options.stateRoot, "state", spec.prefix),
      "--json",
      "--progress",
      "none",
    ];

    if (!this.options.config.index.semantic) args.push("--no-semantic");
    if (this.options.config.index.workers !== null) {
      args.push("--workers", String(this.options.config.index.workers));
    }

    try {
      const output = await run(this.options.binaryPath, args, this.timeoutMs());
      const summary = await this.summarize(spec, parseBrainRun(output));
      this.record(spec, { at: Date.now(), ...summary, error: null });
      this.options.onRun?.();
      this.options.logger.info(`brain ${spec.name} indexed`, summary);
    } catch (error) {
      this.record(spec, {
        at: Date.now(),
        docs: 0,
        edges: 0,
        error: error instanceof Error ? error.message : String(error),
      });
      this.options.logger.warn(`brain ${spec.name} indexing failed`, String(error));
    }
  }

  /** The run document reports edges written, not the graph's live total. */
  private async summarize(
    spec: BrainSpec,
    fallback: BrainRunSummary,
  ): Promise<BrainRunSummary> {
    try {
      const overview = await this.client.get(
        `/_graph/${encodeURIComponent(spec.name)}/overview`,
        "graph overview failed",
      );
      if (!isRecord(overview)) return fallback;

      // `nodes.total` counts section records, not files; keep the run's doc
      // total and take only the live edge count from the overview.
      const edges = isRecord(overview.edges)
        ? numberField(overview.edges, "total")
        : null;

      return {
        docs: fallback.docs,
        edges: edges ?? fallback.edges,
      };
    } catch (error) {
      this.options.logger.debug("could not read the graph overview", String(error));
      return fallback;
    }
  }

  private record(spec: BrainSpec, run: Omit<BrainRun, "name" | "prefix">): void {
    this.runs.set(spec.name, { name: spec.name, prefix: spec.prefix, ...run });
    this.options.onChange?.();
  }

  private timeoutMs(): number {
    return Math.max(MIN_TIMEOUT_MS, this.options.config.index.maxMinutes * 60_000);
  }
}

/** Reads the run document `autoindex --json` prints as its last JSON line. */
export function parseBrainRun(output: string): BrainRunSummary {
  const line = [...output.trim().split("\n")]
    .reverse()
    .find((entry) => entry.trim().startsWith("{"));

  if (!line) return { docs: 0, edges: 0 };

  try {
    const document = JSON.parse(line) as Record<string, unknown>;
    const graph = isRecord(document.graph) ? document.graph : {};
    return {
      docs:
        numberField(document, "records_total") ??
        numberField(document, "records_submitted_this_run") ??
        0,
      edges: numberField(graph, "edges_written") ?? 0,
    };
  } catch {
    return { docs: 0, edges: 0 };
  }
}

function run(
  command: string,
  args: ReadonlyArray<string>,
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";

    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      // Exit 3 completed with junk recorded; the run still counts.
      if (code === 0 || code === 3) resolve(stdout);
      else reject(new Error(`autoindex exited ${code}: ${stderr.trim().slice(0, 300)}`));
    });
  });
}

function numberField(value: Record<string, unknown>, key: string): number | null {
  const found = value[key];
  return typeof found === "number" && Number.isFinite(found) ? found : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
