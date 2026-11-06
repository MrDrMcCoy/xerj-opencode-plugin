// Pre-compaction capture.
//
// The `compaction` hook runs before the host builds its summary, so the whole
// window is still available: tool output, intermediate assistant text, and the
// prompts that produced them. A summary compresses that away. This flattens the
// window into the turn archive first, bounded by size and message count, and
// remembers which message ids it stored so a retried compaction does not append
// the same text twice.
//
// Only text and tool-result bodies are kept. Media, reasoning, and the host's
// own compaction markers are skipped: they are large, private, or not project
// text, and none of them help a later `xerj_expand`.

import { createHash } from "node:crypto";
import type { Plugin } from "@opencode/plugin";
import type { Logger } from "../log.ts";
import type { ArchiveRecord, TurnArchive, TurnRole } from "./turns.ts";

export const MAX_WINDOW_BYTES = 200 * 1024;
export const MAX_WINDOW_MESSAGES = 40;
const MAX_MESSAGE_CHARS = 4000;
const MAX_TRACKED_SESSIONS = 200;

export interface WindowCapture {
  /** Oldest first, so the archive reads in conversation order. */
  readonly records: ReadonlyArray<ArchiveRecord>;
  readonly bytes: number;
  /** Message ids the caller adds to its seen set after a successful write. */
  readonly ids: ReadonlyArray<string>;
}

export interface CompactionArchiveOptions {
  readonly archive: TurnArchive;
  readonly logger: Logger;
  /** Limits capture to this instance's sessions; omitted, every one counts. */
  readonly owns?: (sessionID: string) => boolean;
  readonly maxBytes?: number;
  readonly maxMessages?: number;
}

/**
 * Flattens the newest messages that were not captured before. A single
 * oversized message is clipped rather than dropped: its first lines are still
 * more useful than an empty window.
 */
export function captureWindow(options: {
  readonly messages: ReadonlyArray<unknown>;
  readonly seen: ReadonlySet<string>;
  readonly maxBytes?: number;
  readonly maxMessages?: number;
}): WindowCapture {
  const maxBytes = options.maxBytes ?? MAX_WINDOW_BYTES;
  const maxMessages = options.maxMessages ?? MAX_WINDOW_MESSAGES;

  const picked: Array<{ id: string; record: ArchiveRecord }> = [];
  let bytes = 0;

  for (let index = options.messages.length - 1; index >= 0; index -= 1) {
    if (picked.length >= maxMessages) break;
    const message = asMessage(options.messages[index]);
    if (message === null) continue;

    const text = flattenMessage(message);
    if (text.length === 0) continue;
    const id = message.id ?? contentId(message.role, text);
    if (options.seen.has(id)) continue;

    const remaining = maxBytes - bytes;
    if (remaining <= 0) break;
    const body = text.length <= remaining ? text : text.slice(0, remaining);
    picked.push({ id, record: { role: message.role, text: body } });
    bytes += Buffer.byteLength(body, "utf8");
  }

  picked.reverse();
  return {
    records: picked.map((entry) => entry.record),
    bytes,
    ids: picked.map((entry) => entry.id),
  };
}

interface WindowMessage {
  readonly id: string | null;
  readonly role: TurnRole;
  readonly content: ReadonlyArray<unknown>;
}

function asMessage(value: unknown): WindowMessage | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as { id?: unknown; role?: unknown; content?: unknown };
  const role = asRole(record.role);
  if (role === null || !Array.isArray(record.content)) return null;
  const id =
    typeof record.id === "string" && record.id.length > 0 ? record.id : null;
  return { id, role, content: record.content };
}

function asRole(value: unknown): TurnRole | null {
  return value === "user" ||
    value === "assistant" ||
    value === "tool" ||
    value === "system"
    ? value
    : null;
}

/** Text and tool-result bodies; everything else is skipped by type. */
function flattenMessage(message: WindowMessage): string {
  const blocks: string[] = [];
  for (const part of message.content) {
    const text = flattenPart(part);
    if (text.length > 0) blocks.push(text);
  }
  return blocks.join("\n\n").trim().slice(0, MAX_MESSAGE_CHARS);
}

function flattenPart(value: unknown): string {
  if (typeof value !== "object" || value === null) return "";
  const part = value as { type?: unknown };
  if (part.type === "text") {
    const text = (part as { text?: unknown }).text;
    return typeof text === "string" ? text.trim() : "";
  }
  if (part.type === "tool-result") return flattenToolResult(part);
  return "";
}

function flattenToolResult(value: unknown): string {
  const result = (value as { result?: unknown }).result;
  if (typeof result === "string") return result.trim();
  if (typeof result !== "object" || result === null) return "";

  const record = result as { type?: unknown; text?: unknown; error?: unknown; content?: unknown };
  if (record.type === "text" && typeof record.text === "string") {
    return record.text.trim();
  }
  if (record.type === "error" && typeof record.error === "string") {
    return `error: ${record.error}`.trim();
  }
  if (record.type === "content" && Array.isArray(record.content)) {
    return record.content
      .map((item) => {
        if (typeof item !== "object" || item === null) return "";
        const block = item as { type?: unknown; text?: unknown };
        return block.type === "text" && typeof block.text === "string"
          ? block.text.trim()
          : "";
      })
      .filter((text) => text.length > 0)
      .join("\n\n");
  }
  return "";
}

function contentId(role: TurnRole, text: string): string {
  return createHash("sha256").update(`${role}\n${text}`).digest("hex").slice(0, 16);
}

/**
 * Registers the `compaction` hook. Registration is cheap; the write happens
 * inline because the hook must finish before the summary replaces the window,
 * and a failure is logged so compaction proceeds either way.
 */
export async function registerCompactionArchive(
  ctx: Plugin.Context,
  options: CompactionArchiveOptions,
): Promise<void> {
  const seen = new Map<string, Set<string>>();

  await ctx.session.hook("compaction", async (event) => {
    try {
      const sessionID = event.sessionID;
      if (options.owns && !options.owns(sessionID)) return;

      const captured = seen.get(sessionID) ?? new Set<string>();
      const window = captureWindow({
        messages: event.messages,
        seen: captured,
        maxBytes: options.maxBytes,
        maxMessages: options.maxMessages,
      });
      if (window.records.length === 0) return;

      const marker: ArchiveRecord = {
        role: "system",
        text:
          `Compaction window: ${window.records.length} earlier messages ` +
          `captured before the summary.`,
      };
      await options.archive.appendBatch(sessionID, [marker, ...window.records]);

      for (const id of window.ids) captured.add(id);
      seen.delete(sessionID);
      seen.set(sessionID, captured);
      while (seen.size > MAX_TRACKED_SESSIONS) {
        const oldest = seen.keys().next().value;
        if (oldest === undefined) break;
        seen.delete(oldest);
      }
      options.logger.debug("archived the pre-compaction window", {
        sessionID,
        messages: window.records.length,
        bytes: window.bytes,
      });
    } catch (error) {
      options.logger.debug("could not archive the pre-compaction window", String(error));
    }
  });
}
