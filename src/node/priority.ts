// XERJ runs beside the editor: indexing must not compete with typing or with
// the model call. Every process the plugin starts is therefore deprioritised by
// default, and the configuration can raise it when a corpus is small and speed
// matters more than responsiveness.
//
// CPU priority is portable (nice on POSIX, process priority class on Windows).
// I/O priority is a Linux concept, applied through `ionice` when it exists; on
// other platforms only CPU priority is set.

import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { availableParallelism, setPriority } from "node:os";
import { promisify } from "node:util";
import type { Logger } from "../log.ts";

export enum Priority {
  Low = "low",
  Normal = "normal",
  High = "high",
}

/** `nice` values: 19 is the lowest a user process can ask for. */
export function niceValue(priority: Priority): number {
  switch (priority) {
    case Priority.Low:
      return 19;
    case Priority.Normal:
      return 0;
    case Priority.High:
      return -10;
  }
}

/** `ionice`: class 3 is idle, class 2 best-effort. Realtime is never used. */
export function ioniceArgs(priority: Priority, pid: number): string[] {
  const className = priority === Priority.Low ? "3" : "2";
  return ["-c", className, "-p", String(pid)];
}

/** Windows process priority classes; `High` still yields to the foreground. */
export function windowsPriorityClass(priority: Priority): string {
  switch (priority) {
    case Priority.Low:
      return "Idle";
    case Priority.Normal:
      return "Normal";
    case Priority.High:
      return "High";
  }
}

export interface PriorityRunner {
  readonly platform: NodeJS.Platform;
  setNice(pid: number, value: number): Promise<void>;
  run(command: string, args: string[]): Promise<void>;
}

const execFileAsync = promisify(execFile);

const DEFAULT_RUNNER: PriorityRunner = {
  platform: process.platform,
  setNice: async (pid, value) => {
    setPriority(pid, value);
  },
  run: async (command, args) => {
    await execFileAsync(command, args, { timeout: 5_000 });
  },
};

/**
 * Deprioritises a process the plugin just spawned. Best effort: a denied or
 * unsupported call is logged at debug level and never blocks startup, because
 * priority is an optimisation, not a requirement.
 */
export async function applyPriority(options: {
  readonly pid: number | undefined;
  readonly priority: Priority;
  readonly logger?: Logger;
  readonly runner?: PriorityRunner;
}): Promise<void> {
  const { pid, priority, logger } = options;
  if (pid === undefined) return;

  const runner = options.runner ?? DEFAULT_RUNNER;
  const windows = runner.platform === "win32";

  if (windows) {
    const priorityClass = windowsPriorityClass(priority);
    await attempt(
      () =>
        runner.run("powershell.exe", [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `(Get-Process -Id ${pid}).PriorityClass = '${priorityClass}'`,
        ]),
      logger,
      `could not set the priority class of pid ${pid}`,
    );
    return;
  }

  await attempt(
    () => runner.setNice(pid, niceValue(priority)),
    logger,
    `could not set the nice value of pid ${pid}`,
  );

  // `ionice` is Linux-only and optional; a missing binary is not an error.
  if (runner.platform === "linux") {
    await attempt(
      () => runner.run("ionice", ioniceArgs(priority, pid)),
      logger,
      `could not set the I/O priority of pid ${pid}`,
    );
  }
}

async function attempt(
  action: () => Promise<void>,
  logger: Logger | undefined,
  message: string,
): Promise<void> {
  try {
    await action();
  } catch (error) {
    logger?.debug(message, String(error));
  }
}

// CPU affinity. `node.cpus` selects the logical CPUs every XERJ process may
// run on. Like priority, it is best effort: a missing `taskset`, a restrictive
// cpuset, or a platform with no per-process selection logs once and leaves the
// process alone.

/** A validated `node.cpus` value; null means "leave affinity unchanged". */
export type CpuSpec =
  | { readonly kind: "list"; readonly indexes: ReadonlyArray<number> }
  | { readonly kind: "odd" }
  | { readonly kind: "even" }
  | { readonly kind: "percent"; readonly percent: number };

export interface CpuSpecResult {
  readonly spec: CpuSpec | null;
  /** Why a non-empty value was refused; null when it parsed. */
  readonly error: string | null;
}

// Bounds a hostile range so parsing cannot allocate an unbounded set.
const MAX_CPU_INDEX = 65_535;
const WINDOWS_CPU_LIMIT = 64;
// One warning per logger is enough when a platform cannot honour the key.
const UNSUPPORTED_WARNED = new WeakSet<Logger>();

/**
 * Parses `node.cpus`: a list of indices and inclusive ranges, `odd`, `even`,
 * a percentage, or `all`. Syntax is checked here; which CPUs actually exist is
 * resolved at spawn, because a cgroup or a parent `taskset` can hide some.
 */
export function parseCpuSpec(value: string): CpuSpecResult {
  const trimmed = value.trim();
  const lower = trimmed.toLowerCase();
  if (trimmed.length === 0 || lower === "all") {
    return { spec: null, error: null };
  }
  if (lower === "odd" || lower === "even") {
    return { spec: { kind: lower }, error: null };
  }

  const percent = /^(\d{1,3})%$/.exec(trimmed);
  if (percent !== null) {
    const amount = Number(percent[1]);
    if (amount < 1 || amount > 100) {
      return { spec: null, error: "percentage must be between 1 and 100" };
    }
    return { spec: { kind: "percent", percent: amount }, error: null };
  }

  const list = parseIndexList(trimmed);
  if (list.error !== null) return { spec: null, error: list.error };
  return { spec: { kind: "list", indexes: list.indexes }, error: null };
}

function parseIndexList(
  value: string,
): { indexes: number[]; error: string | null } {
  const indexes = new Set<number>();

  for (const raw of value.split(",")) {
    const item = raw.trim();
    if (item.length === 0) return { indexes: [], error: "has an empty item" };

    const range = /^(\d+)-(\d+)$/.exec(item);
    if (range !== null) {
      const start = Number(range[1]);
      const end = Number(range[2]);
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) {
        return { indexes: [], error: `range ${item} is too large` };
      }
      if (start > end) {
        return { indexes: [], error: `range ${item} is reversed` };
      }
      if (end > MAX_CPU_INDEX) {
        return {
          indexes: [],
          error: `range ${item} exceeds CPU ${MAX_CPU_INDEX}`,
        };
      }
      for (let index = start; index <= end; index += 1) indexes.add(index);
      continue;
    }

    if (/^\d+$/.test(item)) {
      const index = Number(item);
      if (!Number.isSafeInteger(index) || index > MAX_CPU_INDEX) {
        return {
          indexes: [],
          error: `CPU index ${item} exceeds ${MAX_CPU_INDEX}`,
        };
      }
      indexes.add(index);
      continue;
    }

    const message =
      `has an invalid item "${item}"; use indices, ranges, ` +
      `"odd", "even", or a percentage`;
    return { indexes: [], error: message };
  }

  return { indexes: [...indexes].sort((a, b) => a - b), error: null };
}

function formatRun(start: number, end: number): string {
  return start === end ? String(start) : `${start}-${end}`;
}

/** The configuration form of a CPU spec; `all` means no affinity change. */
export function formatCpuSpec(spec: CpuSpec | null): string {
  if (spec === null) return "all";
  switch (spec.kind) {
    case "list":
      return formatCpuList(spec.indexes);
    case "odd":
    case "even":
      return spec.kind;
    case "percent":
      return `${spec.percent}%`;
  }
}

/** Compresses a sorted index set back into the list form `taskset` takes. */
export function formatCpuList(indexes: ReadonlyArray<number>): string {
  const sorted = [...new Set(indexes)].sort((a, b) => a - b);
  const first = sorted[0];
  if (first === undefined) return "";

  const parts: string[] = [];
  let runStart = first;
  let runEnd = first;
  for (const index of sorted.slice(1)) {
    if (index === runEnd + 1) {
      runEnd = index;
      continue;
    }
    parts.push(formatRun(runStart, runEnd));
    runStart = index;
    runEnd = index;
  }
  parts.push(formatRun(runStart, runEnd));
  return parts.join(",");
}

/** Maps a spec onto the CPUs this process may actually use. */
export function resolveCpuIndexes(
  spec: CpuSpec,
  allowed: ReadonlyArray<number>,
): number[] {
  const available = [...new Set(allowed)].sort((a, b) => a - b);

  switch (spec.kind) {
    case "list": {
      const usable = new Set(available);
      return spec.indexes.filter((index) => usable.has(index));
    }
    case "odd":
      return available.filter((index) => index % 2 === 1);
    case "even":
      return available.filter((index) => index % 2 === 0);
    case "percent": {
      const share = (available.length * spec.percent) / 100;
      const count = Math.max(1, Math.floor(share));
      return available.slice(0, count);
    }
  }
}

/**
 * The CPUs this process may use. Linux exposes the real affinity mask, which
 * a cgroup or a parent `taskset` narrows; elsewhere the visible count is the
 * best available answer. `os.availableParallelism()` already accounts for
 * quotas, unlike `os.cpus().length`.
 */
export function availableCpuIndexes(
  platform: NodeJS.Platform = process.platform,
): number[] {
  if (platform === "linux") {
    const restricted = cpusFromProcStatus();
    if (restricted !== null && restricted.length > 0) return restricted;
  }
  return Array.from({ length: availableParallelism() }, (_, index) => index);
}

function cpusFromProcStatus(): number[] | null {
  try {
    const status = readFileSync("/proc/self/status", "utf8");
    const prefix = "Cpus_allowed_list:";
    for (const line of status.split("\n")) {
      if (!line.startsWith(prefix)) continue;
      const parsed = parseIndexList(line.slice(prefix.length).trim());
      return parsed.error === null ? parsed.indexes : null;
    }
  } catch {
    // /proc is absent on non-Linux hosts and in unusual sandboxes.
  }
  return null;
}

/** A Windows affinity bitmask, or null when the set needs a second group. */
export function windowsAffinityMask(
  indexes: ReadonlyArray<number>,
): bigint | null {
  let mask = 0n;
  for (const index of indexes) {
    if (index >= WINDOWS_CPU_LIMIT) return null;
    mask |= 1n << BigInt(index);
  }
  return mask;
}

/** `IntPtr` is signed 64-bit, so a mask with bit 63 set is emitted negative. */
export function windowsAffinityValue(mask: bigint): string {
  const signed = mask >= 1n << 63n ? mask - (1n << 64n) : mask;
  return signed.toString();
}

export interface AffinityRunner {
  readonly platform: NodeJS.Platform;
  run(command: string, args: string[]): Promise<void>;
  /** CPUs this process may use; defaults to the host's visible set. */
  allowedCpus?: () => ReadonlyArray<number>;
}

/**
 * Confines a process to the configured CPUs. The caller applies this right
 * after spawn; on Linux the list covers every thread because `xerj` builds its
 * scan pool after startup.
 */
export async function applyCpuAffinity(options: {
  readonly pid: number | undefined;
  readonly spec: CpuSpec;
  readonly logger?: Logger;
  readonly runner?: AffinityRunner;
}): Promise<void> {
  const { pid, spec, logger } = options;
  if (pid === undefined) return;

  const runner: AffinityRunner = options.runner ?? DEFAULT_RUNNER;
  const allowed =
    runner.allowedCpus?.() ?? availableCpuIndexes(runner.platform);
  const indexes = resolveCpuIndexes(spec, allowed);

  if (indexes.length === 0) {
    logger?.warn(
      "node.cpus matched no available CPU; leaving affinity unchanged",
    );
    return;
  }
  if (spec.kind === "list" && indexes.length < spec.indexes.length) {
    const dropped = spec.indexes.length - indexes.length;
    logger?.warn(`node.cpus dropped ${dropped} unavailable CPU(s)`);
  }

  if (runner.platform === "linux") {
    await attempt(
      () =>
        runner.run("taskset", [
          "-a",
          "-pc",
          formatCpuList(indexes),
          String(pid),
        ]),
      logger,
      `could not set the CPU affinity of pid ${pid}`,
    );
    return;
  }

  if (runner.platform === "win32") {
    const mask = windowsAffinityMask(indexes);
    if (mask === null) {
      warnUnsupported(
        logger,
        "node.cpus names a CPU at or above 64; " +
          "Windows processor groups are not supported",
      );
      return;
    }
    const command =
      `(Get-Process -Id ${pid}).ProcessorAffinity = ` +
      `[IntPtr]${windowsAffinityValue(mask)}`;
    await attempt(
      () =>
        runner.run("powershell.exe", [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          command,
        ]),
      logger,
      `could not set the CPU affinity of pid ${pid}`,
    );
    return;
  }

  warnUnsupported(logger, `node.cpus has no effect on ${runner.platform}`);
}

function warnUnsupported(logger: Logger | undefined, message: string): void {
  if (logger === undefined || UNSUPPORTED_WARNED.has(logger)) return;
  UNSUPPORTED_WARNED.add(logger);
  logger.warn(message);
}
