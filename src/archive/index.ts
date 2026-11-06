// The turn archive as a searchable corpus.
//
// Turns are small and append-only, so indexing them is cheap: one document per
// turn, idempotent by a hash of session and ordinal, with a manifest so a turn
// that pruning removed also leaves the index.

import { readdir, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { Logger } from "../log.ts";
import type { XerjClient } from "../node/client.ts";
import { readManifest, writeManifest } from "../manifest.ts";

export interface ArchiveIndexOptions {
  readonly client: XerjClient;
  readonly indexName: string;
  /** The directory the plugin's TurnArchive writes. */
  readonly directory: string;
  readonly statePath: string;
  readonly logger: Logger;
  readonly maxFiles?: number;
  readonly signal?: AbortSignal;
}

export interface ArchiveSummary {
  readonly indexed: number;
  readonly skipped: number;
  readonly pruned: number;
  readonly turns: number;
}

interface ManifestEntry {
  readonly id: string;
  readonly session: string;
  readonly role: string;
  readonly at: string;
  readonly ordinal: number;
}

const MAPPING = {
  properties: {
    // Plain text: a summary of the conversation, small and already prose.
    body: { type: "text" },
    session: { type: "keyword" },
    role: { type: "keyword" },
    at: { type: "date" },
    ordinal: { type: "integer" },
    ax_path: { type: "keyword" },
    title: { type: "text" },
  },
} as const;

const DEFAULT_MAX_FILES = 500;

export function turnId(session: string, ordinal: number): string {
  return createHash("sha256").update(`${session}\n${ordinal}`).digest("hex").slice(0, 20);
}

export class ArchiveIndex {
  constructor(private readonly options: ArchiveIndexOptions) {}

  async run(): Promise<ArchiveSummary> {
    const names = await readdir(this.options.directory)
      .then((entries) => entries.filter((name) => name.endsWith(".ndjson")).sort())
      .catch(() => [] as string[]);
    if (names.length === 0) {
      return { indexed: 0, skipped: 0, pruned: 0, turns: 0 };
    }
    if (names.length > (this.options.maxFiles ?? DEFAULT_MAX_FILES)) {
      this.options.logger.warn("archive index skipped: too many session files", {
        files: names.length,
      });
      return { indexed: 0, skipped: 0, pruned: 0, turns: 0 };
    }

    const manifest = await readManifest<ManifestEntry>(this.options.statePath);
    const next: Record<string, ManifestEntry> = {};
    const actions: Array<{ id: string; source: Record<string, unknown> }> = [];

    for (const name of names) {
      if (this.options.signal?.aborted) break;
      const session = name.replace(/\.ndjson$/, "");
      const text = await readFile(join(this.options.directory, name), "utf8").catch(() => null);
      if (text === null) continue;

      let ordinal = 0;
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
        const body = typeof record.text === "string" ? record.text.trim() : "";
        ordinal += 1;
        if (body.length === 0) continue;

        const id = turnId(session, ordinal);
        const role = record.role === "assistant" ? "assistant" : "user";
        const at = typeof record.at === "string" ? record.at : "";
        next[id] = { id, session, role, at, ordinal };

        // A manifest hit means this turn was already sent; its id is stable, so
        // a re-send would only cost a write.
        if (manifest[id] !== undefined) continue;
        actions.push({
          id,
          source: {
            body,
            session,
            role,
            at: at.length > 0 ? at : undefined,
            ordinal,
            ax_path: `archive/${session}/${ordinal}`,
            title: `${role} turn ${ordinal}`,
          },
        });
      }
    }

    if (actions.length > 0) {
      await this.options.client
        .put(this.options.indexName, MAPPING, "could not create the archive index")
        .catch((error: unknown) => {
          this.options.logger.debug("archive index already present", String(error));
        });
      await this.options.client.bulk(this.options.indexName, actions);
    }

    const gone = Object.keys(manifest).filter((id) => next[id] === undefined);
    if (gone.length > 0) {
      await this.options.client
        .bulkDelete(this.options.indexName, gone)
        .catch((error: unknown) => this.options.logger.debug("could not prune turns", String(error)));
    }

    await writeManifest(this.options.statePath, next, this.options.logger);

    return {
      indexed: actions.length,
      skipped: Object.keys(next).length - actions.length,
      pruned: gone.length,
      turns: Object.keys(next).length,
    };
  }
}
