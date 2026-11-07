// One managed-binary command. The engine already owns cloning, indexing,
// signatures, and pack handling, so the plugin's wrappers only build argument
// lists and read the result.

import { spawn } from "node:child_process";

export interface EngineRunResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_ERROR_BYTES = 64 * 1024;

/** Runs one command with a hard deadline; never throws. */
export function runEngine(
  binary: string,
  args: ReadonlyArray<string>,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<EngineRunResult> {
  return new Promise((resolve) => {
    const child = spawn(binary, [...args], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      env,
    });
    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    timer.unref?.();
    // Keep at most the cap, not "append a whole chunk while under it": one
    // 64 KiB stderr chunk would otherwise double a 64 KiB limit.
    child.stdout.on("data", (chunk: Buffer) => {
      if (stdoutBytes >= MAX_OUTPUT_BYTES) return;
      const room = MAX_OUTPUT_BYTES - stdoutBytes;
      const part = chunk.length > room ? chunk.subarray(0, room) : chunk;
      stdout += part.toString("utf8");
      stdoutBytes += part.length;
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderrBytes >= MAX_ERROR_BYTES) return;
      const room = MAX_ERROR_BYTES - stderrBytes;
      const part = chunk.length > room ? chunk.subarray(0, room) : chunk;
      stderr += part.toString("utf8");
      stderrBytes += part.length;
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: String(error), timedOut });
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}
