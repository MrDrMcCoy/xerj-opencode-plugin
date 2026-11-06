// Runtime detection. Everything that needs the host rather than the config
// lives here, so the release selection itself stays pure and testable.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  effectiveArch,
  isRosetta,
  platformInfoForTarget,
  releaseTarget,
  type Libc,
  type PlatformInfo,
} from "../platform.ts";

const execFileAsync = promisify(execFile);
const SYSCTL_TIMEOUT_MS = 2_000;

export interface RuntimeTarget {
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly rosetta: boolean;
  readonly info: PlatformInfo | null;
}

export interface DetectOptions {
  readonly libc: Libc;
  readonly target: string | null;
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Deadline for host detection commands; defaults to 2 seconds. */
  readonly timeoutMs?: number;
}

export async function detectRuntime(options: DetectOptions): Promise<RuntimeTarget> {
  const platform = process.platform;
  const rosetta =
    platform === "darwin"
      ? await detectRosetta(options.timeoutMs ?? SYSCTL_TIMEOUT_MS)
      : false;
  const arch = effectiveArch(platform, process.arch, options.env ?? process.env, rosetta);

  const info = options.target
    ? platformInfoForTarget(options.target, platform)
    : releaseTarget(platform, arch, rosetta, options.libc);

  return { platform, arch, rosetta, info };
}

/** Apple Silicon running an x86_64 process under Rosetta 2. */
async function detectRosetta(timeoutMs: number): Promise<boolean> {
  if (process.platform !== "darwin") return false;

  try {
    const { stdout } = await execFileAsync("sysctl", ["-n", "sysctl.proc_translated"], {
      timeout: timeoutMs,
    });
    return isRosetta(stdout);
  } catch {
    return false;
  }
}
