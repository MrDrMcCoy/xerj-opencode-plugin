// The tree-sitter grammar pack, downloaded once and verified.
//
// The full `tree-sitter-wasms` pack is 4.4 MB compressed and about 50 MB
// unpacked. It holds every language, so one download covers a mixed project.
// The npm tarball's sha512 integrity is the pin; a mismatch aborts the install
// and leaves the previous tree in place.

import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Logger } from "../log.ts";

export const GRAMMAR_PACK_VERSION = "0.1.13";
export const GRAMMAR_PACK_URL =
  "https://registry.npmjs.org/tree-sitter-wasms/-/tree-sitter-wasms-0.1.13.tgz";
/** sha512 of that exact tarball, from the npm registry metadata. */
export const GRAMMAR_PACK_INTEGRITY =
  "sha512-wT+cR6DwaIz80/vho3AvSF0N4txuNx/5bcRKoXouOfClpxh/qqrF4URNLQXbbt8MaAxeksZcZd1j8gcGjc+QxQ==";

/** Grammar file per language id used by the analyzer. */
export const GRAMMAR_FILES: Readonly<Record<string, string>> = {
  typescript: "tree-sitter-typescript.wasm",
  tsx: "tree-sitter-tsx.wasm",
  javascript: "tree-sitter-javascript.wasm",
  python: "tree-sitter-python.wasm",
  rust: "tree-sitter-rust.wasm",
  go: "tree-sitter-go.wasm",
  java: "tree-sitter-java.wasm",
  c: "tree-sitter-c.wasm",
  cpp: "tree-sitter-cpp.wasm",
  ruby: "tree-sitter-ruby.wasm",
  php: "tree-sitter-php.wasm",
  kotlin: "tree-sitter-kotlin.wasm",
  lua: "tree-sitter-lua.wasm",
  bash: "tree-sitter-bash.wasm",
  json: "tree-sitter-json.wasm",
};

export interface GrammarInstall {
  readonly directory: string;
  readonly files: ReadonlyMap<string, string>;
}

export interface GrammarManagerOptions {
  /** `<data root>/grammars`; shared by every project in the installation. */
  readonly root: string;
  readonly logger: Logger;
  readonly timeoutMs?: number;
  /** Override the pinned tarball URL; tests use a local server. */
  readonly url?: string;
  /** Override the pinned sha512; tests use a fixture tarball. */
  readonly integrity?: string;
}

export class GrammarManager {
  private readonly root: string;
  private readonly logger: Logger;
  private readonly timeoutMs: number;
  private readonly url: string;
  private readonly integrity: string;
  private pending: Promise<string | null> | null = null;

  constructor(options: GrammarManagerOptions) {
    this.root = options.root;
    this.logger = options.logger;
    this.timeoutMs = options.timeoutMs ?? 300_000;
    this.url = options.url ?? GRAMMAR_PACK_URL;
    this.integrity = options.integrity ?? GRAMMAR_PACK_INTEGRITY;
  }

  get directory(): string {
    return join(this.root, GRAMMAR_PACK_VERSION);
  }

  /**
   * Installs the pack when needed and returns the requested wasm paths. A
   * failure logs once and returns null, which disables only the parser tools.
   */
  async ensure(languages: ReadonlyArray<string>): Promise<Map<string, string> | null> {
    const wanted = new Map<string, string>();
    for (const language of languages) {
      const file = GRAMMAR_FILES[language];
      if (file !== undefined) wanted.set(language, join(this.directory, "out", file));
    }
    if (wanted.size === 0) return null;
    if (await this.complete(wanted)) return wanted;

    if (this.pending === null) {
      this.pending = this.install().finally(() => {
        this.pending = null;
      });
    }
    await this.pending;
    return (await this.complete(wanted)) ? wanted : null;
  }

  private async complete(wanted: Map<string, string>): Promise<boolean> {
    for (const path of wanted.values()) {
      if (!(await isFile(path))) return false;
    }
    return true;
  }

  private async install(): Promise<string | null> {
    const final = this.directory;
    const staging = `${final}.partial-${process.pid}`;
    const tarball = join(this.root, `${GRAMMAR_PACK_VERSION}.partial-${process.pid}.tgz`);
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await rm(staging, { recursive: true, force: true }).catch(() => {});
    await mkdir(staging, { recursive: true, mode: 0o700 });

    try {
      this.logger.info("downloading the tree-sitter grammar pack", {
        version: GRAMMAR_PACK_VERSION,
        note: "about 4.4 MB compressed, 50 MB unpacked, one time",
      });
      await this.download(tarball);
      const hash = await sha512(tarball);
      if (hash !== this.integrity) {
        throw new Error(`grammar pack integrity mismatch (want ${this.integrity})`);
      }
      await extract(tarball, staging, this.timeoutMs);
      const out = join(staging, "package", "out");
      if (!(await isDirectory(out))) throw new Error("the grammar pack has no out/ directory");
      await rename(out, join(staging, "out"));
      await rm(join(staging, "package"), { recursive: true, force: true }).catch(() => {});
      await writeFile(
        join(staging, "manifest.json"),
        `${JSON.stringify(
          {
            version: GRAMMAR_PACK_VERSION,
            integrity: this.integrity,
            installedAt: new Date().toISOString(),
          },
          null,
          2,
        )}\n`,
        { mode: 0o600 },
      );
      await rm(final, { recursive: true, force: true }).catch(() => {});
      await rename(staging, final);
      this.logger.info("the tree-sitter grammar pack is installed", { directory: final });
      return final;
    } catch (error) {
      this.logger.warn("could not install the tree-sitter grammar pack", String(error));
      await rm(staging, { recursive: true, force: true }).catch(() => {});
      return null;
    } finally {
      await rm(tarball, { force: true }).catch(() => {});
    }
  }

  private async download(destination: string): Promise<void> {
    const response = await fetch(this.url, {
      redirect: "follow",
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok || !response.body) {
      throw new Error(`grammar pack download failed: HTTP ${response.status}`);
    }
    await pipeline(
      Readable.fromWeb(response.body as never),
      createWriteStream(destination, { mode: 0o600 }),
    );
  }
}

function extract(
  archive: string,
  destination: string,
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("tar", ["-xzf", archive, "-C", destination], {
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("grammar pack extraction timed out"));
    }, timeoutMs);
    timer.unref?.();
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolvePromise();
      else reject(new Error(`tar exited ${code}: ${stderr.slice(0, 200)}`));
    });
  });
}

function sha512(path: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const hash = createHash("sha512");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("error", reject);
    stream.once("end", () => resolvePromise(`sha512-${hash.digest("base64")}`));
  });
}

async function isFile(path: string): Promise<boolean> {
  return stat(path).then((info) => info.isFile(), () => false);
}

async function isDirectory(path: string): Promise<boolean> {
  return stat(path).then((info) => info.isDirectory(), () => false);
}

/** Reads the install manifest, or null when the tree is incomplete. */
export async function readGrammarManifest(
  directory: string,
): Promise<{ version?: string; integrity?: string } | null> {
  try {
    return JSON.parse(await readFile(join(directory, "manifest.json"), "utf8")) as {
      version?: string;
      integrity?: string;
    };
  } catch {
    return null;
  }
}

