// Shared harness for the integration tests. It starts one node against a
// scratch data root, indexes a fixture project, and tears everything down.
//
// The tests are intentionally outside `test/unit`: they need a real binary.
// Set XERJ_BIN to reuse one; otherwise the pinned release is downloaded once
// into the cache directory and reused by later runs.

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { detectRuntime } from "../../src/binary/detect.ts";
import { ensureBinary } from "../../src/binary/manager.ts";
import { DEFAULT_CONFIG } from "../../src/config.ts";
import { autoindexArgs, corpusLayout } from "../../src/index/corpus.ts";
import { createLogger } from "../../src/log.ts";
import { XerjClient } from "../../src/node/client.ts";
import { NodeRuntime } from "../../src/node/runtime.ts";

export interface Harness {
  readonly root: string;
  readonly project: string;
  readonly prefix: string;
  readonly client: XerjClient;
  readonly baseUrl: string;
  readonly binaryPath: string;
  readonly logger: ReturnType<typeof createLogger>;
  index(): Promise<IndexOutcome>;
  reattach(): Promise<boolean>;
  close(): Promise<void>;
}

export interface IndexOutcome {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

const PREFIX = "xop-int-0000";

function memoryStorage(): {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
} {
  const store = new Map<string, unknown>();
  return {
    get: async (key: string) => store.get(key),
    set: async (key: string, value: unknown) => void store.set(key, value),
  };
}

const logger = createLogger(memoryStorage(), { echoToConsole: false });

async function resolveBinary(root: string): Promise<string> {
  const pinned = process.env.XERJ_BIN;
  if (pinned) return pinned;

  const host = await detectRuntime({ libc: "musl", target: null });
  const info = host.info;
  if (!info) {
    throw new Error(`unsupported platform: ${process.platform}/${process.arch}`);
  }

  const binary = await ensureBinary({
    root,
    requested: "auto",
    platform: process.platform,
    info,
    logger,
  });
  return binary.path;
}

/** Creates the fixture project the tests index. */
async function writeFixture(project: string): Promise<void> {
  await mkdir(join(project, "src"), { recursive: true });
  await mkdir(join(project, "docs"), { recursive: true });

  await writeFile(
    join(project, "src/alpha.ts"),
    [
      "// The only place this rare token appears.",
      "export function zephyrmarker(): number {",
      "  return 42;",
      "}",
      "",
    ].join("\n"),
  );

  await writeFile(
    join(project, "src/deleted.ts"),
    "export const doomedtoken = 'delete me later';\n",
  );

  await writeFile(
    join(project, "src/renamed-old.ts"),
    "export const renametoken = 'this file moves';\n",
  );

  await writeFile(
    join(project, "docs/guide.md"),
    "# Guide\n\nA short document about the build.\n",
  );

  // Must never reach the index: secret-shaped, and ignored by the plugin.
  await writeFile(join(project, ".env"), "SECRET_TOKEN=do-not-index\n");

  // Binary content must be recorded as junk, not indexed.
  await writeFile(
    join(project, "assets.bin"),
    Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0x00]),
  );

  // A large text file: present, but the plugin caps baselines at 128 KB.
  await writeFile(join(project, "big.log"), `${"x".repeat(64)}\n`.repeat(4000));
}

export async function startHarness(): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), "xerj-int-"));
  const project = join(root, "project");
  await mkdir(project, { recursive: true });
  await writeFixture(project);

  // The binary is cached across runs; node data stays per-run so tests cannot
  // see each other's indices.
  const cacheRoot =
    process.env.XERJ_CACHE ??
    join(homedir(), ".cache", "opencode", "xerj-int");
  await mkdir(cacheRoot, { recursive: true });
  const binaryPath = await resolveBinary(cacheRoot);
  const nodeDir = join(root, "node");
  const runtimeOptions = {
    nodeDir,
    projectRoot: project,
    preferredPort: 9700,
    dataDir: join(root, "data"),
    explicitUrl: null,
    logger,
    binary: () => ({ path: binaryPath, version: "test", upgraded: false }),
  };
  const nodes = new NodeRuntime(runtimeOptions);
  const node = await nodes.ensure();

  const client = new XerjClient(node.baseUrl);
  const layout = corpusLayout(project, PREFIX, root);

  const fastConfig: typeof DEFAULT_CONFIG = {
    ...DEFAULT_CONFIG,
    index: { ...DEFAULT_CONFIG.index, semantic: false },
  };

  const index = async (): Promise<IndexOutcome> => {
    const args = autoindexArgs({
      layout,
      nodeUrl: node.baseUrl,
      config: fastConfig,
      watch: false,
    });

    const result = Bun.spawnSync({
      cmd: [binaryPath, ...args],
      cwd: project,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, NO_COLOR: "1" },
    });

    return {
      code: result.exitCode,
      stdout: result.stdout.toString(),
      stderr: result.stderr.toString(),
    };
  };

  return {
    root,
    project,
    prefix: PREFIX,
    client,
    baseUrl: node.baseUrl,
    binaryPath,
    logger,
    index,
    reattach: async () => {
      // A fresh runtime on the same node directory must attach, not spawn.
      const again = new NodeRuntime(runtimeOptions);
      const handle = await again.ensure();
      await again.stop("test");
      return handle.spawned;
    },
    close: async () => {
      await nodes.stop("test");
      await rm(root, { recursive: true, force: true });
    },
  };
}

/** Asks for every id in the project prefix, so tests can assert on membership. */
export async function projectPaths(harness: Harness): Promise<string[]> {
  const response = await harness.client.search(`${harness.prefix}-*`, {
    size: 1000,
    _source: ["ax_path"],
    query: { match_all: {} },
  });

  const hits = (
    response as { hits?: { hits?: Array<{ _source?: { ax_path?: string } }> } }
  ).hits?.hits;
  if (!Array.isArray(hits)) return [];
  const paths = new Set<string>();
  for (const hit of hits) {
    const path = hit._source?.ax_path;
    if (typeof path === "string") paths.add(path);
  }
  return [...paths].sort();
}

/** Blocks until the prefix answers, or fails after `timeoutMs`. */
export async function waitForIndex(
  harness: Harness,
  timeoutMs = 120_000,
): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await harness.client.indices();
      if (response.some((entry) => entry.index.startsWith(`${harness.prefix}-`))) {
        return;
      }
    } catch {
      // Node not ready yet.
    }
    await Bun.sleep(250);
  }
  throw new Error(`index ${harness.prefix} did not appear within ${timeoutMs} ms`);
}
