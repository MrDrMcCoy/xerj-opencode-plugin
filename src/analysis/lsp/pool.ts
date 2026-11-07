// One language server per language, scoped to the project.
//
// Discovery order: a configured command, the project's `node_modules`, PATH,
// the plugin cache, then a pinned npm install when `autoInstall` is on. A
// server is stopped after `idleMs` without a request, and at most
// `maxServers` run at once.

import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, delimiter, join } from "node:path";
import { promisify } from "node:util";
import type { Logger } from "../../log.ts";
import { pathHash } from "../../paths.ts";
import { listProjectFiles, readProjectFile } from "../walk.ts";
import type { LspOptions } from "../../config.ts";
import {
  LspClient,
  pathToUri,
  uriToPath,
  type LspCommand,
  type LspDiagnostic,
  type LspPosition,
} from "./client.ts";

export interface LspPoolOptions {
  readonly projectRoot: string;
  /** `<data root>/lsp`; shared by every project. */
  readonly root: string;
  readonly config: LspOptions;
  readonly logger: Logger;
}

export interface LspCallSite {
  readonly name: string;
  readonly path: string;
  readonly line: number;
  readonly column: number;
  readonly callerLine: number;
}

export interface LspImpact extends LspCallSite {
  readonly depth: number;
}

interface Active {
  readonly client: LspClient;
  readonly language: string;
  lastUse: number;
}

const SERVER_VERSION = "6.0.3";
const TYPESCRIPT_VERSION = "5.9.3";
const INSTALL_TIMEOUT_MS = 300_000;
const LOCK_STALE_MS = 10 * 60_000;
const IDLE_CHECK_MS = 30_000;

export class LspPool {
  private readonly active = new Map<string, Active>();
  private readonly diagnostics = new Map<string, ReadonlyArray<LspDiagnostic>>();
  private readonly waiters = new Map<
    string,
    Array<(value: ReadonlyArray<LspDiagnostic>) => void>
  >();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly options: LspPoolOptions) {}

  async callers(symbol: string, path?: string): Promise<LspCallSite[]> {
    const root = await this.prepare(symbol, path);
    if (root === null) return [];
    const incoming = await root.client
      .request("callHierarchy/incomingCalls", { item: root.item })
      .catch(() => null);
    this.options.logger.debug("lsp incoming", {
      count: Array.isArray(incoming) ? incoming.length : -1,
    });
    return sitesFrom(incoming, this.options.projectRoot);
  }

  async impact(symbol: string, path?: string, maxDepth = 3): Promise<LspImpact[]> {
    const root = await this.prepare(symbol, path);
    if (root === null) return [];
    const seen = new Set<string>();
    const found: LspImpact[] = [];
    let frontier: Array<{ item: unknown; depth: number }> = [
      { item: root.item, depth: 1 },
    ];
    while (frontier.length > 0 && found.length < 50) {
      const next: Array<{ item: unknown; depth: number }> = [];
      for (const current of frontier) {
        if (current.depth > maxDepth) continue;
        const incoming = await root.client
          .request("callHierarchy/incomingCalls", { item: current.item })
          .catch(() => null);
        const items = Array.isArray(incoming) ? incoming : [];
        for (const entry of items) {
          const from = (entry as { from?: unknown }).from;
          if (from === undefined) continue;
          const site = sitesFrom([entry], this.options.projectRoot)[0];
          if (site === undefined) continue;
          const key = `${site.path}:${site.line}:${site.name}`;
          if (seen.has(key)) continue;
          seen.add(key);
          found.push({ ...site, depth: current.depth });
          next.push({ item: from, depth: current.depth + 1 });
          if (found.length >= 50) break;
        }
      }
      frontier = next;
    }
    return found;
  }

  /** Pulls publishDiagnostics for one file; empty when the server sends none. */
  async inspect(
    path: string,
    signal?: AbortSignal,
  ): Promise<ReadonlyArray<LspDiagnostic>> {
    const language = languageForPath(path);
    if (language === null) return [];
    const active = await this.start(language.server);
    if (active === null) return [];
    // The path comes from a tool argument. The walk helper enforces the
    // project boundary and the size cap; a raw `join` would allow an escape.
    const text = await readProjectFile(this.options.projectRoot, path, 1_048_576);
    if (text === null) return [];
    const absolute = join(this.options.projectRoot, path);
    const uri = pathToUri(absolute);
    active.client.didOpen(uri, language.languageId, text);
    return this.awaitDiagnostics(uri, signal);
  }

  /** Pids of running servers, for the telemetry sampler. */
  activePids(): number[] {
    const pids: number[] = [];
    for (const active of this.active.values()) {
      const pid = active.client.pid;
      if (pid !== null) pids.push(pid);
    }
    return pids;
  }

  async stopAll(): Promise<void> {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    const active = [...this.active.values()];
    this.active.clear();
    await Promise.all(
      active.map(async (entry) => {
        await entry.client.stop().catch(() => {});
        await this.forgetPid(entry.language);
      }),
    );
  }

  private async prepare(
    symbol: string,
    path?: string,
  ): Promise<{ client: LspClient; item: unknown } | null> {
    const name = symbol.trim();
    if (name.length === 0) return null;
    const language = path === undefined ? "typescript" : languageForPath(path)?.server ?? "typescript";
    const active = await this.start(language);
    if (active === null) return null;
    const symbols = await active.client
      .request("workspace/symbol", { query: name })
      .catch((error: unknown) => {
        this.options.logger.debug("lsp symbol lookup failed", String(error));
        return null;
      });
    this.options.logger.debug("lsp symbols", {
      symbol: name,
      count: Array.isArray(symbols) ? symbols.length : -1,
    });
    if (!Array.isArray(symbols)) return null;
    const matches = symbols.filter((entry) => {
      if (typeof entry !== "object" || entry === null) return false;
      const record = entry as { name?: unknown; location?: unknown };
      if (record.name !== name) return false;
      if (path === undefined) return true;
      const location = record.location as { uri?: unknown } | undefined;
      return typeof location?.uri === "string" && location.uri.endsWith(encodePath(path));
    });
    const first = matches[0] as
      | {
          location?: { uri?: string; range?: { start?: LspPosition } };
        }
      | undefined;
    if (first?.location?.uri === undefined) return null;
    let position = first.location.range?.start ?? { line: 0, character: 0 };
    const documentSymbols = await active.client
      .request("textDocument/documentSymbol", {
        textDocument: { uri: first.location.uri },
      })
      .catch(() => null);
    const named = findSelection(documentSymbols, name);
    if (named !== null) {
      position = named;
    } else {
      const absolute = uriToPath(first.location.uri);
      const text = await readFile(absolute, "utf8").catch(() => null);
      if (text !== null) {
        const line = text.split("\n")[position.line] ?? "";
        const index = line.indexOf(name);
        if (index >= 0) position = { line: position.line, character: index };
      }
    }
    this.options.logger.debug("lsp prepare", {
      symbol: name,
      line: position.line,
      character: position.character,
    });
    const prepared = await active.client
      .request("textDocument/prepareCallHierarchy", {
        textDocument: { uri: first.location.uri },
        position,
      })
      .catch(() => null);
    this.options.logger.debug("lsp prepared", {
      count: Array.isArray(prepared) ? prepared.length : -1,
    });
    if (!Array.isArray(prepared) || prepared.length === 0) return null;
    return { client: active.client, item: prepared[0] };
  }

  private async start(language: string): Promise<Active | null> {
    const existing = this.active.get(language);
    if (existing !== undefined) {
      existing.lastUse = Date.now();
      return existing;
    }
    if (this.active.size >= this.options.config.maxServers) {
      const oldest = [...this.active.values()].sort(
        (left, right) => left.lastUse - right.lastUse,
      )[0];
      if (oldest !== undefined) await this.stopLanguage(oldest.language);
    }
    const command = await this.commandFor(language);
    if (command === null) {
      this.options.logger.warn(
        `no language server for ${language}; configure analysis.lsp.servers or enable autoInstall`,
      );
      return null;
    }
    await this.sweepStale(language, command);
    const client = new LspClient({
      command,
      cwd: this.options.projectRoot,
      rootPath: this.options.projectRoot,
      logger: this.options.logger,
      timeoutMs: this.options.config.timeoutMs,
      onDiagnostics: (uri, items) => this.capture(uri, items),
    });
    try {
      await client.start();
    } catch (error) {
      this.options.logger.warn(`could not start the ${language} language server`, String(error));
      await client.stop().catch(() => {});
      return null;
    }
    if (language === "typescript") await this.openProject(client);
    const active: Active = { client, language, lastUse: Date.now() };
    this.active.set(language, active);
    await this.recordPid(language);
    this.armIdleTimer();
    this.options.logger.info("language server started", { language });
    return active;
  }

  /** tsserver only indexes files the client has opened. */
  private async openProject(client: LspClient): Promise<void> {
    const files = await listProjectFiles(this.options.projectRoot, {
      maxFiles: 500,
    }).catch(() => []);
    const selected = files.filter((file) => /\.(ts|tsx|mts|cts)$/.test(file));
    for (const path of selected) {
      const text = await readProjectFile(this.options.projectRoot, path, 1_048_576);
      if (text === null) continue;
      const absolute = join(this.options.projectRoot, path);
      const languageId = path.endsWith(".tsx") ? "typescriptreact" : "typescript";
      client.didOpen(pathToUri(absolute), languageId, text);
    }
    if (selected.length > 0) {
      this.options.logger.debug("opened project files in the language server", {
        files: selected.length,
      });
    }
  }

  private async stopLanguage(language: string): Promise<void> {
    const active = this.active.get(language);
    if (active === undefined) return;
    this.active.delete(language);
    await active.client.stop().catch(() => {});
    await this.forgetPid(language);
  }

  /** Pidfile for one project's server in one language. */
  private pidPath(language: string): string {
    return join(
      this.options.root,
      "pids",
      `${language}-${pathHash(this.options.projectRoot, 8)}.pid`,
    );
  }

  private async recordPid(language: string): Promise<void> {
    const client = this.active.get(language)?.client;
    const pid = client?.pid ?? null;
    if (pid === null) return;
    const path = this.pidPath(language);
    await mkdir(join(this.options.root, "pids"), {
      recursive: true,
      mode: 0o700,
    }).catch(() => {});
    await writeFile(path, `${pid}\n`, { mode: 0o600 }).catch(() => {});
  }

  private async forgetPid(language: string): Promise<void> {
    await rm(this.pidPath(language), { force: true }).catch(() => {});
  }

  /**
   * A pidfile left by a crashed plugin names a server that no longer has a
   * client. Signal it only when the process still looks like the command we
   * started: a pid can be reused by an unrelated process.
   */
  private async sweepStale(language: string, command: LspCommand): Promise<void> {
    const path = this.pidPath(language);
    const raw = await readFile(path, "utf8").catch(() => null);
    if (raw === null) return;
    const pid = Number(raw.trim());
    if (!Number.isInteger(pid) || pid <= 0) {
      await rm(path, { force: true }).catch(() => {});
      return;
    }
    if (isAlive(pid) && (await commandMatches(pid, command))) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        // Gone between the check and the signal.
      }
    }
    await rm(path, { force: true }).catch(() => {});
  }

  private armIdleTimer(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => {
      const now = Date.now();
      for (const [language, active] of this.active) {
        if (now - active.lastUse >= this.options.config.idleMs) {
          void this.stopLanguage(language);
        }
      }
      if (this.active.size === 0 && this.timer !== null) {
        clearInterval(this.timer);
        this.timer = null;
      }
    }, IDLE_CHECK_MS);
    this.timer.unref?.();
  }

  private capture(uri: string, items: ReadonlyArray<LspDiagnostic>): void {
    this.diagnostics.set(intoKey(uri), items);
    const waiting = this.waiters.get(intoKey(uri));
    if (waiting === undefined) return;
    this.waiters.delete(intoKey(uri));
    for (const resolve of waiting) resolve(items);
  }

  private awaitDiagnostics(
    uri: string,
    signal?: AbortSignal,
  ): Promise<ReadonlyArray<LspDiagnostic>> {
    const key = intoKey(uri);
    const cached = this.diagnostics.get(key);
    if (cached !== undefined) return Promise.resolve(cached);
    return new Promise((resolve) => {
      const waiting = this.waiters.get(key) ?? [];
      const done = (items: ReadonlyArray<LspDiagnostic>): void => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        resolve(items);
      };
      const timer = setTimeout(() => done([]), Math.max(2_000, this.options.config.timeoutMs));
      timer.unref?.();
      const abort = (): void => done([]);
      signal?.addEventListener("abort", abort, { once: true });
      waiting.push(done);
      this.waiters.set(key, waiting);
    });
  }

  private async commandFor(language: string): Promise<LspCommand | null> {
    const configured = this.options.config.servers[language];
    if (configured !== undefined) {
      if (typeof configured === "string") {
        return { command: configured, args: ["--stdio"] };
      }
      if (configured.length === 0) return null;
      return {
        command: configured[0]!,
        args: [...configured.slice(1), ...(configured.includes("--stdio") ? [] : ["--stdio"])],
      };
    }

    if (language !== "typescript") return null;

    const projectCli = join(
      this.options.projectRoot,
      "node_modules",
      "typescript-language-server",
      "lib",
      "cli.mjs",
    );
    if (await isFile(projectCli)) {
      return { command: process.execPath, args: [projectCli, "--stdio"] };
    }
    const onPath = await findOnPath("typescript-language-server");
    if (onPath !== null) return { command: onPath, args: ["--stdio"] };

    const cachedCli = join(
      this.options.root,
      "typescript",
      SERVER_VERSION,
      "node_modules",
      "typescript-language-server",
      "lib",
      "cli.mjs",
    );
    if (await isFile(cachedCli)) {
      return { command: process.execPath, args: [cachedCli, "--stdio"] };
    }
    if (!this.options.config.autoInstall) return null;
    const installed = await this.installTypeScript();
    if (installed === null) return null;
    return { command: process.execPath, args: [installed, "--stdio"] };
  }

  private async installTypeScript(): Promise<string | null> {
    const root = join(this.options.root, "typescript");
    const final = join(root, SERVER_VERSION);
    const cli = join(final, "node_modules", "typescript-language-server", "lib", "cli.mjs");
    if (await isFile(cli)) return cli;

    await mkdir(root, { recursive: true, mode: 0o700 });
    const lock = join(root, ".install.lock");
    if (!(await acquire(lock))) {
      this.options.logger.warn("another language-server install is still running");
      return null;
    }
    try {
      if (await isFile(cli)) return cli;
      const staging = `${final}.partial-${process.pid}`;
      await rm(staging, { recursive: true, force: true }).catch(() => {});
      await mkdir(staging, { recursive: true, mode: 0o700 });
      this.options.logger.info("installing the TypeScript language server", {
        version: SERVER_VERSION,
        note: "one-time npm install into the plugin cache",
      });
      const npm = await findOnPath("npm");
      if (npm === null) throw new Error("npm is not on PATH");
      const result = await run(
        npm,
        [
          "install",
          "--prefix",
          staging,
          "--ignore-scripts",
          "--no-audit",
          "--no-fund",
          `typescript-language-server@${SERVER_VERSION}`,
          `typescript@${TYPESCRIPT_VERSION}`,
        ],
        INSTALL_TIMEOUT_MS,
        { npm_config_cache: join(this.options.root, "npm-cache") },
      );
      if (result.code !== 0) {
        throw new Error(`npm exited ${result.code}: ${result.stderr.slice(0, 200)}`);
      }
      if (!(await isFile(join(staging, "node_modules", "typescript-language-server", "lib", "cli.mjs")))) {
        throw new Error("npm did not install typescript-language-server");
      }
      await writeFile(
        join(staging, "manifest.json"),
        `${JSON.stringify({ server: SERVER_VERSION, typescript: TYPESCRIPT_VERSION, installedAt: new Date().toISOString() }, null, 2)}\n`,
        { mode: 0o600 },
      );
      await rm(final, { recursive: true, force: true }).catch(() => {});
      await rename(staging, final);
      this.options.logger.info("the TypeScript language server is installed", { directory: final });
      return isFile(cli).then((ok) => (ok ? cli : null));
    } catch (error) {
      this.options.logger.warn("could not install the TypeScript language server", String(error));
      return null;
    } finally {
      await rm(lock, { recursive: true, force: true }).catch(() => {});
    }
  }
}

export function languageForPath(
  path: string,
): { server: string; languageId: string } | null {
  if (/\.(ts|mts|cts)$/.test(path)) return { server: "typescript", languageId: "typescript" };
  if (/\.tsx$/.test(path)) return { server: "typescript", languageId: "typescriptreact" };
  return null;
}

function findSelection(value: unknown, name: string): LspPosition | null {
  if (!Array.isArray(value)) return null;
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as {
      name?: unknown;
      selectionRange?: { start?: LspPosition };
      children?: unknown;
    };
    if (record.name === name && record.selectionRange?.start !== undefined) {
      return record.selectionRange.start;
    }
    const nested = findSelection(record.children, name);
    if (nested !== null) return nested;
  }
  return null;
}

function sitesFrom(value: unknown, root: string): LspCallSite[] {
  if (!Array.isArray(value)) return [];
  const sites: LspCallSite[] = [];
  for (const entry of value) {
    const from = (entry as { from?: unknown; fromRanges?: unknown }).from;
    const ranges = (entry as { fromRanges?: unknown }).fromRanges;
    if (from === undefined) continue;
    const site = siteOf(from, root);
    if (site === null) continue;
    const callerLine = Array.isArray(ranges) && ranges[0] !== undefined
      ? ((ranges[0] as { start?: LspPosition }).start?.line ?? site.line - 1) + 1
      : site.line;
    sites.push({ ...site, callerLine });
  }
  return sites;
}

function siteOf(value: unknown, root: string): Omit<LspCallSite, "callerLine"> | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as {
    name?: unknown;
    uri?: unknown;
    range?: { start?: LspPosition };
    selectionRange?: { start?: LspPosition };
  };
  if (typeof record.name !== "string" || typeof record.uri !== "string") return null;
  const position = record.range?.start ?? record.selectionRange?.start ?? { line: 0, character: 0 };
  const absolute = uriToPath(record.uri);
  const path = absolute.startsWith(root)
    ? absolute.slice(root.length).replace(/^[/\\]/, "").replace(/\\/g, "/")
    : record.uri;
  return {
    name: record.name,
    path,
    line: position.line + 1,
    column: position.character + 1,
  };
}

function intoKey(uri: string): string {
  return uri;
}

function encodePath(path: string): string {
  return path.replace(/\\/g, "/");
}

async function isFile(path: string): Promise<boolean> {
  return stat(path).then((info) => info.isFile(), () => false);
}

async function findOnPath(command: string): Promise<string | null> {
  const path = process.env.PATH ?? "";
  const names =
    process.platform === "win32"
      ? [`${command}.cmd`, `${command}.exe`, `${command}.bat`, command]
      : [command];
  for (const directory of path.split(delimiter)) {
    if (directory.length === 0) continue;
    for (const name of names) {
      const candidate = join(directory, name);
      if (await isFile(candidate)) return candidate;
    }
  }
  return null;
}

async function acquire(lock: string): Promise<boolean> {
  const deadline = Date.now() + 5 * 60_000;
  while (true) {
    try {
      await mkdir(lock, { recursive: false, mode: 0o700 });
      return true;
    } catch {
      const info = await stat(lock).catch(() => null);
      if (info !== null && Date.now() - info.mtimeMs > LOCK_STALE_MS) {
        await rm(lock, { recursive: true, force: true }).catch(() => {});
        continue;
      }
      if (Date.now() > deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }
}

function run(
  command: string,
  args: ReadonlyArray<string>,
  timeoutMs: number,
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, [...args], {
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
      shell: process.platform === "win32",
      env: { ...process.env, ...extraEnv },
    });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 4096) stderr += chunk.toString("utf8");
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    timer.unref?.();
    child.once("error", (error) => {
      clearTimeout(timer);
      resolve({ code: null, stderr: String(error) });
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stderr });
    });
  });
}


function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // A process owned by another user exists; the signal is refused.
    return (error as { code?: unknown }).code === "EPERM";
  }
}

const execFileAsync = promisify(execFile);

/**
 * True when the pid's command line still names this language server. The
 * server may be launched through `node`, so the script argument is checked
 * too. Windows has no cheap equivalent, so a pid there is left alone.
 */
async function commandMatches(
  pid: number,
  command: LspCommand,
): Promise<boolean> {
  const needles = [basename(command.command)];
  for (const arg of command.args) {
    if (!arg.startsWith("-")) needles.push(basename(arg));
  }

  if (process.platform === "linux") {
    const raw = await readFile(`/proc/${pid}/cmdline`, "utf8").catch(() => null);
    if (raw === null) return false;
    const parts = raw.split("\0").filter((part) => part.length > 0);
    return needles.some((needle) => parts.some((part) => part.includes(needle)));
  }
  if (process.platform === "darwin") {
    const { stdout } = await execFileAsync("ps", [
      "-p",
      String(pid),
      "-o",
      "command=",
    ]).catch(() => ({ stdout: "" }));
    return needles.some((needle) => stdout.includes(needle));
  }
  return false;
}
