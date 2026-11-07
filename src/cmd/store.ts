// Command output on disk: one pair per command under the project's own state.
//
// `<stem>-cmd.txt` holds the command, `<stem>-out.txt` holds stdout and stderr
// interleaved. The manifest beside them carries what a file cannot: exit code,
// duration, line count, and which lines the index holds. Losing the manifest
// costs those fields, not the text.

import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import type { Logger } from "../log.ts";
import { redactClip } from "../redact.ts";

export type CmdSource = "run" | "host" | "ingest";

export interface CmdEntry {
  readonly stem: string;
  readonly at: number;
  readonly command: string;
  readonly exitCode: number | null;
  readonly durationMs: number;
  readonly bytes: number;
  readonly lines: number;
  readonly truncated: boolean;
  readonly binary: boolean;
  readonly timedOut: boolean;
  readonly source: CmdSource;
  /** Start lines of the windows the index holds; empty until indexed. */
  readonly windows: ReadonlyArray<number>;
  readonly indexedBytes: number;
}

export interface CmdPair {
  readonly stem: string;
  readonly commandPath: string;
  readonly outputPath: string;
  /** Where the runner writes until the command exits. */
  readonly partPath: string;
}

export interface CmdRead {
  readonly lines: ReadonlyArray<string>;
  readonly total: number;
  /** One-based line number of the first returned line. */
  readonly from: number;
}

export interface CmdResult {
  readonly stem: string;
  readonly exitCode: number | null;
  readonly durationMs: number;
  readonly bytes: number;
  readonly lines: number;
  readonly truncated: boolean;
  readonly binary: boolean;
  readonly timedOut: boolean;
}

interface Manifest {
  readonly version: 1;
  readonly entries: Record<string, CmdEntry>;
}

const MANIFEST = "manifest.json";
const MANIFEST_TMP = "manifest.json.tmp";
const CMD_SUFFIX = "-cmd.txt";
const OUT_SUFFIX = "-out.txt";
const PART_SUFFIX = "-out.txt.part";
const COMMAND_CLIP = 4_000;

/** `20261106T192233123Z`: lexical order is age order, and it is filename-safe. */
export function cmdStem(at: number): string {
  const date = new Date(at);
  const pad = (value: number, width = 2): string =>
    String(value).padStart(width, "0");
  return (
    `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
    `T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}` +
    `${pad(date.getUTCMilliseconds(), 3)}Z`
  );
}

/** The inverse, for pruning and for sorting a rebuilt manifest. */
export function stemTime(stem: string): number {
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(\d{3})Z$/.exec(stem);
  if (match === null) return 0;
  const [year, month, day, hour, minute, second, ms] = match
    .slice(1)
    .map((part) => Number(part));
  return Date.UTC(year!, month! - 1, day!, hour!, minute!, second!, ms!);
}

export interface CmdStoreOptions {
  /** `<storage root>/cmd`. */
  readonly directory: string;
  /** Cap for every pair together. */
  readonly maxBytes: number;
  /** Cap for the live index, measured by the caller. */
  readonly maxIndexBytes: number;
  /** One file past this is stored but never read by a tool. */
  readonly maxFileBytes: number;
  readonly logger: Logger;
}

/**
 * One writer per store: stems must be unique, and the manifest is rewritten
 * whole. Both are serialised through one promise chain.
 */
export class CmdStore {
  private readonly directory: string;
  private readonly maxBytes: number;
  private readonly maxIndexBytes: number;
  private readonly maxFileBytes: number;
  private readonly logger: Logger;
  private entries = new Map<string, CmdEntry>();
  private chain: Promise<void> = Promise.resolve();
  private loaded = false;

  constructor(options: CmdStoreOptions) {
    this.directory = options.directory;
    this.maxBytes = options.maxBytes;
    this.maxIndexBytes = options.maxIndexBytes;
    this.maxFileBytes = options.maxFileBytes;
    this.logger = options.logger;
  }

  get path(): string {
    return this.directory;
  }

  async init(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 }).catch((error: unknown) => {
      this.logger.warn("could not create the command output directory", String(error));
    });
    await this.readManifest();
    await this.recoverPartials();
    await this.reconcile();
  }

  /** Newest first, complete entries only. */
  list(limit: number, filter?: string): CmdEntry[] {
    const needle = filter?.trim().toLowerCase() ?? "";
    return [...this.entries.values()]
      .filter((entry) => entry.bytes >= 0 && entry.lines >= 0)
      .filter((entry) => needle.length === 0 || entry.command.toLowerCase().includes(needle))
      .sort((left, right) => right.at - left.at)
      .slice(0, limit);
  }

  get(stem: string): CmdEntry | null {
    return this.entries.get(stem) ?? null;
  }

  all(): CmdEntry[] {
    return [...this.entries.values()];
  }

  /** Reserves a stem and writes the command file; the output follows. */
  async begin(command: string, source: CmdSource, now = Date.now()): Promise<CmdPair> {
    return this.serialise(async () => {
      await this.load();
      let at = now;
      let stem = cmdStem(at);
      while (this.taken(stem)) {
        at += 1;
        stem = cmdStem(at);
      }

      const commandPath = join(this.directory, `${stem}${CMD_SUFFIX}`);
      const outputPath = join(this.directory, `${stem}${OUT_SUFFIX}`);
      const partPath = join(this.directory, `${stem}${PART_SUFFIX}`);
      const text = redactClip(command, COMMAND_CLIP);
      await writeFile(commandPath, `${text}\n`, { mode: 0o600 });
      // A provisional entry keeps the pair out of `list` until it completes,
      // and lets a crash leave something the startup pass can recover.
      this.entries.set(stem, {
        stem,
        at,
        command: text,
        exitCode: null,
        durationMs: 0,
        bytes: -1,
        lines: -1,
        truncated: false,
        binary: false,
        timedOut: false,
        source,
        windows: [],
        indexedBytes: 0,
      });
      await this.writeManifest();
      return { stem, commandPath, outputPath, partPath };
    });
  }

  /** Completes a pair after the command exited. */
  async finish(stem: string, result: CmdResult): Promise<CmdEntry | null> {
    return this.serialise(async () => {
      const pair = this.pathsFor(stem);
      await rename(pair.partPath, pair.outputPath).catch((error: unknown) => {
        this.logger.debug("could not finalise a command output file", String(error));
      });
      const entry = this.entries.get(stem);
      if (entry === undefined) return null;
      const next: CmdEntry = {
        ...entry,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        bytes: result.bytes,
        lines: result.lines,
        truncated: result.truncated,
        binary: result.binary,
        timedOut: result.timedOut,
      };
      this.entries.set(stem, next);
      await this.writeManifest();
      return next;
    });
  }

  /** Records a command whose text the plugin already has (a mirrored result). */
  async record(
    command: string,
    text: string,
    options: {
      readonly source: CmdSource;
      readonly truncated: boolean;
      readonly durationMs?: number;
      readonly bytes?: number;
      readonly lines?: number;
      readonly binary?: boolean;
    },
  ): Promise<CmdEntry | null> {
    const pair = await this.begin(command, options.source);
    const bytes = options.bytes ?? Buffer.byteLength(text, "utf8");
    // Past the cap the mirror is a loss anyway; keep the head and say so.
    const clipped = bytes > this.maxFileBytes ? text.slice(0, this.maxFileBytes) : text;
    const clippedBytes = Buffer.byteLength(clipped, "utf8");
    await writeFile(pair.partPath, clipped, { mode: 0o600 }).catch((error: unknown) => {
      this.logger.warn("could not write a command output file", String(error));
    });
    return this.finish(pair.stem, {
      stem: pair.stem,
      exitCode: null,
      durationMs: options.durationMs ?? 0,
      bytes: clippedBytes,
      lines: countLines(clipped),
      truncated: options.truncated || clippedBytes < bytes,
      binary: options.binary ?? clipped.includes("\u0000"),
      timedOut: false,
    });
  }

  /** The exact lines, one-based and inclusive, plus the file's total. */
  async read(
    stem: string,
    start?: number,
    end?: number,
  ): Promise<CmdRead | null> {
    const entry = this.entries.get(stem);
    if (entry === undefined) return null;
    const path = this.pathsFor(stem).outputPath;
    const size = await stat(path).then((info) => info.size, () => -1);
    if (size < 0 || size > this.maxFileBytes) return null;

    const text = await readFile(path, "utf8").catch(() => null);
    if (text === null) return null;
    const lines = text.split("\n");
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

    const from = Math.max(1, Math.round(start ?? Math.max(1, lines.length - 99)));
    const to = Math.min(
      lines.length,
      Math.round(end ?? (start === undefined ? lines.length : from + 199)),
    );
    return { lines: lines.slice(from - 1, Math.max(from - 1, to)), total: lines.length, from };
  }

  /** Which window starts the index holds, so a re-index stays incremental. */
  async markIndexed(
    stem: string,
    windows: ReadonlyArray<number>,
    indexedBytes: number,
  ): Promise<void> {
    await this.serialise(async () => {
      const entry = this.entries.get(stem);
      if (entry === undefined) return;
      this.entries.set(stem, { ...entry, windows, indexedBytes });
      await this.writeManifest();
    });
  }

  /**
   * Drops the oldest complete pairs until both caps hold. `indexBytes` is the
   * live size of the index, measured by the caller. Returns what was removed so
   * the caller can delete the matching documents.
   */
  async sweep(indexBytes: number): Promise<CmdEntry[]> {
    return this.serialise(async () => {
      await this.load();
      const removed: CmdEntry[] = [];
      let files = await this.totalBytes();
      let index = indexBytes;
      const complete = () =>
        [...this.entries.values()]
          .filter((entry) => entry.bytes >= 0)
          .sort((left, right) => left.at - right.at);

      for (const entry of complete()) {
        if (files <= this.maxBytes && index <= this.maxIndexBytes) break;
        await this.removeFiles(entry.stem);
        this.entries.delete(entry.stem);
        files -= entry.bytes;
        index -= entry.indexedBytes;
        removed.push(entry);
      }

      if (removed.length > 0) await this.writeManifest();
      return removed;
    });
  }

  /** Entries whose files vanished, so the index can forget them too. */
  async reconcile(): Promise<CmdEntry[]> {
    return this.serialise(async () => {
      await this.load();
      const gone: CmdEntry[] = [];
      for (const entry of [...this.entries.values()]) {
        if (entry.bytes < 0) continue;
        const ok = await stat(this.pathsFor(entry.stem).outputPath).then(
          (info) => info.isFile(),
          () => false,
        );
        if (ok) continue;
        this.entries.delete(entry.stem);
        gone.push(entry);
      }
      if (gone.length > 0) await this.writeManifest();
      return gone;
    });
  }

  async totalBytes(): Promise<number> {
    let total = 0;
    const names = await readdir(this.directory).catch(() => [] as string[]);
    for (const name of names) {
      if (name === MANIFEST || name === MANIFEST_TMP) continue;
      total += await stat(join(this.directory, name)).then(
        (info) => info.size,
        () => 0,
      );
    }
    return total;
  }

  private taken(stem: string): boolean {
    return this.entries.has(stem);
  }

  private pathsFor(stem: string): {
    commandPath: string;
    outputPath: string;
    partPath: string;
  } {
    return {
      commandPath: join(this.directory, `${stem}${CMD_SUFFIX}`),
      outputPath: join(this.directory, `${stem}${OUT_SUFFIX}`),
      partPath: join(this.directory, `${stem}${PART_SUFFIX}`),
    };
  }

  private async removeFiles(stem: string): Promise<void> {
    const pair = this.pathsFor(stem);
    await Promise.all([
      rm(pair.commandPath, { force: true }).catch(() => {}),
      rm(pair.outputPath, { force: true }).catch(() => {}),
      rm(pair.partPath, { force: true }).catch(() => {}),
    ]);
  }

  private async serialise<T>(body: () => Promise<T>): Promise<T> {
    const run = this.chain.then(body, body);
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    await this.readManifest();
  }

  private async readManifest(): Promise<void> {
    const text = await readFile(join(this.directory, MANIFEST), "utf8").catch(() => null);
    if (text !== null) {
      try {
        const parsed = JSON.parse(text) as Manifest;
        if (parsed.version === 1 && typeof parsed.entries === "object" && parsed.entries !== null) {
          this.entries = new Map(Object.entries(parsed.entries));
          this.loaded = true;
          return;
        }
      } catch {
        // A corrupt manifest is rebuilt from the pairs below.
      }
    }
    await this.rebuild();
  }

  private async rebuild(): Promise<void> {
    const names = await readdir(this.directory).catch(() => [] as string[]);
    const entries = new Map<string, CmdEntry>();
    for (const name of names) {
      if (!name.endsWith(CMD_SUFFIX)) continue;
      const stem = name.slice(0, -CMD_SUFFIX.length);
      const command = await readFile(join(this.directory, name), "utf8").catch(() => "");
      const output = await stat(join(this.directory, `${stem}${OUT_SUFFIX}`)).catch(() => null);
      if (output === null) continue;
      entries.set(stem, {
        stem,
        at: stemTime(stem),
        command: command.trim(),
        exitCode: null,
        durationMs: 0,
        bytes: output.size,
        lines: 0,
        truncated: false,
        binary: false,
        timedOut: false,
        source: "run",
        windows: [],
        indexedBytes: 0,
      });
    }
    this.entries = entries;
    this.loaded = true;
    await this.writeManifest();
  }

  private async recoverPartials(): Promise<void> {
    const names = await readdir(this.directory).catch(() => [] as string[]);
    for (const name of names) {
      if (!name.endsWith(PART_SUFFIX)) continue;
      const stem = name.slice(0, -PART_SUFFIX.length);
      const entry = this.entries.get(stem);
      // A provisional entry with a partial means the process died; keep what
      // was captured and mark it. A partial with no command file is removed.
      const pair = this.pathsFor(stem);
      const cmdExists = await stat(pair.commandPath).then(() => true, () => false);
      if (!cmdExists) {
        await rm(pair.partPath, { force: true }).catch(() => {});
        continue;
      }
      const info = await stat(pair.partPath).catch(() => null);
      if (info === null) continue;
      await rename(pair.partPath, pair.outputPath).catch(() => {});
      const command = entry?.command ?? (await readFile(pair.commandPath, "utf8").catch(() => "")).trim();
      this.entries.set(stem, {
        stem,
        at: entry?.at ?? stemTime(stem),
        command,
        exitCode: entry?.exitCode ?? null,
        durationMs: entry?.durationMs ?? 0,
        bytes: info.size,
        lines: entry?.lines ?? 0,
        truncated: true,
        binary: entry?.binary ?? false,
        timedOut: entry?.timedOut ?? false,
        source: entry?.source ?? "run",
        windows: entry?.windows ?? [],
        indexedBytes: entry?.indexedBytes ?? 0,
      });
    }
    await this.writeManifest();
  }

  private async writeManifest(): Promise<void> {
    const manifest: Manifest = {
      version: 1,
      entries: Object.fromEntries(this.entries),
    };
    const path = join(this.directory, MANIFEST);
    const temporary = join(this.directory, MANIFEST_TMP);
    await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, {
      mode: 0o600,
    }).catch((error: unknown) => {
      this.logger.debug("could not write the command manifest", String(error));
    });
    await rename(temporary, path).catch((error: unknown) => {
      this.logger.debug("could not replace the command manifest", String(error));
    });
  }
}

export function countLines(text: string): number {
  if (text.length === 0) return 0;
  let lines = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) lines += 1;
  }
  return text.endsWith("\n") ? lines : lines + 1;
}
