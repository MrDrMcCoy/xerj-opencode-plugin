// MCP protocol, as JSON-RPC 2.0 over newline-delimited JSON on stdio. Only the
// parts the plugin needs: initialize, tools/list, tools/call, ping, and the
// notifications a client sends while the server is running.
//
// The handler is pure: a message in, a response out, or null when the message is
// a notification. That keeps the whole protocol testable without a process.

export const PROTOCOL_VERSION = "2024-11-05";
export const SERVER_NAME = "xerj";
export const SERVER_VERSION = "1.0.0";

export interface JsonRpcRequest {
  readonly jsonrpc: "2.0";
  readonly id?: number | string | null;
  readonly method: string;
  readonly params?: unknown;
}

export interface JsonRpcResponse {
  readonly jsonrpc: "2.0";
  readonly id: number | string | null;
  readonly result?: unknown;
  readonly error?: { readonly code: number; readonly message: string; readonly data?: unknown };
}

/** JSON-RPC error codes the server returns. */
export const ErrorCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
} as const;

export interface McpToolDefinition {
  readonly name: string;
  readonly description: string;
  /** JSON Schema for the tool input, as MCP expects under `inputSchema`. */
  readonly input: unknown;
  execute(input: unknown): Promise<unknown>;
}

/** What the protocol handler needs from the server around it. */
export interface McpToolSource {
  tools(): Promise<ReadonlyArray<McpToolDefinition>>;
  /** Free-form text for `initialize`; shown to the client's user. */
  instructions?(): string;
}

/**
 * Handles one parsed message. Returns the response to send, or null when the
 * message was a notification (which by protocol takes no answer).
 */
export async function handleMessage(
  message: unknown,
  source: McpToolSource,
): Promise<JsonRpcResponse | null> {
  if (!isRequest(message)) {
    return error(null, ErrorCode.InvalidRequest, "expected a JSON-RPC 2.0 request");
  }

  const isNotification = message.id === undefined || message.id === null;

  try {
    switch (message.method) {
      case "initialize":
        return respond(message, {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
          instructions:
            source.instructions?.() ??
            "Local code and documentation search. Prefer xerj_search over reading whole files.",
        });
      case "ping":
        return respond(message, {});
      case "tools/list": {
        const tools = await source.tools();
        return respond(message, {
          tools: tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.input,
          })),
        });
      }
      case "tools/call":
        return await callTool(message, source);
      default:
        // A notification for an unknown method is ignored; a request is an
        // error the client can report.
        if (isNotification) return null;
        return error(
          message.id ?? null,
          ErrorCode.MethodNotFound,
          `unknown method: ${message.method}`,
        );
    }
  } catch (cause) {
    return error(
      message.id ?? null,
      ErrorCode.InternalError,
      cause instanceof Error ? cause.message : String(cause),
    );
  }
}

async function callTool(
  message: JsonRpcRequest,
  source: McpToolSource,
): Promise<JsonRpcResponse> {
  const params = message.params;
  if (!isRecord(params) || typeof params.name !== "string") {
    return error(message.id ?? null, ErrorCode.InvalidParams, "tools/call needs a tool name");
  }

  const tools = await source.tools();
  const tool = tools.find((candidate) => candidate.name === params.name);
  if (tool === undefined) {
    return error(message.id ?? null, ErrorCode.InvalidParams, `unknown tool: ${params.name}`);
  }

  const input = isRecord(params.arguments) ? params.arguments : {};
  const result = await tool.execute(input);

  // The plugin's tools answer `{ content: string }`; MCP wants a content array.
  return respond(message, toMcpResult(result));
}

/** Maps a tool answer onto MCP's `CallToolResult` shape. */
export function toMcpResult(result: unknown): {
  content: Array<{ type: "text"; text: string }>;
  isError: boolean;
  structuredContent?: Record<string, unknown>;
} {
  if (isRecord(result) && typeof result.content === "string") {
    const metadata = isRecord(result.metadata) ? result.metadata : undefined;
    const structured = isRecord(metadata?.xerj) ? metadata.xerj : undefined;
    return structured === undefined
      ? { content: [{ type: "text", text: result.content }], isError: false }
      : {
          content: [{ type: "text", text: result.content }],
          isError: false,
          structuredContent: structured,
        };
  }

  if (typeof result === "string") {
    return { content: [{ type: "text", text: result }], isError: false };
  }

  return {
    content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    isError: false,
  };
}

function respond(message: JsonRpcRequest, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id: message.id ?? null, result };
}

function error(
  id: number | string | null,
  code: number,
  message: string,
): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function isRequest(value: unknown): value is JsonRpcRequest {
  return (
    isRecord(value) &&
    value.jsonrpc === "2.0" &&
    typeof value.method === "string"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
