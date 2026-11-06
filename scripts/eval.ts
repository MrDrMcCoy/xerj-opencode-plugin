// Retrieval benchmark: measures the production search path against a labeled
// set of questions about this repository. Run it before and after a ranking
// change, against a node that has this project indexed:
//
//   bun scripts/eval.ts
//   bun scripts/eval.ts --k 8 --surface tool --json
//
// It reports how often the expected file survives into the result set, the
// bytes those results cost, and which prompts missed. The expected file is
// what a maintainer would open to answer the question, so the number is a
// proxy for usefulness, not a proof of it.

import { XerjClient } from "../src/node/client.ts";
import { indexPrefix } from "../src/paths.ts";
import { SearchService } from "../src/search/service.ts";

interface LabeledPrompt {
  readonly query: string;
  readonly expected: string;
}

/** Questions a maintainer would ask, with the file that answers each one. */
const LABELED: ReadonlyArray<LabeledPrompt> = [
  { query: "where is the idle timeout for the node configured", expected: "src/config.ts" },
  { query: "how does the node stop when the last session closes", expected: "src/lifecycle.ts" },
  { query: "how are fetched web pages stored", expected: "src/remote/spool.ts" },
  { query: "how is the savings baseline calculated", expected: "src/stats/ledger.ts" },
  { query: "how are fetched pages redacted before indexing", expected: "src/remote/spool.ts" },
  { query: "which credential file names are refused before reading", expected: "src/remote/spool.ts" },
  { query: "how does the plugin avoid indexing secrets", expected: "src/remote/spool.ts" },
  { query: "how are external files ingested", expected: "src/remote/spool.ts" },
  { query: "how does the watcher restart after a crash", expected: "src/index/watcher.ts" },
  { query: "how are memory ids generated", expected: "src/memory/store.ts" },
  { query: "how is a long memory clipped to fit", expected: "src/memory/store.ts" },
  { query: "how is the binary target triple chosen", expected: "src/platform.ts" },
  { query: "how is the node port lock acquired", expected: "src/node/supervisor.ts" },
  { query: "how are ports picked when two projects start at once", expected: "src/node/supervisor.ts" },
  { query: "how is the node pid file written", expected: "src/node/supervisor.ts" },
  { query: "how are shell command file references detected", expected: "src/remote/shell.ts" },
  { query: "how are two search results fused by reciprocal rank", expected: "src/search/service.ts" },
  { query: "how are prerelease version numbers compared", expected: "src/semver.ts" },
  { query: "how is an anomaly detector scored", expected: "src/telemetry/anomaly.ts" },
  { query: "how is the sidebar line rendered in the terminal UI", expected: "src/ui/format.ts" },
  { query: "how is a reindex triggered from the terminal UI", expected: "src/tui.tsx" },
  { query: "how does the sidebar refresh its numbers", expected: "src/tui.tsx" },
  { query: "how are hidden folders scanned and bulk indexed", expected: "src/index/hidden.ts" },
  { query: "how are hidden documents removed when a file disappears", expected: "src/index/hidden.ts" },
  { query: "how is a brain graph built from a folder", expected: "src/index/brain.ts" },
  { query: "how are brain neighbors expanded one hop", expected: "src/search/brains.ts" },
  { query: "how is the release checksum verified before install", expected: "src/binary/release.ts" },
  { query: "how is the project index prefix derived from the path", expected: "src/paths.ts" },
  { query: "what does the durable log ring buffer keep", expected: "src/log.ts" },
  { query: "how are generated lockfiles demoted in ranking", expected: "src/search/rank.ts" },
  { query: "how does the plugin detect a node another process started", expected: "src/node/runtime.ts" },
  { query: "what happens when the state directory is already in use", expected: "src/index/watcher.ts" },
  { query: "what token budget does the context block use", expected: "src/config.ts" },
  { query: "where are anomalies scored", expected: "src/telemetry/anomaly.ts" },
  { query: "how does the plugin know a session was compacted", expected: "src/memory/capture.ts" },
  { query: "how are remembered memories kept relevant to the prompt", expected: "src/hooks/session.ts" },
  { query: "how is the injected context formatted for the model", expected: "src/hooks/session.ts" },
  { query: "what does the ledger count as saved bytes", expected: "src/stats/ledger.ts" },
  { query: "how is the embedding mode reconciled after a change", expected: "src/node/embed-mode.ts" },
  { query: "how does the plugin refuse to index the home directory", expected: "src/index.ts" },
];

interface Options {
  readonly url: string;
  readonly prefix: string;
  readonly k: number;
  readonly maxTokens: number;
  readonly surface: "context" | "tool";
  readonly trust: boolean;
  readonly json: boolean;
}

function parseArgs(argv: ReadonlyArray<string>, projectRoot: string): Options {
  const flags = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] ?? "";
    if (!argument.startsWith("--")) continue;
    const [name, inline] = argument.slice(2).split("=");
    if (inline !== undefined) flags.set(name ?? "", inline);
    else flags.set(name ?? "", argv[index + 1] ?? "");
  }

  const url = flags.get("url") ?? process.env.XERJ_URL ?? "http://127.0.0.1:9200";
  return {
    url,
    prefix: flags.get("prefix") ?? process.env.XERJ_PREFIX ?? indexPrefix(projectRoot),
    k: Number(flags.get("k") ?? 6),
    maxTokens: Number(flags.get("max-tokens") ?? 1500),
    surface: (flags.get("surface") ?? "context") === "tool" ? "tool" : "context",
    trust: flags.has("no-trust") ? false : true,
    json: flags.has("json"),
  };
}

const projectRoot = process.cwd();
const options = parseArgs(process.argv.slice(2), projectRoot);
const client = new XerjClient(options.url);
const logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  entries: async () => [],
  flush: async () => {},
} as never;
const service = new SearchService(client, [options.prefix], logger, projectRoot);

let found = 0;
let empty = 0;
let bytes = 0;
const misses: Array<{ expected: string; query: string; top: string }> = [];

for (const prompt of LABELED) {
  const result = await service.search(prompt.query, {
    k: options.k,
    maxTokens: options.maxTokens,
    surface: options.surface,
    trustSemantic: options.trust,
  });
  bytes += result.bytes;
  if (result.hits.length === 0) empty += 1;

  if (result.hits.some((hit) => hit.path === prompt.expected)) {
    found += 1;
    continue;
  }
  misses.push({
    expected: prompt.expected,
    query: prompt.query,
    top: result.hits[0]?.path ?? "(none)",
  });
}

const summary = {
  prompts: LABELED.length,
  found,
  recall: found / LABELED.length,
  empty,
  bytes,
  bytesPerPrompt: Math.round(bytes / LABELED.length),
  misses,
};

if (options.json) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  console.log(
    `found ${summary.found}/${summary.prompts}  empty=${summary.empty}  ` +
      `${summary.bytes} bytes (${summary.bytesPerPrompt} per prompt)`,
  );
  for (const miss of summary.misses) {
    console.log(`  miss ${miss.expected}  (top: ${miss.top})  <- ${miss.query}`);
  }
}
