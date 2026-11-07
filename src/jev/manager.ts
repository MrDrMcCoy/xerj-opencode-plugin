// Downloads and installs the jevos decision model and its binary.
//
// The model is ~630 MB, so the install is a deliberate one-time cost that the
// config opts into (`memory.distill.judge: "local"`). Both assets are checked
// against the release SHA256SUMS.txt before anything is executed; a missing or
// malformed list fails closed, the same rule the engine binary follows.

import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import {
  chmod,
  mkdir,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join, dirname } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { spawn } from "node:child_process";
import type { Logger } from "../log.ts";
import {
  assetUrl,
  binaryAsset,
  DEFAULT_JEVOS_VERSION,
  JEVOS_SUMS_ASSET,
  modelAsset,
  parseSums,
  type JevosTarget,
} from "./release.ts";

export interface JevosInstall {
  /** Directory holding `bin/` and `model/`. */
  readonly root: string;
  readonly binary: string;
  readonly modelDir: string;
  readonly version: string;
  readonly target: string;
}

export interface JevosManagerOptions {
  /** `<data root>/jev`; shared by every project in the installation. */
  readonly root: string;
  readonly version?: string;
  readonly target: JevosTarget;
  readonly logger: Logger;
  /** A pre-installed directory: skip download and detection entirely. */
  readonly path?: string | null;
  /** Deadline for one asset download; the model is large. */
  readonly downloadTimeoutMs?: number;
  readonly commandTimeoutMs?: number;
  /** Override the release base URL; tests serve fixtures on loopback. */
  readonly releaseBase?: string;
}

const MODEL_FILES = [
  "model.json",
  "openvino_model.xml",
  "openvino_model.bin",
  "tokenizer.gguf",
];
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 15 * 60_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 5 * 60_000;
const INSTALLED = "installed.json";
const LOCK_STALE_MS = 10 * 60_000;

export class JevosManager {
  private readonly root: string;
  private readonly version: string;
  private readonly target: JevosTarget;
  private readonly logger: Logger;
  private readonly pathOverride: string | null;
  private readonly downloadTimeoutMs: number;
  private readonly commandTimeoutMs: number;
  private readonly releaseBase: string | null;

  constructor(options: JevosManagerOptions) {
    this.root = options.root;
    this.version = options.version ?? DEFAULT_JEVOS_VERSION;
    this.target = options.target;
    this.logger = options.logger;
    this.pathOverride = options.path ?? null;
    this.downloadTimeoutMs = options.downloadTimeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS;
    this.commandTimeoutMs = options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    this.releaseBase = options.releaseBase ?? null;
  }

  /** The pinned release URL, or the test base joined with the same path. */
  private assetUrlFor(asset: string): string {
    return this.releaseBase === null
      ? assetUrl(this.version, asset)
      : `${this.releaseBase}/${this.version}/${asset}`;
  }

  get directory(): string {
    return this.pathOverride ?? join(this.root, `${this.version}-${this.target.name}`);
  }

  /** An installed copy, or null when anything is missing. */
  async inspect(): Promise<JevosInstall | null> {
    const root = this.directory;
    const binary = join(root, "bin", process.platform === "win32" ? "jev.exe" : "jev");
    const modelDir = join(root, "model");
    if (!(await isFile(binary))) return null;
    for (const name of MODEL_FILES) {
      if (!(await isFile(join(modelDir, name)))) return null;
    }
    return { root, binary, modelDir, version: this.version, target: this.target.name };
  }

  /** Installs when needed; the caller decides whether to block on it. */
  async ensure(): Promise<JevosInstall> {
    const installed = await this.inspect();
    if (installed !== null) return installed;
    if (this.pathOverride !== null) {
      throw new Error(
        `memory.distill.local.path does not hold a jevos install (want bin/jev and model/)`,
      );
    }

    await this.withLock(async () => {
      const again = await this.inspect();
      if (again !== null) return;
      await this.install();
    });

    const result = await this.inspect();
    if (result === null) throw new Error("the jevos install is incomplete after extraction");
    return result;
  }

  private async install(): Promise<void> {
    const final = this.directory;
    const staging = `${final}.partial-${process.pid}`;
    await rm(staging, { recursive: true, force: true }).catch(() => {});
    await mkdir(staging, { recursive: true, mode: 0o700 });

    try {
      const sums = await this.fetchSums();
      const binaryName = binaryAsset(this.target);
      const modelName = modelAsset(this.version);

      this.logger.info("downloading the jevos binary", { asset: binaryName });
      const binaryPath = join(staging, binaryName);
      await this.download(this.assetUrlFor(binaryName), binaryPath, sums);

      this.logger.info("downloading the jevos model", {
        asset: modelName,
        note: "about 630 MB, one time",
      });
      const modelPath = join(staging, modelName);
      await this.download(this.assetUrlFor(modelName), modelPath, sums);

      const binDir = join(staging, "bin");
      await mkdir(binDir, { recursive: true, mode: 0o700 });
      await extract(
        binaryPath,
        binDir,
        this.target.archive,
        this.logger,
        this.commandTimeoutMs,
      );
      await flatten(binDir, "jev", this.logger);
      const binary = join(binDir, process.platform === "win32" ? "jev.exe" : "jev");
      await chmod(binary, 0o755).catch(() => {});

      // The model is published as a zip on every platform; only the binary
      // archive follows the target's archive kind.
      await extract(
        modelPath,
        staging,
        "zip",
        this.logger,
        this.commandTimeoutMs,
      );

      await this.probe(binary);

      await writeFile(
        join(staging, INSTALLED),
        `${JSON.stringify(
          {
            version: this.version,
            target: this.target.name,
            installedAt: new Date().toISOString(),
          },
          null,
          2,
        )}\n`,
        { mode: 0o600 },
      ).catch(() => {});

      await rm(final, { recursive: true, force: true }).catch(() => {});
      await rename(staging, final);
      this.logger.info("jevos is installed", { directory: final });
    } catch (error) {
      // A failed download or extraction must not leave a partial tree that
      // `inspect` could later mistake for an install.
      await rm(staging, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  }

  private async fetchSums(): Promise<Map<string, string>> {
    const response = await fetch(this.assetUrlFor(JEVOS_SUMS_ASSET), {
      redirect: "follow",
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      throw new Error(`checksum list download failed: HTTP ${response.status}`);
    }
    const sums = parseSums(await response.text());
    if (sums.size === 0) throw new Error("the jevos checksum list is empty");
    return sums;
  }

  private async download(
    url: string,
    destination: string,
    sums: Map<string, string>,
  ): Promise<void> {
    const expected = sums.get(url.split("/").pop() ?? "");
    if (expected === undefined) {
      throw new Error(`no checksum for ${url.split("/").pop()}; refusing to install`);
    }

    const response = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(this.downloadTimeoutMs),
    });
    if (!response.ok || !response.body) {
      throw new Error(`download failed: HTTP ${response.status}`);
    }
    await pipeline(
      Readable.fromWeb(response.body as never),
      createWriteStream(destination, { mode: 0o600 }),
    );

    const actual = await hashFile(destination);
    if (actual !== expected) {
      await rm(destination, { force: true }).catch(() => {});
      throw new Error(`checksum mismatch for ${destination} (want ${expected})`);
    }
  }

  /** The binary is not a server here: running it prints usage and exits 2. */
  private async probe(binary: string): Promise<void> {
    const result = await run(binary, [], this.commandTimeoutMs).catch(
      (error: unknown) => {
        throw new Error(`the jevos binary did not run: ${String(error)}`);
      },
    );
    if (result.code !== 2 || !result.stderr.includes("usage: jev")) {
      throw new Error(
        `the jevos binary did not report its usage (exit ${result.code}): ${result.stderr.slice(0, 200)}`,
      );
    }
  }

  private async withLock(body: () => Promise<void>): Promise<void> {
    const lock = join(this.root, ".install.lock");
    await mkdir(this.root, { recursive: true, mode: 0o700 }).catch(() => {});
    const deadline = Date.now() + 5 * 60_000;
    while (true) {
      try {
        await mkdir(lock, { recursive: false, mode: 0o700 });
        break;
      } catch {
        const info = await stat(lock).catch(() => null);
        if (info !== null && Date.now() - info.mtimeMs > LOCK_STALE_MS) {
          await rm(lock, { recursive: true, force: true }).catch(() => {});
          continue;
        }
        if (Date.now() > deadline) throw new Error("another jevos install is still running");
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
    }
    try {
      await body();
    } finally {
      await rm(lock, { recursive: true, force: true }).catch(() => {});
    }
  }
}

/** The release archives root the binary under its own folder. */
export async function flatten(directory: string, name: string, logger: Logger): Promise<void> {
  const nested = join(directory, name);
  const isDir = await stat(nested).then((info) => info.isDirectory(), () => false);
  if (!isDir) return;

  // Move the folder aside first: the binary inside it has the same name as
  // the folder, so moving entries in place can hit a non-empty target.
  const stash = `${nested}.extract`;
  await rename(nested, stash);
  for (const entry of await readdir(stash)) {
    await rename(join(stash, entry), join(directory, entry)).catch((error: unknown) => {
      logger.debug("could not move an extracted file", String(error));
    });
  }
  await rm(stash, { recursive: true, force: true }).catch(() => {});
}

async function extract(
  archive: string,
  destination: string,
  kind: string,
  logger: Logger,
  timeoutMs: number,
): Promise<void> {
  if (kind === "zip") {
    try {
      const result = await run(
        "unzip",
        ["-q", "-o", archive, "-d", destination],
        timeoutMs,
      );
      if (result.code === 0) return;
    } catch {
      // Fall through to tar, which handles zip as bsdtar on Windows and macOS.
    }
  }
  const result = await run("tar", ["-xf", archive, "-C", destination], timeoutMs).catch(
    (error: unknown) => {
      throw new Error(`could not extract ${archive}: ${String(error)}`);
    },
  );
  if (result.code !== 0) {
    logger.warn("archive extraction failed", result.stderr.slice(0, 200));
    throw new Error(`could not extract ${archive}`);
  }
}

function run(
  command: string,
  args: ReadonlyArray<string>,
  timeoutMs: number,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, [...args], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${command} timed out`));
    }, timeoutMs);
    timer.unref?.();
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolvePromise({ code, stdout, stderr });
    });
  });
}

async function isFile(path: string): Promise<boolean> {
  return stat(path).then((info) => info.isFile(), () => false);
}

/** Streams the file so a 630 MB model is never held in memory. */
export function hashFile(path: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.once("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("end", () => resolvePromise(hash.digest("hex")));
  });
}
