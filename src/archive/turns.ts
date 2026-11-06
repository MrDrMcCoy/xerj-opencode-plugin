// An append-only archive of turns, one file per session.
//
// The host compacts history, and what it drops is gone. This keeps the raw
// text so a later turn can expand what a summary replaced. It duplicates
// conversation text on disk inside the project's own `.xerj`, which is mode
// 0700 and self-ignored, and it is bounded: a file past the cap keeps its tail.

import { appendFile, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { Logger } from "../log.ts";

export type TurnRole = "user" | "assistant" | "tool" | "system";

export interface ArchiveRecord {
  readonly role: TurnRole;
  readonly text: string;
}

export interface ArchivedTurn {
  /** One-based position within the session, after pruning. */
  readonly ordinal: number;
  readonly role: TurnRole;
  readonly at: string;
  readonly text: string;
}

export interface TurnArchiveOptions {
  readonly directory: string;
  readonly logger: Logger;
  /** Per-session ceiling. The oldest half is dropped past this. */
  readonly maxBytes?: number;
}

export interface ExpandResult {
  readonly sessionID: string;
  readonly total: number;
  readonly turns: ReadonlyArray<ArchivedTurn>;
}

const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
const MAX_TEXT = 4000;
const FILE = ".ndjson";

export class TurnArchive {
  private readonly directory: string;
  private readonly logger: Logger;
  private readonly maxBytes: number;
  private ready: Promise<void> | null = null;

  constructor(options: TurnArchiveOptions) {
    this.directory = options.directory;
    this.logger = options.logger;
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  }

  /** Appends one turn; a failed write is logged, never thrown at a turn. */
  async append(sessionID: string, role: TurnRole, text: string): Promise<void> {
    const trimmed = text.trim();
    if (trimmed.length === 0 || sessionID.length === 0) return;

    await this.ensureDirectory();
    const path = this.pathFor(sessionID);
    const record = JSON.stringify({
      role,
      at: new Date().toISOString(),
      text: trimmed.slice(0, MAX_TEXT),
    });

    await appendFile(path, `${record}\n`, "utf8").catch((error: unknown) => {
      this.logger.debug("could not archive a turn", String(error));
    });
    await this.prune(path);
  }

  /**
   * Appends several records in one write. Used by the pre-compaction capture,
   * which must not pay a stat-and-prune pass per message.
   */
  async appendBatch(
    sessionID: string,
    records: ReadonlyArray<ArchiveRecord>,
  ): Promise<void> {
    if (sessionID.length === 0 || records.length === 0) return;

    await this.ensureDirectory();
    const at = new Date().toISOString();
    const lines: string[] = [];
    for (const record of records) {
      const text = record.text.trim();
      if (text.length === 0) continue;
      lines.push(
        JSON.stringify({
          role: record.role,
          at,
          text: text.slice(0, MAX_TEXT),
        }),
      );
    }
    if (lines.length === 0) return;

    const path = this.pathFor(sessionID);
    await appendFile(path, `${lines.join("\n")}\n`, "utf8").catch(
      (error: unknown) => {
        this.logger.debug(
          "could not archive a compaction window",
          String(error),
        );
      },
    );
    await this.prune(path);
  }

  /** Turns `start` through `end`, one-based and inclusive. */
  async expand(sessionID: string, start: number, end: number): Promise<ExpandResult> {
    const path = this.pathFor(sessionID);
    const text = await readFile(path, "utf8").catch(() => null);
    if (text === null) return { sessionID, total: 0, turns: [] };

    const all = parseTurns(text);
    const from = Math.max(1, Math.floor(start));
    const to = Math.max(from, Math.floor(end));
    const turns = all.filter((turn) => turn.ordinal >= from && turn.ordinal <= to);
    return { sessionID, total: all.length, turns };
  }

  /** Drops the oldest half when a session's file passes the cap. */
  private async prune(path: string): Promise<void> {
    const info = await stat(path).catch(() => null);
    if (info === null || info.size <= this.maxBytes) return;

    const text = await readFile(path, "utf8").catch(() => null);
    if (text === null) return;
    const lines = text.split("\n").filter((line) => line.trim().length > 0);
    const keep = lines.slice(Math.floor(lines.length / 2));

    const temporary = `${path}.tmp`;
    await writeFile(temporary, keep.length === 0 ? "" : `${keep.join("\n")}\n`, "utf8")
      .then(() => rename(temporary, path))
      .catch((error: unknown) => {
        this.logger.debug("could not prune the turn archive", String(error));
      });
  }

  private async ensureDirectory(): Promise<void> {
    this.ready ??= mkdir(this.directory, { recursive: true, mode: 0o700 })
      .then(() => undefined)
      .catch((error: unknown) => {
        this.logger.debug("could not create the archive directory", String(error));
      });
    await this.ready;
  }

  private pathFor(sessionID: string): string {
    const name = createHash("sha256").update(sessionID).digest("hex").slice(0, 16);
    return join(this.directory, `${name}${FILE}`);
  }
}

function turnRole(value: unknown): TurnRole | null {
  return value === "user" ||
    value === "assistant" ||
    value === "tool" ||
    value === "system"
    ? value
    : null;
}

/** Parses archived lines, numbering them from one. A bad line is skipped. */
export function parseTurns(text: string): ArchivedTurn[] {
  const turns: ArchivedTurn[] = [];
  for (const line of text.split("\n")) {
    if (line.trim().length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof parsed !== "object" || parsed === null) continue;

    const record = parsed as { role?: unknown; at?: unknown; text?: unknown };
    const role = turnRole(record.role);
    const body = typeof record.text === "string" ? record.text : null;
    if (role === null || body === null) continue;

    turns.push({
      ordinal: turns.length + 1,
      role,
      at: typeof record.at === "string" ? record.at : "",
      text: body,
    });
  }
  return turns;
}

/** One-letter labels so a long expansion stays scannable. */
const ROLE_LABELS: Record<TurnRole, string> = {
  user: "U",
  assistant: "A",
  tool: "T",
  system: "S",
};

/** The expansion a tool prints: `[n] U:` for a prompt, `[n] A:` for an answer. */
export function formatExpansion(result: ExpandResult): string {
  if (result.turns.length === 0) {
    return result.total === 0
      ? `No archived turns for ${result.sessionID}.`
      : `That range is outside the ${result.total} archived turns.`;
  }

  return result.turns
    .map((turn) => `[${turn.ordinal}] ${ROLE_LABELS[turn.role]}: ${turn.text}`)
    .join("\n");
}
