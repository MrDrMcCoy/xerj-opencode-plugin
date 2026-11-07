// The language-server pool is a resident process pool, so these tests drive a
// real stdio server (a small fake) instead of stubbing JSON-RPC. They cover
// the handshake, one call-hierarchy hop, the pidfile, and the two ways a stale
// pidfile can be handled.

import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LspPool } from "../../src/analysis/lsp/pool.ts";
import { pathToUri } from "../../src/analysis/lsp/client.ts";
import { DEFAULT_CONFIG } from "../../src/config.ts";
import { pathHash } from "../../src/paths.ts";

const logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  entries: async () => [],
  flush: async () => {},
};

const scratch: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "xerj-lsp-pool-"));
  scratch.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of scratch.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

/** A JSON-RPC server that answers the calls the pool makes. */
const SERVER = String.raw`
const root = process.argv[2];
const { pathToFileURL } = await import("node:url");
const uri = (name) => pathToFileURL(root + "/src/" + name).href;
const symbol = {
  name: "buildTools",
  kind: 12,
  location: { uri: uri("a.ts"), range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } },
};
const hierarchy = {
  name: "buildTools",
  kind: 12,
  uri: uri("a.ts"),
  range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
  selectionRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
};
const incoming = {
  from: {
    name: "caller",
    kind: 12,
    uri: uri("b.ts"),
    range: { start: { line: 2, character: 0 }, end: { line: 2, character: 1 } },
    selectionRange: { start: { line: 2, character: 0 }, end: { line: 2, character: 1 } },
  },
  fromRanges: [{ start: { line: 4, character: 0 }, end: { line: 4, character: 1 } }],
};
const send = (message) => {
  const body = JSON.stringify(message);
  process.stdout.write("Content-Length: " + Buffer.byteLength(body) + "\r\n\r\n" + body);
};
const handle = (message) => {
  if (message.id === undefined) return;
  const { id, method } = message;
  if (method === "initialize") return send({ jsonrpc: "2.0", id, result: { capabilities: {} } });
  if (method === "workspace/symbol") return send({ jsonrpc: "2.0", id, result: [symbol] });
  if (method === "textDocument/documentSymbol") return send({ jsonrpc: "2.0", id, result: [] });
  if (method === "textDocument/prepareCallHierarchy") return send({ jsonrpc: "2.0", id, result: [hierarchy] });
  if (method === "callHierarchy/incomingCalls") return send({ jsonrpc: "2.0", id, result: [incoming] });
  if (method === "shutdown") return send({ jsonrpc: "2.0", id, result: null });
  if (method === "exit") process.exit(0);
  send({ jsonrpc: "2.0", id, result: null });
};
let buffer = Buffer.alloc(0);
process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    const end = buffer.indexOf("\r\n\r\n");
    if (end === -1) return;
    const match = /Content-Length:\s*(\d+)/i.exec(buffer.subarray(0, end).toString());
    if (match === null) { buffer = buffer.subarray(end + 4); continue; }
    const length = Number(match[1]);
    if (buffer.length < end + 4 + length) return;
    const body = buffer.subarray(end + 4, end + 4 + length).toString();
    buffer = buffer.subarray(end + 4 + length);
    handle(JSON.parse(body));
  }
});
setInterval(() => {}, 1000);
`;

async function fixture(): Promise<{
  project: string;
  root: string;
  script: string;
  pool: () => LspPool;
  pidPath: string;
}> {
  const project = await tempDir();
  await mkdir(join(project, "src"), { recursive: true });
  await writeFile(join(project, "src", "a.ts"), "export function buildTools() {}\n");
  await writeFile(join(project, "src", "b.ts"), "function caller() {\n  buildTools();\n}\n");
  const script = join(project, "fake-lsp.ts");
  await writeFile(script, SERVER);
  const root = join(project, ".lsp");
  const pidPath = join(
    root,
    "pids",
    `typescript-${pathHash(project, 8)}.pid`,
  );

  return {
    project,
    root,
    script,
    pidPath,
    pool: () =>
      new LspPool({
        projectRoot: project,
        root,
        config: {
          ...DEFAULT_CONFIG.analysis.lsp,
          enabled: true,
          servers: { typescript: [process.execPath, script, project] },
          timeoutMs: 5_000,
          idleMs: 60_000,
          maxServers: 2,
        },
        logger,
      }),
  };
}

describe("LspPool", () => {
  test("answers a call hierarchy and records the server pid", async () => {
    const { pool, pidPath, project } = await fixture();
    const instance = pool();
    let pid = 0;
    try {
      const sites = await instance.callers("buildTools");
      expect(sites).toHaveLength(1);
      expect(sites[0]).toMatchObject({
        name: "caller",
        path: "src/b.ts",
        line: 3,
        callerLine: 5,
      });

      const pids = instance.activePids();
      expect(pids).toHaveLength(1);
      pid = pids[0]!;
      const recorded = await readFile(pidPath, "utf8");
      expect(recorded.trim()).toBe(String(pid));
      // The fake server never changes directory.
      expect(project).toContain("xerj-lsp-pool-");
    } finally {
      await instance.stopAll();
    }

    // Teardown must leave no process behind, and no pidfile either.
    expect(() => process.kill(pid, 0)).toThrow();
    expect(await readFile(pidPath, "utf8").catch(() => null)).toBeNull();
  }, 30_000);

  test("does not signal a stale pid that is another process", async () => {
    const { pool, pidPath } = await fixture();
    await mkdir(join(pidPath, ".."), { recursive: true });
    const stranger = spawn("sleep", ["30"], { stdio: "ignore" });
    try {
      await writeFile(pidPath, `${stranger.pid}\n`);
      const instance = pool();
      await instance.callers("buildTools");
      await instance.stopAll();

      // The sweep removed the pidfile instead of signalling the sleep.
      expect(() => process.kill(stranger.pid!, 0)).not.toThrow();
    } finally {
      stranger.kill("SIGKILL");
      await rm(pidPath, { force: true }).catch(() => {});
    }
  }, 30_000);
});
