// Post-compaction recall.
//
// The host replaces history with a summary, which drops the passages this
// session was working from. This rebuilds a small block from the files those
// passages cited, so the model does not have to rediscover them. It reads only
// files inside the project root and never writes anything.

import { readFile, stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { isPathInside } from "./paths.ts";

/** One cited passage: a project file and the line it started at. */
export interface CitedLocation {
  readonly path: string;
  readonly line: number;
}

export interface RecallResult {
  readonly text: string;
  /** Bytes the block adds to context, header included. */
  readonly bytes: number;
  /** `path:line` keys the block actually carries. */
  readonly locations: ReadonlyArray<string>;
}

// Three passages fit the 600-token default without crowding the turn.
const MAX_LOCATIONS = 3;
// A generated or vendored file can be huge; never read one for a recall.
const MAX_FILE_BYTES = 1_048_576;
// One passage is a window around the cited line, not the whole file.
const LINES_PER_PASSAGE = 24;
const HEADER = [
  "<xerj-recall>",
  "From this session before the host compacted it. " +
    "This is current file text; cite path:line.",
  "",
].join("\n");
const FOOTER = "\n</xerj-recall>";

export type RecallReader = (path: string) => Promise<string | null>;

/** A passage's identity; matches the session dedupe key in the hooks. */
export function recallKey(location: CitedLocation): string {
  return `${location.path}:${location.line}`;
}

export function formatRecallBlock(
  entries: ReadonlyArray<{ readonly location: string; readonly body: string }>,
): string {
  return `${HEADER}${entries.map((entry) => `${entry.location}\n${entry.body}`).join("\n\n")}${FOOTER}`;
}

/**
 * Builds the block from the most recent citations. A file that is gone, too
 * large, outside the project, or already covered by the fresh retrieval is
 * skipped silently: recall is a bonus, never a reason to delay a turn.
 */
export async function buildRecallBlock(options: {
  readonly projectRoot: string;
  readonly locations: ReadonlyArray<CitedLocation>;
  readonly maxBytes: number;
  readonly exclude?: (key: string) => boolean;
  readonly readFile?: RecallReader;
  readonly maxLocations?: number;
}): Promise<RecallResult | null> {
  const budget = options.maxBytes - HEADER.length - FOOTER.length;
  if (budget <= 0) return null;

  const selected = pickLocations(options);
  if (selected.length === 0) return null;

  // Labels, newlines and separators are part of the block, so reserve them
  // before splitting the rest: the result must never exceed `maxBytes`.
  const labels = selected.reduce(
    (sum, location) => sum + Buffer.byteLength(recallKey(location), "utf8") + 1,
    0,
  );
  const separators = Math.max(0, selected.length - 1) * 2;
  const bodyBudget = budget - labels - separators;
  if (bodyBudget <= 0) return null;

  const read = options.readFile ?? defaultReader(options.projectRoot);
  const share = Math.floor(bodyBudget / selected.length);
  const entries: Array<{ location: string; body: string }> = [];

  for (const location of selected) {
    const absolute = resolveCitedPath(options.projectRoot, location.path);
    if (absolute === null) continue;

    const body = await snippet(read, absolute, location.line, share);
    if (body.length === 0) continue;
    entries.push({ location: recallKey(location), body });
  }
  if (entries.length === 0) return null;

  const text = formatRecallBlock(entries);
  return {
    text,
    bytes: Buffer.byteLength(text, "utf8"),
    locations: entries.map((entry) => entry.location),
  };
}

/** Newest citations first, then restored to citation order for reading. */
function pickLocations(options: {
  readonly projectRoot: string;
  readonly locations: ReadonlyArray<CitedLocation>;
  readonly exclude?: (key: string) => boolean;
  readonly maxLocations?: number;
}): CitedLocation[] {
  const limit = options.maxLocations ?? MAX_LOCATIONS;
  const picked: CitedLocation[] = [];

  for (let index = options.locations.length - 1; index >= 0; index -= 1) {
    const location = options.locations[index];
    if (location === undefined) continue;
    if (resolveCitedPath(options.projectRoot, location.path) === null) continue;
    if (options.exclude?.(recallKey(location)) === true) continue;
    picked.push(location);
    if (picked.length >= limit) break;
  }

  return picked.reverse();
}

function resolveCitedPath(projectRoot: string, path: string): string | null {
  // URLs and index identifiers are not files this plugin may read.
  if (path.includes("://")) return null;
  const trimmed = path.trim();
  if (trimmed.length === 0) return null;

  const absolute = isAbsolute(trimmed)
    ? resolve(trimmed)
    : resolve(join(projectRoot, trimmed));
  return isPathInside(projectRoot, absolute) ? absolute : null;
}

function defaultReader(projectRoot: string): RecallReader {
  return async (path) => {
    if (!isPathInside(projectRoot, path)) return null;
    const info = await stat(path).catch(() => null);
    if (!info?.isFile() || info.size > MAX_FILE_BYTES) return null;
    return readFile(path, "utf8").catch(() => null);
  };
}

async function snippet(
  read: RecallReader,
  path: string,
  line: number,
  share: number,
): Promise<string> {
  if (share <= 0) return "";
  const text = await read(path);
  if (text === null) return "";

  const lines = text.split("\n");
  if (lines.length === 0) return "";
  const start = Math.max(0, Math.min(lines.length - 1, line - 1));
  const window = lines.slice(start, start + LINES_PER_PASSAGE).join("\n");
  const trimmed = window.replace(/\s+$/, "");
  if (trimmed.length === 0) return "";

  // Cut on a character boundary; the budget is a cap, not a target.
  return trimmed.length <= share ? trimmed : trimmed.slice(0, share);
}
