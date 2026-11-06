// XERJ runs beside the editor: indexing must not compete with typing or with
// the model call. Every process the plugin starts is therefore deprioritised by
// default, and the configuration can raise it when a corpus is small and speed
// matters more than responsiveness.
//
// CPU priority is portable (nice on POSIX, process priority class on Windows).
// I/O priority is a Linux concept, applied through `ionice` when it exists; on
// other platforms only CPU priority is set.

import { execFile } from "node:child_process";
import { setPriority } from "node:os";
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
