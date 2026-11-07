// The MCP host builds its own runtime from a project directory. Booting a node
// belongs to the integration suite; this file covers everything that must be
// right before any node exists: settings, paths, and the tool definitions a
// client lists at connect time.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpHost } from "../../src/mcp/host.ts";

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

describe("McpHost", () => {
  test("the project defaults to the working directory", () => {
    const host = new McpHost({ env: {} });
    expect(host.projectRoot).toBe(process.cwd());
  });

  test("paths derive from the project, not from the environment", async () => {
    const project = await directory("xerj-mcp-host-");
    const storage = await directory("xerj-mcp-state-");
    const host = new McpHost({
      projectRoot: project,
      env: { XERJ_STORAGE_ROOT: storage },
    });

    expect(host.storageRoot).toBe(storage);
    expect(host.prefix.startsWith("xop-")).toBe(true);
    expect(host.nodeDir).toBe(join(storage, "nodes", host.prefix));
  });

  test("XERJ_BIN pins a binary and XERJ_NODE_URL an existing node", async () => {
    const project = await directory("xerj-mcp-host-");
    const storage = await directory("xerj-mcp-state-");
    const host = new McpHost({
      projectRoot: project,
      env: {
        XERJ_BIN: "/opt/xerj/bin/xerj",
        XERJ_STORAGE_ROOT: storage,
        XERJ_NODE_URL: "http://127.0.0.1:9400",
      },
    });

    expect(host.config.binary.path).toBe("/opt/xerj/bin/xerj");
    expect(host.config.node.url).toBe("http://127.0.0.1:9400");
    expect(host.storageRoot).toBe(storage);
  });

  test("a blank environment value is ignored", async () => {
    const project = await directory("xerj-mcp-host-");
    const host = new McpHost({
      projectRoot: project,
      env: { XERJ_BIN: "   ", XERJ_NODE_URL: "" },
    });

    expect(host.config.binary.path).toBeNull();
    expect(host.config.node.url).toBeNull();
  });

  test("the tool surface is static, so listing it starts nothing", async () => {
    const project = await directory("xerj-mcp-host-");
    const storage = await directory("xerj-mcp-state-");
    const host = new McpHost({
      projectRoot: project,
      env: { XERJ_STORAGE_ROOT: storage },
    });

    const tools = await host.tools();

    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "anomaly",
      "ask",
      "ast",
      "callers",
      "code",
      "complexity",
      "dataset",
      "def",
      "expand",
      "find",
      "forget",
      "hub",
      "impact",
      "imports",
      "index",
      "inspect",
      "notes",
      "outline",
      "prjdocs",
      "recall",
      "refs",
      "reindex",
      "remember",
      "search",
      "status",
      "sysdocs",
      "zoom",
    ]);
    // Every tool carries a description and a JSON schema; a client rejects one
    // that does not.
    for (const tool of tools) {
      expect(tool.description.length).toBeGreaterThan(10);
      expect(tool.input).toBeDefined();
    }
    // A node would have written a pid file under the storage root.
    expect(Bun.file(join(host.nodeDir, "node.pid")).size).toBe(0);
  });

  test("stopping a host that never started is harmless", async () => {
    const project = await directory("xerj-mcp-host-");
    const host = new McpHost({ projectRoot: project, env: {} });
    await expect(host.stop()).resolves.toBeUndefined();
  });
});

describe("McpHost boot against an existing node", () => {
  test("start attaches, builds services, and answers status", async () => {
    const project = await directory("xerj-mcp-host-");
    const storage = await directory("xerj-mcp-state-");
    const fakeBinary = join(storage, "xerj");

    // A stand-in binary: `--version` is the only thing the host asks of it,
    // because XERJ_NODE_URL means "attach, never spawn".
    await writeFile(fakeBinary, "#!/bin/sh\necho 'xerj v1.0.0-rc.101'\n", { mode: 0o755 });

    const server = Bun.serve({
      port: 0,
      fetch: (request) => {
        const url = new URL(request.url);
        if (url.pathname === "/") {
          return Response.json({ cluster_name: "xerj", version: { number: "8.13.0" } });
        }
        if (url.pathname.startsWith("/_memory/")) {
          return Response.json({ count: 2, entries: [] });
        }
        if (url.pathname === "/_cat/indices") {
          return Response.json([
            { index: "xop-test-docs", docs: { count: "5" }, "store.size": "1kb" },
          ]);
        }
        return Response.json({});
      },
    });

    const host = new McpHost({
      projectRoot: project,
      nodeUrl: `http://127.0.0.1:${server.port}`,
      env: { XERJ_BIN: fakeBinary, XERJ_STORAGE_ROOT: storage },
    });

    await host.start();
    const tools = await host.tools();
    const status = tools.find((tool) => tool.name === "status");
    expect(status).toBeDefined();

    const result = (await status?.execute({})) as { content: string };
    expect(result.content).toContain("xerj");

    // The dataset tool runs against the same client, so listing answers from
    // the node rather than failing on a missing service.
    const dataset = tools.find((tool) => tool.name === "dataset");
    const listed = (await dataset?.execute({ action: "list" })) as { content: string };
    expect(listed.content).toContain("xop-test-docs");
    expect(listed.content).toContain("managed");

    await host.stop();
    server.stop(true);
  }, 60_000);
});
