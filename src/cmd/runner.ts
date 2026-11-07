// One foreground command, captured to the pair the store reserved. No pty, no
// detach, no session: the caller waits, the deadline and the byte cap bound it,
// and the process group is killed when either trips.

import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import type { Logger } from "../log.ts";
import type { CmdPair, CmdResult, CmdStore } from "./store.ts";

export interface RunOptions {
  readonly command: string;
  readonly cwd: string;
  /** Deadline for the whole command. */
  readonly timeoutMs: number;
  /** Captured bytes before truncation. */
  readonly maxBytes: number;
  readonly store: CmdStore;
  readonly logger: Logger;
  readonly signal?: AbortSignal;
}

const KILL_GRACE_MS = 2_000;

export async function runCommand(options: RunOptions): Promise<CmdResult> {
  const { store, logger } = options;
  const pair: CmdPair = await store.begin(options.command, "run");

  return new Promise<CmdResult>((resolve) => {
    const started = Date.now();
    const out = createWriteStream(pair.partPath, { mode: 0o600 });
    let bytes = 0;
    let newlines = 0;
    let lastChar = "";
    let binary = false;
    let truncated = false;
    let timedOut = false;
    let closing = false;

    const child = spawn(process.platform === "win32" ? "cmd" : "/bin/bash", [
      // Not a login shell: a profile can print banners into the capture.
      ...(process.platform === "win32" ? ["/d", "/s", "/c"] : ["-c"]),
      options.command,
    ], {
      cwd: options.cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      // A new process group lets the deadline take the command's children too.
      detached: process.platform !== "win32",
      windowsHide: true,
    });

    const kill = (): void => {
      const pid = child.pid;
      if (pid === undefined) return;
      const signalGroup = (signal: NodeJS.Signals): void => {
        try {
          if (process.platform === "win32") child.kill(signal);
          else process.kill(-pid, signal);
        } catch {
          child.kill(signal);
        }
      };
      signalGroup("SIGTERM");
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) signalGroup("SIGKILL");
      }, KILL_GRACE_MS).unref?.();
    };

    const append = (chunk: Buffer): void => {
      if (closing) return;
      let data = chunk;
      if (bytes + data.length > options.maxBytes) {
        data = data.subarray(0, Math.max(0, options.maxBytes - bytes));
        truncated = true;
      }
      if (data.length === 0) {
        if (truncated) kill();
        return;
      }
      if (data.includes(0)) binary = true;
      bytes += data.length;
      for (let index = 0; index < data.length; index += 1) {
        const byte = data[index];
        if (byte === 10) newlines += 1;
        lastChar = byte === 10 ? "\n" : "x";
      }
      out.write(data);
    };

    child.stdout?.on("data", append);
    child.stderr?.on("data", append);

    const deadline = setTimeout(() => {
      timedOut = true;
      kill();
    }, Math.max(1_000, options.timeoutMs));
    deadline.unref?.();

    const onAbort = (): void => {
      truncated = true;
      kill();
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });

    const settle = async (exitCode: number | null): Promise<void> => {
      if (closing) return;
      closing = true;
      clearTimeout(deadline);
      options.signal?.removeEventListener("abort", onAbort);
      if (truncated) {
        out.write(`\n[xerj: output truncated at ${bytes} bytes]\n`);
      }
      await new Promise<void>((done) => out.end(done));
      const result: CmdResult = {
        stem: pair.stem,
        exitCode,
        durationMs: Date.now() - started,
        bytes,
        lines: newlines + (bytes > 0 && lastChar !== "\n" ? 1 : 0),
        truncated,
        binary,
        timedOut,
      };
      await store.finish(pair.stem, result).catch((error: unknown) => {
        logger.warn("could not finalise a command run", String(error));
      });
      resolve(result);
    };

    child.once("error", (error) => {
      logger.warn("could not run a command", String(error));
      void settle(null);
    });
    child.once("close", (code) => {
      void settle(code);
    });
  });
}
