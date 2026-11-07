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
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    timer.unref?.();
    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length < MAX_OUTPUT_BYTES) stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < MAX_ERROR_BYTES) stderr += chunk.toString("utf8");
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
