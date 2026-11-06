// Remote documents: fetched pages spool to disk for the web corpus watcher,
// and explicit external files are ingested through `_bulk` because autoindex
// refuses a single-file path.
//
// The spool lives under the data root, never in the project: its files are
// events for the watcher, and the watched tree must not contain the journal.

import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { basename, extname, join, relative, resolve, sep } from "node:path";
import type { Logger } from "../log.ts";
import { NodeRequestError, type XerjClient } from "../node/client.ts";
import { redact } from "../redact.ts";

export interface SpoolOptions {
  readonly root: string;
  readonly projectRoot: string;
  readonly prefix: string;
  readonly externalPrefix: string;
  readonly maxBytes: number;
  readonly client: XerjClient;
  readonly logger: Logger;
}

export interface StoredDocument {
  readonly path: string;
  readonly bytes: number;
  readonly title: string;
}

/** Text formats the plugin will index from disk; binaries are skipped. */
const TEXT_EXTENSIONS = new Set([
  ".md",
  ".markdown",
  ".txt",
  ".rst",
  ".json",
  ".yaml",
  ".yml",
  ".toml",
  ".csv",
  ".tsv",
  ".html",
  ".htm",
  ".xml",
  ".log",
  ".ts",
  ".tsx",
  ".js",
  ".py",
  ".rs",
  ".go",
  ".java",
  ".rb",
  ".sh",
]);

export class RemoteSpool {
  readonly directory: string;

  private mapped = false;
  /** `<absolute path> -> mtime:size`, so a repeated read does not re-bulk. */
  private readonly externalStamps = new Map<string, string>();

  constructor(private readonly options: SpoolOptions) {
    this.directory = join(options.root, "spool", options.prefix);
  }

  async init(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
  }

  /** Stores a fetched page as markdown and drops any earlier version of it. */
  async ingestUrl(url: string, content: string, title?: string): Promise<StoredDocument | null> {
    const body = redact(truncate(content, this.options.maxBytes)).trim();
    if (body.length === 0) return null;

    const id = digest(url).slice(0, 20);
    const document = [
      `# ${title?.trim() || url}`,
      "",
      `Source: ${url}`,
      `Fetched: ${new Date().toISOString()}`,
      "",
      body,
      "",
    ].join("\n");

    await this.init();
    await this.removeVersions(id);

    const path = join(this.directory, `${id}.md`);
    await writeFile(path, document, { mode: 0o600 });

    return { path, bytes: Buffer.byteLength(document, "utf8"), title: title ?? url };
  }

  /** Ingests one file outside the project index through `_bulk`. */
  async ingestExternalFile(
    filePath: string,
    options: { skipUnchanged?: boolean } = {},
  ): Promise<StoredDocument | null> {
    const absolute = resolve(filePath);
    if (!isTextPath(absolute) || isSecretPath(absolute)) return null;

    const info = await stat(absolute).catch(() => null);
    if (!info?.isFile() || info.size === 0) return null;

    const stamp = `${info.mtimeMs}:${info.size}`;
    if (options.skipUnchanged && this.externalStamps.get(absolute) === stamp) {
      return null;
    }

    const raw = await readFile(absolute, "utf8").catch(() => null);
    if (raw === null || raw.includes("\u0000")) return null;

    const body = redact(truncate(raw, this.options.maxBytes));
    if (body.trim().length === 0) return null;

    const root = resolve(this.options.projectRoot);
    const inside = absolute === root || absolute.startsWith(root + sep);
    const relativePath = inside ? relative(root, absolute) : absolute;

    await this.ensureMapping();

    const source = {
      body,
      title: basename(absolute),
      path: relativePath,
      abs_path: absolute,
      mtime: new Date(info.mtimeMs).toISOString(),
    };

    // A stable id means a changed file replaces its old document.
    await this.options.client.bulk(`${this.options.externalPrefix}-docs`, [
      { id: digest(absolute).slice(0, 24), source },
    ]);
    this.externalStamps.set(absolute, stamp);

    return {
      path: relativePath,
      bytes: Buffer.byteLength(body, "utf8"),
      title: basename(absolute),
    };
  }

  private async ensureMapping(): Promise<void> {
    if (this.mapped) return;

    try {
      await this.options.client.put(
        `/${this.options.externalPrefix}-docs`,
        {
          mappings: {
            properties: {
              body: { type: "semantic_text" },
              title: { type: "keyword" },
              path: { type: "keyword" },
              abs_path: { type: "keyword" },
              mtime: { type: "date" },
            },
          },
        },
        "could not create the external index",
      );
    } catch (error) {
      // The index survives restarts; 400/409 mean it already exists.
      if (
        !(error instanceof NodeRequestError) ||
        (error.status !== 400 && error.status !== 409)
      ) {
        throw error;
      }
    }

    this.mapped = true;
  }

  private async removeVersions(id: string): Promise<void> {
    await rm(join(this.directory, `${id}.md`), { force: true });
  }
}

export function isTextPath(filePath: string): boolean {
  return TEXT_EXTENSIONS.has(extname(filePath).toLowerCase());
}

const SECRET_FILES = new Set([
  ".env",
  ".netrc",
  ".npmrc",
  ".pypirc",
  ".git-credentials",
  ".htpasswd",
  ".pgpass",
  "auth.json",
  "credentials.json",
  "secrets.json",
  "service.json",
  "token.json",
  "id_rsa",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
]);
const SECRET_EXTENSIONS = /\.(pem|key|p12|pfx|crt|cer)$/i;
/** Directories that hold credentials; nothing inside them is indexed. */
const SECRET_DIRECTORIES = new Set([".ssh", ".aws", ".gnupg", ".kube", ".docker"]);

/** Secrets are not indexed even when a tool reads them. */
export function isSecretPath(filePath: string): boolean {
  const name = basename(filePath).toLowerCase();
  if (SECRET_FILES.has(name) || name.startsWith(".env.")) return true;
  if (SECRET_EXTENSIONS.test(name)) return true;

  return resolve(filePath)
    .split(sep)
    .some((part) => SECRET_DIRECTORIES.has(part.toLowerCase()));
}

export function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function truncate(text: string, maxBytes: number): string {
  if (maxBytes <= 0 || Buffer.byteLength(text, "utf8") <= maxBytes) return text;

  // Cut on a character boundary: encoding the slice first keeps multi-byte
  // characters intact when the byte cap lands inside one.
  const buffer = Buffer.from(text, "utf8").subarray(0, maxBytes);
  return buffer.toString("utf8").replace(/\uFFFD$/, "");
}

export { redact } from "../redact.ts";
