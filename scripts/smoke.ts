// End-to-end smoke test for the M0 slice: download (or reuse) the pinned
// binary, spawn a node, attach, and read index metadata. Run with:
//
//   bun scripts/smoke.ts
//
// It uses a scratch data root so it never touches the real plugin index.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectRuntime } from "../src/binary/detect.ts";
import { ensureBinary, probeBinaryVersion } from "../src/binary/manager.ts";
import { createLogger } from "../src/log.ts";
import { XerjClient } from "../src/node/client.ts";
import { NodeRuntime } from "../src/node/runtime.ts";
const memory = new Map<string, unknown>();
const storage = {
  get: async (key: string) => memory.get(key),
  set: async (key: string, value: unknown) => void memory.set(key, value),
};

const logger = createLogger(storage, { echoToConsole: true });

const root = await mkdtemp(join(tmpdir(), "xerj-smoke-"));
const host = await detectRuntime({ libc: "musl", target: null });
const info = host.info;
if (!info) throw new Error(`unsupported platform: ${process.platform}/${process.arch}`);

try {
  const binary = await ensureBinary({
    root,
    requested: "auto",
    platform: process.platform,
    info,
    logger,
  });
  console.log("binary", binary);

  const reported = await probeBinaryVersion(binary.path);
  console.log("reported version", reported);

  // One project node directory; the runtime attaches on the second run.
  const nodes = new NodeRuntime({
    nodeDir: join(root, "node"),
    projectRoot: root,
    preferredPort: 9500,
    dataDir: null,
    explicitUrl: null,
    logger,
    binary: () => binary,
  });
  const node = await nodes.ensure();
  console.log("node", node);

  const client = new XerjClient(node.baseUrl);
  console.log("info", await client.info());
  console.log("health", await client.health());
  console.log("indices", await client.indices());

  const again = new NodeRuntime({
    nodeDir: join(root, "node"),
    projectRoot: root,
    preferredPort: 9500,
    dataDir: null,
    explicitUrl: null,
    logger,
    binary: () => binary,
  });
  const attached = await again.ensure();
  console.log("attach existing", attached.port, attached.spawned);

  if (attached.port !== node.port || attached.spawned) {
    throw new Error("the second runtime did not attach to the first node");
  }

  // The node is detached by design; the smoke run owns this one.
  await nodes.stop("smoke");
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log("smoke ok");
