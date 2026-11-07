import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JevosManager } from "../../src/jev/manager.ts";
import { JevosSupervisor } from "../../src/jev/supervisor.ts";

const logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  entries: async () => [],
  flush: async () => {},
};

const target = { name: "linux-x64", archive: "tar.gz" as const };
const MODEL_FILES = ["model.json", "openvino_model.xml", "openvino_model.bin", "tokenizer.gguf"];

const scratch: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "xerj-jev-test-"));
  scratch.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of scratch.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe("jevos manager", () => {
  test("inspect reports nothing for an empty directory", async () => {
    const root = await tempDir();
    const manager = new JevosManager({ root, target, logger });
    expect(await manager.inspect()).toBeNull();
  });

  test("inspect requires the binary and every model file", async () => {
    const root = await tempDir();
    const install = join(root, "jevos-v5-linux-x64");
    await mkdir(join(install, "bin"), { recursive: true });
    await mkdir(join(install, "model"), { recursive: true });
    await writeFile(join(install, "bin", "jev"), "binary");

    const manager = new JevosManager({ root, target, logger });
    expect(await manager.inspect()).toBeNull();

    for (const name of MODEL_FILES) {
      await writeFile(join(install, "model", name), "x");
    }
    const found = await manager.inspect();
    expect(found?.binary).toBe(join(install, "bin", "jev"));
    expect(found?.modelDir).toBe(join(install, "model"));
  });

  test("a pre-installed path that is incomplete fails without downloading", async () => {
    const dir = await tempDir();
    const manager = new JevosManager({
      root: dir,
      target,
      logger,
      path: dir,
    });
    await expect(manager.ensure()).rejects.toThrow("memory.distill.local.path");
  });

  test("a complete pre-installed path is used as-is", async () => {
    const dir = await tempDir();
    await mkdir(join(dir, "bin"));
    await mkdir(join(dir, "model"));
    await writeFile(join(dir, "bin", "jev"), "binary");
    for (const name of MODEL_FILES) {
      await writeFile(join(dir, "model", name), "x");
    }

    const manager = new JevosManager({ root: dir, target, logger, path: dir });
    const install = await manager.ensure();
    expect(install.root).toBe(dir);
  });
});

describe("jevos supervisor", () => {
  test("attaches to a healthy server on the configured port", async () => {
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (request) =>
        new URL(request.url).pathname === "/health"
          ? Response.json({ status: "ready", model_files: {} })
          : new Response("no", { status: 404 }),
    });

    let installed = 0;
    const supervisor = new JevosSupervisor({
      install: async () => {
        installed += 1;
        throw new Error("must not install");
      },
      port: server.port!,
      threads: 0,
      logger,
      logPath: join(await tempDir(), "jev.log"),
      idleMs: 60_000,
      startupTimeoutMs: 500,
      probeTimeoutMs: 200,
      stopGraceMs: 100,
    });

    expect(await supervisor.ensure()).toBe(`http://127.0.0.1:${server.port}`);
    supervisor.touch();
    await supervisor.stop();
    expect(supervisor.url).toBeNull();
    expect(installed).toBe(0);
    server.stop(true);
  });

  test("a dead server is forgotten and not retried during the cooldown", async () => {
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => Response.json({ status: "ready", model_files: {} }),
    });
    let installed = 0;
    const supervisor = new JevosSupervisor({
      install: async () => {
        installed += 1;
        throw new Error("must not install");
      },
      port: server.port!,
      threads: 0,
      logger,
      logPath: join(await tempDir(), "jev.log"),
      idleMs: 60_000,
      startupTimeoutMs: 500,
      probeTimeoutMs: 200,
      stopGraceMs: 100,
    });

    expect(await supervisor.ensure()).not.toBeNull();
    server.stop(true);
    await supervisor.invalidate();
    expect(supervisor.url).toBeNull();
    expect(await supervisor.ensure()).toBeNull();
    expect(installed).toBe(0);
  });

  test("an install failure cools down instead of retrying on every turn", async () => {
    const warnings: string[] = [];
    const loud = { ...logger, warn: (message: string) => warnings.push(message) };
    let attempts = 0;
    const supervisor = new JevosSupervisor({
      install: async () => {
        attempts += 1;
        throw new Error("offline");
      },
      port: 0,
      threads: 0,
      logger: loud,
      logPath: join(await tempDir(), "jev.log"),
      idleMs: 60_000,
      startupTimeoutMs: 500,
      probeTimeoutMs: 200,
      stopGraceMs: 100,
    });

    expect(await supervisor.ensure()).toBeNull();
    expect(await supervisor.ensure()).toBeNull();
    expect(attempts).toBe(1);
    expect(warnings.some((line) => line.includes("heuristic"))).toBe(true);
  });
});
