// stdio transport. MCP uses newline-delimited JSON-RPC: one message per line,
// no headers, no framing. Responses go to stdout and nothing else may: a stray
// console.log corrupts the stream for the client.

import { createInterface } from "node:readline";
import { handleMessage, type McpToolSource } from "./protocol.ts";

export interface ServeOptions {
  readonly input: NodeJS.ReadableStream;
  readonly output: NodeJS.WritableStream;
  readonly source: McpToolSource;
  /** Called once after the client sends `notifications/initialized`. */
  readonly onReady?: () => void;
}

/**
 * Reads messages until the input closes. Each line is handled in order, so a
 * slow tool call delays later messages rather than interleaving with them.
 */
export async function serve(options: ServeOptions): Promise<void> {
  const lines = createInterface({ input: options.input, crlfDelay: Infinity });

  for await (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;

    let message: unknown;
    try {
      message = JSON.parse(trimmed);
    } catch {
      write(options.output, {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "invalid JSON" },
      });
      continue;
    }

    if (isNotification(message)) {
      if (message.method === "notifications/initialized") options.onReady?.();
      // A cancelled request needs no answer; nothing is queued for it here.
      continue;
    }

    const response = await handleMessage(message, options.source);
    if (response !== null) write(options.output, response);
  }
}

/** One JSON line per message, flushed so a client never waits on a buffer. */
function write(output: NodeJS.WritableStream, message: unknown): void {
  output.write(`${JSON.stringify(message)}\n`);
}

function isNotification(message: unknown): message is { method: string } {
  return (
    typeof message === "object" &&
    message !== null &&
    "method" in message &&
    !("id" in message)
  );
}
