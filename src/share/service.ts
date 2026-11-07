// Read-only share links, wrapped from `xerj share`.
//
// The engine owns the link, passcode, expiry, guest keys, and revocation. The
// plugin builds the arguments, points the command at its own node, and returns
// the link the engine printed. No tunnel is offered: it would send traffic
// through a third party.

import type { Config } from "../config.ts";
import type { Logger } from "../log.ts";
import { runEngine, type EngineRunResult } from "../engine/run.ts";

export interface ShareOptions {
  readonly config: Config["share"];
  readonly binary: () => string | null;
  readonly nodeUrl: () => string | null;
  readonly logger: Logger;
  readonly run?: (
    args: ReadonlyArray<string>,
    env: NodeJS.ProcessEnv,
  ) => Promise<EngineRunResult>;
}

export interface ShareResult {
  readonly ok: boolean;
  readonly text: string;
}

const OK = 0;

export class ShareService {
  constructor(private readonly options: ShareOptions) {}

  async create(input: {
    readonly target: string;
    readonly expires?: string;
    readonly maxClaims?: number;
    readonly passcode?: string;
    readonly label?: string;
  }): Promise<ShareResult> {
    const target = input.target.trim();
    if (target.length === 0) return failure("a target index or folder is required");
    const expires = input.expires?.trim() || this.options.config.expires;
    const maxClaims = Math.max(
      1,
      Math.min(
        input.maxClaims ?? this.options.config.maxClaims,
        50,
      ),
    );
    const args = [
      "share",
      target,
      "--expires",
      expires,
      "--max-claims",
      String(maxClaims),
      ...this.urlArgs(),
    ];
    if (input.passcode !== undefined && input.passcode.trim().length > 0) {
      args.push("--passcode", input.passcode.trim());
    }
    if (input.label !== undefined && input.label.trim().length > 0) {
      args.push("--label", input.label.trim());
    }
    return this.result(await this.run(args), "share created");
  }

  async list(): Promise<ShareResult> {
    return this.result(
      await this.run(["share", "--list", ...this.urlArgs()]),
      "no shares",
    );
  }

  async revoke(handle: string): Promise<ShareResult> {
    const id = handle.trim();
    if (id.length === 0) return failure("a share handle is required");
    return this.result(
      await this.run(["share", "--revoke", id, ...this.urlArgs()]),
      `revoked ${id}`,
    );
  }

  private urlArgs(): string[] {
    const url = this.options.nodeUrl();
    return url === null ? [] : ["--url", url];
  }

  private async run(args: ReadonlyArray<string>): Promise<EngineRunResult> {
    const binary = this.options.binary();
    if (binary === null) {
      return {
        code: null,
        stdout: "",
        stderr: "the xerj binary is not installed",
        timedOut: false,
      };
    }
    if (this.options.run !== undefined) return this.options.run(args, process.env);
    return runEngine(binary, args, process.env, this.options.config.timeoutMs);
  }

  private result(result: EngineRunResult, fallback: string): ShareResult {
    if (result.timedOut) {
      return failure(`xerj share timed out after ${this.options.config.timeoutMs} ms`);
    }
    const output = [result.stdout, result.stderr].join("\n").trim();
    if (result.code === OK) {
      return { ok: true, text: output.length > 0 ? output : fallback };
    }
    return failure(output.length > 0 ? output : "the share command failed");
  }
}

function failure(text: string): ShareResult {
  return { ok: false, text };
}
