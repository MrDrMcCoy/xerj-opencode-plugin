// What a process costs right now: CPU as a percentage of one core, and resident
// memory. The node is a separate process, so the plugin reads its counters from
// the kernel rather than guessing from its own event loop.

import { readFile } from "node:fs/promises";

export interface ProcessUsage {
  /** CPU used during the sample window, as a percentage of one core. */
  readonly cpuPercent: number;
  /** Resident set size in bytes. */
  readonly memoryBytes: number;
}

/** Sample window: long enough to be stable, short enough to stay off a status line. */
const SAMPLE_MS = 120;

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

/** User plus system CPU ticks, or null when the process is gone. */
async function cpuTicks(pid: number, read: typeof readFile): Promise<number | null> {
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
async function residentBytes(pid: number, read: typeof readFile): Promise<number | null> {
  const status = await read(`/proc/${pid}/status`, "utf8").catch(() => null);
  if (status === null) return null;

  const match = /^VmRSS:\s+(\d+) kB$/m.exec(status);
  if (match?.[1] === undefined) return null;
  return Number(match[1]) * 1024;
}
