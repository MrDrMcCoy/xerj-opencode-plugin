// What a finished tool call tells the index. Three signals matter: a fetched
// URL carries a document, a shell command names files it read, and a read tool
// names one file. All of them index in the background so the tool result is
// never delayed, and every failure is logged rather than raised.

import { isAbsolute, resolve, sep } from "node:path";
import type { Logger } from "../log.ts";
import { shellReadPaths } from "../remote/shell.ts";

/** The `content` field of a tool result, whose shape differs per tool. */
const MIN_SPOOLED_CHARS = 200;

export interface ToolResultEvent {
  readonly tool: string;
  readonly status: string;
  readonly sessionID: string;
  readonly input: unknown;
  readonly result: { readonly content?: unknown };
}

export interface ToolResultTargets {
  readonly projectRoot: string;
  readonly logger: Logger;
  /** Document sink; null until the spool is ready. */
  readonly spool: {
    ingestUrl(url: string, content: string): Promise<unknown>;
    ingestExternalFile(
      path: string,
      options?: { skipUnchanged?: boolean },
    ): Promise<unknown>;
  } | null;
  /**
   * Command output sink; null when `cmd.enabled` is off. A host shell result is
   * mirrored so the log covers commands the plugin did not run itself.
   */
  readonly cmd: {
    mirror(
      command: string,
      text: string,
      options: { truncated: boolean },
    ): Promise<{ stem: string; lines: number } | null>;
  } | null;
  /** False when the host clipped the result before the plugin saw it. */
  readonly cmdTruncated: (event: ToolResultEvent) => boolean;
  /** Invalidates the mapping cache after a document lands. */
  readonly invalidate: (() => void) | null;
  /** Records activity so the node's idle timer is accurate. */
  readonly touch: ((sessionID: string) => void) | null;
  readonly recordRead: (
    sessionID: string,
    path: string,
    bytes: number,
  ) => Promise<void>;
}

/** Routes one completed tool call to the indexer that understands it. */
export async function handleToolResult(
  event: ToolResultEvent,
  targets: ToolResultTargets,
): Promise<void> {
  if (event.status !== "completed") return;
  targets.touch?.(event.sessionID);

  mirrorCommandOutput(event, targets);
  if (spoolFetchedUrl(event, targets)) return;
  if (indexShellReads(event, targets)) return;
  await indexExternalRead(event, targets);
}

/**
 * Any tool that fetched a URL (webfetch, an MCP extract, a search) can spool
 * its text. A short result is an error or a list, not a document.
 */
function spoolFetchedUrl(event: ToolResultEvent, targets: ToolResultTargets): boolean {
  const url = urlOf(event.input);
  const content = textOf(event.result.content);
  if (url === null || content === null) return false;
  if (content.length < MIN_SPOOLED_CHARS || targets.spool === null) return false;

  void targets.spool
    .ingestUrl(url, content)
    .then(() => targets.invalidate?.())
    .catch((error: unknown) => {
      targets.logger.debug("could not spool a fetched document", String(error));
    });
  return true;
}

/**
 * Every host shell result is written to the command log so history covers the
 * commands the plugin did not run. `xerj_run` already recorded its own output.
 */
function mirrorCommandOutput(event: ToolResultEvent, targets: ToolResultTargets): void {
  if (event.tool !== "bash" && event.tool !== "shell") return;
  if (targets.cmd === null) return;

  const command = commandOf(event.input);
  const text = textOf(event.result.content);
  if (command === null || text === null || text.trim().length === 0) return;

  void targets.cmd
    .mirror(command, text, { truncated: targets.cmdTruncated(event) })
    .catch((error: unknown) => {
      targets.logger.debug("could not record a command result", String(error));
    });
}

/**
 * Bash reads are invisible per file, so the command is parsed for literal file
 * references and only existing files outside the project are indexed.
 */
function indexShellReads(event: ToolResultEvent, targets: ToolResultTargets): boolean {
  if (event.tool !== "bash" && event.tool !== "shell") return false;

  const command = commandOf(event.input);
  const spool = targets.spool;
  if (command === null || spool === null) return true;

  void readShellFiles(command, event.input, targets).catch((error: unknown) => {
    targets.logger.debug("could not index a shell-read file", String(error));
  });
  return true;
}

async function readShellFiles(
  command: string,
  input: unknown,
  targets: ToolResultTargets,
): Promise<void> {
  const spool = targets.spool;
  if (spool === null) return;

  const read = await shellReadPaths(command, toolCwd(input, targets.projectRoot));
  const paths = read.filter((path) => isOutside(targets.projectRoot, path));
  if (paths.length === 0) return;

  const stored = await Promise.all(
    paths.map((path) =>
      spool.ingestExternalFile(path, { skipUnchanged: true }).catch(() => null),
    ),
  );
  if (stored.some((entry) => entry !== null)) targets.invalidate?.();
}

/** A read outside the project is the only signal that the file matters. */
async function indexExternalRead(
  event: ToolResultEvent,
  targets: ToolResultTargets,
): Promise<void> {
  if (event.tool !== "read") return;

  const filePath = filePathOf(event.input);
  if (filePath === null) return;
  await targets.recordRead(
    event.sessionID,
    filePath,
    contentBytes(event.result.content),
  );

  if (targets.spool === null || !isOutside(targets.projectRoot, filePath)) return;
  void targets.spool
    .ingestExternalFile(filePath, { skipUnchanged: true })
    .then(() => targets.invalidate?.())
    .catch((error: unknown) => {
      targets.logger.debug("could not index an external file", String(error));
    });
}

function urlOf(input: unknown): string | null {
  if (typeof input !== "object" || input === null) return null;
  const value = (input as { url?: unknown }).url;
  return typeof value === "string" ? value : null;
}

function commandOf(input: unknown): string | null {
  if (typeof input !== "object" || input === null) return null;
  const value = (input as { command?: unknown }).command;
  return typeof value === "string" ? value : null;
}

function textOf(content: unknown): string | null {
  return typeof content === "string" ? content : null;
}

/** OpenCode's built-in read uses `filePath`; other tool packs use `path`. */
function filePathOf(input: unknown): string | null {
  if (typeof input !== "object" || input === null) return null;
  const record = input as { filePath?: unknown; path?: unknown };
  if (typeof record.filePath === "string") return record.filePath;
  return typeof record.path === "string" ? record.path : null;
}

/** The working directory a shell tool ran in, when it names one. */
export function toolCwd(input: unknown, fallback: string): string {
  if (typeof input !== "object" || input === null) return fallback;

  const record = input as Record<string, unknown>;
  for (const key of ["cwd", "workdir", "directory"]) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) {
      return isAbsolute(value) ? resolve(value) : resolve(fallback, value);
    }
  }
  return fallback;
}

/** True when the path is outside the project root, which is all we ingest. */
export function isOutside(root: string, filePath: string): boolean {
  const base = resolve(root);
  const absolute = resolve(filePath);
  return absolute !== base && !absolute.startsWith(base + sep);
}

/** Bytes of a tool result, whether it is a string or text parts. */
export function contentBytes(content: unknown): number {
  if (typeof content === "string") return Buffer.byteLength(content, "utf8");
  if (!Array.isArray(content)) return 0;

  return content.reduce((total, entry) => {
    if (typeof entry === "object" && entry !== null && "text" in entry) {
      const text = (entry as { text?: unknown }).text;
      if (typeof text === "string") return total + Buffer.byteLength(text, "utf8");
    }
    return total;
  }, 0);
}
