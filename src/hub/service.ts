// The engine's hub surface, wrapped for the tool layer.
//
// Pack fetching, signature checks, snapshot restore, routing, and licence
// rules all live in `xerj ask` / `xerj hub`; this module only picks the
// privacy flags, runs the managed binary, and formats the JSON answer. The
// plugin never handles a signing key or a pack archive.

import { spawn } from "node:child_process";
import type { Config } from "../config.ts";
import type { Logger } from "../log.ts";

export interface HubOptions {
  readonly config: Config["hub"];
  readonly binary: () => string | null;
  readonly nodeUrl: () => string | null;
  readonly logger: Logger;
  /** Tests inject a runner; production spawns the managed binary. */
  readonly run?: (
    args: ReadonlyArray<string>,
    env: NodeJS.ProcessEnv,
  ) => Promise<RunResult>;
}

export interface HubAskInput {
  readonly question: string;
  readonly corpus?: string;
  readonly mode?: "how" | "def" | "files";
  readonly symbol?: string;
  readonly maxTokens?: number;
}

export interface HubResult {
  readonly ok: boolean;
  readonly text: string;
  readonly corpus?: string;
  readonly answeredFrom?: string;
  readonly cached?: boolean;
}

export interface RunResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const STATUS_ANSWERED = 0;
const NO_MATCH = 1;
const USAGE = 2;
const VERIFY_FAILED = 3;
const AMBIGUOUS = 4;
const NO_PUBKEY = 5;
const NO_CATALOGUE = 6;

export class HubService {
  constructor(private readonly options: HubOptions) {}

  async ask(input: HubAskInput): Promise<HubResult> {
    const question = input.question.trim();
    if (question.length === 0) return failure("ask a non-empty question");
    if (input.mode === "def" && (input.symbol ?? "").trim().length === 0) {
      return failure("mode `def` needs a symbol");
    }

    const network = this.options.config.network;
    const hosted = network ? this.options.config.hosted : "off";
    const args = [
      "ask",
      question,
      "--json",
      "--max-tokens",
      String(Math.max(100, input.maxTokens ?? this.options.config.maxTokens)),
      "--hosted",
      hosted,
    ];
    if (!network) args.push("--offline");
    if (input.corpus !== undefined) args.push("--corpus", input.corpus);
    if (input.mode === "def") args.push("--def", (input.symbol ?? "").trim());
    else if (input.mode === "files") args.push("--files");
    else if (input.mode === "how") args.push("--how");

    const nodeUrl = this.options.nodeUrl();
    if (nodeUrl !== null) args.push("--url", nodeUrl);

    const result = await this.run(args);
    if (result.timedOut) return failure(`xerj ask timed out after ${this.options.config.timeoutMs} ms`);
    if (result.code === STATUS_ANSWERED) return this.formatAnswer(result.stdout);
    return failure(this.explain(result));
  }

  async find(query: string, k = 8): Promise<HubResult> {
    const text = query.trim();
    if (text.length === 0) return failure("ask a non-empty question");
    const result = await this.run([
      "hub",
      "find",
      text,
      "--json",
      "--k",
      String(Math.max(1, Math.min(k, 25))),
    ]);
    if (result.timedOut) return failure("xerj hub find timed out");
    if (result.code !== STATUS_ANSWERED) return failure(this.explain(result));
    return this.formatFind(result.stdout);
  }

  async sync(): Promise<HubResult> {
    if (!this.options.config.network) {
      return failure("hub.network is off; sync needs the network");
    }
    const args = ["hub", "sync"];
    const nodeUrl = this.options.nodeUrl();
    if (nodeUrl !== null) args.push("--url", nodeUrl);
    const result = await this.run(args);
    if (result.timedOut) return failure("xerj hub sync timed out");
    const output = [result.stdout, result.stderr].join("\n").trim();
    if (result.code !== STATUS_ANSWERED) {
      return failure(output.length > 0 ? output : this.explain(result));
    }
    return { ok: true, text: output.length > 0 ? output : "hub catalogue synced" };
  }

  async status(): Promise<HubResult> {
    const result = await this.run(["hub", "status"]);
    if (result.timedOut) return failure("xerj hub status timed out");
    const output = [result.stdout, result.stderr].join("\n").trim();
    if (result.code !== STATUS_ANSWERED) {
      return failure(output.length > 0 ? output : this.explain(result));
    }
    const network = this.options.config.network;
    const hosted = network ? this.options.config.hosted : "off";
    return {
      ok: true,
      text: `${output}\nplugin: network ${network ? "on" : "off"} · hosted ${hosted}`,
    };
  }

  private async run(args: ReadonlyArray<string>): Promise<RunResult> {
    const binary = this.options.binary();
    if (binary === null) {
      return { code: null, stdout: "", stderr: "the xerj binary is not installed", timedOut: false };
    }
    const env = {
      ...process.env,
      XERJ_HUB_URL: this.options.config.url,
    };
    if (this.options.run !== undefined) return this.options.run(args, env);
    return runBinary(binary, args, env, this.options.config.timeoutMs);
  }

  private explain(result: RunResult): string {
    const detail = result.stderr.trim() || result.stdout.trim();
    switch (result.code) {
      case NO_MATCH:
        return detail.length > 0
          ? `${detail}\n\nNo hub corpus covered this. Try xerj_hub find or index the project locally.`
          : "No hub corpus covered this question. Try xerj_hub find or index the project locally.";
      case VERIFY_FAILED:
        return `The pack failed signature or checksum verification. Nothing was used.\n${detail}`;
      case AMBIGUOUS:
        return `More than one corpus matched. Re-run with a corpus slug.\n${detail}`;
      case NO_PUBKEY:
        return "This xerj build has no hub public key, so no pack can be verified. Nothing was downloaded.";
      case NO_CATALOGUE:
        return (
          "No hub catalogue is cached. Run xerj_hub action=sync once " +
          `(hub.network is ${this.options.config.network ? "on" : "off"}).\n${detail}`
        );
      case USAGE:
        return `xerj rejected the request.\n${detail}`;
      default:
        return detail.length > 0 ? detail : "the hub command failed";
    }
  }

  private formatAnswer(stdout: string): HubResult {
    let answer: {
      corpus?: unknown;
      pin_sha?: unknown;
      pin_date?: unknown;
      age_days?: unknown;
      licence_spdx?: unknown;
      answered_from?: unknown;
      mode?: unknown;
      hits?: unknown;
      warnings?: unknown;
      truncated?: unknown;
    };
    try {
      answer = JSON.parse(stdout) as typeof answer;
    } catch {
      return failure("the hub returned an answer that is not JSON");
    }
    const hits = Array.isArray(answer.hits) ? answer.hits : [];
    const corpus = typeof answer.corpus === "string" ? answer.corpus : "unknown";
    const answeredFrom =
      typeof answer.answered_from === "string" ? answer.answered_from : "unknown";
    const pin = typeof answer.pin_sha === "string" ? answer.pin_sha.slice(0, 8) : "unknown";
    const date = typeof answer.pin_date === "string" ? answer.pin_date : "unknown";
    const age = typeof answer.age_days === "number" ? `${answer.age_days}d old` : "age unknown";
    const licence = typeof answer.licence_spdx === "string" ? answer.licence_spdx : "licence unknown";
    const lines: string[] = [
      `${corpus} · pin ${pin} (${date}, ${age}) · ${licence}`,
      `answered from: ${answeredFrom}`,
    ];

    for (const hit of hits) {
      if (typeof hit !== "object" || hit === null) continue;
      const record = hit as {
        file?: unknown;
        line?: unknown;
        kind?: unknown;
        text?: unknown;
        value?: unknown;
        licence_warning?: unknown;
      };
      const file = typeof record.file === "string" ? record.file : "?";
      const line = typeof record.line === "number" ? record.line : 0;
      const kind = typeof record.kind === "string" ? ` [${record.kind}]` : "";
      const body = typeof record.text === "string" ? record.text : "";
      lines.push(`\n${file}:${line}${kind}\n${body}`);
      if (typeof record.value === "string") lines.push(`value: ${record.value}`);
      if (typeof record.licence_warning === "string") {
        lines.push(`licence warning: ${record.licence_warning}`);
      }
    }

    if (Array.isArray(answer.warnings)) {
      for (const warning of answer.warnings) {
        if (typeof warning === "string") lines.push(`warning: ${warning}`);
      }
    }
    if (answer.truncated === true) lines.push("truncated: raise max_tokens for more");

    return {
      ok: true,
      text: lines.join("\n"),
      corpus,
      answeredFrom,
      cached: answeredFrom === "local_pack",
    };
  }

  private formatFind(stdout: string): HubResult {
    let body: { routing?: unknown; corpora?: unknown };
    try {
      body = JSON.parse(stdout) as typeof body;
    } catch {
      return failure("xerj hub find returned no JSON");
    }
    const corpora = Array.isArray(body.corpora) ? body.corpora : [];
    if (corpora.length === 0) {
      return failure("no hub corpus covers that question; index the project locally instead");
    }
    const lines = [
      `${corpora.length} candidate${corpora.length === 1 ? "" : "s"}` +
        (typeof body.routing === "string" ? ` · routing ${body.routing}` : ""),
    ];
    for (const entry of corpora) {
      if (typeof entry !== "object" || entry === null) continue;
      const record = entry as {
        slug?: unknown;
        score?: unknown;
        cached?: unknown;
        licence_spdx?: unknown;
        pack_bytes?: unknown;
        ask_for?: unknown;
      };
      const slug = typeof record.slug === "string" ? record.slug : "?";
      const cached = record.cached === true ? "cached" : "not cached";
      const licence = typeof record.licence_spdx === "string" ? record.licence_spdx : "?";
      const mb =
        typeof record.pack_bytes === "number"
          ? `${(record.pack_bytes / 1e6).toFixed(1)} MB`
          : "?";
      const askFor = typeof record.ask_for === "string" ? record.ask_for : "";
      const score = typeof record.score === "number" ? ` · ${record.score.toFixed(1)}` : "";
      lines.push(`${slug} · ${cached} · ${mb} · ${licence}${score}\n  ${askFor}`);
    }
    return { ok: true, text: lines.join("\n") };
  }
}

function failure(text: string): HubResult {
  return { ok: false, text };
}

function runBinary(
  binary: string,
  args: ReadonlyArray<string>,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<RunResult> {
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
      if (stderr.length < 64 * 1024) stderr += chunk.toString("utf8");
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
