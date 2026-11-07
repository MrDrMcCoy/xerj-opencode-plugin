// Git history as a searchable corpus.
//
// "Why did this change" is answered by a commit, not by a file, and nothing in
// the project corpus holds one. Commits are collected with one `git log` call,
// stored under their own prefix, and re-collected incrementally: only hashes
// the index has not seen are written, and a hash that disappeared (a rebase)
// is removed.

import { spawn } from "node:child_process";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { Logger } from "../log.ts";
import { NodeRequestError, type XerjClient } from "../node/client.ts";

export interface CommitRecord {
  readonly hash: string;
  readonly author: string;
  readonly date: string;
  readonly subject: string;
  readonly body: string;
  readonly files: ReadonlyArray<string>;
}

export interface CommitIndexOptions {
  readonly client: XerjClient;
  readonly indexName: string;
  readonly projectRoot: string;
  /** Where the set of indexed hashes is kept between runs. */
  readonly statePath: string;
  readonly logger: Logger;
  /** Commits to read per run. The newest win; history is trimmed. */
  readonly limit?: number;
  readonly signal?: AbortSignal;
}

export interface CommitSummary {
  readonly indexed: number;
  readonly skipped: number;
  readonly pruned: number;
  readonly discovered: number;
  readonly total: number;
}

const DEFAULT_LIMIT = 500;
const MAX_FILES_PER_COMMIT = 40;
const FIELD = "\x1f";
const RECORD = "\x1e";

/** Reads the newest commits, newest first. */
export async function readCommits(
  projectRoot: string,
  limit: number,
  signal?: AbortSignal,
): Promise<CommitRecord[]> {
  const format = [ "%H", "%an", "%ad", "%s", "%b" ].join(FIELD);
  const raw = await run(
    projectRoot,
    [
      "git",
      "-C",
      projectRoot,
      "log",
      `-n${limit}`,
      "--date=short",
      "--name-only",
      // The marker leads each record: `--name-only` prints a commit's files
      // after its fields, so the marker must open the chunk those files belong
      // to rather than close the one before it.
      `--pretty=format:${RECORD}${format}`,
    ],
    signal,
  );
  if (raw === null) return [];

  const commits: CommitRecord[] = [];
  for (const chunk of raw.split(RECORD)) {
    const trimmed = chunk.trim();
    if (trimmed.length === 0) continue;

    const lines = trimmed.split("\n");
    const fields = (lines.shift() ?? "").split(FIELD);
    if (fields.length < 4) continue;

    const files = lines
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .slice(0, MAX_FILES_PER_COMMIT);

    commits.push({
      hash: fields[0] ?? "",
      author: fields[1] ?? "",
      date: fields[2] ?? "",
      subject: fields[3] ?? "",
      body: (fields[4] ?? "").trim(),
      files,
    });
  }
  return commits.filter((commit) => commit.hash.length > 0);
}

/** One `git` invocation; null when git is missing or the folder is not a repo. */
function run(projectRoot: string, args: string[], signal?: AbortSignal): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn(args[0] ?? "git", args.slice(1), {
      cwd: projectRoot,
      stdio: ["ignore", "pipe", "pipe"],
      signal,
    });
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
    });
    child.on("error", () => resolve(null));
    child.on("close", (code) => resolve(code === 0 ? out : null));
  });
}

const MAPPING = {
  properties: {
    // Plain text: committing a few hundred small documents through the neural
    // embedder would dominate an index pass for little recall gain.
    body: { type: "text" },
    subject: { type: "text" },
    author: { type: "keyword" },
    date: { type: "date" },
    hash: { type: "keyword" },
    ax_path: { type: "keyword" },
    files: { type: "text" },
    title: { type: "text" },
  },
} as const;

export class CommitIndex {
  constructor(private readonly options: CommitIndexOptions) {}

  async run(): Promise<CommitSummary> {
    const limit = this.options.limit ?? DEFAULT_LIMIT;
    const commits = await readCommits(this.options.projectRoot, limit, this.options.signal);
    if (commits.length === 0) {
      return { indexed: 0, skipped: 0, pruned: 0, discovered: 0, total: 0 };
    }

    const known = await this.readState();
    const fresh = commits.filter((commit) => !known.has(commit.hash));
    const present = new Set(commits.map((commit) => commit.hash));
    const gone = [...known].filter((hash) => !present.has(hash));
    // The state keeps only hashes inside the current window: the read limit is
    // the retention policy, so an old hash is neither re-indexed nor pruned.
    const next = new Set(commits.map((commit) => commit.hash));

    if (fresh.length === 0 && gone.length === 0) {
      return {
        indexed: 0,
        skipped: commits.length,
        pruned: 0,
        discovered: commits.length,
        total: commits.length,
      };
    }

    await this.ensureMapping();
    if (fresh.length > 0) {
      const actions = fresh.map((commit) => ({
        id: commit.hash,
        source: {
          hash: commit.hash,
          author: commit.author,
          date: commit.date,
          subject: commit.subject,
          body: [commit.subject, commit.body].filter((part) => part.length > 0).join("\n\n"),
          files: commit.files.join("\n"),
          title: commit.subject,
          ax_path: `git/${commit.hash.slice(0, 7)}`,
        },
      }));
      await this.options.client.bulk(this.options.indexName, actions);
    }
    if (gone.length > 0) {
      await this.options.client
        .bulkDelete(this.options.indexName, gone)
        .catch((error: unknown) => {
          this.options.logger.debug("could not prune commits", String(error));
        });
    }

    await this.writeState(next);
    return {
      indexed: fresh.length,
      skipped: commits.length - fresh.length,
      pruned: gone.length,
      discovered: commits.length,
      total: commits.length,
    };
  }

  private async ensureMapping(): Promise<void> {
    try {
      await this.options.client.put(
        `/${this.options.indexName}`,
        MAPPING,
        "could not create the commit index",
      );
    } catch (error) {
      // 409 means it already exists, which is the normal repeat case. Anything
      // else means the mapping was never created and `_bulk` built the index
      // from dynamic inference instead, so the keyword fields are not keyword.
      const status = error instanceof NodeRequestError ? error.status : null;
      const existing = status === 400 || status === 409;
      const message = "commit index mapping not created";
      if (existing) this.options.logger.debug(message, String(error));
      else this.options.logger.warn(message, String(error));
    }
  }

  private async readState(): Promise<Set<string>> {
    const text = await readFile(this.options.statePath, "utf8").catch(() => null);
    if (text === null) return new Set();
    try {
      const parsed: unknown = JSON.parse(text);
      if (!Array.isArray(parsed)) return new Set();
      return new Set(parsed.filter((entry): entry is string => typeof entry === "string"));
    } catch {
      return new Set();
    }
  }

  private async writeState(hashes: Set<string>): Promise<void> {
    await mkdir(dirname(this.options.statePath), { recursive: true }).catch(() => {});
    await writeFile(this.options.statePath, JSON.stringify([...hashes]), "utf8").catch(
      (error: unknown) => {
        this.options.logger.debug("could not write the commit state", String(error));
      },
    );
  }
}
