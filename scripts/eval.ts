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

import { DEFAULT_CONFIG } from "../src/config.ts";
import { XerjClient } from "../src/node/client.ts";
import { indexPrefix, projectBrainName } from "../src/paths.ts";
import { BrainGraph } from "../src/search/brains.ts";
import { SearchService } from "../src/search/service.ts";

interface LabeledPrompt {
  readonly query: string;
  readonly expected: string;
  /**
   * A token the answer itself contains, for prompts where one unambiguous
   * anchor exists. Used to measure answerability, not just file recall.
   */
  readonly contains?: string;
}

/** Questions a maintainer would ask, with the file that answers each one. */
const LABELED: ReadonlyArray<LabeledPrompt> = [
  { query: "where is the idle timeout for the node configured", contains: 'idleMs', expected: "src/config.ts" },
  { query: "how does the node stop when the last session closes", contains: 'closeSession', expected: "src/lifecycle.ts" },
  { query: "how are fetched web pages stored", contains: 'spool', expected: "src/remote/spool.ts" },
  { query: "how is the savings baseline calculated", expected: "src/stats/ledger.ts" },
  { query: "how are fetched pages redacted before indexing", contains: 'redact', expected: "src/remote/spool.ts" },
  { query: "which credential file names are refused before reading", contains: 'isSecretPath', expected: "src/remote/spool.ts" },
  { query: "how does the plugin avoid indexing secrets", expected: "src/remote/spool.ts" },
  { query: "how are external files ingested", expected: "src/remote/spool.ts" },
  { query: "how does the watcher restart after a crash", contains: 'restarts', expected: "src/index/watcher.ts" },
  { query: "how are memory ids generated", contains: 'createHash', expected: "src/memory/store.ts" },
  { query: "how is a long memory clipped to fit", expected: "src/memory/store.ts" },
  { query: "how is the binary target triple chosen", contains: 'releaseTarget', expected: "src/platform.ts" },
  { query: "how is the node port lock acquired", contains: 'port-lock', expected: "src/node/supervisor.ts" },
  { query: "how are ports picked when two projects start at once", expected: "src/node/supervisor.ts" },
  { query: "how is the node pid file written", expected: "src/node/supervisor.ts" },
  { query: "how are shell command file references detected", contains: 'SHORT_FLAG', expected: "src/remote/shell.ts" },
  { query: "how are two search results fused by reciprocal rank", contains: 'RRF', expected: "src/search/service.ts" },
  { query: "how are prerelease version numbers compared", contains: 'comparePrerelease', expected: "src/semver.ts" },
  { query: "how is an anomaly detector scored", contains: '_score', expected: "src/telemetry/anomaly.ts" },
  { query: "how is the sidebar line rendered in the terminal UI", expected: "src/ui/format.ts" },
  { query: "how is a reindex triggered from the terminal UI", expected: "src/tui.tsx" },
  { query: "how does the sidebar refresh its numbers", expected: "src/tui.tsx" },
  { query: "how are hidden folders scanned and bulk indexed", contains: 'MAX_FILES', expected: "src/index/hidden.ts" },
  { query: "how are hidden documents removed when a file disappears", expected: "src/index/hidden.ts" },
  { query: "how is a brain graph built from a folder", expected: "src/index/brain.ts" },
  { query: "how are brain neighbors expanded one hop", expected: "src/search/brains.ts" },
  { query: "how is the release checksum verified before install", expected: "src/binary/release.ts" },
  { query: "how is the project index prefix derived from the path", contains: 'indexPrefix', expected: "src/paths.ts" },
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
  { query: "how is a turn answer captured into memory", contains: 'startTurnCapture', expected: "src/memory/capture.ts" },
  { query: "how are memory summaries expired by age", contains: 'planPrune', expected: "src/memory/retain.ts" },
  { query: "how does the search tool trim its response", expected: "src/tools/search.ts" },
  { query: "how are remembered facts ranked by recency", expected: "src/memory/store.ts" },
  { query: "how is a generated file demoted instead of dropped", expected: "src/search/rank.ts" },
  { query: "how does the plugin decide the node is idle", expected: "src/lifecycle.ts" },
  { query: "how is the index rebuilt when the embedding mode changes", expected: "src/node/embed-mode.ts" },
  { query: "how are literal file arguments found in a shell command", expected: "src/remote/shell.ts" },
  { query: "how is the autoindex command line assembled", expected: "src/index/corpus.ts" },
  { query: "how does the watcher back off between restarts", expected: "src/index/watcher.ts" },
  { query: "what counters does the plugin keep per process", expected: "src/stats/counters.ts" },
  { query: "how is a binary downloaded and verified", expected: "src/binary/manager.ts" },
  { query: "how are release checksums parsed", expected: "src/binary/release.ts" },
  { query: "which platform triples are supported", expected: "src/platform.ts" },
  { query: "how is a version with a prerelease tag compared", expected: "src/semver.ts" },
  { query: "how much disk does the engine data occupy", contains: 'directoryBytes', expected: "src/disk.ts" },
  { query: "when is the node log rotated", contains: 'rotateNodeLog', expected: "src/node/log-file.ts" },
  { query: "how is a tool result routed to the indexer", expected: "src/hooks/tool-results.ts" },
  { query: "how is the memory namespace named for a project", contains: 'memoryNamespace', expected: "src/paths.ts" },
  { query: "how does the plugin keep secrets out of the index", expected: "src/remote/spool.ts" },
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
    // Default to what the plugin ships, so a run reflects production.
    k: Number(flags.get("k") ?? DEFAULT_CONFIG.context.maxPassages),
    maxTokens: Number(flags.get("max-tokens") ?? DEFAULT_CONFIG.context.maxTokens),
    surface: (flags.get("surface") ?? "context") === "tool" ? "tool" : "context",
    trust: flags.has("no-trust") ? false : true,
    /** Expand a hit one hop through the graph; measures what edges add. */
    expand: flags.has("expand"),
    /** Graph name of the corpus; defaults to the project's own brain name. */
    brain: flags.get("brain"),
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
// Graph corpora can expand a hit one hop. Off by default so a run measures the
// corpus itself; `--expand` measures what the graph adds.
const graph = options.expand
  ? new BrainGraph({
      client,
      brains: [
        {
          name: options.brain ?? projectBrainName(projectRoot),
          label: ".",
          directory: projectRoot,
          prefix: options.prefix,
          pathciteOnly: true,
        },
      ],
      logger,
    })
  : null;

const service = new SearchService(
  client,
  [options.prefix],
  logger,
  projectRoot,
  graph,
);

let found = 0;
let answerable = 0;
let anchored = 0;
/** Anchored prompts where the file was cited but the answer text was cut. */
let sectionLoss = 0;
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

  const onTarget = result.hits.filter((hit) => hit.path === prompt.expected);
  if (prompt.contains !== undefined) {
    anchored += 1;
    const needle = prompt.contains;
    const hasText = onTarget.some((hit) => hit.text.includes(needle));
    if (hasText) answerable += 1;
    else if (onTarget.length > 0) sectionLoss += 1;
  }

  if (onTarget.length > 0) {
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
  /** Prompts whose expected file arrived with the answer text inside it. */
  anchored,
  answerable,
  answerRate: anchored === 0 ? null : answerable / anchored,
  sectionLoss,
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
  console.log(
    `answerable ${summary.answerable}/${summary.anchored}  ` +
      `(of those, ${summary.sectionLoss} cited the file without the answer text)`,
  );
  for (const miss of summary.misses) {
    console.log(`  miss ${miss.expected}  (top: ${miss.top})  <- ${miss.query}`);
  }
}
