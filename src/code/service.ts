// Reference-corpus retrieval and lifecycle, wrapped from `xerj code` and
// `xerj corpus`. The plugin never clones or indexes a corpus itself: the
// engine owns the checkout, the build, and the licence detection.

import type { Config } from "../config.ts";
import type { Logger } from "../log.ts";
import { runEngine, type EngineRunResult } from "../engine/run.ts";

export interface CodeOptions {
  readonly config: Config["code"];
  readonly binary: () => string | null;
  readonly nodeUrl: () => string | null;
  /** `<data root>/code`; `XERJ_CODE_HOME` for the engine. */
  readonly codeRoot: string;
  readonly logger: Logger;
  readonly run?: (
    args: ReadonlyArray<string>,
    env: NodeJS.ProcessEnv,
  ) => Promise<EngineRunResult>;
}

export interface CodeResult {
  readonly ok: boolean;
  readonly text: string;
}

export interface CodeQuery {
  readonly corpus: string;
  readonly query: string;
  readonly k?: number;
  readonly mode?: "bm25" | "semantic" | "hybrid";
  readonly lang?: string;
  readonly full?: number;
}

const OK = 0;

export class CodeService {
  constructor(private readonly options: CodeOptions) {}

  async list(): Promise<CodeResult> {
    return this.textResult(
      await this.run(["corpus", "list", ...this.urlArgs()]),
      "no reference corpora yet; add one with xerj_code action=add",
    );
  }

  async add(corpus: string, urls: ReadonlyArray<string>): Promise<CodeResult> {
    if (!this.options.config.network) {
      return failure(
        "code.network is off; adding a corpus clones its git URLs and needs the network",
      );
    }
    const name = corpus.trim();
    if (name.length === 0) return failure("corpus is required");
    const clean = urls.map((url) => url.trim()).filter((url) => url.length > 0);
    if (clean.length === 0) return failure("at least one git URL is required");
    return this.textResult(
      await this.run(["corpus", "add", name, ...clean]),
      `added ${name}`,
    );
  }

  async index(corpus: string): Promise<CodeResult> {
    const name = corpus.trim();
    if (name.length === 0) return failure("corpus is required");
    return this.textResult(
      await this.run(["corpus", "index", name, ...this.urlArgs()]),
      `indexed ${name}`,
    );
  }

  async query(input: CodeQuery): Promise<CodeResult> {
    const corpus = input.corpus.trim();
    const query = input.query.trim();
    if (corpus.length === 0 || query.length === 0) {
      return failure("corpus and query are required");
    }
    const args = [
      "code",
      corpus,
      query,
      "-k",
      String(Math.max(1, Math.min(input.k ?? this.options.config.maxResults, 50))),
      "--mode",
      input.mode ?? "bm25",
      "--full",
      String(
        Math.max(
          0,
          input.full ?? this.options.config.maxPassageChars,
        ),
      ),
      ...this.urlArgs(),
    ];
    if (input.lang !== undefined && input.lang.trim().length > 0) {
      args.push("--lang", input.lang.trim());
    }
    return this.textResult(await this.run(args), "");
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
    const env = { ...process.env, XERJ_CODE_HOME: this.options.codeRoot };
    if (this.options.run !== undefined) return this.options.run(args, env);
    return runEngine(binary, args, env, this.options.config.timeoutMs);
  }

  private textResult(result: EngineRunResult, fallback: string): CodeResult {
    if (result.timedOut) {
      return failure(`xerj code timed out after ${this.options.config.timeoutMs} ms`);
    }
    const output = [result.stdout, result.stderr].join("\n").trim();
    if (result.code === OK) {
      return { ok: true, text: output.length > 0 ? output : fallback };
    }
    return failure(output.length > 0 ? output : "the corpus command failed");
  }
}

function failure(text: string): CodeResult {
  return { ok: false, text };
}
