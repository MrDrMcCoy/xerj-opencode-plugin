# XERJ for OpenCode

Local code and documentation search, agent memory, and retrieval accounting
for OpenCode V2, backed by [XERJ](https://github.com/xerj-org/xerj).

The plugin downloads and manages a XERJ binary, runs a private node on loopback,
keeps a project index current with a filesystem watcher, and gives the model
cited passages instead of whole files. Nothing leaves the machine.

## What it does

- **Search.** `xerj_search` returns passages with `path:line` citations, not
  file listings. `xerj_def` finds a declaration by symbol.
- **Context injection.** Once per prompt, relevant passages and memories are
  spliced into the system context for that turn. It has a hard token budget
  and a deadline; a slow retrieval injects nothing rather than stalling.
- **Memory.** `xerj_remember`, `xerj_recall`, and `xerj_forget` keep durable
  project facts across sessions.
- **Remote ingest.** Pages fetched during a session are spooled and indexed, so
  a URL read today is searchable tomorrow. Reading or `cat`-ing a file outside
  the project also indexes it.
- **Hidden trees.** `index.hidden` indexes folders that `autoindex` skips, such
  as `.agents` or `.github`, as plain searchable documents.
- **Second brain.** Opt in with `index.brain` to build a graph over a docs
  folder. Hits expand one hop along citation and sequence edges.
- **Accounting.** `xerj_status` reports queries, hit rate, bytes returned, and
  measured token savings. The sidebar and `/xerj` panel show the same numbers.
- **Anomaly scoring.** `xerj_anomaly` flags spikes in a numeric metric series
  using XERJ's on-demand detector. It is batch scoring, not monitoring.

## Requirements

- OpenCode V2 with plugin support.
- Linux x86_64/aarch64, macOS x86_64/arm64, or Windows x86_64/arm64.
- No XERJ install needed: the plugin manages its own binary under
  `~/.local/share/opencode/xerj/` (or `%LOCALAPPDATA%` on Windows).
- Linux installs use the static musl build by default.

Only Linux x86_64 has been exercised end to end. The other release targets are
selected, downloaded, and probed for execution, but not tested in CI.

## Install

```jsonc
// opencode.json
{
  "plugins": [
    {
      "package": "@mrdrmccoy/xerj-opencode-plugin",
      "options": {
        "index": { "brain": [".agents"] }
      }
    }
  ]
}
```

Until the first npm publish, use `"package": "./"` from a checkout. The
scoped name above is the publish target, not yet a live package.

Restart OpenCode once. The first start downloads XERJ, creates a data root,
and builds the project index in the background. `xerj_status` reports when it
is ready.

## Configuration

Every option has a default; a malformed value warns and falls back instead of
failing plugin load.

```jsonc
{
  "binary":  { "version": "auto", "path": null, "target": null, "libc": "musl" },
  "node":    { "url": null, "port": 9200, "dataDir": null },
  "index":   { "auto": true, "watch": true, "debounceMs": 800,
               "periodicMs": 900000, "workers": null, "brain": [],
               "hidden": [], "hiddenMaxBytes": 262144, "semantic": true,
               "maxBytes": 2147483648, "maxMinutes": 10 },
  "remote":  { "enabled": true, "maxBytes": 2000000 },
  "context": { "enabled": true, "maxTokens": 1500, "memoryTokens": 400,
               "maxPassages": 4, "timeoutMs": 400 },
  "memory":  { "enabled": true },
  "stats":   { "enabled": true, "bytesPerToken": 4,
               "maxBaselineBytes": 131072 },
  "telemetry": { "anomaly": false }
}
```

| Key | Meaning |
|---|---|
| `binary.version` | `auto` tracks the latest release; any other value pins it. |
| `binary.path` | Use this binary; skip download, upgrade, and platform checks. |
| `binary.target` | Explicit release triple, e.g. `aarch64-apple-darwin`. |
| `binary.libc` | `musl` (default) or `gnu` on Linux. |
| `node.url` | Attach to this node and never spawn one. |
| `node.port` | Preferred port. The supervisor advances it if taken. |
| `index.auto` | Run project, hidden, and brain indexing on startup. |
| `index.watch` | Keep a resident `autoindex --watch` process. |
| `index.brain` | Folders to index as second brains, e.g. `[".agents"]`. |
| `index.hidden` | Hidden folders to index as plain documents, e.g. `[".agents"]`. |
| `index.hiddenMaxBytes` | Per-file ceiling for hidden documents. |
| `index.semantic` | Include the semantic retrieval leg. |
| `remote.enabled` | Spool and index fetched pages. |
| `context.enabled` | Inject retrieved context; the kill switch. |
| `context.maxTokens` | Ceiling for injected passages. |
| `context.memoryTokens` | Ceiling for injected memories. |
| `context.timeoutMs` | Retrieval deadline; miss it and inject nothing. |
| `stats.maxBaselineBytes` | Cap on the baseline credited per cited file. |
| `telemetry.anomaly` | Reserved; background telemetry is not implemented. |

## Tools

| Tool | Input | Use |
|---|---|---|
| `xerj_search` | `query`, `k?`, `max_tokens?` | Find passages before reading files. |
| `xerj_def` | `symbol`, `k?` | Find a declaration by name. |
| `xerj_status` | — | Node, index, memory, and accounting state. |
| `xerj_remember` | `text`, `kind?`, `topic?` | Store a durable fact. |
| `xerj_recall` | `query`, `k?` | Retrieve memories by meaning. |
| `xerj_forget` | `id` | Retract a memory. |
| `xerj_index` | `url?` or `path?` | Index a page or external file now. |
| `xerj_anomaly` | `index`, `time_field?`, `function?`, `field?`, `bucket_span?`, `threshold?` | Score a metric series and return flagged buckets. |

## TUI

- Sidebar: docs and size, hit rate, tokens saved, freshness.
- `/xerj`: open the details panel. Also accepts `status`, `reindex`,
  `remember <text>`, and `search <query>`.
- `/xerj-reindex`, `/xerj-remember`, `/xerj-search`: direct commands.

## How retrieval works

1. A lexical leg queries `body`, which is the field that produces a passage.
2. A semantic leg runs when the index mapping is `semantic_text`.
3. The two legs are fused with reciprocal rank fusion in the plugin. The
   engine refuses passages on a server-side hybrid query, so fusion happens
   client-side.
4. Results are cut to the token budget and formatted with `path:line`
   citations.
5. Brain hits get one hop of neighbors, using only `pathcite` and `sequence`
   edges, capped and budgeted separately.
6. Brain paths are rewritten to project-relative paths before line resolution.
   A hidden whole-file hit is dropped when a brain section covers that path, so
   one file is cited from the precise section index.

Savings are measured, not asserted: the baseline is each cited file's size
capped at `stats.maxBaselineBytes`, counted once per session. Reading a file
subtracts the bytes actually read, so a partial read only removes what it
covered.

## Data locations

```
~/.local/share/opencode/xerj/bin/<version>-<target>/xerj
~/.local/share/opencode/xerj/data/            engine storage
~/.local/share/opencode/xerj/state/<prefix>/  autoindex journals
~/.local/share/opencode/xerj/spool/<prefix>/  fetched pages
<project>/.xerj/                              marker and gitignore
~/.local/share/opencode/xerj/data/node.pid    detached node
```

The node is detached and outlives OpenCode; indexing and memory survive
restarts. The plugin never kills it on unload.

## Limitations

- XERJ is pre-1.0. The plugin pins a release and isolates every call behind
  `node/client.ts`; upgrades require the same major and never downgrade.
- `autoindex` skips hidden paths. `index.hidden` covers configured folders
  (`.agents`, `.github`) through a separate `_bulk` index. `.git`, `.xerj`,
  build output, virtualenvs, and secret-shaped files are always skipped.
- External files are indexed as plain text through `_bulk`; no AST or symbol
  extraction.
- Shell reads are detected heuristically: `cat`, `head`, `tail`, `less`,
  `more`, `nl`, `tac`, and `sed` with literal paths. Variables, globs, and
  `cd` chains beyond a simple `cd dir && ...` are not resolved.
- `autoindex` cannot watch a graph, so brains reindex on startup and on
  `/xerj-reindex`, not on every edit.
- Anomaly scoring has no datafeed, timer, or alerting.

## Development

```bash
bun install
bun test test/unit
npx tsc --noEmit
bun scripts/smoke.ts   # download, spawn, attach, stop
```

The repo dogfoods its own plugin through `opencode.json` and uses `.agents` as
the example brain.

## License

Apache-2.0.
