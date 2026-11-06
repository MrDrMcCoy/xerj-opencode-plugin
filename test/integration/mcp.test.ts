// The MCP server as another agent sees it: a subprocess speaking JSON-RPC over
// stdio. This drives the real entry point against a real node, so a broken
// handshake, a missing tool, or a stdout line that is not JSON-RPC fails here.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveBinary } from "./support.ts";

const scratch: string[] = [];

afterAll(async () => {
  for (const directory of scratch.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

async function directory(prefix: string): Promise<string> {
  const created = await mkdtemp(join(tmpdir(), prefix));
  scratch.push(created);
  return created;
}

interface Sent {
  id?: number;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

/** Sends messages to a fresh server and collects one response per request. */
async function converse(
  messages: ReadonlyArray<Record<string, unknown>>,
  expected: number,
  options: { project: string; storage: string; binary: string },
): Promise<Sent[]> {
  const child = Bun.spawn(["bun", "src/mcp/main.ts", "--project", options.project], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      XERJ_BIN: options.binary,
      XERJ_STORAGE_ROOT: options.storage,
    },
  });

  const send = (message: Record<string, unknown>): void => {
    child.stdin.write(`${JSON.stringify(message)}\n`);
  };

  for (const message of messages) send(message);

  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  const responses: Sent[] = [];
  let buffer = "";
  const deadline = Date.now() + 120_000;

  while (responses.length < expected && Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    let index = buffer.indexOf("\n");
    while (index >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line.length > 0) responses.push(JSON.parse(line) as Sent);
      index = buffer.indexOf("\n");
    }
  }

  child.kill();
  return responses;
}

describe("MCP server", () => {
  test("answers initialize and lists the whole tool surface", async () => {
    const project = await directory("xerj-mcp-project-");
    const storage = await directory("xerj-mcp-storage-");
    const binary = (await resolveBinary(storage)) as string;
    expect(binary.length).toBeGreaterThan(0);
    await writeFile(join(project, "README.md"), "# demo\n\nA small project.\n");

    const responses = await converse(
      [
        { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
        { jsonrpc: "2.0", method: "notifications/initialized" },
        { jsonrpc: "2.0", id: 2, method: "tools/list" },
      ],
      2,
      { project, storage, binary },
    );

    const init = responses.find((response) => response.id === 1);
    expect(init?.result).toMatchObject({
      serverInfo: { name: "xerj" },
      capabilities: { tools: {} },
    });

    const list = responses.find((response) => response.id === 2)?.result as {
      tools: Array<{ name: string; inputSchema: unknown }>;
    };
    expect(list.tools.map((tool) => tool.name).sort()).toEqual([
      "anomaly",
      "def",
      "forget",
      "index",
      "prjdocs",
      "recall",
      "reindex",
      "remember",
      "search",
      "status",
      "sysdocs",
    ]);
    for (const tool of list.tools) expect(tool.inputSchema).toBeDefined();
  }, 180_000);

  test("a status call returns text and starts the node on demand", async () => {
    const project = await directory("xerj-mcp-project-");
    const storage = await directory("xerj-mcp-storage-");
    const binary = (await resolveBinary(storage)) as string;
    expect(binary.length).toBeGreaterThan(0);
    await writeFile(join(project, "README.md"), "# demo\n\nA small project.\n");

    const responses = await converse(
      [
        { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
        { jsonrpc: "2.0", method: "notifications/initialized" },
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "status", arguments: {} },
        },
      ],
      2,
      { project, storage, binary },
    );

    const call = responses.find((response) => response.id === 2)?.result as {
      content: Array<{ type: string; text: string }>;
      isError: boolean;
    };

    expect(call.isError).toBe(false);
    expect(call.content[0]?.type).toBe("text");
    expect(call.content[0]?.text).toContain("node");
  }, 180_000);
});
