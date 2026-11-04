// Retrieval accounting. Everything here is measured: bytes actually handed to
// the model, the size of each cited file, and whether the model read that file
// anyway. The last point is what keeps "tokens saved" from being fiction: a
// file the model read in full contributes nothing, even if a passage from it
// was cited first.

import { stat } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";
import type { KeyValueStorage, Logger } from "../log.ts";

export interface CitedFile {
  readonly path: string;
  readonly citations: number;
  readonly bytes: number;
}

export interface LedgerSnapshot {
  readonly queries: number;
  readonly hits: number;
  readonly hitRate: number;
  readonly bytesReturned: number;
  readonly baselineBytes: number;
  readonly filesCited: number;
  readonly filesRead: number;
  readonly bytesRead: number;
  readonly savedBytes: number;
  readonly tokensSaved: number;
  readonly topFiles: ReadonlyArray<CitedFile>;
}

export interface LedgerOptions {
  readonly storage: KeyValueStorage;
  /** Storage key; scoped per project so one panel shows one project's usage. */
  readonly key: string;
  readonly projectRoot: string;
  readonly bytesPerToken: number;
  readonly maxBaselineBytes: number;
  readonly logger: Logger;
}

interface SessionState {
  readonly cited: Map<string, number>;
  readonly citations: Map<string, number>;
  /** Bytes the model already read from a cited file. */
  readonly read: Map<string, number>;
  queries: number;
  hits: number;
  returned: number;
}

interface LifetimeState {
  queries: number;
  hits: number;
  returned: number;
  bytesRead: number;
  readonly cited: Map<string, number>;
  readonly citations: Map<string, number>;
  readonly read: Map<string, number>;
}

const MAX_TRACKED_FILES = 5000;
const FLUSH_DELAY_MS = 2_000;

export class Ledger {
  private readonly sessions = new Map<string, SessionState>();
  private readonly sizes = new Map<string, number>();
  private lifetime: LifetimeState = {
    queries: 0,
    hits: 0,
    returned: 0,
    bytesRead: 0,
    cited: new Map(),
    citations: new Map(),
    read: new Map(),
  };
  private loadPromise: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly options: LedgerOptions) {
    // Warm the persisted counters so the first status after a restart is real.
    void this.load();
  }

  async recordQuery(
    sessionID: string,
    paths: ReadonlyArray<string>,
    bytes: number,
    hits: number,
  ): Promise<void> {
    await this.load();
    const session = this.session(sessionID);

    session.queries += 1;
    session.returned += bytes;
    this.lifetime.queries += 1;
    this.lifetime.returned += bytes;

    if (hits > 0) {
      session.hits += 1;
      this.lifetime.hits += 1;
    }

    for (const path of new Set(paths)) {
      session.citations.set(path, (session.citations.get(path) ?? 0) + 1);
      this.lifetime.citations.set(
        path,
        (this.lifetime.citations.get(path) ?? 0) + 1,
      );

      if (!session.cited.has(path)) {
        const size = await this.fileSize(path);
        if (size === null) continue;
        session.cited.set(path, size);
        this.lifetime.cited.set(path, size);
      }
    }

    this.trim();
    this.scheduleFlush();
  }

  async recordRead(sessionID: string, filePath: string, bytes: number): Promise<void> {
    await this.load();
    const path = this.relative(filePath);
    if (path === null) return;

    // A read with no measured size counts as the whole file.
    const amount = Number.isFinite(bytes) && bytes > 0 ? bytes : Number.POSITIVE_INFINITY;
    const session = this.session(sessionID);
    bumpRead(session.read, path, amount);
    bumpRead(this.lifetime.read, path, amount);

    if (Number.isFinite(amount)) {
      this.lifetime.bytesRead += amount;
    }

    this.scheduleFlush();
  }

  snapshot(sessionID?: string): LedgerSnapshot {
    const session = sessionID ? this.sessions.get(sessionID) : undefined;
    const cited = session?.cited ?? this.lifetime.cited;
    const citations = session?.citations ?? this.lifetime.citations;
    const read = session?.read ?? this.lifetime.read;
    const queries = session?.queries ?? this.lifetime.queries;
    const hits = session?.hits ?? this.lifetime.hits;
    const returned = session?.returned ?? this.lifetime.returned;

    let baseline = 0;
    let filesCited = 0;
    for (const [path, size] of cited) {
      filesCited += 1;
      const alreadyRead = read.get(path) ?? 0;
      baseline += Math.max(0, size - alreadyRead);
    }

    const saved = Math.max(0, baseline - returned);
    return {
      queries,
      hits,
      hitRate: queries === 0 ? 0 : hits / queries,
      bytesReturned: returned,
      baselineBytes: baseline,
      filesCited,
      filesRead: read.size,
      bytesRead: this.lifetime.bytesRead,
      savedBytes: saved,
      tokensSaved: Math.round(saved / this.options.bytesPerToken),
      topFiles: topCited(citations, cited),
    };
  }

  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await this.save();
  }

  private load(): Promise<void> {
    this.loadPromise ??= this.loadFromStorage();
    return this.loadPromise;
  }

  private async loadFromStorage(): Promise<void> {
    const stored = await this.options.storage.get(this.options.key).catch(() => undefined);
    if (typeof stored !== "object" || stored === null) return;

    const record = stored as Record<string, unknown>;
    this.lifetime = {
      queries: numberOr(record.queries, 0),
      hits: numberOr(record.hits, 0),
      returned: numberOr(record.returned, 0),
      bytesRead: numberOr(record.bytesRead, 0),
      cited: fileMap(record.cited),
      citations: countMap(record.citations),
      read: fileMap(record.read),
    };
  }

  private session(sessionID: string): SessionState {
    let session = this.sessions.get(sessionID);
    if (!session) {
      session = {
        cited: new Map(),
        citations: new Map(),
        read: new Map(),
        queries: 0,
        hits: 0,
        returned: 0,
      };
      this.sessions.set(sessionID, session);
    }
    return session;
  }

  private async fileSize(path: string): Promise<number | null> {
    const cached = this.sizes.get(path);
    if (cached !== undefined) return cached;

    const absolute = this.absolute(path);
    if (absolute === null) return null;

    const info = await stat(absolute).catch(() => null);
    if (!info?.isFile()) return null;

    const size = Math.min(info.size, this.options.maxBaselineBytes);
    this.sizes.set(path, size);
    return size;
  }

  private absolute(path: string): string | null {
    const root = resolve(this.options.projectRoot);
    const absolute = isAbsolute(path) ? resolve(path) : resolve(join(root, path));
    if (absolute !== root && !absolute.startsWith(root + sep)) return null;
    return absolute;
  }

  private relative(path: string): string | null {
    const absolute = this.absolute(path);
    if (absolute === null) return null;
    const root = resolve(this.options.projectRoot);
    return absolute === root ? "" : absolute.slice(root.length + 1);
  }

  /** Keeps the tracked set bounded without losing recent evidence. */
  private trim(): void {
    while (this.lifetime.cited.size > MAX_TRACKED_FILES) {
      const oldest = this.lifetime.cited.keys().next().value;
      if (oldest === undefined) break;
      this.lifetime.cited.delete(oldest);
    }
    while (this.lifetime.citations.size > MAX_TRACKED_FILES) {
      const oldest = this.lifetime.citations.keys().next().value;
      if (oldest === undefined) break;
      this.lifetime.citations.delete(oldest);
    }
    while (this.lifetime.read.size > MAX_TRACKED_FILES) {
      const oldest = this.lifetime.read.keys().next().value;
      if (oldest === undefined) break;
      this.lifetime.read.delete(oldest);
    }
  }

  private scheduleFlush(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.save();
    }, FLUSH_DELAY_MS);
  }

  private async save(): Promise<void> {
    const payload = {
      queries: this.lifetime.queries,
      hits: this.lifetime.hits,
      returned: this.lifetime.returned,
      bytesRead: this.lifetime.bytesRead,
      cited: [...this.lifetime.cited].slice(-MAX_TRACKED_FILES),
      citations: [...this.lifetime.citations].slice(-MAX_TRACKED_FILES),
      // Infinity is not JSON; -1 means "the whole file was read".
      read: [...this.lifetime.read]
        .slice(-MAX_TRACKED_FILES)
        .map(([path, amount]) => [path, Number.isFinite(amount) ? amount : -1]),
    };

    await this.options.storage.set(this.options.key, payload as never).catch((error: unknown) => {
      this.options.logger.debug("could not persist stats", String(error));
    });
  }
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function fileMap(value: unknown): Map<string, number> {
  const map = new Map<string, number>();
  if (!Array.isArray(value)) return map;

  for (const entry of value) {
    if (!Array.isArray(entry) || entry.length !== 2) continue;
    const [path, size] = entry;
    if (typeof path === "string" && typeof size === "number") {
      map.set(path, size < 0 ? Number.POSITIVE_INFINITY : size);
    }
  }
  return map;
}

function countMap(value: unknown): Map<string, number> {
  const map = new Map<string, number>();
  if (!Array.isArray(value)) return map;

  for (const entry of value) {
    if (!Array.isArray(entry) || entry.length !== 2) continue;
    const [path, count] = entry;
    if (typeof path === "string" && typeof count === "number" && count > 0) {
      map.set(path, count);
    }
  }
  return map;
}

const TOP_FILES = 5;

function topCited(
  citations: ReadonlyMap<string, number>,
  cited: ReadonlyMap<string, number>,
): CitedFile[] {
  return [...citations.entries()]
    .map(([path, count]) => ({ path, citations: count, bytes: cited.get(path) ?? 0 }))
    .sort((left, right) => right.citations - left.citations || left.path.localeCompare(right.path))
    .slice(0, TOP_FILES);
}

function bumpRead(map: Map<string, number>, path: string, amount: number): void {
  if (map.get(path) === Number.POSITIVE_INFINITY) return;
  if (amount === Number.POSITIVE_INFINITY) {
    map.set(path, amount);
    return;
  }
  map.set(path, (map.get(path) ?? 0) + amount);
}
