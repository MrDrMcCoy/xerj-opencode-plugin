// What a process costs right now: CPU as a percentage of one core, and resident
// memory. The node is a separate process, so the plugin reads its counters from
// the kernel rather than guessing from its own event loop.
//
// Two readers share one shape: `sampleProcess` sleeps between two reads and
// suits a status line, while the telemetry sampler takes point readings and
// subtracts consecutive tick counts itself, so a 15-second series costs no
// sleep and reports the real interval.

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";

export interface ProcessUsage {
  /** CPU used during the sample window, as a percentage of one core. */
  readonly cpuPercent: number;
  /** Resident set size in bytes. */
  readonly memoryBytes: number;
}

/** One point reading; `ticks` is cumulative CPU time in clock ticks. */
export interface ProcessCounters {
  /** Linux only: user plus system ticks from `/proc/<pid>/stat`. */
  readonly ticks: number | null;
  /** Set on platforms that report a percentage directly, such as `ps`. */
  readonly cpuPercent: number | null;
  readonly memoryBytes: number;
  readonly threads: number | null;
}

/** Sample window: long enough to be stable, short enough to stay off a status line. */
const SAMPLE_MS = 120;
/** Clock ticks per second in `/proc`; Linux is always 100. */
const TICKS_PER_SECOND = 100;

/**
 * Reads one process's CPU and memory. Linux exposes both through `/proc`; on
 * other platforms the caller gets null and the panel shows nothing.
 */
export async function sampleProcess(
  pid: number,
  options: { readonly sampleMs?: number; readonly read?: typeof readFile } = {},
): Promise<ProcessUsage | null> {
  const read = options.read ?? readFile;
  const before = await cpuTicks(pid, read);
  if (before === null) return null;

  const started = Date.now();
  await new Promise((resolve) => setTimeout(resolve, options.sampleMs ?? SAMPLE_MS));
  const after = await cpuTicks(pid, read);
  if (after === null) return null;

  const elapsedSeconds = Math.max((Date.now() - started) / 1000, 0.001);
  const memoryBytes = await residentBytes(pid, read);
  if (memoryBytes === null) return null;

  return {
    cpuPercent: Math.max(0, Math.round(((after - before) / 100) / elapsedSeconds * 1000) / 10),
    memoryBytes,
  };
}

/**
 * One point reading of a process. No sleep: the telemetry sampler owns the
 * cadence and converts tick deltas itself.
 */
export async function readProcessCounters(
  pid: number,
  options: {
    readonly read?: typeof readFile;
    readonly platform?: NodeJS.Platform;
    readonly ps?: (pid: number) => Promise<string | null>;
  } = {},
): Promise<ProcessCounters | null> {
  const platform = options.platform ?? process.platform;

  if (platform === "linux") {
    const read = options.read ?? readFile;
    const ticks = await cpuTicks(pid, read);
    if (ticks === null) return null;
    const memoryBytes = await residentBytes(pid, read);
    if (memoryBytes === null) return null;
    return {
      ticks,
      cpuPercent: null,
      memoryBytes,
      threads: await threadCount(pid, read),
    };
  }

  if (platform === "win32") return null;

  const read = options.ps ?? psSample;
  const output = await read(pid);
  if (output === null) return null;
  const parsed = parsePs(output);
  if (parsed === null) return null;
  return {
    ticks: null,
    cpuPercent: parsed.cpuPercent,
    memoryBytes: parsed.memoryBytes,
    threads: null,
  };
}

/**
 * CPU percentage between two point readings of the same pid, or null when
 * there is no earlier reading to subtract.
 */
export function cpuPercentSince(
  previous: { readonly ticks: number; readonly at: number },
  next: { readonly ticks: number; readonly at: number },
): number | null {
  const elapsed = (next.at - previous.at) / 1000;
  if (elapsed <= 0) return null;
  const used = (next.ticks - previous.ticks) / TICKS_PER_SECOND;
  return Math.max(0, Math.round((used / elapsed) * 1000) / 10);
}

/** `ps -o pcpu=,rss= -p <pid>`: percentage of one core, RSS in KB. */
async function psSample(pid: number): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      "ps",
      ["-o", "pcpu=,rss=", "-p", String(pid)],
      { timeout: 2_000 },
      (error, stdout) => resolve(error === null ? stdout : null),
    );
  });
}

export function parsePs(
  output: string,
): { cpuPercent: number; memoryBytes: number } | null {
  const match = /^\s*([\d.]+)\s+(\d+)\s*$/m.exec(output);
  if (match?.[1] === undefined || match[2] === undefined) return null;
  const cpuPercent = Number(match[1]);
  const memoryBytes = Number(match[2]) * 1024;
  if (!Number.isFinite(cpuPercent) || !Number.isFinite(memoryBytes)) {
    return null;
  }
  return { cpuPercent, memoryBytes };
}

/** User plus system CPU ticks, or null when the process is gone. */
async function cpuTicks(
  pid: number,
  read: typeof readFile,
): Promise<number | null> {
  const stat = await read(`/proc/${pid}/stat`, "utf8").catch(() => null);
  if (stat === null) return null;

  // The command name is parenthesised and may contain spaces, so fields are
  // counted from the last `)` rather than split from the start.
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  const user = Number(fields[11]);
  const system = Number(fields[12]);
  if (!Number.isFinite(user) || !Number.isFinite(system)) return null;
  return user + system;
}

/** VmRSS in bytes, or null when the process is gone. */
async function residentBytes(
  pid: number,
  read: typeof readFile,
): Promise<number | null> {
  const status = await read(`/proc/${pid}/status`, "utf8").catch(() => null);
  if (status === null) return null;

  const match = /^VmRSS:\s+(\d+) kB$/m.exec(status);
  if (match?.[1] === undefined) return null;
  return Number(match[1]) * 1024;
}

/** Threads held; explains a falling CPU share when a pool shrinks. */
async function threadCount(
  pid: number,
  read: typeof readFile,
): Promise<number | null> {
  const status = await read(`/proc/${pid}/status`, "utf8").catch(() => null);
  if (status === null) return null;
  const match = /^Threads:\s+(\d+)$/m.exec(status);
  return match?.[1] === undefined ? null : Number(match[1]);
}
