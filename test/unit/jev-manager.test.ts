import { afterEach, describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { JevosManager, flatten, hashFile } from "../../src/jev/manager.ts";
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

describe("install helpers", () => {
  test("hashFile hashes every chunk, not only the first", async () => {
    const dir = await tempDir();
    const file = join(dir, "blob.bin");
    const bytes = randomBytes(300_000);
    await writeFile(file, bytes);
    const expected = createHash("sha256").update(await readFile(file)).digest("hex");
    expect(await hashFile(file)).toBe(expected);
  });

  test("flatten moves a binary out of a folder with the same name", async () => {
    const dir = await tempDir();
    const nested = join(dir, "jev");
    await mkdir(nested, { recursive: true });
    await writeFile(join(nested, "jev"), "binary");
    await writeFile(join(nested, "libopenvino.so"), "library");

    await flatten(dir, "jev", logger);

    expect(await readFile(join(dir, "jev"), "utf8")).toBe("binary");
    expect(await readFile(join(dir, "libopenvino.so"), "utf8")).toBe("library");
    expect(await stat(join(dir, "jev")).then((info) => info.isDirectory())).toBe(false);
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

const runCommand = promisify(execFile);
const hasPython = Bun.which("python3") !== null;
const binaryName = "jev-linux-x64.tar.gz";
const modelName = "jevos-v5-openvino-int8.zip";

async function sha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  hash.update(await readFile(path));
  return hash.digest("hex");
}

function serveRelease(dir: string): { base: string; stop: () => void } {
  const server = Bun.serve({
    port: 0,
    fetch: (request) => {
      const name = new URL(request.url).pathname.split("/").pop() ?? "";
      return new Response(Bun.file(join(dir, name)));
    },
  });
  return {
    base: String(server.url).replace(/\/$/, ""),
    stop: () => server.stop(true),
  };
}

async function buildBinary(dir: string): Promise<string> {
  const stage = join(dir, "binary");
  await mkdir(stage, { recursive: true });
  const binary = join(stage, "jev");
  await writeFile(binary, "#!/bin/sh\necho 'usage: jev' >&2\nexit 2\n");
  await chmod(binary, 0o755);
  const tarball = join(dir, binaryName);
  await runCommand("tar", ["-czf", tarball, "-C", stage, "jev"]);
  return tarball;
}

async function buildModel(dir: string): Promise<string> {
  const stage = join(dir, "model-stage");
  await mkdir(join(stage, "model"), { recursive: true });
  for (const name of MODEL_FILES) {
    await writeFile(join(stage, "model", name), "x");
  }
  const zip = join(dir, modelName);
  await runCommand("python3", [
    "-c",
    [
      "import os, sys, zipfile",
      "z = zipfile.ZipFile(sys.argv[1], 'w')",
      "for root, _, files in os.walk(sys.argv[2]):",
      "    for name in files:",
      "        path = os.path.join(root, name)",
      "        z.write(path, os.path.relpath(path, sys.argv[2]))",
      "z.close()",
    ].join("\n"),
    zip,
    stage,
  ]);
  return zip;
}

describe("jevos install", () => {
  test.skipIf(!hasPython || process.platform === "win32")(
    "downloads, verifies, and lays out the binary and model",
    async () => {
      const dir = await tempDir();
      const tarball = await buildBinary(dir);
      const zip = await buildModel(dir);
      await writeFile(
        join(dir, "SHA256SUMS.txt"),
        `${await sha256(tarball)}  ${binaryName}\n` +
          `${await sha256(zip)}  ${modelName}\n`,
      );
      const served = serveRelease(dir);
      const manager = new JevosManager({
        root: join(dir, "root"),
        version: "jevos-v5",
        target: { name: "linux-x64", archive: "tar.gz" },
        logger,
        releaseBase: served.base,
        downloadTimeoutMs: 10_000,
        commandTimeoutMs: 10_000,
      });

      try {
        const installed = await manager.ensure();
        expect(installed.binary).toContain(join("bin", "jev"));
        expect(await readFile(installed.binary, "utf8")).toContain("usage: jev");
        for (const name of MODEL_FILES) {
          expect(await readFile(join(installed.modelDir, name), "utf8")).toBe("x");
        }
        // A second ensure reuses the tree without a request.
        expect(await manager.inspect()).toEqual(installed);
      } finally {
        served.stop();
      }
    },
    30_000,
  );

  test("a checksum mismatch fails closed and leaves no tree", async () => {
    const dir = await tempDir();
    const tarball = await buildBinary(dir);
    await writeFile(
      join(dir, "SHA256SUMS.txt"),
      `${"0".repeat(64)}  ${binaryName}\n`,
    );
    const served = serveRelease(dir);
    const manager = new JevosManager({
      root: join(dir, "root"),
      version: "jevos-v5",
      target: { name: "linux-x64", archive: "tar.gz" },
      logger,
      releaseBase: served.base,
      downloadTimeoutMs: 10_000,
      commandTimeoutMs: 10_000,
    });

    try {
      await expect(manager.ensure()).rejects.toThrow(/checksum mismatch/);
      expect(await manager.inspect()).toBeNull();
      expect((await stat(tarball).catch(() => null))?.isFile()).toBe(true);
    } finally {
      served.stop();
    }
  }, 30_000);
});

describe("jevos supervisor start and stop", () => {
  test.skipIf(process.platform === "win32")(
    "starts a server, reports its URL, and stops it",
    async () => {
      const root = await tempDir();
      const installDir = join(root, "install");
      await mkdir(installDir, { recursive: true });
      const serverScript = join(installDir, "server.ts");
      await writeFile(
        serverScript,
        [
          "const args = process.argv.slice(2);",
          "const index = args.indexOf('--port');",
          "const port = Number(args[index + 1]);",
          "Bun.serve({ port, fetch: (request) =>",
          "  new URL(request.url).pathname === '/health'",
          "    ? Response.json({ status: 'ready', model_files: {} })",
          "    : new Response('ok') });",
          "setInterval(() => {}, 1000);",
        ].join("\n"),
      );
      const wrapper = join(installDir, "fake-jev.sh");
      await writeFile(
        wrapper,
        `#!/bin/sh\nexec "${process.execPath}" "${serverScript}" "$@"\n`,
      );
      await chmod(wrapper, 0o755);

      const supervisor = new JevosSupervisor({
        install: async () => ({
          root: installDir,
          binary: wrapper,
          modelDir: installDir,
          version: "jevos-v5",
          target: "linux-x64",
        }),
        port: 0,
        threads: null,
        logger,
        logPath: join(root, "jev.log"),
        idleMs: 60_000,
        startupTimeoutMs: 10_000,
        probeTimeoutMs: 500,
        stopGraceMs: 2_000,
      });

      const url = await supervisor.ensure();
      expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      const pid = supervisor.pid;
      expect(pid).not.toBeNull();

      await supervisor.stop();
      expect(() => process.kill(pid!, 0)).toThrow();
      expect(supervisor.url).toBeNull();
    },
    30_000,
  );
});
