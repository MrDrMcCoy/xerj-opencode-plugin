# XERJ for OpenCode

Local code and documentation search, agent memory, and retrieval accounting
for OpenCode V2, backed by [XERJ](https://github.com/xerj-org/xerj).

The plugin downloads and manages a XERJ binary, runs a private node on loopback,
keeps a project index current with a filesystem watcher, and gives the model
cited passages instead of whole files. Nothing leaves the machine.

## Table of contents

- [What it does](#what-it-does)
- [Requirements](#requirements)
- [Install](#install)
  - [From a local checkout](#from-a-local-checkout)
- [Where the config goes](#where-the-config-goes)
- [Configuration](#configuration)
  - [Local telemetry](#local-telemetry)
- [How the project index works](#how-the-project-index-works)
- [How retrieval works](#how-retrieval-works)
  - [Measuring a change](#measuring-a-change)
- [Memory](#memory)
  - [Distillation](#distillation)
- [Command output](#command-output)
- [Fetched pages and external files](#fetched-pages-and-external-files)
- [Tools](#tools)
- [Analysis tools](#analysis-tools)
- [TUI](#tui)
  - [Completion notices](#completion-notices)
- [Project documentation](#project-documentation)
  - [Eager mode](#eager-mode)
- [System documentation](#system-documentation)
- [Extra indexes and dumps](#extra-indexes-and-dumps)
- [Anomaly scoring](#anomaly-scoring)
- [Standalone MCP server](#standalone-mcp-server)
  - [Client setup](#client-setup)
  - [Arguments](#arguments)
  - [MCP tools](#mcp-tools)
- [Releasing](#releasing)
- [Data locations](#data-locations)
- [Limitations](#limitations)
- [Development](#development)
- [License](#license)

## What it does

- **Search.** `xerj_search` returns passages with `path:line` citations, not
  file listings. `xerj_def` finds a declaration by symbol.
- **Context injection.** Once per prompt, relevant passages and memories are
  spliced into the system context for that turn. It has a hard token budget
  and a deadline; a slow retrieval injects nothing rather than stalling.
- **Memory.** `xerj_remember`, `xerj_recall`, and `xerj_forget` keep durable
  project facts across sessions.
- **Remote ingest.** Pages fetched during a session are spooled and indexed, so
  a URL read today is searchable tomorrow. Any shell command that references
  a file outside the project also indexes it.
- **One graph corpus.** `index.graph` indexes the project as a single corpus
  with sections, symbols, `path:line`, and reference edges, refreshed by the
  plugin's own watcher. `index.hidden` adds folders the engine skips, such as
  `.agents` or `.github`; a folder configured in `index.brain` is indexed once,
  as a graph, not twice.
- **System documentation.** `/xerj-sysdocs` indexes this machine's man and info
  pages, including user, Homebrew, and Nix roots, skipping unchanged pages and
  pruning pages that vanished.
- **Library documentation.** `/xerj-prjdocs` reads the project's manifests and
  runtime pins, then crawls official docs for its languages, frameworks, and
  cloud APIs at the versions it uses, pruning other versions. `eager` widens
  the crawl and judges pages with the current model.
- **Your own datasets.** `xerj_dataset` lists, creates, and deletes extra
  indexes, and imports or exports them as Elasticsearch-compatible NDJSON
  dumps.
- **MCP.** The same nineteen retrieval and analysis tools are available to
  agents that do not run OpenCode, through a standalone `xerj-mcp` server on
  stdio.
- **Accounting.** `xerj_status` reports queries, hit rate, bytes returned, and
  measured token savings. The sidebar and `/xerj` panel show the same numbers.
- **Anomaly scoring.** `xerj_anomaly` flags spikes in a numeric metric series
  using XERJ's on-demand detector. It is batch scoring, not monitoring.
- **Command output.** `xerj_run` keeps a command's output under `.xerj/cmd/`
  and returns a receipt; `xerj_out` lists what ran, shows an exact line range,
  or searches it, so a long log is read by range instead of by `head` and
  `tail`.
- **Code navigation.** `xerj_refs`, `xerj_outline`, `xerj_zoom`, `xerj_find`,
  `xerj_ast`, and `xerj_imports` answer "where is this used", "what does this
  file declare", and "what imports this" without a language server.
- **Local telemetry.** Every operation, boot, crash, and process sample goes
  into bounded local files, and `xerj_telemetry` reports them. Nothing is sent
  anywhere.
- **A live sidebar.** The TUI shows the service state, corpora, memory, savings,
  and jobs, and announces a finished index or docs run with a toast.

[Back to top](#table-of-contents)

## Requirements

- OpenCode V2 with plugin support.
- Linux x86_64/aarch64, macOS x86_64/arm64, or Windows x86_64/arm64.
- No XERJ install needed: the plugin manages its own binary under
  `~/.local/share/opencode/xerj/` (or `%LOCALAPPDATA%` on Windows).
- Linux installs use the static musl build by default.

Only Linux x86_64 has been exercised end to end. The other release targets are
selected, downloaded, and probed for execution, but not tested in CI.

[Back to top](#table-of-contents)

## Install

The plugin is published as `@mrdrmccoy/xerj-opencode-plugin`. Add it to any
OpenCode config file, global or project:

```jsonc
// ~/.config/opencode/opencode.jsonc   (all projects)
// or <project>/opencode.json          (one project)
{
  "plugins": [
    {
      "package": "@mrdrmccoy/xerj-opencode-plugin",
      "options": {
        "index": { "hidden": [".agents"] }
      }
    }
  ]
}
```

The host fetches the package on first load and caches it under
`~/.cache/opencode/`. No separate install command is needed.

### From a local checkout

A checkout works the same way. Clone it, install its dev dependencies, and
point `package` at the directory:

```bash
git clone https://github.com/xerj-org/xerj-opencode-plugin.git \
  ~/src/xerj-opencode-plugin
cd ~/src/xerj-opencode-plugin
bun install      # dev dependencies; the host supplies @opencode/plugin
```

```jsonc
// ~/.config/opencode/opencode.jsonc   (all projects)
// or <project>/opencode.json          (one project)
{
  "plugins": [
    {
      "package": "/home/you/src/xerj-opencode-plugin",
      "options": {
        "index": { "hidden": [".agents"] }
      }
    }
  ]
}
```

Use an absolute path. A relative `package` resolves against the project holding
the config, not against the checkout, so `"./"` works only when the config and
the checkout share a directory. That is what this repository does in its own
`opencode.json`.

The server and RPC entries are TypeScript sources that the host compiles when
it loads them. The TUI entry ships prebuilt (`dist/tui.js`) because it must bind
to the host's JSX runtime rather than resolve its own copy; `prepack`
regenerates it.

After adding the entry, restart OpenCode once. The first start downloads XERJ,
creates `<project>/.xerj`, and builds the project index in the background.
`xerj_status` reports when it is ready. `opencode debug config` lists the
config files that were read, which is the quickest way to confirm the entry was
picked up.

[Back to top](#table-of-contents)

## Where the config goes

OpenCode reads two config documents and applies them in order:

| Scope | Path | Notes |
|---|---|---|
| Global | `~/.config/opencode/opencode.jsonc` | Applies to every project. `$XDG_CONFIG_HOME` replaces `~/.config` when set. |
| Project | `<project>/opencode.json` | Applies to that project only. |

Each directory holds one document: when both `opencode.json` and
`opencode.jsonc` exist, `opencode.json` wins. In a directory without
`opencode.json`, `opencode.jsonc` is read instead. The same rule applies in the
global config directory, which is why the examples above name
`opencode.jsonc` there. This is what `opencode debug config` reports:

```bash
opencode debug config        # prints every config source with its path
opencode debug paths         # prints the global config, data, cache, state dirs
```

[Back to top](#table-of-contents)

## Configuration

Options go under the plugin entry, inside `options`. Never at the document
root: a top-level `context` key is ignored by the plugin.

Every option has a default, so the file only needs the keys that differ. A
malformed value warns and falls back instead of failing plugin load. Nested
objects merge per key, so `{"context": {"maxTokens": 800}}` keeps the other
context defaults.

This is the complete set with its defaults, in
`~/.config/opencode/opencode.jsonc` (all projects) or `<project>/opencode.json`
(one project):

```jsonc
{
  "plugins": [
    {
      "package": "@mrdrmccoy/xerj-opencode-plugin",
      "options": {
        "binary": {
          "version": "auto",             // "auto" tracks the newest release
          "path": null,                  // explicit binary; skips download
          "target": null,                // e.g. "aarch64-apple-darwin"
          "libc": "musl",                // "musl" or "gnu" on Linux
          "detectTimeoutMs": 2000,       // host detection commands
          "commandTimeoutMs": 60000,     // download and local commands
          "requestTimeoutMs": 10000      // release metadata and checksums
        },
        "storage": {
          "root": null                   // null means <project>/.xerj
        },
        "node": {
          "url": null,                   // attach to this node; never spawn
          "priority": "low",             // "low", "normal", or "high"
          "cpus": "odd",                 // "0-3,8", "odd", "even", "50%"
          "logMaxBytes": 8388608,        // 8 MiB; 0 disables rotation
          "port": 9200,
          "dataDir": null,
          "idleMs": 1800000,             // 30 minutes
          "shutdownOnIdle": true,
          "clientTimeoutMs": 5000,       // read and search requests
          "writeTimeoutMs": 120000,      // writes that embed first
          "probeTimeoutMs": 800,         // one GET / health probe
          "startupTimeoutMs": 30000,     // spawn to first answer
          "stopGraceMs": 5000            // SIGTERM to SIGKILL
        },
        "index": {
          "auto": true,
          "watch": true,
          "debounceMs": 800,
          "periodicMs": 900000,          // 15 minutes
          "workers": null,
          "brain": [],
          "hidden": [],
          "hiddenMaxBytes": 262144,      // 256 KiB per hidden file
          "semantic": true,
          "graph": true,
          "git": true,
          "gitLimit": 500,
          "neural": true,
          "maxBytes": 2147483648,        // 2 GiB first-index ceiling
          "maxMinutes": 10
        },
        "remote": {
          "enabled": true,
          "maxBytes": 2000000,
          "fetchTimeoutMs": 10000        // xerj_index URL fetch
        },
        "context": {
          "enabled": true,
          "maxTokens": 1500,
          "memoryTokens": 400,
          "archiveEnabled": true,
          "archiveMaxBytes": 67108864,   // 64 MiB
          "rehydrate": true,             // recall passages after a compaction
          "rehydrateTokens": 600,
          "maxPassages": 8,
          "timeoutMs": 400,              // retrieval deadline
          "recallTimeoutMs": 120,        // post-compaction re-read
          "hintTimeoutMs": 150           // one-line search hint
        },
        "prjdocs": {
          "maxTargets": 40,
          "maxPages": 0,                 // 0 uses the per-source default
          "eager": false,
          "eagerMaxPages": 120,
          "eagerMaxDepth": 12,
          "eagerModelCalls": 150,
          "eagerKeywords": [],
          "builtin": true,
          "builtinXerjPages": 200,
          "builtinElasticsearchPages": 2500,
          "builtinRefreshDays": 7,
          "requestTimeoutMs": 15000,     // one page request
          "latestTimeoutMs": 5000,       // one release lookup
          "userAgent": "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
          "requestIntervalMs": 250,      // one request per host interval
          "requestJitterMs": 100         // random extra delay
        },
        "sysdocs": {
          "maxDocs": 5000,
          "maxBytesPerDoc": 65536,       // 64 KiB
          "manDirs": [],
          "infoDirs": []
        },
        "memory": {
          "enabled": true,
          "captureTurns": true,
          "retain": {
            "days": 0,                   // 0 means unlimited
            "maxCount": 0,               // 0 disables the count cap
            "maxBytes": 2147483648       // 2 GiB
          },
          "distill": {                   // typed memory from live turns
            "enabled": true,             // on; the local model downloads once
            "judge": "local",            // CPU model; "model" or "heuristic"
            "minConfidence": 55,         // percentage a candidate needs
            "maxPerTurn": 3,             // memories promoted per turn
            "maxPerProject": 200,        // distilled memories kept
            "modelMaxCalls": 3,          // model calls one turn may spend
            "modelContextChars": 1200,   // turn text shown to the model
            "modelTimeoutMs": 4000,      // deadline for one judgement
            "local": {                   // the jevos CPU decision model
              "version": "jevos-v5",     // release tag; changing it re-downloads
              "path": null,              // pre-installed dir; skips download
              "port": 8017,              // loopback port for the server
              "threads": 0,              // 0 uses every logical CPU
              "idleMs": 600000,          // stop after this long unused
              "timeoutMs": 5000,         // one judgement request
              "threshold": 20,           // P(keep) floor, percent
              "kindConfidence": 40,      // kind choice floor, percent
              "downloadTimeoutMs": 900000, // 630 MB model download
              "startupTimeoutMs": 120000 // model load + first health
            }
          }
        },
        "stats": {
          "enabled": true,
          "bytesPerToken": 4,
          "maxBaselineBytes": 131072     // 128 KiB
        },
        "cmd": {                        // command output kept under .xerj/cmd/
          "enabled": true,              // registers xerj_run and xerj_out
          "suggest": true,              // teach the tools in the context block
          "mirrorHostResults": true,    // record host shell results too
          "inject": false,              // include the corpus in prompt injection
          "maxBytes": 268435456,        // 256 MiB for the pair files
          "maxIndexBytes": 33554432,    // 32 MiB of indexed text
          "maxCommandBytes": 67108864,  // captured per command before truncation
          "maxFileBytes": 33554432,     // one file past this is stored, not parsed
          "windowLines": 200,           // index window, lines
          "windowBytes": 16384,         // index window, bytes
          "showTokens": 1200,           // cap for one xerj_out show
          "timeoutMs": 600000,          // deadline for one xerj_run
          "hintLines": 40               // a mirrored result past this queues a hint
        },
        "telemetry": {
          "anomaly": false,             // reserved; on-demand tool only
          "enabled": true,              // local files only; never sent
          "maxBytes": 134217728,        // 128 MiB for the whole directory
          "samplesPerType": 256,        // ring length per operation type
          "rotateBytes": 8388608,       // 8 MiB before ops.ndjson rotates
          "rotations": 4,               // rotated operation files kept
          "flushMs": 5000,              // queue drain period
          "sampleMs": 15000,            // CPU and RSS period; 0 disables
          "maxText": 160                // caller text characters; 0 none
        }
      }
    }
  ]
}
```

The same entry works with a checkout path instead of the package name; see
[Install](#install).

| Key | Meaning |
|---|---|
| `binary.version` | `auto` tracks the latest release; any other value pins it. |
| `binary.path` | Use this binary; skip download, upgrade, and platform checks. |
| `binary.target` | Explicit release triple, e.g. `aarch64-apple-darwin`. |
| `binary.libc` | `musl` (default) or `gnu` on Linux. |
| `binary.detectTimeoutMs` | Deadline for host detection commands such as `sysctl`. Default 2000. |
| `binary.commandTimeoutMs` | Deadline for the archive download and every local command (`tar`, `--version`). Default 60000. |
| `binary.requestTimeoutMs` | Deadline for release metadata and checksum requests. Default 10000. |
| `storage.root` | Per-project XERJ root. Defaults to `<project>/.xerj`; relative paths resolve inside the project, absolute paths may point elsewhere. |
| `node.url` | Attach to this node and never spawn one. |
| `node.logMaxBytes` | Size at which `node.log` rotates to `node.log.1`; `0` disables rotation. Default 8 MiB. |
| `node.priority` | CPU and I/O priority for every XERJ process: `low` (default), `normal`, or `high`. `low` is nice 19 plus idle-class I/O on Linux, the idle priority class on Windows. |
| `node.cpus` | CPUs every XERJ process may use: a comma-separated list of indices and ranges (`"0-3,8"`), `odd` (default), `even`, or a percentage of the available CPUs (`"50%"`, rounded down). `null` or `"all"` leaves affinity unchanged. Linux uses `taskset`; Windows uses `ProcessorAffinity`; macOS has no per-process selection and warns once. |
| `node.port` | Preferred port. The supervisor advances it if taken. |
| `node.idleMs` | Stop this project's node after this long with no session activity. |
| `node.shutdownOnIdle` | Set false to keep the node up after the last session closes. |
| `node.clientTimeoutMs` | Deadline for a read or search request to the node. Default 5000. |
| `node.writeTimeoutMs` | Deadline for a write. A semantic write embeds before it acknowledges, so this is longer than a read. Default 120000. |
| `node.probeTimeoutMs` | Deadline for one `GET /` health probe. Default 800. |
| `node.startupTimeoutMs` | How long a spawn waits for the node to answer. Default 30000. |
| `node.stopGraceMs` | How long a stop waits after SIGTERM before SIGKILL. Default 5000. |
| `index.auto` | Run project, hidden, and brain indexing on startup. |
| `index.watch` | Refresh on file changes. Project-local state forces the plugin's own watcher with one-shot index runs; set false for polling only. |
| `index.brain` | Folders to index as second brains, e.g. `[".agents"]`. |
| `index.hidden` | Hidden folders to index as plain documents. Empty means "the docs folders that exist": `.agents`, `.github`, `.claude`. Set a list to choose exactly what is indexed. |
| `index.hiddenMaxBytes` | Per-file ceiling for hidden documents. |
| `prjdocs.maxTargets` | Documentation sites crawled in one run. Default 40. |
| `prjdocs.maxPages` | Pages per site; `0` uses the per-source default (8 to 25). |
| `prjdocs.eager` | Eager mode: no page-type or depth limit, model-judged relevance, and search for unknown technologies. Default `false`. |
| `prjdocs.eagerMaxPages` | Pages per site in eager mode. Default 120. |
| `prjdocs.eagerMaxDepth` | Link depth in eager mode. Default 12. |
| `prjdocs.eagerModelCalls` | Model judgements per run; the heuristic covers the rest. Default 150. |
| `prjdocs.eagerKeywords` | Terms to document even though the project does not use them. Eager mode only. Default `[]`. |
| `prjdocs.builtin` | Always index XERJ's own docs and the Elasticsearch reference for this node's version. Default `true`. |
| `prjdocs.builtinXerjPages` | Markdown files taken from the XERJ repository. Default 200. |
| `prjdocs.builtinElasticsearchPages` | Crawl budget for the Elasticsearch reference; 2500 yields about 630 API pages. Default 2500. |
| `prjdocs.builtinRefreshDays` | Days before the always-on sources are crawled again. Default 7; `0` always refreshes. |
| `prjdocs.userAgent` | `User-Agent` sent with every documentation request. |
| `prjdocs.requestIntervalMs` | Minimum gap between two requests to one documentation host; all crawls in a run share it. |
| `prjdocs.requestJitterMs` | Random extra delay added to that gap. |
| `prjdocs.requestTimeoutMs` | Deadline for one documentation page request. Default 15000. |
| `prjdocs.latestTimeoutMs` | Deadline for one latest-release lookup. Default 5000. |
| `sysdocs.maxDocs` | Pages indexed per run. Default 5000. |
| `sysdocs.maxBytesPerDoc` | Bytes kept per page, head first. Default 64 KiB. |
| `sysdocs.manDirs` | Extra man roots, searched before the machine roots. Empty means `MANPATH` only. |
| `sysdocs.infoDirs` | Extra info roots, searched before the machine roots. Empty means `INFOPATH` only. |
| `memory.retain.days` | Days an automatic summary is kept; `0` (default) means unlimited. |
| `memory.retain.maxCount` | Summaries kept regardless of age; `0` disables the count cap. |
| `memory.retain.maxBytes` | Bytes of summary text kept; `0` disables the size cap. |
| `memory.distill.enabled` | Turn live turns into typed memories and retire what stops being true. On by default; the first run downloads the jevos model. |
| `memory.distill.judge` | `heuristic` (the local filter), `model` (one bounded call per candidate, using the host's model), or `local` (the downloaded jevos CPU model). |
| `memory.distill.minConfidence` | Percentage a candidate needs to become a memory. |
| `memory.distill.maxPerTurn` | Memories promoted from one turn. |
| `memory.distill.maxPerProject` | Distilled memories kept; the lowest-confidence, oldest go first. |
| `memory.distill.modelMaxCalls` | Model calls one turn may spend when `judge` is `model`. Candidates past the cap keep the heuristic verdict. |
| `memory.distill.modelContextChars` | Characters of the turn shown to the model judge. |
| `memory.distill.modelTimeoutMs` | Deadline for one model judgement; a timeout falls back to the heuristic. |
| `memory.distill.local.version` | jevos release tag; `jevos-v5` is the known good one. Changing it downloads that release. |
| `memory.distill.local.path` | A pre-installed directory holding `bin/jev` and `model/`; skips the download. |
| `memory.distill.local.port` | Loopback port for the jevos server; a healthy server there is attached instead of a second one. |
| `memory.distill.local.threads` | Worker threads; 0 uses every logical CPU. |
| `memory.distill.local.idleMs` | Stop the server after this long without a judgement. |
| `memory.distill.local.timeoutMs` | Deadline for one judgement request. |
| `memory.distill.local.threshold` | P(keep) floor as a percentage. The report question scores conservatively, so the default is low; calibrate it with `bun run eval:distill`. |
| `memory.distill.local.kindConfidence` | Minimum choice confidence before the model's kind replaces the heuristic class. |
| `memory.distill.local.downloadTimeoutMs` | Deadline for the one-time 630 MB model download. |
| `memory.distill.local.startupTimeoutMs` | Deadline for the server to answer its first health probe. |
| `index.graph` | Index the project as one graph corpus (a "super brain"): sections, symbols, `path:line`, and edges. On by default; `false` restores the flat `--no-graph` corpus with the engine's own watcher. A change rebuilds the project corpus once. |
| `index.semantic` | Include the semantic retrieval leg. |
| `index.neural` | Embed passages with the node's neural model (`--embed-mode neural`). Set `false` for lexical embeddings. Changing it rebuilds the project index once; neural indexing is roughly ten times slower than lexical. |
| `remote.enabled` | Spool and index fetched pages. |
| `remote.fetchTimeoutMs` | Deadline for a URL fetched by `xerj_index`. Default 10000. |
| `context.enabled` | Inject retrieved context; the kill switch. |
| `context.maxTokens` | Ceiling for injected passages. |
| `context.memoryTokens` | Ceiling for injected memories. |
| `context.timeoutMs` | Retrieval deadline; miss it and inject nothing. |
| `context.recallTimeoutMs` | Deadline for re-reading the working set after a compaction. Default 120. |
| `context.hintTimeoutMs` | Deadline for the one-line search hint when the gate rejects a prompt. Default 150. |
| `context.rehydrate` | After the host compacts a session, re-inject two or three passages from that session's working set once, under a `<xerj-recall>` marker. A fresh retrieval with hits supersedes it. |
| `context.rehydrateTokens` | Ceiling for the post-compaction recall, in tokens; 0 disables it. |
| `memory.captureTurns` | Store each substantive turn's final answer (400+ characters) as a `summary` memory, paired with its prompt. Needs `context.enabled`, which records the prompts. |
| `stats.maxBaselineBytes` | Cap on the baseline credited per cited file. |
| `telemetry.anomaly` | Reserved; on-demand anomaly scoring only. |
| `telemetry.enabled` | Record local operation, boot, crash, and process figures. The files stay on this machine and are never sent anywhere. |
| `telemetry.maxBytes` | Cap for the whole telemetry directory. |
| `telemetry.samplesPerType` | Samples kept per operation type. |
| `telemetry.rotateBytes` | Size at which `ops.ndjson` rotates. |
| `telemetry.rotations` | Rotated operation files kept. |
| `telemetry.flushMs` | How often the in-memory queue drains to disk. |
| `telemetry.sampleMs` | CPU and RSS sample period; `0` disables sampling. |
| `telemetry.maxText` | Characters of caller text kept in a record; `0` records none. |
| `cmd.enabled` | Register `xerj_run` and `xerj_out` and keep command output under `.xerj/cmd/`. On by default. |
| `cmd.suggest` | Add the command-output instruction to the first model call of a session and hint after a large result. |
| `cmd.mirrorHostResults` | Record results from the host's `bash`/`shell` tool too, so history covers commands `xerj_run` did not run. |
| `cmd.inject` | Include the command corpus in prompt-time injection. Off by default; `xerj_search` and `xerj_out` still reach it. |
| `cmd.maxBytes` | Cap for the `<stem>-cmd.txt` and `<stem>-out.txt` pairs together. |
| `cmd.maxIndexBytes` | Cap for the indexed text of the command corpus. |
| `cmd.maxCommandBytes` | Captured bytes per command before truncation. |
| `cmd.maxFileBytes` | One output file past this is stored but not parsed or indexed. |
| `cmd.windowLines`, `cmd.windowBytes` | Index window size, whichever binds first. |
| `cmd.showTokens` | Output budget for one `xerj_out show`. |
| `cmd.timeoutMs` | Deadline for one `xerj_run` command. |
| `cmd.hintLines` | A mirrored command result past this many lines queues one hint for the next turn. |

### Local telemetry

The plugin measures its own cost. Every operation, boot phase, crash, restart,
service-state transition, and CPU/RSS sample goes into bounded NDJSON files
under `telemetry/` at the XERJ data root:

```
ops.ndjson            every operation, newest last; rotates at 8 MiB, 4 kept
rings/<type>.ndjson   the last 256 samples of one operation type
samples/<date>.ndjson one CPU/RSS line per XERJ process every 15 s
rollup/<date>/        per-instance counters and dwell time for one day
state/boot-<id>.json  this process's boot marker; removed on a clean stop
```

The files are local to this machine, the plugin has no network path for them,
and `telemetry.enabled: false` leaves no trace. Operations are timed at the
boundary that already exists (tools and RPC generically at registration, the
index and node services at their own calls), so a tool added later is measured
without touching it. A record carries the type, duration, outcome, the project
prefix, the job count at the start (idle or busy), and up to `telemetry.maxText`
characters of caller text after redaction; error messages are never stored.

`xerj_telemetry` reports operation counts with p50 and p95 split by idle and
busy, the last ten boots with setup, ready, and indexed figures, crash and
restart counts, the day's dwell split, and each XERJ process's CPU and RSS with
the day's peak and growth. A sweep at startup and every ten minutes keeps the
directory under `telemetry.maxBytes`.

The same five states drive the sidebar badge and the panel: `starting` before
the node answers, `ready` when it does, `busy` while a long job runs (index,
docs, install), `degraded` when a corpus is broken or memory is missing, and
`stopped` after an idle shutdown. `busy` does not mean unready; a query still
answers during a pass.

[Back to top](#table-of-contents)

## How the project index works

The project corpus is the index everything else builds on: code, prose, and
anything under the project root that the ignores do not exclude. It lives in
the project's own node under `<project>/.xerj/nodes/<prefix>/data`, namespaced
by a prefix derived from the canonical project path, so two checkouts of one
repository are two corpora.

`autoindex` builds it. With `index.graph: true` (the default) the corpus is one
graph: section records, symbol records with `code`, `path:line` fields, and
reference edges between files. With `index.graph: false` the same files become
plain section records with no graph.

The refresh path follows the mode. A graph cannot use the engine's resident
watcher, so the plugin watches the tree with `fs.watch(recursive)` behind a
debounce, runs one-shot incremental passes, and falls back to polling when a
recursive watch is unavailable or the tree exceeds the watch budget.
`index.watch: false` leaves the periodic timer as the only trigger. At most one
pass runs per prefix and at most one is queued, so an edit burst becomes one
run rather than a dozen.

A pass reconciles additions, edits, deletions, and renames against its journal:
a deleted file's documents disappear, a rename appears under its new path, and
an unchanged file costs nothing. `.gitignore`, nested ignores,
`.git/info/exclude`, and `.xerjignore` apply; `.git`, `.xerj`, build output,
virtualenvs, and secret-shaped names are always skipped.

Hidden folders are outside autoindex's reach, so `index.hidden` lists folders
the plugin scans itself and writes with `_bulk` into
`<prefix>-hidden-docs`, skipping the same secrets and binaries and deleting
documents whose file vanished. A folder configured in `index.brain` is indexed
once as its own graph corpus instead.

Four more corpora refresh alongside the project: git history
(`<prefix>-git-docs`, the newest `index.gitLimit` commits), the turn archive
(`<prefix>-archive-docs`), command output (`<prefix>-cmd-docs`) when
`cmd.enabled` is on, and the docs corpora when their commands run. Fetched
pages, external files, and hidden documents each have their own prefix and
ingest path, so a failure in one leaves the others alone.

Switching `index.graph` or `index.neural` changes what the engine can open. The
plugin records the mode under the node directory and, when it changes, drops
the project corpus and its journal so the next pass rebuilds in the new mode.
Memory, hidden, web, external, and documentation corpora are not mode-sensitive
and survive.

[Back to top](#table-of-contents)

## How retrieval works

A search runs three legs and fuses them:

1. **Lexical**: `match` on `body`, the field that produces a passage.
2. **Semantic**: runs when the index mapping is `semantic_text`, so a question
   phrased differently from the code can still land.
3. **Symbol and title**: `multi_match` weighting `name` (the function or type a
   record is about) and `title` (its file or section) above `body`, so a file
   that defines the concept outranks prose that mentions it.

The legs are fused with reciprocal rank fusion in the plugin, because the
engine refuses passages on a server-side hybrid query. The fused pool is twice
the requested size, so demotion and filtering can promote something that
ranked lower.

Then the context surface decides what is worth a token:

- **Relevance gate.** A passage survives only when its text or path carries
  half the prompt's content terms, matched by stem so "generated" finds
  "generate". The top three semantic hits get a pass when they share a term,
  which is what lets the semantic leg answer a paraphrase.
- **Prompt gate.** A prompt under 12 characters, a slash command, or one made
  only of filler ("continue", "go ahead") retrieves nothing. Prompts the gate
  drops are counted as `noiseSkips`, not as misses, so the hit rate reflects
  real attempts.
- **Demotion, not removal.** Lockfiles, minified assets, build output, license
  boilerplate, and chronicle files (changelogs, status logs, journals) sink
  unless the prompt names them. Chronicles name every feature and answer
  nothing, so they would otherwise match any question.
- **One section per file.** A long README cannot spend the whole budget; the
  first matching section stays and the rest give way.
- **Per-session dedupe.** A `path:line` already injected in this session is not
  injected again, so a follow-up question does not pay twice for one section.
- **Budget.** `context.maxPassages` passages within `context.maxTokens`, split
  evenly so one whole-section match cannot hide the others.
- **Post-compaction recall.** When the host compacts a session, the summary
  drops the passages the session was working from. On the next model call the
  plugin re-reads up to three of those files and injects a window around each
  cited line under a `<xerj-recall>` marker, capped by
  `context.rehydrateTokens`. It happens once, and a fresh retrieval with hits
  supersedes it. The summariser's own request receives nothing.

Send a question to `xerj_search` and the same legs run with the tool surface:
no relevance gate, no budget discard, and generated files kept but demoted,
because there the caller asked explicitly.

Brain hits get one hop of neighbors, with their own budget. Configured brains
follow `pathcite` and `sequence` edges; the project-wide graph follows only
`pathcite`, because adjacent-section edges added tokens without adding answers
when measured here. Brain paths are rewritten to project-relative paths before
line resolution, and a hidden whole-file hit is dropped when a brain section
covers the same file, so one file is cited from its precise section.

### Measuring a change

`bun run eval` runs 60 labeled questions against a live index and reports how
often the expected file survives, the bytes it costs, and every miss:

```
bun run eval
bun run eval --k 8 --surface tool --json
```

It prints two numbers: how often the expected file is cited, and how often the
answer text itself arrived (a token each prompt pins). The second is the one
that says whether the injected block is useful rather than merely on target,
and it separates a file that was never picked from a section that was cut.

Defaults match what the plugin ships. Run it against a current index: a file
added since the last pass is missing from the corpus, and the miss it causes
looks like a ranking fault. A one-prompt change is inside the noise of a
60-prompt set; treat a single point as unproven.

Savings are measured, not asserted: the baseline is each cited file's size
capped at `stats.maxBaselineBytes`, counted once per session. Reading a file
subtracts the bytes actually read, so a partial read only removes what it
covered.

[Back to top](#table-of-contents)

## Memory

`xerj_remember` stores one durable fact, decision, preference, fix, or note in
a per-project namespace (`proj-<slug>-<hash>`), optionally with a topic. The id
is `sha256(namespace + text)`, so remembering the same text twice is idempotent
rather than a duplicate. Memory lives in the node's own index
(`.xerj-memory-<namespace>`), beside the corpus it belongs to.

Recall is blended, not pure vector: `xerj_recall` asks `/_memory` for the
nearest entries with `recency_weight` (0.2), so a recent decision outranks an
older nearly-equal one. Kind filtering happens in the plugin, because the
engine's metadata filters returned nothing on every shape tried against
`v1.0.0-rc.*`.

Prompt-time recall is separate from search. On a prompt that passes the gate
the plugin recalls the top three memories, keeps only those that cover half the
prompt's terms, and injects them under `context.memoryTokens`. A decision
stored weeks ago can answer a question without a tool call, and an unrelated
memory is never injected just because it is nearest.

Memory is written from three sources: the tools, a substantive turn whose
final answer is long enough to be worth reading again
(`memory.captureTurns`), and the host's compaction summary
(`session.compaction.ended`). A summary is clipped at 4,000 characters and
stored once per text, so a repeated event is idempotent.

`xerj_forget` retracts one entry by id. Retention bounds the store:
`memory.retain.days` (0 means no age limit), `maxCount`, and `maxBytes` apply
in one hourly sweep, and only automatic summaries expire; explicit memories do
not.

Two passes keep the store honest. Verification marks a memory stale when a
path, key, or symbol it names no longer exists, and never deletes it. Curation
drops an exact duplicate of an automatic summary and flags other repeats as
`duplicateOf`, leaving the decision to the model or the user.

A memory index built for one embed mode is refused by a node running another.
The plugin backs the index up and resets it only when its recorded backend
differs from the configured mode; when the backend matches, the index is left
in place with a warning, because the node is probably running another mode and
resetting would cost the whole store for a transient fault.

Memory written before project storage moved out of the global data root is
copied into the node's data directory on setup when the destination is empty.

### Distillation

`memory.distill.enabled` (on by default) turns finished turns into typed
memories without touching the model's window. After each answer the plugin classifies a few
sentences from that turn as a decision, constraint, convention, preference, or
fact, scores them, and stores the ones that clear `minConfidence`. A
`path:line`, a config key, or a version raises the score; a question, a hedge,
a plan ("let me check"), or fenced code is never a candidate. It runs after
`session.execution.succeeded`, so a short turn such as "we decided to use
SQLite" counts even when it is too short for turn capture. Distillation does not
require `memory.captureTurns`: a caller can keep typed memories without keeping
a Q/A summary of every turn, and turn capture can stay on with distillation off.

Three judges share the same write path. `heuristic` is the local filter above
and costs nothing. `model` asks the host's model about each candidate, one call
up to `modelMaxCalls` per turn, with the turn clipped to `modelContextChars`
and a `modelTimeoutMs` deadline. The model answers a JSON verdict (keep, kind,
score); an unusable answer, a timeout, or a missing host model keeps the
heuristic verdict for that candidate instead of dropping it. `local` runs the
jevos CPU model described below. The judge is stored on every memory as
`source: distill:<judge>`, so a later comparison can tell which produced what.

#### The local judge

`judge: "local"` is the default and needs no endpoint and no network after
the first run. The
plugin downloads the jevos v5 OpenVINO INT8 model (about 630 MB) and its
binary once into `<data root>/jev/`, checks both against the release
`SHA256SUMS.txt`, and starts a loopback server. The download runs in the
background from `setup`, so a turn never waits for it; until it finishes, or
on a platform jevos does not publish for, distillation keeps the heuristic
verdict. The server stops after `local.idleMs` without a judgement and starts
again on the next one.

A judgement is one request with the sentence as the state. One yes/no
question decides whether the sentence is a lasting project rule or fact,
rather than a report of what was just done, and the same request asks for the
five-way kind. The keep question is contrastive because the plain "is this a
durable fact" wording accepted 24 of 40 candidates mined from this project's
own turn archive, most of them progress reports ("completed the archive",
"wrote the tests", "version 0.7.0"). The contrastive wording keeps 10 of those
40 and accepts 7 of the 8 labeled memories. On the labeled report set it cuts
noise from 3 of 10 to 1 of 10 at the default 0.20 floor, so it is a report
filter, not a noise filter: the heuristic drops questions, hedges, and code
before a judge sees a candidate. Sending the turn around the sentence lowered every score, so the
state is the sentence alone.

The model is small on purpose. It runs on the CPU, the first call after a
start takes about 1.5 s and later calls about 200 ms on four threads, and the
server holds about 1.2 GB resident with the context and state cache kept to
one short sentence. `local.path` points at a pre-installed directory holding
`bin/jev` and `model/` when the machine already has one; `local.port` is the
loopback port the plugin attaches to or starts on; `local.threads` sets the
OpenVINO worker count, and 0 uses every logical CPU.

Every judgement also writes one `memory.distill.judge` record to local
telemetry: the model's score and verdict, the heuristic's kind and score, the
final kind, the origin, and the outcome. The record holds up to 160 characters
of the sentence, redacted and clipped the same way as every other telemetry
string, and lives under the usual 128 MiB cap and rotation. `bun run tune:local`
reads every rotated ops file, prints the keep rate, mean scores by verdict, a
score histogram, and the latest borderline samples, and writes one JSONL row
per judgement to `~/.cache/opencode/xerj-tune/judge-samples.jsonl` for labeling
and comparison.

Retirement is by evidence, not by relevance. A decision stays true whether or
not this turn needed it, so distilled memories are retired by budget (keep the
highest confidence, then the newest) and by the usual verification and curation
passes, never because a retrieval did not select them.

Every judge reports to telemetry as `memory.distill`, with the judge name and
the candidate, promoted, duplicate, and rejected counts, and the recall pass
records how many of its hits were distilled. Together those are the cost side
(duration and count per judge) and the effectiveness side (promoted memories
that are actually recalled), readable through `xerj_telemetry op=memory.distill`
and `xerj_telemetry op=memory.recall`. The panel's Telemetry section shows the
same line: `distilled N · heuristic A · model B · local C · calls D · recalled
E`, with a judge's count omitted while it is zero.

The measurement harness is `bun run eval:distill`. It prints each judge's
recall, false positives, class accuracy, and how many labeled progress reports
it keeps, so a wording change is compared on the same two fronts. The
`bun run tune:local` report covers the live corpus instead of the labeled one.
`DISTILL_EVAL_JEVOS_URL` points it at a running jevos server and prints the
local judge's figures; `DISTILL_EVAL_URL`, `DISTILL_EVAL_MODEL`, and
`DISTILL_EVAL_KEY` do the same for an OpenAI-compatible chat endpoint. A script
cannot borrow the host's model, which is why that endpoint is explicit; the
plugin's own judge uses the host model when `judge` is `model`.

[Back to top](#table-of-contents)

## Command output

Long command output is the largest avoidable cost in a session: a model reads
`head`, then `tail`, then runs the command again to see the middle. With
`cmd.enabled` (on by default) the plugin keeps the text instead.

```
<project>/.xerj/cmd/20261106T192233123Z-cmd.txt   the command
<project>/.xerj/cmd/20261106T192233123Z-out.txt   stdout and stderr, interleaved
<project>/.xerj/cmd/manifest.json                 exit code, duration, lines, windows
```

`xerj_run` executes one foreground command, writes the pair, and returns only
a receipt: exit code, duration, line and byte counts, and the stem. The command
runs in the project root with a deadline (`cmd.timeoutMs`, 10 minutes) and a
captured-byte cap (`cmd.maxCommandBytes`, 64 MiB). A timeout kills the process
group and keeps the partial output, marked. Output is written to a `.part` file
and renamed on exit, so a reader never sees a half-written log; a `.part` left
by a crash is recovered on the next start.

`xerj_out` reads it back without paginating a terminal:

| Action | What it returns |
|---|---|
| `list` | Recent commands, newest first, with exit code, age, lines, and bytes |
| `show` | An exact numbered line range from the raw file; no range means the last 100 lines |
| `search` | Matching windows with `cmd/<stem>-out.txt:<line>` citations and the exit code |
| `ingest` | Copies a file the agent wrote itself into the directory as a new pair |

The corpus is `<prefix>-cmd-docs`, plain `text`, split into windows of
`cmd.windowLines` (200) or `cmd.windowBytes` (16 KiB), whichever binds first.
Nothing is embedded: logs are literal, an error string is an exact term, and
the lexical leg is the useful one, so the cost stays far below a project pass.
A file past `cmd.maxFileBytes` (32 MiB) is stored and listed but not parsed.

The model is told about this on its first call: a `<xerj-command-output>` block
says to run long commands through `xerj_run` and read them with `xerj_out`,
and that `list` shows what already ran before running something twice. The
block is re-emitted after a compaction, and a mirrored result past
`cmd.hintLines` (40) queues one `<xerj-cmd-hint>` line naming the stem. Host
`bash`/`shell` results are mirrored too (`cmd.mirrorHostResults`), so `list`
covers commands the wrapper did not run.

Two caps bound the directory: `cmd.maxBytes` (256 MiB) for the pairs and
`cmd.maxIndexBytes` (32 MiB) for the indexed text. A sweep at startup, after
every ingest, and hourly deletes the oldest complete stem, files and documents
together. Only the indexed text is redacted; the raw pair is `0600` inside a
`0700` directory and never leaves the machine. `cmd.enabled: false` registers
no tools, creates no directory, and injects nothing.

[Back to top](#table-of-contents)

## Fetched pages and external files

A URL a session reads is a document worth keeping. Any completed tool result
that carries a `url` and at least 200 characters of text is written to
`<project>/.xerj/spool/<web prefix>/` as markdown with its source and fetch
time, and a second index (`xop-web-<hash>`) watches that directory. The same
URL replaces its earlier file, so a page is refreshed rather than duplicated,
and yesterday's page is still searchable today. Bodies are redacted (bearer
tokens, `sk-`/`ghp_`/`xox`/`AKIA` keys, private key blocks, and
`password`/`token`/`secret` key-value shapes) and bounded by `remote.maxBytes`
(2 MB). `remote.enabled: false` stops the spool entirely.

A file outside the project is indexed when something reads it. The `read` tool
names one path; a `bash` or `shell` command is parsed for literal arguments
that resolve to existing regular files. Both run in the background through
`_bulk` into `xop-ext-<hash>-docs`, with an mtime-and-size stamp so an unchanged
file is not re-sent, and a stable id so an edited file replaces its document
rather than leaving a stale copy. Credential-shaped names and directories
(`.env*`, `*.pem`, `*.key`, `service.json`, `credentials.json`, `auth.json`,
`.ssh`, `.aws`, `.gpg`, `.kube`, `.docker`) are refused before the file is
read.

The shell parser is conservative on purpose: a short option's value is skipped
(`head -n 20`), and variables, globs, tilde paths, and redirection targets are
not resolved, because guessing would index files the command never touched.

[Back to top](#table-of-contents)

## Tools

Every tool is namespaced `xerj` and returns cited text plus `metadata.xerj`
with counts and paths, so accounting and the panel do not parse prose. A tool
answers from the index; none of them reads a file to answer a question the
index can answer, and none writes a project file.

| Tool | Input | Use |
|---|---|---|
| `xerj_search` | `query`, `k?`, `max_tokens?` | Find passages before reading files. |
| `xerj_def` | `symbol`, `k?` | Find a declaration by name. |
| `xerj_refs` | `symbol`, `k?` | The declarations that use a symbol, as `path:line`. |
| `xerj_outline` | `path`, `k?` | A file's symbols with line numbers. |
| `xerj_zoom` | `path`, `symbol`, `k?` | One declaration's exact source range. |
| `xerj_find` | `pattern`, `glob?`, `ignore_case?`, `files_only?`, `limit?` | Regex over files, or a glob over paths. |
| `xerj_ast` | `pattern`, `lang`, `glob?`, `limit?` | Structural search through `ast-grep`, read only. |
| `xerj_imports` | `action` (`cycles`, `file`), `path?`, `limit?` | Import graph and cycles without a language server. |
| `xerj_expand` | `sessionID`, `start?`, `end?` | The raw text of earlier turns, including a compaction window. |
| `xerj_status` | — | Node, index, corpora, memory, and accounting state. |
| `xerj_telemetry` | `op?`, `window?`, `sort?`, `limit?` | Local operation timings, boots, crashes, and process cost. |
| `xerj_remember` | `text`, `kind?`, `topic?` | Store a durable fact. |
| `xerj_recall` | `query`, `k?` | Retrieve memories by meaning. |
| `xerj_forget` | `id` | Retract a memory. |
| `xerj_index` | `url?` or `path?` | Index a page or external file now. |
| `xerj_run` | `command`, `timeout_ms?` | Run one command with its output kept under `.xerj/cmd/`. |
| `xerj_out` | `action`, `stem?`, `start?`, `end?`, `query?`, `path?` | List, show, search, or ingest command output. |
| `xerj_anomaly` | `index`, `time_field?`, `function?`, `field?`, `bucket_span?`, `threshold?` | Score a metric series and return flagged buckets. |
| `xerj_dataset` | `action`, `index?`, `path?`, `mapping?`, `force?` | Manage extra indexes and NDJSON dumps. |
| `xerj_reindex` | — | Incremental pass over the project, fetched pages, and hidden folders. |
| `xerj_sysdocs` | — | Index this machine's man and info pages. |
| `xerj_prjdocs` | `eager?`, `keywords?` | Index official docs for the project's stack. |

The turn archive is one file per session under the project's node directory,
capped by `context.archiveMaxBytes`. Before the host compacts, the plugin
appends the messages the summary will replace, so tool output stays available
to `xerj_expand`.

[Back to top](#table-of-contents)

## Analysis tools

Seven tools answer code questions from indexed records or a bounded local
scan, without a language server:

- `xerj_refs` lists the declarations that use a symbol, as `path:line`, from
  the `code` field of indexed records. Run it before a rename or a signature
  change instead of grepping the tree.
- `xerj_outline` lists a file's symbols with line numbers, so a whole-file read
  can start from the part that matters.
- `xerj_zoom` returns one declaration's exact source range by name.
- `xerj_find` runs a regular expression over project files, or a glob over
  paths, with line numbers. It reads the tree itself, so it sees a file before
  the index does; secret files are skipped and results are capped.
- `xerj_ast` runs `ast-grep` when the binary is on `PATH`, matching code by
  shape with metavariables such as `$A`. It passes the pattern as an argument
  and never rewrites.
- `xerj_imports` builds the import graph from the files: cycles, or one file's
  imports with resolution for relative paths, Python modules, Go paths, and
  Rust `crate::` paths.
- `xerj_expand` returns the raw text of earlier turns, including the window a
  compaction replaced, from the turn archive.

All seven are read-only. The AST tool reports the missing binary rather than
guessing, and a language it does not know is reported as unresolved, not as an
import with no files.

[Back to top](#table-of-contents)

## TUI

The sidebar is a bordered box with a collapsible header. Expanded, it reads:

- the header row, `▼ XERJ`;
- the state line, `● ready` or `◐ busy · indexing · 12s`, with the elapsed time
  counting up while a job runs;
- the plugin version;
- a `⚠` line when a corpus is failing or a warning is recorded;
- the sections below, each switchable in preferences.

Collapsed, it shows the header and the summary rows: `Index`, `Saved`, and
`Memory`, plus `Jobs` while something is running. Clicking the header toggles
the state, and the choice is remembered in the shared
`tui-preferences.jsonc` under the `xerj` key, beside other plugins' keys.

The sections are State (the service state, running jobs, today's dwell), Corpora
(one row per corpus with its error), Session (queries, hits, injected turns,
prompts skipped as noise), Savings (saved, cost, net, returned), Runtime (CPU
and RSS, embedding state, sessions), and Health (warnings, last run, error).

Every command is also in the palette.

| Command | What it does |
| --- | --- |
| `/xerj` | Open the details panel: node, binary, index, corpora, datasets, memory, usage, counters, top cited files, and health. |
| `/xerj status` | Same as `/xerj`. |
| `/xerj reindex` | Run an incremental pass over the project and report the record count. |
| `/xerj remember <text>` | Store a durable fact in project memory. |
| `/xerj search <query>` | Search the index and show cited passages in a dialog. |
| `/xerj-reindex` | Incremental pass over the project, fetched pages, and hidden folders. |
| `/xerj-remember <text>` | Store a memory (prompts for the text when empty). |
| `/xerj-search <query>` | Search and show cited passages (prompts when empty). |
| `/xerj-prjdocs [eager]` | Index official docs for the project's languages, frameworks, and cloud APIs. Add `eager` for the wider, model-judged crawl. |
| `/xerj-sysdocs` | Index this machine's man and info pages. |

The panel reports, in order: the service state and running jobs, the node, the
binary, the index, every corpus, the datasets by size with each one's share of
the store, the documented frameworks with their document and byte counts, the
node's CPU and resident memory, whether it is building embeddings, memory,
usage, counters, the most-cited files, and health.

The panel closes three ways: `escape`, the **✕ close** button in its footer, or
running `/xerj` again.

The TUI talks to the server part over RPC (`status`, `reindex`, `search`,
`remember`, `wrapup`, `sysdocs`, `prjdocs`, `uiLog`, and an `updated` event the
sidebar follows), so the commands work in any OpenCode window on the same
project.

### Completion notices

The sidebar announces a finished run once, whoever started it: the first
project index pass after startup, `/xerj-reindex`, `/xerj-prjdocs`,
`/xerj-sysdocs`, and an agent-triggered `xerj_prjdocs` or `xerj_sysdocs`. A
toast names the files and records for the project, or the pages for a docs
corpus, and a command run from the TUI supplies its richer text (technologies,
unchanged pages, pruned pages, failures). The first status a TUI sees is the
baseline, so a corpus built before the session is not announced again.

[Back to top](#table-of-contents)

## Project documentation

`/xerj-prjdocs` reads the project's manifests and file extensions, then crawls
the official documentation for what it finds into
`xop-<project>-prjdocs-docs`.

Detection is deliberate, not clever:

- **Languages** come from file extensions and from the files that pin a runtime:
  `.nvmrc`, `.node-version`, `.python-version`, `.tool-versions`,
  `rust-toolchain.toml`, `engines` in `package.json`, `go` in `go.mod`, and
  `requires-python` in `pyproject.toml`.
- **Frameworks** come from `package.json` dependencies, `requirements.txt`,
  `Cargo.toml`, and `go.mod`, matched against a known list.
- **Cloud APIs** come from dependency names: `@aws-sdk/*`, `@google-cloud/*`,
  `@azure/*`, `stripe`, `twilio`, `@supabase/*`, `wrangler`, `vercel`, and the
  like.
- **GPU compute stacks** come from what only that toolchain uses:

  | Stack | Proof |
  |---|---|
  | CUDA | `.cu` or `.cuh` files, `cuda_runtime.h`, `cublas`/`cudnn`/`nccl` headers, `__global__`, `cudaMalloc`, `nvcc`, `CUDAExtension`, or `cupy`/`pycuda`/`cuda-python` |
  | ROCm | `.hip` files, `hip/hip_runtime.h`, `rocblas`/`hipblas`/`miopen` headers, `hipMalloc`, `hipcc`, or a `rocm/dev-*` base image |
  | SYCL | `sycl/sycl.hpp`, `CL/sycl.hpp`, `sycl::queue`, `-fsycl`, `SYCL_DEVICE_FILTER`, or `adaptivecpp` |
  | oneAPI | `oneapi/mkl.hpp`, `mkl.h`, `dnnl.hpp`, `oneapi/tbb/*`, `level_zero/ze_api.h`, `zeInit`, `dpcpp`/`icpx`, `ONEAPI_ROOT`, `intel/oneapi-*` images, or `intel-extension-for-pytorch`/`scikit-learn-intelex`/`mkl` |
  | Vulkan | `.glsl`/`.vert`/`.frag`/`.comp`/`.slang` shaders, `vulkan/vulkan.h`, `vkCreate*`, `find_package(Vulkan)`, `glslang`/`shaderc`, or the `ash`/`vulkano` crates |

  Automation and infrastructure ecosystems are detected the same way, from the
  files they own: Ansible from `ansible.cfg`, `site.yml`, `roles/`, or the
  `ansible.*` module names in a playbook; community collections from a
  `requirements.yml` that lists `collections:`, or any `community.*` or
  `ansible.*` collection reference; NetBox from `pynetbox`, a
  `netboxcommunity/netbox` image, or `NETBOX_URL`; and the HashiCorp products
  from their own markers, including `resource`/`provider` blocks for Terraform,
  `path` blocks and `VAULT_*` for Vault, `job` blocks for Nomad, `source` blocks
  for Packer, `Vagrant.configure` for Vagrant, and `.tf`, `.tfvars`, `.nomad`,
  and `.pkr.hcl` files.

  A GPU stack is reported only when a header, build file, kernel extension, or
  version pin proves it. A project that merely mentions CUDA in prose does not
  get its documentation.

  Each stack is a collection, not one URL, so a crawl names its component
  guides: CUDA's cuBLAS, cuFFT, cuSPARSE, cuSOLVER, cuRAND, NPP, cuDNN, and
  NCCL; ROCm's HIP, rocBLAS, MIOpen, RCCL, rocFFT, rocPRIM, rocSPARSE, and the
  rest of its `projects/` tree; oneAPI's specification plus oneTBB, oneDNN, and
  oneCCL; Vulkan's guide and specification chapters. The per-stack budget is 200
  pages for CUDA, 150 for ROCm, 120 for Vulkan, 80 for oneAPI, and 40 for
  SYCL, with at least eight pages per component. Seeds are crawled four at a
  time: one vendor host serves every guide, and seventeen simultaneous requests
  come back empty.

Each technology maps to one entry URL. Versioned sources (Node, Python, CUDA,
ROCm) produce one URL for the version the project declares and one for the
latest release; oneAPI's specification is unversioned and stays inside the
foundation's specification section rather than its news pages. Intel's own
documentation site refuses non-browser clients, so oneAPI reads the UXL
Foundation specification, which is where that specification is maintained. Node and Python resolve theirs from `nodejs.org/dist/index.json`
and `endoflife.date`, CUDA from its archive listing, and ROCm from the
`docs-<version>` path; a version the project does not pin falls back to the
current guide. Everything else is an unversioned site with a page budget of 8
to 25.

Two sources are indexed on every run, whatever the project uses:

- **XERJ's own documentation.** Every markdown file under `docs/` in the
  `xerj-org/xerj` repository, recipes included, fetched from the source rather
  than a rendered site. This is what answers "how does the engine do X".
- **The Elasticsearch reference** for the version this node emulates. The node
  reports its wire version (`8.13.0`), the branch follows it (`8.13`), and a
  version change prunes the old pages on the next run. The crawl starts from
  `rest-apis.html`, takes the chapter indexes it links, and crawls each one
  separately, because one breadth-first pass over the whole site spends its
  budget on chapter summaries and reaches no endpoints. Links outside the
  branch are not followed, so the company blog and other products stay out.

Eager mode also takes keywords: `prjdocs.eagerKeywords` in configuration, or a
`keywords` argument on `xerj_prjdocs` and the MCP tool. Each term is searched
and its documentation crawled even when the project does not use it, which
covers a library you plan to adopt and one detection cannot see. Keywords
apply only in eager mode.

Eager mode (`/xerj-prjdocs eager`, or `prjdocs.eager: true`) widens the
Elasticsearch crawl from the API chapters to the whole guide, keeping the API
pages and adding concepts, configuration, and operations. Three families stay
out because they describe versions other than the one in use: release notes,
migration guides, and deprecated APIs. The same rule filters links, so a
chapter that cites a migration page does not drag it in.

The crawler spaces its requests per host (`prjdocs.requestIntervalMs`, 250 ms,
plus `prjdocs.requestJitterMs`, 100 ms) so component guides and the builtin
chapters that share a host do not reach it in parallel, and it honours a
server's `Retry-After` once before giving up on a page. It sends
`prjdocs.userAgent`, which defaults to a crawler token documentation hosts
already admit; set it to your own bot string if you would rather identify the
plugin directly, since naming another crawler is your call and can breach a
site's terms.

Set `prjdocs.builtin: false` to skip both, and size them with
`prjdocs.builtinXerjPages` (200) and `prjdocs.builtinElasticsearchPages`
(2500, which yields roughly 630 API pages). `prjdocs.builtinRefreshDays`
(7) is how long those pages stay current: the reference crawl takes about a
minute, so it runs on that window rather than on every command, and the
existing pages are kept in the meantime.

The crawler stays on the site it started from, follows links two levels deep,
skips assets and non-HTML responses, and stops at its page budget. A document
carries `url`, `title`, `tech`, `version`, and `fetched_at`, so a page for a
version the project no longer uses is **pruned** on the next run, as is a page
that moved. Unchanged pages are skipped by body hash.

Measured here: two technologies, 12 pages, 1 s; moving `.nvmrc` from 22 to 20
indexed the 20 pages and pruned the 5 from 22; removing the pin pruned the rest.

### Eager mode

`/xerj-prjdocs eager`, or `prjdocs.eager: true`, trades the safety limits for
reach:

- **No page-type limit.** Plain text, markdown, and JSON are indexed alongside
  HTML.
- **A wider depth.** Links are followed up to `prjdocs.eagerMaxDepth` (12) and
  `prjdocs.eagerMaxPages` pages per site (120).
- **Model-judged relevance.** Each page is shown to the current model, which
  answers `yes` or `no`; the page is kept and its links followed only when it
  says `yes`. The entry page is always kept so the crawl can start. Judgements
  are cached per URL and capped at `prjdocs.eagerModelCalls` (150) per run;
  past the cap, and whenever the model is unavailable, a deterministic
  heuristic decides: a page that names the technology, sits under a
  documentation path, or matches two of the project's own terms is relevant.
- **Documentation search for unknown technologies.** A dependency with no
  entry in the source table is searched for with the host's web search, and the
  first result on a documentation host is crawled. Discovered URLs are cached,
  so a later run does not search again.

Eager mode is off by default because it costs model calls and network traffic.
Measured on `docs.solidjs.com` with the heuristic judge: 25 pages and 169 KB in
9 s, reaching pages three levels below the entry.

[Back to top](#table-of-contents)

## System documentation

`/xerj-sysdocs` indexes the man and info pages this machine can resolve into
their own corpus (`xop-sys-<host hash>`).

Roots are searched in this order, and the first copy of a name wins, so a page
you installed shadows the distribution's copy:

1. `MANPATH` and `INFOPATH`, when set.
2. `sysdocs.manDirs` and `sysdocs.infoDirs`, when configured.
3. `$XDG_DATA_HOME` (or `~/.local/share`), then `~/.nix-profile/share`.
4. `NIX_PROFILES`, then `/run/current-system/sw` for a NixOS system profile.
5. `HOMEBREW_PREFIX`, then `/home/linuxbrew/.linuxbrew`, `/opt/homebrew`, and
   `/usr/local` for Homebrew.
6. `/usr/local/share` and `/usr/share`.

A root that does not exist is skipped, so a machine without Nix or Homebrew
pays nothing for either. The corpus keeps `path`, `abs_path`, `title`, `source`,
and `mtime` per page, so a citation reads `man/git.1`.

A manifest records each page's path, mtime, size, and document id, so a first
run indexes everything (3648 pages in about six seconds here, 33 MB) and later
runs skip unchanged pages in under 100 ms. A page that disappeared from disk is
deleted from the corpus.

`body` is plain `text`, not `semantic_text`, so no page is embedded. A machine
holds thousands of long pages, embedding them with the local model takes hours,
and reference prose already carries the words people search for.

[Back to top](#table-of-contents)

## Extra indexes and dumps

`xerj_dataset` manages the indexes on this node beyond the plugin's own
corpora, and moves data in and out in the format `_bulk` and `elasticdump`
use.

```
xerj_dataset  action=list
xerj_dataset  action=create index=notes mapping='{"properties":{"body":{"type":"text"}}}'
xerj_dataset  action=export index=notes path=/tmp/notes.ndjson
xerj_dataset  action=import path=/tmp/notes.ndjson index=notes-copy
xerj_dataset  action=delete  index=notes-copy
```

A dump is one action line and one source line per document, which is what
`_bulk` reads back:

```
{"index":{"_index":"notes","_id":"1"}}
{"body":"alpha note","n":1}
```

Export pages through `_search` (`pageSize`, 500 by default) and stops at
500,000 documents. Import streams the file line by line, creates the target
index if it is missing, writes in batches (`batchSize`, 500 by default), and
counts malformed lines as skipped rather than failing the run. Documents
without `_id` get a generated id.

Indexes the plugin maintains (`xop-*`, `.xerj-*`, `.xerj_*`) are marked
`managed` in `list`, and `delete` refuses them unless `force` is true: dropping
one loses a corpus the plugin rebuilds only on a full reindex.

[Back to top](#table-of-contents)

## Anomaly scoring

`xerj_anomaly` flags spikes in a numeric series already indexed. A stable
detector id is derived from the configuration (`index`, `time_field`,
`function`, `field`, `bucket_span`), the detector is created or replaced, and
one `_score` call returns the flagged buckets with `actual`, `expected`,
`z_score`, and `anomaly_score`. Only flagged buckets are formatted, at most ten.

It is on-demand batch scoring: no datafeed, no timer, no alerting. Call it
again to score a later window, or point a scheduler at it from outside.

[Back to top](#table-of-contents)

## Standalone MCP server

Agents that do not run OpenCode can use the same index over MCP. The package
ships an `xerj-mcp` executable that speaks JSON-RPC on stdio:

```json
{
  "mcpServers": {
    "xerj": {
      "command": "npx",
      "args": [
        "-y",
        "@mrdrmccoy/xerj-opencode-plugin",
        "xerj-mcp",
        "--project",
        "/path/to/repo"
      ]
    }
  }
}
```

The executable needs nothing but Node 20 or later: it is an ESM bundle with a
`node` shebang, so `npx`, `bunx`, and a direct call all work.

```
npx -y @mrdrmccoy/xerj-opencode-plugin@latest xerj-mcp --project /path/to/repo
bunx @mrdrmccoy/xerj-opencode-plugin@latest xerj-mcp --project /path/to/repo
node ./node_modules/@mrdrmccoy/xerj-opencode-plugin/dist/mcp.mjs --project .
```

### Client setup

Any MCP client works; the entry is the same everywhere.

**Claude Code** (`.mcp.json` in the project, or the CLI):

```json
{
  "mcpServers": {
    "xerj": {
      "command": "npx",
      "args": ["-y", "@mrdrmccoy/xerj-opencode-plugin@latest", "xerj-mcp", "--project", "."]
    }
  }
}
```

```
claude mcp add xerj -- npx -y @mrdrmccoy/xerj-opencode-plugin@latest xerj-mcp --project .
```

**Cursor** (`~/.cursor/mcp.json`) uses the same shape. **Anything else** that
spawns a command over stdio works the same way; point it at `xerj-mcp`.

### Arguments

| Argument | Meaning |
| --- | --- |
| `--project <dir>`, `-C <dir>` | Project to index. Defaults to the working directory. |
| `--url <node url>` | Attach to a running node instead of spawning one. |
| `--help`, `-h` | Print usage on stderr and exit. |

### MCP tools

The MCP server exposes nineteen tools, the retrieval and analysis set the
plugin registers, so a prompt written for one works in the other. The two
command-output tools stay in the plugin, because the MCP host already carries
its own runner:

| Tool | Arguments | What it does |
| --- | --- | --- |
| `search` | `query`, `k?`, `max_tokens?` | Cited passages from the project, docs, and memory corpora. |
| `def` | `symbol`, `k?` | A declaration by name with its signature. |
| `status` | — | Node, index, corpora, memory, and accounting. |
| `remember` | `text`, `kind?`, `topic?` | Store a durable fact. |
| `recall` | `query`, `k?` | Retrieve memories by meaning. |
| `forget` | `id` | Retract a memory. |
| `index` | `url?` or `path?` | Index a page or a file from outside the project. |
| `anomaly` | `index`, plus the detection options | Flag spikes in a numeric series. |
| `dataset` | `action`, `index?`, `path?`, `mapping?`, `force?` | Manage extra indexes and import or export NDJSON dumps. |
| `reindex` | — | Incremental pass over the project now. |
| `sysdocs` | — | Index the machine's man and info pages. |
| `prjdocs` | `eager?` | Index official docs for what the project uses. |
| `refs` | `symbol`, `k?` | The declarations that use a symbol. |
| `outline` | `path`, `k?` | A file's symbols with line numbers. |
| `zoom` | `path`, `symbol`, `k?` | One declaration's source range. |
| `ast` | `pattern`, `lang`, `glob?`, `limit?` | Structural search through `ast-grep`, read only. |
| `find` | `pattern`, `glob?`, `ignore_case?`, `files_only?`, `limit?` | Regex over files, or a glob over paths. |
| `imports` | `action`, `path?`, `limit?` | Import graph and cycles. |
| `expand` | `sessionID`, `start?`, `end?` | The raw text of earlier turns. |

A typical session, in tool-call form:

```
xerj_search {query: "where is the idle timeout configured"}
xerj_def    {symbol: "stopNode"}
xerj_dataset{action: "export", index: "my-notes", path: "/tmp/notes.ndjson"}
xerj_dataset{action: "import", path: "/tmp/notes.ndjson", index: "notes-copy"}
```

The handshake touches nothing: `initialize` and `tools/list` answer
immediately, and the binary download, node start, and index pass happen behind
the first call that needs them. Diagnostics go to stderr, so every line of
stdout is JSON-RPC.

A call returns MCP text content plus `structuredContent` when the tool has
machine-readable output (counts, hits, and paths), so a client can show the
prose or use the numbers.

Settings come from the environment because there are no plugin options:

| Variable | Meaning |
| --- | --- |
| `XERJ_BIN` | Use this XERJ binary and never download one. |
| `XERJ_STORAGE_ROOT` | Project state directory; defaults to `<project>/.xerj`. |
| `XERJ_NODE_URL` | Attach to a running node instead of spawning one. |

The server runs one node per project, exactly as the plugin does, so an
OpenCode session and an MCP client on the same project share it.

[Back to top](#table-of-contents)

## Releasing

Pushing a tag that matches `package.json` publishes to npm:

```
git tag -a v0.7.0 -m "v0.7.0"
git push origin main --follow-tags
```

`.github/workflows/publish.yml` runs on any `v*` tag. It first calls
`ci.yml` (typecheck, unit, and integration tests against a pinned binary), and
only a green run reaches the publish job, so a tag that would have failed CI
never lands on the registry.

The publish job stops if the tag and the manifest disagree, skips silently when
that version is already published, and otherwise runs
`npm publish --access public --provenance`.

`NPM_TOKEN` is read from the `npm` GitHub environment, so the job declares
`environment: npm` and any protection rules on that environment (required
reviewers, branch or tag restrictions) apply before it publishes.

[Back to top](#table-of-contents)

## Data locations

```
~/.local/share/opencode/xerj/bin/<version>-<target>/xerj
~/.local/share/opencode/xerj/nodes/.port-lock  shared port lock
<project>/.xerj/                               storage root by default
<project>/.xerj/nodes/<prefix>/                node port, pid, log, heartbeats
<project>/.xerj/nodes/<prefix>/data/           engine storage and journal
<project>/.xerj/spool/<prefix>/                fetched pages
<project>/.xerj/nodes/<prefix>/sysdocs/        man and info manifest
<project>/.xerj/nodes/<prefix>/prjdocs/        documentation crawl manifest
```

Datasets you create with `xerj_dataset`, and the documentation corpora, live
inside the engine data directory; `xerj_status` reports their document counts
and sizes, and the panel lists them under Corpora and Datasets.

Set `storage.root` to an absolute path to keep a project's data elsewhere. A
configured path inside the project must be under a dot-directory; a visible
engine data directory would be indexed by the watcher and feed its own writes
back into the next pass. A refused path falls back to `.xerj` and appears in
the status warnings.

The node is scoped to the project and stops when the last session closes, after
`node.idleMs` with no activity, or when the plugin unloads. Indexing and memory
survive the stop; the next request restarts the node on the same port with the
same data.

[Back to top](#table-of-contents)

## Limitations

- XERJ is pre-1.0. Every call is isolated behind `node/client.ts`, and
  `binary.version: "auto"` tracks the newest release at or above
  `1.0.0-rc.1` without ever downgrading. Pin a version to freeze it.
- `autoindex` skips hidden paths in every mode, including with `--no-ignore`,
  so `index.hidden` covers configured folders (`.agents`, `.github`) through a
  separate `_bulk` index. That is the one corpus a project graph cannot absorb.
  `.git`, `.xerj`, build output, virtualenvs, and secret-shaped files are
  always skipped.
- External files are indexed as plain text through `_bulk`; no AST or symbol
  extraction.
- Shell references are detected heuristically: every literal argument of a
  shell command that resolves to an existing regular file is indexed. Short
  option values, variables, globs, tilde paths, and redirection targets are
  not resolved, and `cd` is followed only within a simple
  `cd dir && ...` chain.
- The engine cannot watch a graph (`--watch` requires `--no-graph`), so a
  graph project refreshes through the plugin's own directory watcher, and a
  folder brain reindexes on startup and on `/xerj-reindex`.
- A corpus built in one mode cannot be continued in the other: switching
  `index.graph` rebuilds the project corpus once (about two minutes on this
  repository with neural embeddings).
- Anomaly scoring has no datafeed, timer, or alerting.

[Back to top](#table-of-contents)

## Development

```bash
bun install
bun test test/unit        # pure functions, no node needed
bun test test/integration # real node on a scratch data root (~5 s)
bun scripts/smoke.ts      # download, spawn, attach, stop
bun run typecheck
```

Integration tests need a XERJ binary once; it is cached in
`~/.cache/opencode/xerj-int` (override with `XERJ_CACHE`, or point `XERJ_BIN`
at an existing build). CI runs the unit suite on Ubuntu and the integration
suite inside a container, preferring podman and falling back to docker.

The repo dogfoods its own plugin through `opencode.json`: `.agents` is indexed
both as a hidden corpus and as the example brain, which exercises the
duplicate-collapse path in retrieval.

[Back to top](#table-of-contents)

## License

Apache-2.0.

[Back to top](#table-of-contents)
