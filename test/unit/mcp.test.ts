import { PassThrough } from "node:stream";
import { describe, expect, test } from "bun:test";
import {
  ErrorCode,
  handleMessage,
  toMcpResult,
  type McpToolDefinition,
} from "../../src/mcp/protocol.ts";
import { serve } from "../../src/mcp/server.ts";
import { fileStorage } from "../../src/mcp/storage.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tools: McpToolDefinition[] = [
  {
    name: "search",
    description: "Search the index",
    input: { type: "object", properties: { query: { type: "string" } } },
    execute: async (input) => ({
      content: `passage for ${(input as { query?: string }).query ?? ""}`,
      metadata: { xerj: { hits: 1 } },
    }),
  },
  {
    name: "status",
    description: "Report status",
    input: { type: "object", properties: {} },
    execute: async () => "all good",
  },
];

const source = { tools: async () => tools };

describe("MCP protocol", () => {
  test("initialize answers with a version and tool capability", async () => {
    const response = await handleMessage(
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      source,
    );

    expect(response?.id).toBe(1);
    const result = response?.result as {
      protocolVersion: string;
      capabilities: { tools: unknown };
      serverInfo: { name: string };
    };
    expect(result.protocolVersion).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(result.capabilities.tools).toBeDefined();
    expect(result.serverInfo.name).toBe("xerj");
  });

  test("tools/list returns every tool with a JSON schema", async () => {
    const response = await handleMessage(
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      source,
    );

    const result = response?.result as {
      tools: Array<{ name: string; inputSchema: unknown }>;
    };
    expect(result.tools.map((tool) => tool.name)).toEqual(["search", "status"]);
    expect(result.tools[0]?.inputSchema).toBeDefined();
  });

  test("tools/call returns text content and structured metadata", async () => {
    const response = await handleMessage(
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "search", arguments: { query: "idle timeout" } },
      },
      source,
    );

    const result = response?.result as {
      content: Array<{ type: string; text: string }>;
      isError: boolean;
      structuredContent?: Record<string, unknown>;
    };
    expect(result.content[0]?.text).toBe("passage for idle timeout");
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toEqual({ hits: 1 });
  });

  test("an unknown tool is an invalid-params error", async () => {
    const response = await handleMessage(
      { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "nope" } },
      source,
    );

    expect(response?.error?.code).toBe(ErrorCode.InvalidParams);
    expect(response?.error?.message).toContain("unknown tool");
  });

  test("a tool that throws becomes an internal error, not a crash", async () => {
    const failing = {
      tools: async () => [
        {
          name: "boom",
          description: "fails",
          input: {},
          execute: async () => {
            throw new Error("index unavailable");
          },
        },
      ],
    };

    const response = await handleMessage(
      { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "boom" } },
      failing,
    );

    expect(response?.error?.code).toBe(ErrorCode.InternalError);
    expect(response?.error?.message).toContain("index unavailable");
  });

  test("an unknown method is an error, a notification is silent", async () => {
    const request = await handleMessage(
      { jsonrpc: "2.0", id: 6, method: "resources/list" },
      source,
    );
    expect(request?.error?.code).toBe(ErrorCode.MethodNotFound);

    const notification = await handleMessage(
      { jsonrpc: "2.0", method: "notifications/initialized" },
      source,
    );
    expect(notification).toBeNull();
  });

  test("ping answers with an empty result", async () => {
    const response = await handleMessage({ jsonrpc: "2.0", id: 7, method: "ping" }, source);
    expect(response?.result).toEqual({});
  });

  test("a malformed message is rejected without an id", async () => {
    const response = await handleMessage({ method: "initialize" }, source);
    expect(response?.error?.code).toBe(ErrorCode.InvalidRequest);
    expect(response?.id).toBeNull();
  });
});

describe("toMcpResult", () => {
  test("passes a plain string through", () => {
    expect(toMcpResult("text").content[0]?.text).toBe("text");
  });

  test("serializes an object when there is no content field", () => {
    const result = toMcpResult({ indexed: 3 });
    expect(result.content[0]?.text).toContain('"indexed": 3');
  });
});

describe("stdio transport", () => {
  /** Runs `serve` over a pair of memory streams and returns what it wrote. */
  async function run(lines: ReadonlyArray<string>): Promise<string[]> {
    const input = new PassThrough();
    const output = new PassThrough();
    const written: string[] = [];
    output.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString().split("\n")) {
        if (line.trim().length > 0) written.push(line);
      }
    });

    const served = serve({ input, output, source });
    for (const line of lines) input.write(`${line}\n`);
    input.end();
    await served;
    return written;
  }

  test("answers requests and ignores notifications", async () => {
    const written = await run([
      '{"jsonrpc":"2.0","method":"notifications/initialized"}',
      '{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
      '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"status"}}',
    ]);

    const parsed = written.map((line) => JSON.parse(line) as { id: number });
    expect(parsed.map((message) => message.id)).toEqual([1, 2]);
  });

  test("a malformed line reports a parse error and keeps going", async () => {
    const written = await run(["not json", '{"jsonrpc":"2.0","id":9,"method":"ping"}']);

    const parsed = written.map((line) => JSON.parse(line) as { id: number | null });
    expect(parsed[0]?.id).toBeNull();
    expect(parsed[1]?.id).toBe(9);
  });

  test("the ready callback runs after the client's initialized notification", async () => {
    let ready = 0;
    const input = new PassThrough();
    const output = new PassThrough();
    const served = serve({
      input,
      output,
      source,
      onReady: () => {
        ready += 1;
      },
    });

    input.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
    input.write('{"jsonrpc":"2.0","method":"notifications/cancelled"}\n');
    input.end();
    await served;

    expect(ready).toBe(1);
  });
});

describe("fileStorage", () => {
  test("persists values across instances", async () => {
    const dir = await mkdtemp(join(tmpdir(), "xerj-mcp-store-"));
    const path = join(dir, "kv.json");

    const first = fileStorage(path);
    await first.set("stats/lifetime", { queries: 2 });

    const second = fileStorage(path);
    expect(await second.get("stats/lifetime")).toEqual({ queries: 2 });
    expect(second.snapshot()).toEqual({ "stats/lifetime": { queries: 2 } });

    await rm(dir, { recursive: true, force: true });
  });

  test("a missing or corrupt file reads as empty", async () => {
    const dir = await mkdtemp(join(tmpdir(), "xerj-mcp-store-"));
    const path = join(dir, "kv.json");
    const storage = fileStorage(path);
    expect(await storage.get("x")).toBeUndefined();

    await rm(dir, { recursive: true, force: true });
  });
});
