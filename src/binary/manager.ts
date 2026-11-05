// Binary lifecycle: find, download, verify, extract, upgrade. Verified against
// XERJ v1.0.0-rc.100 release assets. Everything here is best-effort except the
// first install: a failed upgrade keeps the working binary.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import {
  chmod,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Logger } from "../log.ts";
import { binaryPath, releaseCachePath } from "../paths.ts";
import {
  highestVersion,
  meetsTrackingFloor,
  normalizeVersion,
  parseVersion,
  shouldUpgrade,
} from "../semver.ts";
import type { PlatformInfo } from "../platform.ts";
import {
  archiveRoot,
  assetName,
  assetUrl,
  cacheIsFresh,
  checksumFrom,
  latestReleaseUrl,
  parseReleaseCache,
  versionFromLatestUrl,
  type ReleaseCache,
} from "./release.ts";

export class BinaryError extends Error {
  constructor(message: string, override readonly cause?: unknown) {
    super(message);
    this.name = "BinaryError";
  }
}

export interface InstalledBinary {
  readonly version: string;
  readonly path: string;
  readonly upgraded: boolean;
}

export interface EnsureBinaryOptions {
  readonly root: string;
  readonly requested: string;
  readonly platform: NodeJS.Platform;
  readonly info: PlatformInfo;
  readonly logger: Logger;
  readonly now?: () => number;
}

const COMMAND_TIMEOUT_MS = 60_000;
const RELEASE_LIST_TIMEOUT_MS = 10_000;
const RELEASES_API_URL = "https://api.github.com/repos/xerj-org/xerj/releases?per_page=100";

export async function ensureBinary(options: EnsureBinaryOptions): Promise<InstalledBinary> {
  const { root, requested, platform, info, logger } = options;
  const now = options.now ?? Date.now;

  const installed = await findInstalled(root, platform, info.target);

  if (requested !== "auto") {
    const version = normalizeVersion(requested);
    if (installed && installed.version === version) {
      return { ...installed, upgraded: false };
    }
    const path = await install(root, version, info, logger);
    return { version, path, upgraded: false };
  }

  const latest = await resolveLatest(root, logger, now);
  if (!latest) {
    if (installed) return { ...installed, upgraded: false };
    throw new BinaryError("no installed xerj binary and the release channel is unreachable");
  }

  if (installed && !shouldUpgrade(installed.version, latest)) {
    return { ...installed, upgraded: false };
  }

  try {
    const path = await install(root, latest, info, logger);
    logger.info(`installed xerj ${latest}`, { path });
    return { version: latest, path, upgraded: installed !== null };
  } catch (error) {
    if (installed) {
      logger.warn(`xerj ${latest} install failed; keeping ${installed.version}`, String(error));
      return { ...installed, upgraded: false };
    }
    throw new BinaryError(`could not install xerj ${latest}`, error);
  }
}

/** Runs `xerj --version` and returns the parsed version. A binary that does
 * not run yields null rather than throwing; callers decide what that means. */
export async function probeBinaryVersion(path: string): Promise<string | null> {
  try {
    const output = await run(path, ["--version"]);
    const match = /v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/.exec(output);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

/** Uses a user-supplied binary, skipping download, upgrade, and detection. */
export async function externalBinary(path: string, logger: Logger): Promise<InstalledBinary> {
  const version = await probeBinaryVersion(path);
  if (!version) {
    throw new BinaryError(`binary.path did not run or report a version: ${path}`);
  }

  logger.info("using the configured xerj binary", { path, version });
  return { version, path, upgraded: false };
}

async function findInstalled(
  root: string,
  platform: NodeJS.Platform,
  target: string,
): Promise<InstalledBinary | null> {
  const binDir = join(root, "bin");
  const entries = await readdir(binDir, { withFileTypes: true }).catch(() => []);

  // Directory names are `<version>-<target>`; only this target's binaries run
  // here, so a shared data root may hold others without confusing the choice.
  const suffix = `-${target}`;
  const versions = entries
    .filter((entry) => entry.isDirectory() && entry.name.endsWith(suffix))
    .map((entry) => entry.name.slice(0, -suffix.length));

  const best = highestVersion(versions);
  if (!best) return null;

  const path = binaryPath(root, best, platform, target);
  const version = await probeBinaryVersion(path);
  if (!version) return null;
  return { version, path, upgraded: false };
}

async function resolveLatest(
  root: string,
  logger: Logger,
  now: () => number,
): Promise<string | null> {
  const cachePath = releaseCachePath(root);
  const cached = parseReleaseCache(await readFileJson(cachePath));

  if (cached && cacheIsFresh(cached, now())) return cached.version;

  try {
    const version = await newestTrackedRelease();
    if (!version) throw new Error("no release at or above the tracking floor");

    const next: ReleaseCache = { checkedAt: now(), version };
    await mkdir(root, { recursive: true, mode: 0o700 });
    await writeFile(cachePath, JSON.stringify(next), { mode: 0o600 });
    return version;
  } catch (error) {
    logger.warn("could not check the latest xerj release", String(error));
    return cached?.version ?? null;
  }
}

/** Newest release at or above the tracking floor. Prereleases are not
 * marked latest by GitHub, so the full list is read; the redirect is the
 * fallback when the API is unreachable or rate limited. */
async function newestTrackedRelease(): Promise<string | null> {
  try {
    const response = await fetch(RELEASES_API_URL, {
      headers: { accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(RELEASE_LIST_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const releases = (await response.json()) as ReadonlyArray<{
      tag_name?: unknown;
      draft?: unknown;
    }>;
    const versions = releases
      .filter((release) => release.draft !== true)
      .map((release) => String(release.tag_name ?? "").replace(/^v/, ""))
      .filter(meetsTrackingFloor);
    return highestVersion(versions);
  } catch {
    const response = await fetch(latestReleaseUrl(), {
      redirect: "follow",
      signal: AbortSignal.timeout(RELEASE_LIST_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return versionFromLatestUrl(response.url);
  }
}

async function install(
  root: string,
  version: string,
  info: PlatformInfo,
  logger: Logger,
): Promise<string> {
  if (!parseVersion(version)) throw new BinaryError(`invalid version: ${version}`);

  const asset = assetName(version, info.target, info.archive);
  const url = assetUrl(version, asset);
  const downloadPath = join(root, "bin", asset);
  const partialDir = join(root, "bin", `.${version}-${info.target}.partial`);
  const targetDir = join(root, "bin", `${version}-${info.target}`);

  await mkdir(dirname(downloadPath), { recursive: true, mode: 0o700 });
  await rm(partialDir, { recursive: true, force: true });
  await mkdir(partialDir, { recursive: true, mode: 0o700 });

  try {
    logger.info(`downloading ${asset}`);
    await download(url, downloadPath);
    await verifyChecksum(`${url}.sha256`, downloadPath);

    await extractArchive(downloadPath, partialDir, info, logger);

    const expected = join(partialDir, archiveRoot(version, info.target), info.binary);
    const binary = (await isFile(expected)) ? expected : await findFile(partialDir, info.binary);
    if (!binary) throw new BinaryError(`archive ${asset} did not contain ${info.binary}`);

    await chmod(binary, 0o755);
    await rm(targetDir, { recursive: true, force: true });
    await rename(dirname(binary), targetDir);

    const installed = join(targetDir, info.binary);
    // A binary for the wrong architecture installs and then fails to exec, so
    // prove it runs before declaring success.
    const reported = await probeBinaryVersion(installed);
    if (!reported) {
      await rm(targetDir, { recursive: true, force: true });
      throw new BinaryError(
        `the ${info.target} binary did not run on this machine; set binary.target or install the native build`,
      );
    }

    return installed;
  } finally {
    await rm(partialDir, { recursive: true, force: true });
    await rm(downloadPath, { force: true });
  }
}

/**
 * Extracts a release archive. `tar -xf` handles tar.gz everywhere and zip on
 * Windows (bsdtar ships with Windows 10+). If tar is missing or refuses the
 * zip, PowerShell's Expand-Archive is the fallback.
 */
async function extractArchive(
  archivePath: string,
  destination: string,
  info: PlatformInfo,
  logger: Logger,
): Promise<void> {
  try {
    await run("tar", ["-xf", archivePath, "-C", destination]);
    return;
  } catch (error) {
    if (info.archive !== "zip" || process.platform !== "win32") throw error;
    logger.warn("tar could not extract the archive; trying PowerShell", String(error));
    await run(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Expand-Archive -LiteralPath $env:XERJ_ZIP -DestinationPath $env:XERJ_DST -Force",
      ],
      { env: { ...process.env, XERJ_ZIP: archivePath, XERJ_DST: destination } },
    );
  }
}

async function download(url: string, destination: string): Promise<void> {
  const response = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(COMMAND_TIMEOUT_MS),
  });
  if (!response.ok || !response.body) {
    throw new BinaryError(`download failed: HTTP ${response.status}`);
  }

  await pipeline(Readable.fromWeb(response.body), createWriteStream(destination, { mode: 0o600 }));
}

async function verifyChecksum(checksumUrl: string, filePath: string): Promise<void> {
  const response = await fetch(checksumUrl, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new BinaryError(`checksum download failed: HTTP ${response.status}`);

  const expected = checksumFrom(await response.text());
  if (!expected) throw new BinaryError("malformed .sha256 sidecar");

  const actual = createHash("sha256")
    .update(await readFile(filePath))
    .digest("hex");

  if (actual !== expected) {
    throw new BinaryError(`checksum mismatch (want ${expected}, got ${actual})`);
  }
}

async function findFile(directory: string, name: string, depth = 4): Promise<string | null> {
  if (depth < 0) return null;

  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isFile() && entry.name === name) return path;
    if (entry.isDirectory()) {
      const found = await findFile(path, name, depth - 1);
      if (found) return found;
    }
  }

  return null;
}

async function isFile(path: string): Promise<boolean> {
  const info = await stat(path).catch(() => null);
  return info?.isFile() ?? false;
}

async function readFileJson(path: string): Promise<unknown> {
  const text = await readFile(path, "utf8").catch(() => null);
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

interface RunOptions {
  readonly env?: NodeJS.ProcessEnv;
}

function run(
  command: string,
  args: ReadonlyArray<string>,
  options: RunOptions = {},
): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, [...args], {
      stdio: ["ignore", "pipe", "pipe"],
      env: options.env,
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";

    const timer = setTimeout(() => child.kill("SIGKILL"), COMMAND_TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(new BinaryError(`${command} failed to start`, error));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolvePromise(stdout.trim());
      else reject(new BinaryError(`${command} exited ${code}: ${stderr.trim().slice(0, 500)}`));
    });
  });
}

