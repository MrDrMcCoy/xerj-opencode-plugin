// The idle dreamer: a child session that curates memory and writes a primer.
//
// It starts only after a quiet period, at most once per interval, and never
// writes a project file. Verification and curation run in-process; the child
// session is created with write, edit, shell, and web permissions denied, and
// its prompt asks for at most a few tool calls and one short memory.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Plugin } from "@opencode/plugin";
import type { Config } from "../config.ts";
import type { Logger } from "../log.ts";
import type { MemoryStore } from "./store.ts";
import { curateMemories, type CurateSummary } from "./curate.ts";
import { verifyMemories, type VerifySummary } from "./verify.ts";

export interface DreamerSession {
  readonly parentID: string;
  readonly title: string;
  readonly model?: { readonly providerID: string; readonly id: string };
  readonly permissions: ReadonlyArray<{
    readonly action: string;
    readonly resource: string;
    readonly effect: "allow" | "deny" | "ask";
  }>;
}

export interface DreamerOptions {
  readonly config: Config["memory"]["dreamer"];
  readonly projectRoot: string;
  readonly stateDirectory: string;
  readonly logger: Logger;
  readonly signal: AbortSignal;
  readonly memory: () => MemoryStore | null;
  readonly owns?: (sessionID: string) => boolean;
  readonly createSession: (input: DreamerSession) => Promise<{ readonly id: string }>;
  readonly prompt: (input: { readonly sessionID: string; readonly text: string }) => Promise<unknown>;
  readonly verify?: (memory: MemoryStore) => Promise<VerifySummary>;
  readonly curate?: (memory: MemoryStore) => Promise<CurateSummary>;
  readonly record?: (result: DreamerResult) => void;
}

export interface DreamerResult {
  readonly ran: boolean;
  readonly child: string | null;
  readonly checked: number;
  readonly stale: number;
  readonly merged: number;
  readonly flagged: number;
  readonly reason?: string;
}

/** What the sidebar and panel need, without reading the state file. */
export interface DreamerSnapshot {
  readonly enabled: boolean;
  readonly running: boolean;
  readonly lastRunAt: number | null;
  /** The interval boundary, not the idle deadline. */
  readonly nextRunAt: number | null;
  readonly lastResult: DreamerResult | null;
  readonly runs: number;
  /** Primers or corrections the dreamer's children stored. */
  readonly contributions: number;
}

const STATE_FILE = "dreamer.json";
const DENY: DreamerSession["permissions"] = [
  { action: "edit", resource: "*", effect: "deny" },
  { action: "write", resource: "*", effect: "deny" },
  { action: "bash", resource: "*", effect: "deny" },
  { action: "shell", resource: "*", effect: "deny" },
  { action: "webfetch", resource: "*", effect: "deny" },
];

export class Dreamer {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastRun = 0;
  private lastResult: DreamerResult | null = null;
  private runs = 0;
  private contributions = 0;
  private loaded = false;
  private running = false;
  private readonly children = new Set<string>();

  constructor(private readonly options: DreamerOptions) {}

  /** The figures the sidebar and panel show. Cheap: no file or node read. */
  snapshot(): DreamerSnapshot {
    return {
      enabled: this.options.config.enabled,
      running: this.running,
      lastRunAt: this.lastRun > 0 ? this.lastRun : null,
      nextRunAt:
        this.lastRun > 0
          ? this.lastRun + this.options.config.intervalMs
          : null,
      lastResult: this.lastResult,
      runs: this.runs,
      contributions: this.contributions,
    };
  }

  /** True while one of this dreamer's child sessions is still running. */
  ownsChild(sessionID: string): boolean {
    return this.children.has(sessionID);
  }

  /** A dreamer child stored a new primer; count it and persist the total. */
  noteContribution(): void {
    this.contributions += 1;
    void this.save();
  }

  /** Registers the idle hook and loads the last-run time. */
  async register(ctx: Plugin.Context): Promise<void> {
    if (!this.options.config.enabled) return;
    await this.load();
    await ctx.session.hook("experimental.idle", (event) => {
      if (this.options.signal.aborted) return;
      if (this.children.delete(event.sessionID)) return;
      if ((event.background ?? []).length > 0) return;
      if (this.options.owns !== undefined && !this.options.owns(event.sessionID)) return;
      this.schedule(event.sessionID);
    });
  }

  /** A prompt or tool call arrived; the project is not idle. */
  touch(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  /** One run, public so a test and a manual command can drive it. */
  async runNow(sessionID: string, force = false): Promise<DreamerResult> {
    if (!this.options.config.enabled) return this.result(false, null, "disabled");
    if (this.running || this.options.signal.aborted) {
      return this.result(false, null, "already running");
    }
    await this.load();
    if (
      !force &&
      this.lastRun > 0 &&
      Date.now() - this.lastRun < this.options.config.intervalMs
    ) {
      return this.result(false, null, "interval not elapsed");
    }
    const memory = this.options.memory();
    if (memory === null) return this.result(false, null, "no memory store");

    this.running = true;
    this.lastRun = Date.now();
    await this.save();
    let child: string | null = null;
    let checked = 0;
    let stale = 0;
    let merged = 0;
    let flagged = 0;
    try {
      const verified = await (this.options.verify?.(memory) ??
        verifyMemories({
          memory,
          projectRoot: this.options.projectRoot,
          logger: this.options.logger,
          signal: this.options.signal,
        }));
      checked = verified.checked;
      stale = verified.stale;
      const curated = await (this.options.curate?.(memory) ??
        curateMemories({
          memory,
          logger: this.options.logger,
          signal: this.options.signal,
        }));
      merged = curated.merged;
      flagged = curated.flagged;

      const model = parseModel(this.options.config.model);
      const session = await this.options.createSession({
        parentID: sessionID,
        title: "XERJ dreamer",
        ...(model === null ? {} : { model }),
        permissions: DENY,
      });
      child = session.id;
      this.children.add(child);
      await this.options.prompt({
        sessionID: child,
        text: dreamerPrompt(this.options.config, this.options.projectRoot),
      });
      this.options.logger.info("dreamer ran", {
        child,
        checked,
        stale,
        merged,
        flagged,
      });
    } catch (error) {
      this.options.logger.debug("dreamer failed", String(error));
    } finally {
      this.running = false;
    }
    const result: DreamerResult = {
      ran: child !== null,
      child,
      checked,
      stale,
      merged,
      flagged,
    };
    this.lastResult = result;
    if (result.ran) this.runs += 1;
    await this.save();
    this.options.record?.(result);
    return result;
  }

  private schedule(sessionID: string): void {
    if (this.timer !== null) return;
    if (this.lastRun > 0 && Date.now() - this.lastRun < this.options.config.intervalMs) {
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.runNow(sessionID);
    }, Math.max(0, this.options.config.idleMs));
    this.timer.unref?.();
  }

  private result(ran: boolean, child: string | null, reason?: string): DreamerResult {
    return { ran, child, checked: 0, stale: 0, merged: 0, flagged: 0, ...(reason === undefined ? {} : { reason }) };
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const value = JSON.parse(
        await readFile(join(this.options.stateDirectory, STATE_FILE), "utf8"),
      ) as {
        lastRun?: unknown;
        lastResult?: unknown;
        runs?: unknown;
        contributions?: unknown;
      };
      if (typeof value.lastRun === "number" && Number.isFinite(value.lastRun)) {
        this.lastRun = value.lastRun;
      }
      if (isCount(value.runs)) this.runs = value.runs;
      if (isCount(value.contributions)) this.contributions = value.contributions;
      if (isDreamerResult(value.lastResult)) this.lastResult = value.lastResult;
    } catch {
      // No state yet.
    }
  }

  private async save(): Promise<void> {
    try {
      await mkdir(dirname(join(this.options.stateDirectory, STATE_FILE)), {
        recursive: true,
        mode: 0o700,
      });
      await writeFile(
        join(this.options.stateDirectory, STATE_FILE),
        `${JSON.stringify(
          {
            lastRun: this.lastRun,
            runs: this.runs,
            contributions: this.contributions,
            ...(this.lastResult === null ? {} : { lastResult: this.lastResult }),
          },
          null,
          2,
        )}\n`,
        { mode: 0o600 },
      );
    } catch (error) {
      this.options.logger.debug("could not save the dreamer state", String(error));
    }
  }
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isDreamerResult(value: unknown): value is DreamerResult {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.ran === "boolean" &&
    (record.child === null || typeof record.child === "string") &&
    isCount(record.checked) &&
    isCount(record.stale) &&
    isCount(record.merged) &&
    isCount(record.flagged)
  );
}

export function parseModel(
  value: string | null,
): { providerID: string; id: string } | null {
  if (value === null) return null;
  const slash = value.indexOf("/");
  if (slash <= 0 || slash === value.length - 1) return null;
  return {
    providerID: value.slice(0, slash),
    id: value.slice(slash + 1),
  };
}

function dreamerPrompt(config: Config["memory"]["dreamer"], projectRoot: string): string {
  return [
    `You are the XERJ dreamer for ${projectRoot}.`,
    "Review durable project memory and keep it accurate. Use xerj_recall to read it and",
    "xerj_remember to store at most one short primer or correction.",
    `Stay within ${config.maxTurns} tool calls and about ${config.maxTokens} tokens.`,
    "Do not edit project files, run shell commands, or use the web.",
    "If nothing durable changed, say so and stop.",
  ].join(" ");
}
