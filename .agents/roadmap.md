# Roadmap: absorbed capability and exposed engine features

This document decides what the plugin takes from two sibling plugins, what
it takes from its own engine, in what order, and what it refuses. It is
the forward-looking companion to `plan.md`, which describes what exists.

Sources examined 2026-11-06, from the installed packages:

| Package | Version | What it is |
|---|---|---|
| `@cortexkit/opencode-magic-context` | 0.49.23 | Context compaction, memory, notes, git search |
| `@cortexkit/aft-opencode` | 0.62.0 | tree-sitter and LSP code analysis, edits, search |

## What decides a candidate

Every candidate is scored on two axes, and effort is what breaks ties.

**Suitability** asks whether the feature belongs to a local-first retrieval
plugin:

- **High**: it improves what the model retrieves or how many tokens an
  answer costs, using data this plugin already indexes.
- **Medium**: it adds a data source or a runtime the plugin can own and
  scope to one project.
- **Low**: it owns file writes, mutates conversation history, or reaches
  outside the machine without an explicit instruction.

**Effort** is measured in working weeks, not lines: S is one week or less,
M is one to three, L is three to six, XL is more than six.

A candidate with high suitability and effort above L is split, so the
cheap half ships first.

## Constraints that shape the plan

1. **The host does not expose its language servers.** `Plugin.Context`
   carries 22 domains; `lsp` is not one of them. An LSP pool is ours to
   run, scope to the project, and stop. Measured host surface:
   `agent`, `aisdk`, `command`, `credential`, `event`, `experimental`,
   `integration`, `mcp`, `model`, `permission`, `plugin`, `provider`,
   `reference`, `rpc`, `session`, `shell`, `skill`, `storage`, `tool`,
   `vcs`, `websearch`, `worktree`.
2. **Compaction belongs to the host.** The harness already compacts, and a
   plugin that also rewrites history double-summarises and thrashes the
   prompt cache. The plugin therefore keeps its own append-only archive of raw
   turns and reads the host's summary from `session.compaction.ended`. It never
   rewrites, reorders, or summarises a message. It reads turn-scoped events
   (prompt, answer, tool result), and reads the message window only in the
   `compaction` hook, where the window is about to be replaced. Expand and
   history search work over the archive.
3. **Grammars are downloaded, not bundled.** Measured: the all-language
   WASM pack is 51.8 MB unpacked, `web-tree-sitter` 4.7 MB, and one
   native TypeScript grammar 38.8 MB. The plugin already owns a verified
   download path for the engine binary; grammars reuse it and live in the
   XERJ data root.
4. **Scope is the project.** Every new runtime reads only files under the
   canonical project root. A path outside it is refused, exactly as the
   indexer refuses one today.
5. **The plugin stays read-only.** It locates, explains, and cites; the host's
   tools and the model write. No tool in this plan opens a project file for
   writing, so a bug here can cost a bad citation but not a file. The plugin's
   own state is the exception and lives outside the project source: the
   XERJ data root, and the hidden `.xerj` directory for per-project data.
6. **No silent outbound traffic.** Anything that leaves the machine,
   including the engine's own field report, is opt-in and off by default:
   `share.enabled` for a listener, `hub.enabled` and `hub.network` for the
   catalogue.

## Capability gates

The candidates that add a parser, a resident process, a listener, or network
access are off by default and opt-in per project, so an install that wants
only retrieval behaves exactly as it does today. A gate is a configuration
setting, not a build flag: the same published package carries the capability.

```jsonc
{
  "plugins": [{
    "package": "@mrdrmccoy/xerj-opencode-plugin",
    "options": {
      "analysis": {
        "treeSitter": {
          "enabled": false,
          "languages": [],
          "maxParseBytes": 1048576
        },
        "lsp": {
          "enabled": false,
          "servers": {},
          "idleMs": 300000,
          "maxServers": 2,
          "timeoutMs": 2000
        }
      },
      "share": { "enabled": false },
      "hub": { "enabled": false, "network": false },
      "memory": {
        "distill": {
          "enabled": false,
          "judge": "heuristic"
        }
      }
    }
  }]
}
```

| Key | Default | Effect |
|---|---|---|
| `analysis.treeSitter.enabled` | `false` | Parse project files for symbol ranges, complexity, duplicates, and structural search |
| `analysis.treeSitter.languages` | `[]` | Which grammars to download. Empty means "detect": the languages the project's own files show, then download those grammars and no others |
| `analysis.treeSitter.maxParseBytes` | 1 MiB | Files above this are skipped, so a bundled asset is never parsed |
| `analysis.lsp.enabled` | `false` | Start language servers for definitions, references, call hierarchy, diagnostics |
| `analysis.lsp.servers` | `{}` | Empty means auto: detect languages, then resolve each server in the order below, installing one when none is found. A non-empty map names the commands and turns auto-install off |
| `analysis.lsp.autoInstall` | `true` | With `servers` empty, install a missing server into the plugin's cache. `false` reports the missing server instead |
| `analysis.lsp.idleMs` | 5 min | Stop a server that answered nothing for this long |
| `analysis.lsp.maxServers` | 2 | Cap concurrent servers, so one project cannot fill memory |
| `analysis.lsp.timeoutMs` | 2 s | Per-request deadline; a miss returns no result rather than delaying a turn |
| `share.enabled` | `false` | Register `xerj_share`, which opens a read-only listener for one index |
| `hub.enabled` | `false` | Register `xerj_ask` and the hub commands |
| `hub.network` | `false` | Allow `xerj ask` to reach the catalogue and download packs; when false only already-cached packs answer |
| `cmd.enabled` | `true` | Register `xerj_run` and `xerj_out`, and maintain the command-output corpus. The one open gate; see its design section |
| `memory.distill.enabled` | `false` | Turn finished turns into typed memories and retire distilled ones past their budget |
| `memory.distill.judge` | `heuristic` | `heuristic` is the free local filter; `model` asks the current model per candidate; `local` runs the downloaded jevos CPU model |

Defaults are closed because each capability adds something a retrieval plugin
should not impose on its own: 52 to 100 MB of grammars, a process holding
hundreds of megabytes, an open port, or traffic to a remote catalogue. The
plugin's contract is that nothing blocks `setup`, and a closed gate keeps
that true.

`cmd.enabled` is the exception, at the user's request. It writes only inside
the plugin's own state, it runs one foreground command with a deadline rather
than owning a shell, and its whole value comes from being on before the first
long command runs. It still needs an off switch that leaves no directory, no
tools, and no suggestion.

### What enabling a gate does

At the default configuration nothing below happens: no language is detected
for analysis, no grammar is requested, no server is probed, no process is
started, no port is opened, and no network call is made.

| You enable | What it detects and fetches, with every other key left at default |
|---|---|
| `analysis.treeSitter.enabled` | Languages from the project's files, the same detection the docs indexer already runs. Grammars for those languages download once, checksum-verified, into `<data root>/grammars/<language>/`, and every later parse reads the cache. A failed download logs once, names the language, and disables only that language |
| `analysis.lsp.enabled` | Detects the project's languages, then resolves a server for each: `servers[language]`, then the project's `node_modules/.bin`, then `PATH`, then the plugin's own cache. If none is found and `autoInstall` is true, it installs a pinned server into `<data root>/lsp/<language>/<version>/`, probes it with `--version`, and uses it. No toolchain check runs first; a language with no known server logs once and stays unanalysed |
| `share.enabled` | Nothing until `xerj_share` is invoked. The tool then prints the address and expiry before it accepts a request |
| `hub.enabled` | The cached catalogue only. `hub.network` adds downloads; until then, a missing pack reports which key would fetch it |
| `memory.distill.enabled` | Nothing until a turn finishes. The turn's own prompt and answer are classified locally, the qualifying sentences are written to memory, and the hourly sweep retires the lowest-confidence distilled ones past the budget. No model call, no window read. `judge: "local"` additionally downloads the jevos binary and its 630 MB model once, checksum-verified, into `<data root>/jev/`, and keeps a loopback server until `local.idleMs` |
| `cmd.enabled` (already on) | Nothing until a command runs. `xerj_run` then creates `<project>/.xerj/cmd/` on first use, writes the command and its output, and indexes the text without embedding it. Turning it off removes the tools, the suggestion, and the directory on the next start |

Two rules follow from the table:

- **Both are cached by the plugin, and neither lands in the project.** A
  grammar and an installed server live under the XERJ data root, pinned by
  version and verified before use. The project's `node_modules` and `PATH` are
  read, never written.
- **Enabling a gate never writes to the project.** Downloads land under the
  XERJ data root, never in `node_modules`, never in the repository.

**Grammar source: settled.** The full `tree-sitter-wasms` pack (0.1.13,
51.8 MB unpacked, every language at once) is acceptable, decided 2026-11-06. It
downloads once through the same verified path the engine binary uses, into
`<data root>/grammars/<version>/`, pinned with a checksum recorded beside the
cache, so an upgrade is a version change rather than a silent replacement. One
download for all languages beats a per-language fetch matrix: fewer failure
states, and no language left unsupported because its grammar has no release
asset. Work on it is deferred at the user's request; `analysis.treeSitter.enabled`
stays closed until then.

### Language servers the plugin can install

Measured from the registry on 2026-11-06. The npm set together is about
26 MB, which is the cost of enabling auto-install on a mixed project.

| Language | Server | Unpacked | Source |
|---|---|---|---|
| TypeScript, JavaScript | `typescript` (`tsserver`) | 2.5 MB | npm |
| Python | `pyright` | 19.5 MB | npm |
| JSON, CSS, HTML | `vscode-langservers-extracted` | 0.9 MB | npm |
| YAML | `yaml-language-server` | 1.2 MB | npm |
| Shell | `bash-language-server` | 2.3 MB | npm |
| Rust | `rust-analyzer` | release asset | GitHub releases |
| Go | `gopls` | release asset | GitHub releases |
| C, C++ | `clangd` | LLVM release asset | LLVM releases |

**Toolchains are assumed present.** The plugin does not check for `go`,
`cargo`, or `clang` before loading a server, and a missing compiler never
suppresses a language. gopls and clangd publish their own binaries, so the
server installs whether or not the toolchain does. If a server later needs
its compiler and does not find one, the first query returns that server's own
error for that language, and every other language keeps working.

The compilers themselves are not installed: that stays the project's
dependency management. clangd arrives inside LLVM release archives, which are
large, so its size is measured before a version is pinned.

Four safety rules for an install:

1. A pinned version and a checksum, both recorded beside the cache, as the
   engine binary already does.
2. npm installs run with `--ignore-scripts`, so a package cannot execute code
   during install, and the expected binary is probed with `--version` before
   first use.
3. The install target is `<data root>/lsp/<language>/<version>/`, never the
   project and never a global prefix.
4. A failed or offline install logs once, names the language and the package,
   retries at most daily, and leaves every other language working.

### Behaviour when a gate is closed

| Capability | Needs | Closed |
|---|---|---|
| `xerj_refs`, `xerj_outline`, `xerj_zoom` | Index only | Available: these never need a gate |
| Import graph, cycles | Index only | Available |
| `xerj_complexity`, structural search | tree-sitter | Tool not registered |
| `xerj_callers`, `xerj_impact` | LSP | Tool not registered |
| `xerj_inspect` | LSP, tree-sitter | Registered with the index-only part (TODOs); diagnostics and unused exports are omitted and named as gated |
| `xerj_share` | A listener | Tool not registered |
| `xerj_ask` | The hub catalogue | Tool not registered; with `hub.enabled` open and `hub.network` closed, only cached packs answer |
| `xerj_run`, `xerj_out` | `cmd.enabled` (open by default) | Tools not registered, no `cmd/` directory is created, and no suggestion is injected |
| Live context distillation | `memory.distill.enabled` | No judge runs, no distilled memory is written, no retirement sweep runs; recall and `xerj_remember` are unchanged |
| The local judge | `memory.distill.judge` = `local` | Nothing is downloaded, no server is started, and the heuristic answers |
| Retrieval, injection, memory, docs corpora | Nothing gated | Identical with every gate closed |

Five rules make the gates trustworthy:

1. A tool whose gate is closed is never registered, so it costs no prompt
   tokens and cannot fail in the middle of a turn.
2. No retrieval path depends on a gated capability. With every gate closed,
   injection output is byte-identical to today's.
3. Status and the panel name each gate and the key that opens it.
4. Opening a gate fetches only what that gate owns: a grammar for the
   languages in play, checksum-verified, visible in the panel rather than a
   silent wait. A language server is discovered, never installed.
5. A closed gate leaves no residue: no process, no cached parse, no file read
   beyond the project scan the index already performs.

Tier XL adds gates of its own, closed the same way: `memory.curate` for the
dreamer's memory work, `memory.extract` for mining durable facts out of a
compaction window, and `context.notes` for notes and smart notes. They follow
the same five rules.

The turn archive is data rather than a runtime, so it is not a capability
gate. It is bounded instead: `context.archive.enabled` defaults to true
because expand and history search are impossible without it, and
`context.archive.maxBytes` (64 MB) prunes the oldest turns at startup the
way `memory.retain` prunes memories. It duplicates conversation text on disk
inside `<project>/.xerj`, mode 0700, and the panel reports its size.

A test per gated capability asserts both directions: absent when closed,
present and answering when open.

## Measured baseline

These numbers are the reason some items are cheap and others are not.

| Measurement | Value |
|---|---|
| Retrieval latency, live corpus | p50 2.5 ms, p95 82 ms |
| Injection deadline | 400 ms |
| Node resident memory | 970 MB |
| Cold index, 94 files, neural | 105 s |
| Incremental pass after one edit | 3.4 s flat, 6.5 s with graph |
| Type-check of this repo, 132 files | 4.5 s |
| Repository size | 16.6k lines, 844 unit + 12 integration tests |
| Coverage | 88.3% lines unit, 89.8% with integration |

## Tier S: one week or less, high suitability

Ship these first. None adds a resident runtime, a grammar download, a parser,
or a listener. Telemetry writes files, but only its own state under the data
root, and it stays in this tier because it needs no process and no network.

| Item | Source | What it does | Done when |
|---|---|---|---|
| **Reset the injection dedupe on compaction** | Defect in current behaviour | A passage dropped by the host's summary must become injectable again | A long session keeps citing after a compaction instead of going quiet |
| `/xerj-wrapup` | Magic Context, reduced | Trigger the host's own compact endpoint; no rewriting | The command reports the host's result |
| `xerj_refs` | AFT callgraph, reduced | Reference count for a symbol from the indexed `code` field, cited as `path:line` | A query returns call sites for `buildTools` with no new process |
| `xerj_outline` | AFT outline | Symbol list for one file from existing records | One call replaces a whole-file read |
| `xerj_zoom` | AFT zoom | One symbol's body by name, with its exact range | Returns the declaration and its lines only |
| Commit indexing | Magic Context | Git log as documents: hash, author, date, subject, body, paths | "why did the sweep change" cites a commit |
| Auto-search hint | Magic Context | One fragment naming the matching file when the gate half-matches | A directive prompt costs one line, not one passage |
| Memory verification | Magic Context | Check memories whose paths, keys, or symbols no longer exist; mark stale, never delete | A memory pointing at a removed file reports stale |
| Memory curation | Magic Context | Merge near-duplicates, archive superseded facts, score by use | The store stops growing with restatements |
| `autoindex map` | XERJ engine | Panel view of what the corpus contains | The panel answers "what do you know" |
| `prjdocs` keyword surfacing | This plugin | Expose `eagerKeywords` in the panel and the command help | A user can add a term without editing JSON |
| Sidebar rebuild | AFT and Magic Context, layout only | Bordered box with a `▼ XERJ` accent header, click to collapse, three summary rows when collapsed and named sections when expanded; per-section on/off and collapse memory in the shared `tui-preferences.jsonc` under key `xerj` (`order` is not offered: this host's slots take `prepend`/`append` only); inline `⚠` for a failing corpus; 150 ms refresh debounce | Collapsed and expanded views both render from `StatusSnapshot` alone, a click survives a view switch, and formatting stays pure and tested |
| **Config example formatting** | This plugin | Rewrite the complete-default options block in the README (and the copy in `plan.md` §3) as one key per line, grouped by section, with a comment naming the default and its unit; the README block omits 21 defaults today, including `node.logMaxBytes`, `index.graph`, `index.git`, `index.gitLimit`, `context.archiveEnabled`, `context.archiveMaxBytes`, every `prjdocs.*`, and every `sysdocs.*`; the `plan.md` copy is staler still (`context.maxPassages` reads 4 against a default of 8) | The block parses as JSONC, its key set equals `DEFAULT_CONFIG`, and a test fails when a new option lands without updating the example |
| **CPU affinity (`node.cpus`)** | This plugin | Confine every XERJ process to a chosen CPU set: explicit indices and inclusive ranges, `odd` (the default), `even`, or a percentage of the CPUs available to the process, rounded down | `node.cpus: "0-3,8"` confines the node and every index run on Linux, `"50%"` resolves against the available CPU count, `null` or `"all"` leaves affinity unchanged, and an unsupported platform behaves as it does today |
| **Local telemetry** | This plugin | Record every operation with its type, duration, and outcome into bounded files under the XERJ data root, plus boot phases, crashes, restarts, CPU and RSS per XERJ process, and the split between idle and busy time, so the plugin's own performance can be measured and improved | `xerj_telemetry` reports count, error rate, p50/p95 split by idle and busy, total time per type, the last ten boots, crash counts, and CPU/RSS with the day's peak and growth; the sidebar and panel show `ready`, `busy` with the running job, `degraded`, `starting`, or `stopped`; with telemetry on, retrieval p50 and p95 do not move and no flush lands inside a turn; the store never exceeds `telemetry.maxBytes` |

### CPU affinity value syntax

`node.cpus` takes one string:

- `"0-3,8,10-11"` uses those logical CPUs; ranges are inclusive.
- `"odd"` and `"even"` take every CPU in the plugin's affinity mask whose index
  is odd or even.
- `"50%"` takes the lowest-numbered `floor(50% * available)` CPUs, at least
  one, where `available` counts the CPUs in the plugin's own affinity mask.
- `"odd"` is the default; `null` or `"all"` makes no affinity change.

`odd` and `even` split the CPU list by index, not by SMT sibling. On a machine
that numbers siblings apart, the pair does not separate them. Neither form
promises more throughput; both exist so the indexer can share a subset with
other work.

On Linux the percentage is a share of the CPUs in the plugin process's own
affinity mask, taken in ascending order, so a parent `taskset` or a container
cpuset is honored instead of widened. Elsewhere it is a share of
`os.availableParallelism()`, which already counts a cgroup quota. An index
above the CPU count is dropped with one warning, and a value that resolves to
no CPU leaves affinity unchanged and warns. An explicit `index.workers` is
left alone: the engine's own default follows the process's available
parallelism, and overriding a deliberate worker count would hide the cost of a
narrow set.

Platform behaviour:

- Linux: `taskset -a -pc <list> <pid>` after spawn, beside the existing
  `ionice` call. `-a` covers every thread, because `xerj` creates its scan pool
  after startup and a main-thread-only call would leave the workers unpinned.
- Windows: `(Get-Process -Id <pid>).ProcessorAffinity`; a set that names a CPU
  index of 64 or more is refused with a warning, because the mask is 64-bit.
- macOS: no per-process CPU selection. The key is accepted, one warning says
  it has no effect, and nothing else changes.

### Local telemetry design

The plugin can only be made faster if its own costs are measured. Today the
only durable record is the warning ring in `ctx.storage` and the per-process
`Counters`, which reset on restart and count six events. That is enough for a
panel and useless for profiling: it cannot answer "is `xerj_zoom` slower than
`xerj_outline`", "did the last release regress retrieval", or "which tool
errors most often".

Telemetry records every operation the plugin performs. It is local data, not
a field report: nothing in this design opens a socket, imports the network
layer, or is read by anything outside the machine. The README, the panel, and
the tool description each say so.

#### Why not the existing log ring

The log ring rewrites its whole array into key-value storage on every entry.
That is fine for fifty warnings a day and wrong for thousands of operations in
a session. Telemetry uses append-only files with explicit rotation, which cost
one write per record and degrade gracefully as the corpus grows.

The two stores stay separate on purpose:

| Store | Answers | Bounded by |
|---|---|---|
| `src/log.ts` ring | "what went wrong that I must see" | 50 entries, key-value |
| Telemetry | "what did the plugin cost, and where" | `telemetry.maxBytes`, files |

#### Where it lives

One store per installation, under the XERJ data root:

```
<data root>/telemetry/
  ops.ndjson                    every operation, newest last
  ops.1.ndjson … ops.N.ndjson   rotated, 1 is the newest rotation
  rings/<type>.ndjson           last N samples for one type
  samples/<date>.ndjson         CPU and RSS of each XERJ process
  rollup/<date>/<instance>.json per-day, per-instance counters
  state/boot-<instance>.json    this process's boot id and last phase
  writer.lock                   owner pid and heartbeat
  README.txt                    what this is and that nothing leaves
```

The data root, not `<project>/.xerj`, because the interesting question
compares projects: "search is slower in this repo than in that one" needs one
place to read from. It is also outside every project, so it cannot be indexed,
committed, or walked by the watcher. Every record carries the project's prefix
(slug and hash, never the absolute path) so the reader can filter.

Per-project state under `storage.root` would split an installation's history
across directories and lose it when a user moves a project. The existing
shared state (binary, release cache, port lock) already lives at the data
root for the same reason.

#### What an operation is

`OpType` is a closed set of dotted names. A closed set is the point: the panel
groups by it, the rings are keyed by it, and a typo cannot silently create a
new file. Groups and their types:

| Group | Types |
|---|---|
| retrieval | `retrieve`, `inject`, `recall`, `hint`, `rehydrate` |
| search | `search`, `search.lexical`, `search.semantic`, `search.name`, `brain.expand` |
| tools | `tool.<name>` for every registered tool |
| rpc | `rpc.<method>` |
| index | `index.project`, `index.hidden`, `index.web`, `index.brain`, `index.git`, `index.archive`, `index.prjdocs`, `index.sysdocs` |
| node | `node.spawn`, `node.attach`, `node.probe`, `node.stop` |
| binary | `binary.detect`, `binary.install`, `binary.resolve` |
| memory | `memory.store`, `memory.recall`, `memory.forget`, `memory.curate`, `memory.verify` |
| hooks | `hook.prompt`, `hook.context`, `hook.tool` |
| graph | `graph.ego`, `graph.overview` |
| archive | `archive.append`, `archive.expand` |
| lifecycle | `lifecycle.boot`, `lifecycle.ready`, `lifecycle.indexed`, `lifecycle.state`, `lifecycle.crash`, `lifecycle.restart` |

Two of those groups are wrapped generically rather than at each call site.
`buildTools` times every tool it returns, and the RPC registration times every
method it registers, so a tool added later is measured without touching it.
The rest are explicit, at the boundary the layer already owns: the corpus
service's run start and end, the supervisor's spawn and attach, the crawler's
page loop.

#### Record shape

One JSON object per line, so `tail`, `jq`, and a line-oriented reader all work
without a parser dependency:

```jsonc
{"at":1762470000000,"op":"search","ms":12,"ok":true,"load":0,
 "prefix":"xop-xerj-opencode-plugin-1a2b3c4d",
 "meta":{"hits":6,"bytes":8120,"leg":"fused"}}
```

Fields are fixed and validated on write. `meta` accepts bounded scalars only:
counts, byte sizes, booleans, enum strings, the project prefix, and up to
`telemetry.maxText` characters of one caller-supplied string. It never
accepts a prompt, a file body, or model output.

`telemetry.maxText` defaults to 160, which is enough to identify the query, the
symbol, or the project-relative path an operation was about, and short enough
that 45 types of 256 samples stay under about 4 MB. The text passes through
the same `redact()` the fetched-page spool uses, so a bearer token or an API
key pasted into a query is not written to disk. `redact` moves from
`src/remote/spool.ts` to `src/redact.ts` so telemetry does not import the
remote layer; the spool keeps using it.

An error is recorded as its class name and, for an HTTP failure, its status
code. Error messages are not recorded, because they embed URLs, file contents,
and model output.

Durations use `performance.now()`, which is monotonic. Timestamps use
`Date.now()`.

#### What each file holds

| File | Holds | Written how | Bound |
|---|---|---|---|
| `ops.ndjson` | every operation, chronological | append, O_APPEND | rotates at `telemetry.rotateBytes` (8 MiB), `telemetry.rotations` (4) kept |
| `rings/<type>.ndjson` | the last `telemetry.samplesPerType` (256) samples of one type | append by any instance, compacted by the owner | 256 lines, rewritten tail-only |
| `samples/<date>.ndjson` | one CPU and RSS line per sampled process | appended by the owner | one day per file, pruned first |
| `rollup/<date>/<instance>.json` | per-day count, errors, total ms, max ms per type | each instance writes its own file | one small file per day per instance |
| `state/boot-<instance>.json` | this process's boot id and last reached phase | rewritten at each milestone, removed on a clean shutdown | one tiny file per live instance |

The rings answer "what is the latency distribution of this operation now".
The rollup answers "how many times did it run, over all time", which a
256-line ring cannot. Keeping the count in the ring header instead would make
the header wrong every time a second instance appends, so the counters live
where each writer can own them.

#### Multiple instances

A server can load the plugin twice for one project (the repository and a
subdirectory inside it). Appending a line under O_APPEND is atomic on every
platform the plugin ships for, so any instance may append. Compaction rewrites
a file, so exactly one instance may do it: the owner, claimed at
`writer.lock` with mkdir and a pid heartbeat, stale after 60 seconds. A
non-owner keeps appending and skips compaction; the owner's next flush tidies
the file. When the owner dies, the next flush takes over.

This is the same idiom as the port lock and the watcher claim, so there is one
concurrency story in the codebase rather than three.

#### Write path

`span(type, body)` measures with `performance.now()`, runs `body`, and pushes
a record onto an in-memory queue. It never awaits a write, and a full queue
drops the oldest entry rather than delaying a turn. A flusher drains the queue
every `telemetry.flushMs` (5 s) and at shutdown, appends the records, and then
touches the rings and rollup it has accumulated.

A failed write logs once and disables telemetry for the session. Telemetry
must never be the reason a turn fails or a plugin does not load.

Nothing in the retrieval path reads telemetry. `xerj_search` does not consult
it, the prompt hook does not gate on it, and disabling it changes no output
byte. That is the same rule the capability gates follow.

#### Startup, crashes, and restarts

A store that only sees completed operations cannot explain the worst turns:
the one that waited for a cold node, and the session where the node died
twice. Five lifecycle records answer that, sharing a `bootId` so they read as
one timeline.

`t0` is the load time of a two-line `src/telemetry/boot-clock.ts` that
`src/index.ts` imports first, so the numbers include the plugin's own import
cost. Every record below carries `ms` from a defined origin:

| Record | When | `ms` means | `meta` |
|---|---|---|---|
| `lifecycle.boot` | end of `setup()` | `t0` → tools, hooks, and RPC registered | per-phase `config`, `binary`, `nodeSpawn`; previous shutdown clean or not |
| `lifecycle.ready` | node first answers | `t0` → first successful health probe | whether the node was attached or spawned, and the port |
| `lifecycle.indexed` | first corpus run document after this boot | `t0` → index usable | corpus and record count |
| `lifecycle.crash` | a death we did not ask for | uptime of the thing that died | `kind` (`plugin`, `node`, `watcher`), exit code, signal, last phase |
| `lifecycle.restart` | service answers again after a death | time from death to answering | `reason` (`crash`, `idle`, `manual`) and the uptime that was lost |

Clean versus crashed shutdown comes from a marker, not from memory:

```
<data root>/telemetry/state/boot-<instance>.json
{"bootId":"…","pid":123,"at":1762470000000,"phase":"ready"}
```

Setup writes it and advances `phase`; a clean shutdown removes it. The next
start treats a marker whose pid is gone as a crash and records
`lifecycle.crash` with `kind: "plugin"` and the last phase reached, so the
report says "died while indexing" rather than "died". A marker whose pid is
alive belongs to another instance and is left alone. Markers older than seven
days are swept with the rest of the store.

The node is spawned detached and unref'd, so it produces no exit event. Its
crash is inferred from the pidfile, which `stopNode` removes on every path it
owns: a pidfile whose process is gone, found by `ensure()` or `stopNode`,
is a crash, recorded once per pid and mtime. The supervisor already makes
that distinction for its own stop logic, so the record is a side effect of a
decision it already takes, not a second watcher.

The resident watcher does report its own exit: the corpus service already
separates a stop it requested from a signal, and a signaled exit already
triggers a backoff restart. That branch gains the `lifecycle.crash` and
`lifecycle.restart` records, with the attempt number.

The report shows the last ten boots as `setup 12 ms · ready 1.2 s · indexed
8.4 s`, marks an unclean previous shutdown, and counts crashes and restarts
per day. One node that dies after four minutes is a different problem from one
that runs all day and stops on idle, and only the uptime separates them.

#### Ready versus busy

`node.phase` already reports `starting`, `ready`, `error`, and `disabled`, and
each corpus reports `starting`, `watching`, or `idle`. Neither answers the
question a user asks during a cold start: "it says ready, so why is search
slow?" A node that answers and is also building the index is ready to serve
and busy doing work. Those are different facts with different consequences,
and today the sidebar shows only the corpus state.

One place computes five service states and publishes them to both the UI and
telemetry:

| State | Means | Shown as |
|---|---|---|
| `starting` | setup done, node not answering yet | `◐ starting · 1.4 s` |
| `ready` | node answers, no job running | `● ready` |
| `busy` | node answers, at least one job running | `◐ busy · indexing · 12 s` |
| `degraded` | ready, but a corpus errors or an index is missing | `▲ degraded · memory missing` |
| `stopped` | node down after an idle stop | `○ stopped` |

Busy does not mean unready. A query still answers during an index pass; it can
answer slower, because the node shares its scan pool with the indexer. Saying
`busy` instead of `ready` is what keeps the badge honest, and recording the
load is what lets the telemetry separate the two cases later.

Precedence is `starting`, `stopped`, `degraded`, `busy`, `ready`. A broken
index outranks a slow one for the badge, and the running jobs stay listed in
the expanded view and the panel. The existing `⚠` line for a failing corpus
stays where it is.

The jobs that make the state busy are the long ones, named by a `JobKind`
enum: `spawn`, `index`, `embed`, `hidden`, `web`, `brain`, `git`, `archive`,
`prjdocs`, `sysdocs`, `install`. A reference-counted registry means the
project index and the web pass can overlap without the first to finish
clearing the state. `snapshot.embeddings` folds into an `embed` job and is
removed once the panel reads jobs.

Each job carries its kind, a short label, and a start time. The elapsed figure
is computed in the UI from the start time on a one-second tick while busy, so
the sidebar counts up without an RPC per second; the state itself only changes
through the snapshot, which is pushed on the existing `updated` event and
falls back to the 30-second poll.

A job past its deadline is the failure that matters here: a leaked job would
report `busy` forever. Each kind gets a deadline (index 30 minutes, docs 20,
install 10, the rest 5), and a job past it is marked stale, stops counting
toward the state, and warns once.

Transitions are telemetry too. `lifecycle.state` records `from`, `to`, and a
reason, and the per-day rollup accumulates the time spent in each state, so
the day reads `ready 6h 12m · busy 48m · degraded 3m · starting 1.2s`. A
transition is recorded even when it lasts a second; only the UI update is
debounced, by the sidebar's existing 150 ms.

Every operation record carries `load`, the number of jobs running when it
started. 0 means idle. The report groups latency by idle and busy, so a p95
measured during an index pass is not mistaken for a retrieval regression.

The snapshot gains one block:

```ts
state: {
  name: "starting" | "ready" | "busy" | "degraded" | "stopped";
  since: number;          // epoch ms of the current state
  detail: string | null;  // "indexing", "memory missing"
  jobs: ReadonlyArray<{ kind: string; label: string; startedAt: number }>;
  today: Readonly<{
    startingMs: number; readyMs: number; busyMs: number; degradedMs: number;
  }>;
}
```

The sidebar header becomes `▼ XERJ ● ready` or `▼ XERJ ◐ busy · indexing`,
and the expanded view gains a `State` section with the current state's age, the
running jobs, and the day's dwell split. The panel opens with the same section
above corpora, so the first thing it answers is "what is it doing right now".

#### CPU and memory

A duration says an index pass took 105 seconds. It does not say whether the
node used one core or eight, or whether its resident set grew by 200 MB while
it did. Those are the two numbers that explain a slow pass and the cost the
plugin puts on the machine.

The sampler reuses `src/process-stats.ts`, extended to remember the previous
CPU-tick count per pid and report the delta over the sampling interval. The
existing `sampleProcess` sleeps 120 ms between two reads, which suits a status
line and not a 15-second series; the telemetry path reads twice per interval,
sleeps not at all, and measures the real window.

Three kinds are sampled:

| Kind | Process | Why |
|---|---|---|
| `node` | the XERJ server from `node.pid` | the memory and CPU the corpus holds all day |
| `watcher` | the resident autoindex process | separates indexing cost from serving cost |
| `index` | a one-shot index or brain run, while it runs | short, CPU-heavy, and worth attributing |

One line per sample, one sample every `telemetry.sampleMs` (15 s):

```jsonc
{"at":1762470000000,"kind":"node","pid":4242,"load":1,
 "cpuPct":86.4,"rssBytes":1017118720,"threads":24}
```

`cpuPct` is a percentage of one core, the unit the panel already shows, so 400
means four cores saturated. `load` and the dominant job kind sit alongside, so
CPU during indexing separates from CPU while serving. `threads` is free from
the same `/proc` read and explains a falling `cpuPct` when the scan pool shrinks.

The first sample after a start carries `cpuPct: null`, because there is no
previous tick count to subtract. It is still written: its RSS is real.

Samples get their own file. At 15 s that is 5760 lines a day for the node
alone, which would bury a log holding a few hundred real operations, and a
sample is not an operation: it has no duration and no outcome. Keeping them
apart keeps both readable, and the sample file is pruned first.

The report gains a `process` block:

- current CPU and RSS, and the day's peak RSS;
- p50 and p95 RSS over the window, so a spike is not read as the steady cost;
- mean CPU while busy against while ready;
- RSS change over the window in MB per day, which is the figure that catches a
  leak before it fills a machine.

The panel's runtime row already shows CPU and RSS now; it gains the day's peak
and the growth figure.

Volume: two resident series at 110 bytes per line is about 1.3 MB a day, or
38 MB for 30 days. That is the largest family under the cap, which is why the
sweep drops sample days before rollups.

Platform: Linux reads `/proc`. macOS and the BSDs use
`ps -o pcpu=,rss= -p <pid>`, one cheap spawn per sample. Windows has no
equivalent without a helper, so sampling is skipped there with one warning
that names the key; every other telemetry record still works.

#### The size limit

`telemetry.maxBytes` defaults to 134217728 (128 MiB) and covers the whole
directory. It is a backstop, not the normal bound: with the defaults above the
log family tops out at 40 MiB, the rings at about 2 MiB, samples at about
1.3 MB a day, and rollups at kilobytes per day.

The sweep runs at startup and every ten minutes. It removes, in order:

1. the oldest rotated ops files, until the cap is met without touching
   `ops.ndjson`, the rings, or the rollup;
2. the oldest sample days, oldest first, because they are the bulk;
3. the oldest rollup days, oldest first;
4. half of every ring, keeping the newest samples;
5. if the cap still binds, telemetry drops to log-only for the session, which
   stops ring, sample, and rollup writes and logs one warning naming the key.

A directory walk measures the real size, cached for 60 seconds, because the
files are also written by another process.

#### Reading it

`xerj_telemetry` takes `op` (a type, a prefix like `tool.`, or omitted for
all), `window` (`session`, `day`, or `all`, default `day`), `sort` (`count`,
`p95`, `total`, or `errors`), and `limit` (default 20). It returns one row per
type: count, errors, p50, p95, max, and total milliseconds, split into idle and
busy by `load`; a `starts` block with the last ten boots, their
setup/ready/indexed figures, and the crash and restart counts; a `state` block
with the day's dwell split; a `process` block with CPU and RSS now, the day's
peak, p50/p95 RSS, mean CPU busy against ready, and the growth in MB per day;
the store's size; and the date the surviving history starts.

The panel gains a telemetry section with the five busiest types, the last
boot's `ready` figure, any unclean shutdown, and the line
`local only · never sent`. The TUI reads them through the status RPC, never
the filesystem.

#### Configuration

```jsonc
"telemetry": {
  "enabled": true,          // local files only; nothing is ever sent
  "maxBytes": 134217728,    // 128 MiB for the whole directory
  "samplesPerType": 256,    // ring length per operation type
  "rotateBytes": 8388608,   // 8 MiB before ops.ndjson rotates
  "rotations": 4,           // rotated ops files kept
  "flushMs": 5000,          // queue drain period
  "sampleMs": 15000,        // CPU and RSS sample period; 0 disables sampling
  "maxText": 160            // characters of caller text; 0 records none
}
```

On by default because the data is local, bounded, and the only way the plugin
can report its own cost. An installation that disagrees sets
`telemetry.enabled: false`; the directory is then never created and no write
path runs, including the lifecycle marker.

The README gains this block in the options example, a row per key in the
options table, and a short paragraph that says in plain words: the files are
local, they are never sent anywhere, the plugin has no network path for them,
and `enabled: false` leaves no trace. The tool description repeats the first
two sentences, because that is where a model and a user will read them.

#### Failure and edge cases

| Case | Behaviour |
|---|---|
| data root unwritable | telemetry disabled for the session, one warning, plugin unaffected |
| corrupt line in a ring or rollup | the line is skipped on read, the rest of the file is kept |
| clock jumps backwards | `performance.now()` keeps durations sane; only the timestamp is odd |
| two instances flush at once | appends are atomic; compaction is owner-only |
| the owner dies | the lock goes stale after 60 s and the next flush takes over |
| text above `maxText` | clipped, then redacted, then written: never whole |
| store over the cap | sweep in the documented order, then log-only |
| a boot marker survives a crash | the next start records the crash and rewrites the marker; nothing blocks setup |
| two instances leave markers | each has its own file and pid; a marker whose pid is alive is ignored |
| the previous run was killed before any milestone | the crash record carries `phase: "setup"`, which is still a signal |
| a job leaks and never ends | a job past its per-kind deadline stops counting toward busy and warns once; the badge cannot stick on `busy` |
| a job flaps on and off | every transition is recorded; only the UI update is debounced |
| a sampled pid vanishes between reads | that sample is skipped; one warning per kind per hour, not one per interval |
| the platform has no `/proc` and no `ps` | sampling is skipped with one warning naming `telemetry.sampleMs`; every other record still works |
| the first sample has no delta | `cpuPct` is null and the RSS is still recorded, so a series always starts with a memory point |

#### Tests

Unit, with a temporary directory and a fake clock: ring cap and tail-only
compaction; rotation names and order; the sweep's deletion order and that it
stops at the cap; rollup summed across days and instances; p50/p95/p99 from a
fixed sample set; disabled mode creates nothing; an unwritable directory warns
once and keeps the plugin alive; a corrupt line is skipped; `maxText: 0`
records no text even when a caller passes one; a full queue drops without
throwing; two stores on one directory agree on the owner.

Lifecycle tests: a boot writes three records that share one `bootId` and
carry increasing `ms`; a clean shutdown removes the marker, so the next boot
reports no crash; a killed process leaves the marker, and the next boot
records `plugin` with the last phase; a stale pidfile records exactly one
node crash, and a second ensure does not repeat it; a signaled watcher
records a crash and a restart with the attempt number; an idle stop records
`lifecycle.restart` with `reason: "idle"` and no crash; `maxText: 160`
clips a long string and redacts a bearer token inside it.

State tests: the precedence order holds when several conditions are true;
two overlapping jobs keep the state busy until both end; a job past its
deadline stops counting and warns once; every transition records `from`,
`to`, and a reason; dwell time sums across a day boundary and across a
restart; a one-second busy period is recorded even though the UI update is
debounced; every operation record carries the load that was running;
`xerj_telemetry` splits p50/p95 by idle and busy; the sidebar renders each of
the five states and counts the busy elapsed from `startedAt` with no RPC.

Sampler tests: the delta sampler reports CPU over the interval from two tick
counts and sleeps not at all; the first sample is null CPU with a real RSS;
consecutive samples of one pid use consecutive deltas; a vanished pid returns
null and the caller skips it without throwing; the `ps` path parses `pcpu` and
`rss`; an unsupported platform warns once and keeps every other record; the
sweep drops sample days before rollup days; the report computes the day's
peak, p50/p95 RSS, mean CPU while busy and while ready, and the growth rate.

Integration: drive one retrieval and one tool call with telemetry on, then
assert both appear in `ops.ndjson` and in their rings, and that the count in
the rollup matches. Then stop the node through the plugin and assert the next
start records an idle restart, not a crash.

Performance gate: measure retrieval p50 and p95 and the prompt hook's wall
time on this repository with telemetry off and on. On must be within noise,
and no flush may appear inside a turn. If it does not hold, the flush moves
off the turn path or the feature ships off by default.

Effort: about 12 hours. Store and sweep 2 h, span API and generic wraps
1.5 h, lifecycle records and crash detection 1.5 h, service state and the
two UI surfaces 1.5 h, CPU and RSS sampler 1.5 h, report and tool 1.5 h,
tests 2.5 h.

## Tier M: one to three weeks, high suitability

| Item | Source | What it does | Prerequisite | Gate |
|---|---|---|---|---|
| Import graph and cycles | AFT inspect | Parse import lines from indexed text, report cycles | None | None: index only |
| Regex and glob search | AFT search | Literal and pattern search over project files | A local matcher; the engine has no regex query | None |
| Structural search | AFT `ast_grep_search` | AST pattern search with metavariables, read only | `ast-grep` on `PATH`; the tool reports absence and nothing else | None; no write path |
| tree-sitter layer, one language | AFT | Lazy grammar download, per-file cache, symbol ranges | TypeScript first | `analysis.treeSitter.enabled` |
| Complexity and duplicates | AFT inspect | Node counts per function, structural hashing | The tree-sitter layer | `analysis.treeSitter.enabled` |
| `xerj_code` | XERJ engine | Retrieval over reference corpora (`corpus add/index/list`) | A corpus lifecycle view in the panel | None |
| `xerj_ask` and hub packs | XERJ engine | Answers from signed pre-indexed packs, with licence and pin named | Cached catalogue | `hub.enabled`; `hub.network` for anything not cached |
| Graph overview in the panel | XERJ engine | Edge totals, hubs, detectors per brain | None; the endpoint is already used | None |
| Turn archive | Magic Context, reduced | Append raw turns to `<project>/.xerj`, pruned by `context.archive.maxBytes` | Retention sweep at startup | `context.archive.enabled`, on by default |
| `xerj_expand` | Magic Context, reduced | Return the original `U:`/`A:` text for an archive range | The archive | `context.archive.enabled` |
| History search | Magic Context, reduced | `xerj_search` over archived turns as an extra corpus | A second index prefix | `context.archive.enabled` |
| Pre-compaction window archive | Magic Context, reduced | Flatten `event.messages` from the `compaction` hook into the archive before the summary replaces them | The turn archive | `context.archive.enabled` |
| Fact mining from the compaction window | Magic Context, reduced | Turn the same window into durable memories; heuristic first, one bounded model call as the second route | A precision measurement | `memory.extract`, off by default |
| Post-compaction rehydration | This plugin, defect-driven | After the host compacts, re-inject two or three passages from the session's own working set before the next prompt arrives, under a separate budget and a `<xerj-recall>` marker | The dedupe reset (shipped) | `context.rehydrate`, on by default, capped by `context.rehydrateTokens` (600) |
| Command output management | This plugin, new | Keep every long command's text in `.xerj/cmd/`, index it cheaply, and give the model `xerj_run` and `xerj_out` instead of `head`/`tail`/`grep` over a terminal | None | `cmd.enabled`, on by default |
| Live context distillation | This plugin, new | After each turn, classify decisions, constraints, conventions, preferences, and facts into memory, and retire distilled memories by evidence and budget | The turn archive and the verification and curation passes (shipped) | `memory.distill.enabled`, off by default |

### Command output management design

A long command is the one place where an agent reliably spends context it
cannot afford: a build log, a test run, a `journalctl`, or a `find` over a
large tree is thousands of lines, and the model reads a `head` or a `tail` and
then runs the command again to see the middle. The output is already produced
and already known; what is missing is a place to keep it and a way to ask it a
question.

This feature adds both: a directory of command text, indexed like a corpus but
cheaply, and two tools that replace the shell idioms. The model is told to use
them and the instruction stays in context across turns.

#### What it is not

It is not a second shell. The roadmap's non-goal stands: no pty, no detach, no
resident session, no background jobs, no notification. `xerj_run` runs one
command in the foreground, waits for it, and returns a receipt. The host's
`bash` tool remains the way to do anything interactive.

It is the one write path outside the plugin's own databases, so it is bounded
to the plugin's state directory: `cmd/` under the project's storage root. No
project file is ever opened for writing.

#### Paths and file format

```
<storage root>/cmd/                   0700, gitignored by .xerj/.gitignore
  20261106T192233123Z-cmd.txt         the command string, exactly as run
  20261106T192233123Z-out.txt         stdout and stderr interleaved, in order
  manifest.json                       stem -> { at, bytes, lines, exitCode, durationMs }
  20261106T192233123Z-out.txt.part    only while the command still runs
```

Two files per command, as specified. The stem is a UTC timestamp with
milliseconds, `YYYYMMDDTHHMMSSmmmZ`, so lexical order is age order and a pair
is found by its common stem. Two commands started in the same millisecond are
serialised under a writer lock that bumps the stamp, so a stem is unique.

Output is written to `<stem>-out.txt.part` and renamed on exit, so a reader
never sees a half-written log. The manifest carries the exit code and timing;
if it is lost, the pairs are still readable, and a rebuild scans the directory
and reports `exitCode: null` rather than guessing.

The directory sits under `.xerj`, which every ingester skips, so these files
never enter the project corpus and cannot feed their own writes back.

#### Lifecycle

| Trigger | Action |
|---|---|
| `xerj_run` | Run the command, write both files, update the manifest, queue an index pass |
| Host `bash`/`shell` result, when `cmd.mirrorHostResults` | Write the command and the result text the host returned; mark `truncated: true` when the host clipped it, so history covers commands run outside the wrapper |
| Exchange of a large result (`cmd.hintLines`, 40) | Queue a one-line hint for the next turn naming the stem |
| Startup, each ingest, hourly | Sweep to the size cap |

The runner uses the host's shell (`bash -lc`), the project root as the working
directory, and the inherited environment. The process group is killed on the
deadline (`cmd.timeoutMs`, 10 min) or when the captured output reaches
`cmd.maxCommandBytes` (64 MiB), and the file records which limit tripped.
Binary output is stored and marked, not parsed.

#### The index: present, cheap, and not embedded

The corpus is `<prefix>-cmd-docs` (for example
`xop-cmd-6f7bb383-docs`), one index, `body` as plain `text`. It is not a
`semantic_text` field: logs are literal, the neural embedder buys nothing for
an error string or a stack trace, and embedding megabytes per command would
cost more than the whole project pass. The semantic leg skips it by mapping,
which is what the scope fix already does.

Files are split into windows of `cmd.windowLines` (200) lines or
`cmd.windowBytes` (16 KiB), whichever binds first. One document per window:

```jsonc
{"stem":"20261106T192233123Z","kind":"out","body":"...",
 "start_line":401,"end_line":600,"lines":1200,"bytes":48213,
 "exit_code":1,"at":"2026-11-06T19:22:33Z","truncated":false,
 "command":"npm test","ax_path":"cmd/20261106T192233123Z-out.txt"}
```

The id is `sha256(stem + kind + start_line)`, so a re-ingest is idempotent and
a pruned stem deletes its windows by id. The command file is indexed as one
small document, so "what did I run last Tuesday" is a search. A file past
`cmd.maxFileBytes` is stored and named in `list`, but not parsed; the raw file
keeps everything either way.

This is the "less aggressive" part: no embedding, bounded windows, indexed
bytes capped, a background job at `node.priority`, and a debounce so a burst
of commands becomes one pass. Query-time `_passage` offsets map a window hit
back to the exact line in the raw file.

#### Tools

| Tool | Input | Returns |
|---|---|---|
| `xerj_run` | `command`, `timeoutMs?` | Exit code, duration, line and byte counts, the stem, and whether output was truncated; never the output |
| `xerj_out` with `list` | `limit?`, `command?` | Newest stems first: stem, command, exit code, age, lines, bytes |
| `xerj_out` with `show` | `stem`, `start?`, `end?` | The exact lines from the raw file, capped by `cmd.showTokens` (1,200 tokens), with `cmd/<stem>-out.txt:120` citations. Works before the file is indexed |
| `xerj_out` with `search` | `query`, `stem?`, `k?` | Lexical windows with `stem:line` citations and the matched text, deduped by window |
| `xerj_out` with `ingest` | `path`, `command?` | Copies a file the agent wrote outside the wrapper into the log directory as a new pair, then indexes it; refuses above `cmd.maxFileBytes` |

`list` is what reduces repeat commands: before re-running a build, the model
can see that it ran it and what the exit code was. `show` and `search` are the
replacements for `head`, `tail`, `sed -n`, and `grep`.

#### The instruction that stays in context

The first model call of a session appends a `<xerj-command-output>` block next
to `<xerj-corpus>`:

```
<xerj-command-output>
Long command output belongs in the XERJ log directory, not in this window.
Run such a command with `xerj_run` (it writes cmd/<stem>-cmd.txt and
cmd/<stem>-out.txt and returns only exit code and sizes), then read what you
need with `xerj_out show stem=<stem> start=120 end=160` or
`xerj_out search query="..."`. Before repeating a command, `xerj_out list`
shows what already ran and how it ended.
</xerj-command-output>
```

The block is charged to the 300-token corpus budget, re-emitted when the
corpus block is rebuilt, and re-emitted after `session.compaction.ended` with
the recall block, because the summary drops the first call. A single
`<xerj-hint>` line after a large mirrored result names the stem once; it
follows the existing hint path and the session dedupe, so it cannot repeat.

`cmd.suggest: false` removes both without disabling the tools.

#### Retention and rotation

One sweep, oldest complete stem first, deleting both files and their index
documents together:

| Key | Default | Bound |
|---|---|---|
| `cmd.maxBytes` | 268435456 (256 MiB) | The directory and `<prefix>-cmd-docs` together: file bytes from a walk plus the index size from `_cat/indices` |
| `cmd.maxFileBytes` | 33554432 (32 MiB) | One command's output; past this it is stored but not parsed |

One budget covers both stores because the request is one number: 256 MiB is
what a user expects to spend, not 256 MiB of files plus a second 64 MiB of
index. The sweep measures both, then deletes the oldest complete stem, files
and documents together, until the total is under the cap. It runs at startup,
after each ingest, and hourly; it never deletes a stem whose command is still
running. A directory walk is cached for 60 seconds, as the telemetry sweep
already does.

#### Configuration

```jsonc
"cmd": {
  "enabled": true,              // registers both tools; false leaves no trace
  "suggest": true,              // the context block and the large-result hint
  "mirrorHostResults": true,    // record host bash/shell results too
  "inject": false,              // include this corpus in prompt-time injection
  "maxBytes": 268435456,        // 256 MiB: files plus the index, together
  "maxCommandBytes": 67108864,  // captured per command before truncation
  "maxFileBytes": 33554432,     // one file past this is stored but not parsed
  "windowLines": 200,           // index window, lines
  "windowBytes": 16384,         // index window, bytes
  "showTokens": 1200,           // cap for one `show` answer
  "timeoutMs": 600000,          // deadline for xerj_run
  "hintLines": 40               // a mirrored result past this queues a hint
}
```

Injection is off by default: a log corpus that always competes for the turn
budget would crowd out the project. `xerj_search` reaches it, `xerj_out` is
the focused path, and `inject: true` opts into automatic retrieval.

#### Failure modes

| Case | Behaviour |
|---|---|
| Disk full or the directory unwritable | Stop capturing, log once, tools report the failure; retrieval and the host shell are unaffected |
| Command times out | Kill the process group, keep the partial output, mark `timedOut` |
| Output over `maxCommandBytes` | Truncate at the cap, append a marker line, mark `truncated` |
| Binary output | Store it, mark `binary: true`, index nothing for that file |
| Manifest missing or corrupt | Rebuild by scanning pairs; exit codes and durations read `null` |
| A killed process leaves `-out.txt.part` | Startup folds a stale partial (older than `cmd.timeoutMs`) into a completed pair, marked `truncated` |
| Two commands in one millisecond | The writer lock bumps the stamp, so stems stay unique |
| Sweep meets a running command | Skip any stem whose `.part` file exists |
| A tool call names an unknown stem | Report the nearest stems by age, never guess |

#### Tests

Unit: stem format and ordering, pairing, manifest round trip and rebuild,
window splitting at both limits, id stability, prune order and cap arithmetic,
redaction of the indexed command string (the raw file keeps what was printed),
`show` range math and token cap, tool argument validation, the suggestion
block's token cost, and a runner that hits its deadline and its byte cap.

Integration, against a real node: a `xerj_run` of a noisy command creates two
files and one index document set; `xerj_out show` returns the exact requested
range; `search` finds a marker line as `cmd/<stem>-out.txt:<line>`; a run past
`cmd.maxBytes` prunes the oldest stem and its documents; `cmd.enabled: false`
creates no directory, registers no tools, and injects nothing; a mirrored host
result is marked truncated and is searchable.

#### Effort

Tier S slice, about three days: `xerj_run`, the files and manifest, `xerj_out
list` and `show`, the sweep, and the context block. No index, so `search` is
absent.

Tier M completion, about five days more (eight total): the windowed index,
`xerj_out search` and `ingest`, mirroring host results, the large-result hint,
and the integration suite.

### Live context distillation design

A session produces knowledge that outlives it: a decision taken, a constraint
the user stated, a convention the code follows. Compaction is not the moment
that knowledge appears, and waiting for it loses most of it. This feature reads
the turn's own prompt and answer after the answer exists, writes the durable
sentences to memory, and retires distilled memories that no longer hold.

It is not compaction: no message is read, reordered, summarised, or removed,
and the window the model sees is untouched.

#### Classification of an item

The class decides whether an item may ever be pruned. Relevance decides nothing:
a decision from last month is true whether or not this turn needed it.

| Class | Examples | Promotion | Retirement |
|---|---|---|---|
| Decision | "use SQLite, not Postgres" | An explicit statement, or a cited artifact | Supersede on contradiction; never on relevance |
| Constraint | "no new runtime dependencies" | Explicit statement, re-asserted facts strengthen it | Supersede; stale when its evidence vanishes |
| Convention | naming, layout, error shape | Two consistent instances, or one explicit statement | Merge near-duplicates, then supersede |
| Fact | "the sweep runs hourly" | Needs a `path:line` or tool-result citation | Stale when the path or symbol disappears |
| Preference | "terse replies, no check-ins" | Explicit user statement only, `user` namespace | Supersede only |
| Task state | current goal, open question | Session-scoped, short TTL | Expire at the end of the session |
| Observation | command output, a stack trace | Never stored here; the archive and index hold it | Not applicable |

#### Judges

One write path, three judges, chosen by `memory.distill.judge`.

- **`heuristic`** (shipped): a local filter. It strips fenced code, splits the
  turn into sentences, rejects questions, hedges, plans, and internal markers,
  and matches one cue set per class. A `path:line`, a config key, or a version
  adds 0.08 to the score; `memory.distill.minConfidence` (55) is the floor and
  `memory.distill.maxPerTurn` (3) the cap. No network, no model, no cost.
- **`model`** (shipped): the same candidates go to the host's model, one call
  each up to `memory.distill.modelMaxCalls` (3), with the turn clipped to
  `modelContextChars` (1200) and a `modelTimeoutMs` (4 s) deadline. The model
  answers a JSON verdict (`keep`, `kind`, `score`). An unusable answer, a
  timeout, a missing host model, or a candidate past the call cap keeps the
  heuristic verdict, so a transient failure never loses a memory.
- **`local`** (shipped): the downloaded jevos v5 OpenVINO INT8 model on the
  CPU, with no endpoint and no network after the install. `src/jev/` owns the
  whole lifetime: `release.ts` (asset names and `SHA256SUMS.txt`), `manager.ts`
  (verified download of `bin/` and `model/`, staged and renamed), `supervisor.ts`
  (one loopback server, attach, idle stop), and `judge.ts` (the request). The
  install is shared by every project in the installation under
  `<data root>/jev/`; the download starts in the background from `setup` so a
  turn never waits for it, and the judge falls back to the heuristic until it
  answers.

All three write the same metadata: `source: distill:<judge>`, `confidence`, `origin`
(prompt or answer), `topic`, and the session id. The id is the text hash, so a
repeated turn is idempotent.

#### The local judge (jevos)

The reason for a downloaded model is portability: `model` needs a host model,
which not every install has, and a hosted endpoint costs money and sends the
turn off the machine. jevos answers yes/no questions on the CPU, so the plugin
can offer a third route that is local, free, and works offline after one
install.

**Install and lifetime.** `<data root>/jev/<version>-<target>/` holds `bin/`
(the binary with its OpenVINO and TBB shared libraries) and `model/`
(`model.json`, `openvino_model.xml`, `openvino_model.bin`, `tokenizer.gguf`).
`JevosManager.ensure()` downloads the release binary (about 27 MB) and the
OpenVINO INT8 model (about 630 MB), checks both against the tag's
`SHA256SUMS.txt`, extracts into a `.partial-<pid>` sibling, probes the binary
(running it prints usage and exits 2), and renames the tree into place. A
failed install removes the partial, keeps the old tree, logs once, and leaves
the heuristic running. The 630 MB hash streams rather than loading the file.

`JevosSupervisor` starts one server per installation on `local.port` (8017 by
default), falling back to the first free port in 8017-8099 when the configured
one belongs to another program. A server already healthy on the port is
attached to instead of a second one; two projects share it, and the first
caller's `--threads` decides the worker count. The server stops after
`local.idleMs` (10 min) with no judgement and restarts on the next one. It
lives under `<data root>/jev/jev.log`, not in any project.

**The judgement.** One `POST /v1/systemone` per candidate, with the sentence as
the state and two questions:

| Id | Type | Asks |
|---|---|---|
| `keep` | `noul` | Is this sentence a lasting project rule or fact, rather than a report of what was just done? |
| `kind` | `choice` | decision, constraint, convention, preference, or fact |

The `noul` probability is the score, and the verdict keeps the candidate when
it clears `local.threshold` (15 by default). The kind replaces the heuristic
class only when the choice confidence clears `local.kindConfidence`.

The keep question is contrastive because the obvious wording failed on real
turns. "Is the sentence a durable fact about the project that will remain
true?" accepted 24 of 40 candidates mined from this project's turn archive,
most of them progress reports ("completed the turn archive", "wrote the
tests", "version 0.7.0"). The contrastive wording keeps 10 of those 40, and
on the labelled set it accepts 7 of 8 memories and cuts report noise from 3 of
10 to 2 of 10. It is a report filter, not a noise filter: the heuristic drops
questions, hedges, and code before a judge sees a candidate.

| Keep wording | Archive kept | Label recall | Reports kept |
|---|---|---|---|
| plain "durable fact" | 24/40 | 7/8 | — |
| contrastive, sentence alone | 10/40 | 7/8 | 2/10 |

The heuristic alone keeps 3 of the 10 labelled reports, so the contrastive
question removes one more. A two-question variant (`durable fact` plus `rule or
decision`) reached 13 of 14 on the labelled set, but still accepted the
archived reports, which is why the contrastive single question replaced it.
The state stays the sentence alone: adding the turn around it lowered every
positive (6 of 8 with the sentence first, 3 of 8 with it last).

**Cost.** Cold server start is about 4.5 s (model load), the first judgement
adds about 1.6 s, and later judgements take about 190 ms on four threads. The
resident set stays in the low hundreds of megabytes.

**Failure modes.** An unsupported platform (anything but Linux x64, macOS
arm64, Windows x64), a failed or offline install, a server that does not answer
within `local.startupTimeoutMs`, and a judgement past `local.timeoutMs` all
leave the heuristic result in place. The caller's `calls < modelMaxCalls` cap
applies to the local judge too, so at most three candidates per turn pay for a
request.

#### Retirement

Retirement is by evidence and budget, in this order: a distilled memory whose
cited path or symbol is gone is marked stale; a duplicate is flagged by curation;
past `memory.distill.maxPerProject` (200) the lowest-confidence, oldest
distilled memories are removed. Explicit memories are never touched, and a
distilled memory is never removed because a retrieval did not select it.

#### Telemetry: cost and effect

Each judge is measured separately, so the expensive route can be judged on
evidence.

| Record | Carries | Answers |
|---|---|---|
| `memory.distill` (`phase: extract`) | `judge`, `candidates`, `promoted`, `duplicates`, `rejected`, `calls`, `chars`, duration | What did the judge cost, and how many memories did it produce |
| `memory.distill` (`phase: retire`) | `retired`, duration | What did the sweep remove |
| `memory.recall` | `hits`, `distilled` | How many recalled memories came from distillation |

`xerj_telemetry op=memory.distill` and `op=memory.recall` report the counts and
durations; the report adds one line, `distilled N memories (heuristic A, model
B, local C) · recalled R`, which is the effectiveness pair: promoted against
recalled. A judge is worth keeping when its `promoted` is useful and its recall
share is non-zero.

#### Tests

Heuristic: decisions, constraints, conventions, preferences, and cited facts
are accepted; questions, hedges, plans, and fenced code are rejected; priority
runs decision before constraint; a sentence repeated across prompt and answer
counts once; `maxPerTurn` and `minConfidence` bind. Model seam: an absent model
falls back with the label it actually used; a supplied judge can reject. Local
judge: the larger of the two probabilities decides, a low-confidence choice
keeps the heuristic kind, a missing probability or an HTTP failure rejects so
the caller falls back, and the request carries the sentence alone with both
questions. Manager: an incomplete install is not mistaken for one, a broken
pre-installed path explains itself, and a failed install leaves no partial
tree. Supervisor: a healthy port is attached to without an install, a failing
install cools down instead of retrying on every turn, and `stop` clears the
URL. Capture:
a short turn still distills. Retirement: the lowest-confidence oldest go first
and explicit memories are never in the set. Telemetry: the distill and recall
records sum into the report block.

#### Effort

Heuristic, retirement, telemetry, and tests: about four hours, shipped. The
model judge adds about half a day and is shipped with a per-turn call cap, a
turn clip, and a timeout; the precision measurement against the heuristic on a
labeled set is still pending, which is what would justify making it the
default.

## Tier L: three to six weeks, high to medium suitability

| Item | Source | What it does | Risk | Gate |
|---|---|---|---|---|
| LSP pool | AFT | Per-language server with cached downloads; definitions, references, call hierarchy, diagnostics | Process leaks, resident memory, supply chain | `analysis.lsp.enabled` |
| Server installer | AFT `lsp-auto-install` | Pinned, checksummed install of a missing server into the data root | Disk use, failed installs offline | `analysis.lsp.enabled` with `autoInstall` |
| `xerj_callers`, `xerj_impact` | AFT callgraph | Real callers via `prepareCallHierarchy` | Depends on the pool; per-language coverage varies | `analysis.lsp.enabled` |
| `xerj_inspect` | AFT inspect | Diagnostics, unused exports, dead code, TODOs | Accuracy varies by language; must report confidence | `analysis.lsp.enabled`; `analysis.treeSitter.enabled` for the full result |
| `xerj_share` | XERJ engine | Read-only link with passcode and expiry | Opens a listener; the tool prints the address and expiry before it answers anyone | `share.enabled` |

## Tier XL: more than six weeks

| Item | Source | What it does | Gate | Precondition |
|---|---|---|---|---|
| Dreamer child sessions | Magic Context | Idle-time curation, doc maintenance, primer refresh | `memory.curate` | Memory curation shipped and stable |
| Notes and smart notes | Magic Context | Deferred intentions with surface conditions | `context.notes` | A scheduler the plugin does not have yet |

## Deliberate non-goals

| Not doing | Why |
|---|---|
| Desktop app | A separate binary over another plugin's database; not a plugin feature |
| Installing a language toolchain (Go, Rust, LLVM) | The compiler and sysroot belong to the project and are assumed to be there. The plugin installs the server, never the toolchain, and never gates a language on the toolchain's presence |
| Bash detach, wait, notifications | The host owns the shell; a second one competes with it |
| Silent field reports | Sends data outward; opt-in at most, never automatic. Local telemetry is the opposite: bounded files under the XERJ data root, no network path, and an off switch |
| Bundling grammars in the npm package | 50 to 100 MB and a per-platform native build matrix |
| Enabling `analysis.*` by default | The gate exists so an install that wants retrieval pays nothing for a parser or a server |
| A gate that silently widens | A gate covers one capability and one key; no key controls two capabilities, and no build flag changes what is registered |
| Edit family: symbol edit, import write, move, delete, checkpoints, conflict resolution, AST replace | A plugin that writes can lose work: a partial write, a wrong range, or a concurrent writer is unrecoverable, and a checkpoint stack beside git gives two recovery stories that disagree. The benefit is real for one feature (bulk AST replace) and the read-only routes cover the rest: `xerj_zoom` supplies exact text for the host's `edit`, `xerj_refs` shows every site first, and `ast-grep` search lists matches for the model to edit |
| Compaction engine: compartments, `ctx_reduce`, `/ctx-recomp`, cache-TTL mutation scheduling | The host already compacts. Rewriting messages duplicates that work, thrashes the prompt cache, and carries the plan's highest data risk for no retrieval gain. Revisit only if the host exposes a compaction API a plugin may drive |
| Rewriting `read` or `grep` inputs | Silent semantic changes break debugging |

## Risks and their handling

| Risk | Handling |
|---|---|
| Language server processes leak | One pool per project, pidfile, idle stop, and a test that asserts no process survives teardown. This plugin has leaked processes before; the check is mandatory |
| Grammar cache corrupts | Verify against a checksum before use, as the binary path does; a bad grammar is a logged skip, not a crash |
| Host compaction hides an injected passage | The dedupe set resets on `session.compaction.ended`, so the next turn may re-inject what the summary dropped |
| The turn archive grows without bound | `context.archive.maxBytes` (64 MB) prunes oldest turns at startup, and the panel reports the size |
| Command output fills the disk | `cmd.maxBytes` (256 MiB) bounds the files and the index together, and the sweep deletes oldest complete stems first, files and documents together |
| `xerj_run` becomes a privilege path | One foreground command with a deadline and a byte cap, no pty, no detach, no session; it writes only under the plugin's own state and never a project file |
| A log contains a secret and is indexed | The raw files are 0600 under a 0700 directory and stay on this machine; the indexed command string and body pass through the same redaction as the web spool, and the tool description says the raw files are not redacted |
| Command history bloats every prompt | The corpus joins prompt-time injection only with `cmd.inject`; by default just the short instruction block and one hint line enter the prompt |
| An archive surprises a user | It is local, mode 0700, inside the project's own `.xerj`, and `context.archive.enabled: false` removes it |
| Retrieval slows down | Every new query path is measured against the 400 ms budget; a path that misses it becomes a tool, not an injection |
| Scope creep | One plugin owning search, analysis, archive, and memory is large; each tier lands as a release with its own coverage gate |
| A gate opens without a decision | Gates default to closed, an upgrade never turns one on, and the panel prints the key that is closed |
| A gate is open but its toolchain is missing | No preflight check. The server loads or installs anyway, and the first query that needs the compiler reports that server's own error for that language alone |
| A server loads but cannot answer | One error per language, cached for the session, and the panel names it; other languages keep answering |
| A gated tool leaks memory or processes | The LSP pool has an idle stop and a server cap; a test asserts zero surviving processes after teardown |
| An installed server is compromised | Pinned version and checksum, `--ignore-scripts` on npm installs, and a `--version` probe before first use |
| Installed servers fill the disk | Measured at about 26 MB for the npm set; the panel reports each install and a cache purge removes them |
| CPU affinity is silently ignored | A missing `taskset`, a restrictive cpuset, or macOS logs one warning and leaves the process unpinned; indexing and retrieval never depend on the key |
| Telemetry slows the turns it measures | Records go to an in-memory queue that a timer drains; `span` never awaits a write, a full queue drops, and the performance gate compares retrieval p50/p95 with telemetry off and on |
| The telemetry store fills the disk | `telemetry.maxBytes` (128 MiB) bounds the directory, the sweep runs every ten minutes, and the defaults stay well under it: about 42 MiB for ops and rings, plus about 1.3 MB of samples a day |
| Sampling costs more than it measures | One `/proc` read on Linux, one cheap `ps` spawn per sample on macOS and the BSDs, and nothing on Windows; `telemetry.sampleMs: 0` turns sampling off without touching the rest of the store |
| Telemetry captures private text | `meta` is a fixed set of scalar fields, error messages are never recorded, and caller text is clipped at `telemetry.maxText` (160) and passed through `redact()` first; prompts and file bodies are never recorded |
| Two instances corrupt the rings | Appends are atomic under O_APPEND; only the lock owner rewrites a file, and a stale lock is taken over after 60 s |
| A crash is miscounted as a clean stop, or twice | The marker is removed on every teardown path, an idle stop is recorded as `idle` and not as a crash, and node crashes are deduped by pid and pidfile mtime |
| The badge says `ready` while work is running | Every long job registers in one reference-counted registry: corpus runs, embeddings, docs runs, and installs; a test asserts `busy` for each |
| The badge sticks on `busy` after a leaked job | Each kind has a deadline, and a job past it stops counting toward the state and warns once |
| A leftover crash marker blocks startup | The marker is read after setup has registered its tools, never before; a read failure is a warning and a fresh marker |

## Sequencing and gates

1. **Tier S**, as one release. Gate: 85% coverage or better, live check that
   each new tool answers on this repository. Nothing in this tier reads a
   capability gate, so it ships with every gate closed. It starts with the
   dedupe reset, because that is a defect in shipped behaviour.
2. **Tier M**, in two releases: analysis without a parser first, then
   tree-sitter for one language. Gate: the capability ships closed, the
   download path is verified with the gate open, and the incremental pass
   time is unchanged with it closed.
3. **Tier L**, one language at a time. Gate: a week of live use with no
   process count growth, a test that a closed gate starts no server, and an
   install proven offline (it fails once, names the package, and leaves every
   other language working).
4. **Tier XL**, curation depth and notes. Gate: curation proven by a dry run
   that names what it would change before it changes anything.
5. Every tier ships with its gates closed by default, and the release notes
   name each key. Opening a gate is the user's decision per project, not a
   default that arrives with an upgrade.
6. Every tier keeps the two rules this plugin already follows: nothing
   blocks `setup`, and every failure is visible in the panel.

## Progress

Updated 2026-11-06. Times are estimates from the work as it was done, not
measured; they include tests and the commits that carry them. A status of
"done" means it is on `main` and the suite is green.

| Item | Tier | Status | Time (est.) | Evidence |
|---|---|---|---|---|
| Reset the injection dedupe on compaction | S | Done | 0.5 h | `165af5c`; three hook tests |
| `/xerj-wrapup` | S | Done | 0.5 h | `ea98e68`; `Lifecycle.latestSession` |
| `xerj_refs` | S | Done | 1.0 h | `5a42bae`; service, tool, six tool tests |
| `xerj_outline` | S | Done | 0.5 h | `5a42bae`; ordered by line |
| `xerj_zoom` | S | Done | 0.5 h | `5a42bae`; symbol-hit line mapping |
| Commit indexing | S | Done | 2.5 h | `7336268`; `index/commits.ts`, 4 tests, `index.git*` |
| Memory verification | S | Done | 1.5 h | `baac28d`; `memory/verify.ts`, 10 tests, panel count |
| Auto-search hint | S | Done | 1.0 h | `search({ hint: true })` skips the word gate with a 150 ms deadline; one `<xerj-hint>` line naming the candidate; three hook tests |
| Memory curation | S | Done | 1.0 h | `memory/curate.ts`: exact duplicate summaries dropped, other repeats flagged `duplicateOf`, never deleted; seven tests |
| Sidebar rebuild | S | Done | 3.0 h | Bordered box with a `▼ XERJ` badge header and version, `onMouseDown` collapse, three rows when collapsed and five sections when expanded, `⚠` line for an error or warning, 150 ms refresh debounce, prefs under key `xerj` in the shared file with other plugins' keys preserved (read once at setup, so no file watcher and no echo guard is needed); ten prefs tests, five view tests, two render tests |
| `autoindex map` in the panel | S | Done | 0.5 h | Record kinds from a `terms` aggregation, shown as `records: function 545 · section 401`; four panel tests |
| `prjdocs` keyword surfacing | S | Done | 0.2 h | `config.prjdocsKeywords` in the status, a panel line, and the command description |
| Config example formatting | S | Done | 0.5 h | README block is one key per line with comments; `test/unit/config-example.test.ts` compares every flattened key and value with `DEFAULT_CONFIG`; `plan.md` §3 is a readable subset that points at the README for the full set |
| CPU affinity (`node.cpus`) | S | Done | 1.5 h | `src/node/priority.ts` parses lists, ranges, `odd`, `even`, and percentages; resolves against `/proc/self/status` on Linux; applies `taskset -a -pc`, `ProcessorAffinity`, or one macOS warning; wired into node, watcher, and brain spawns; 29 unit tests |
| Local telemetry | S | Done | 12.0 h | `src/telemetry/{types,store,state,sampler,lifecycle,boot-clock}.ts`: closed `OpType`/`JobKind` set, op log with rotation, per-type rings, per-day rollups, `samples/<date>.ndjson`, owner-only compaction, 128 MiB sweep, boot/crash/restart records, five-state service model, idle/busy split. Tools and RPC are wrapped generically at registration; `src/redact.ts` holds the shared scrubber. `xerj_telemetry` reports it, and the panel and sidebar show the state plus CPU/RSS peak and growth. Four new unit suites (37 tests); 1067 unit tests pass |
| Graph overview in the panel | M | Done (earlier) | 0 h this pass | Brains already report docs and live edges; the corpora list covers the rest |
| Import graph and cycles | M | Done | 2.0 h | `analysis/imports.ts` plus `xerj_imports`; relative, Python, Go, and Rust specifiers resolve against project files, unresolved ones are counted; ten module tests and four tool tests |
| Regex and glob search | M | Done | 1.5 h | `analysis/find.ts` plus `xerj_find`: glob-to-regex with `**` spanning folders, line-numbered matches, secret files skipped, 200-match cap; ten module tests and three tool tests |
| Structural search (`ast-grep`, read only) | M | Done | 1.0 h | `analysis/ast.ts` plus `xerj_ast`: probes the binary, passes the pattern and glob as arguments, parses `--json=stream`, never rewrites; seven module tests and one tool test |
| tree-sitter layer, one language | M | Not started | — | Grammar source settled (the pinned `tree-sitter-wasms` pack); work deferred by the user, gate remains closed |
| Complexity and duplicates | M | Not started | — | Needs the tree-sitter layer |
| `xerj_code` | M | Not started | — | The engine has `corpus add/own/build/index/list`; `add` clones a git URL, so this needs network consent and belongs behind a gate like `hub` rather than in an always-on tool |
| `xerj_ask` and hub packs | M | Not started | — | Gated by `hub.enabled`, `hub.network` |
| Turn archive | M | Done | 1.5 h | `archive/turns.ts`: one NDJSON file per session under `<node dir>/archive`, 4 KB per turn, oldest half dropped past `context.archive.maxBytes`; prompts and answers both archived; eight module tests |
| `xerj_expand` | M | Done | 0.5 h | Prints `[n] U:`/`[n] A:` for a turn range, or says the archive is off; wired for the plugin and the MCP server |
| Pre-compaction window archive | M | Done | 1.5 h | `archive/window.ts` flattens text and tool-result bodies from the newest messages (40 or about 200 KB, whichever binds first) into the turn archive behind a `system` marker; media, reasoning, and compaction parts are skipped, message ids are deduped against retries, and only this instance's sessions are captured. Roles gained `tool` and `system`, and `xerj_expand` labels them `T` and `S`. Eleven module tests |
| Fact mining from the compaction window | M | Not started | — | Deferred by the user. Two routes: a heuristic pass over the same window (patterns for decisions, constraints, config keys, commands that worked) at about 2 h, or one model call bounded by a token budget at about 3 to 4 h. Needs a precision measurement before it defaults on, a `derived` memory kind, and reuse of the stale flag; gated by `memory.extract`, off by default |
| Post-compaction rehydration | M | Done | 2.0 h | `src/rehydrate.ts` builds the block from the three newest citations, re-reading a 24-line window inside the project root and capping the result at `context.rehydrateTokens` (600); `session.compaction.ended` snapshots the working set, the `model.request` hook suppresses the summariser's own call, and a fresh retrieval with hits supersedes the recall. Ten module tests and six hook tests |
| History search | M | Done | 1.0 h | `archive/index.ts` bulk-loads one document per turn into `<prefix>-archive-docs`, idempotent by session and ordinal, with a manifest so a pruned turn leaves the index; the archive is now a search prefix and its own dataset row; five module tests |
| Live context distillation | M | Done | 10.0 h | `src/memory/distill.ts`: five classes, heuristic and model judges behind one write path, idempotent promotion with `source: distill:<judge>` and `confidence`, budget retirement, `memory.distill`/`memory.recall` telemetry with a report line and per-judge calls/chars. The model judge caps calls per turn, clips the turn, times out, and falls back. 16 distill tests, a capture test, config tests, and a report test. A golden set of 8 labeled memory sentences plus 7 sentences that must never be promoted: 8/8 recalled and classified, 0 false positives. The measurement harness is `bun run eval:distill` (heuristic always, local with `DISTILL_EVAL_JEVOS_URL`, model with an explicit OpenAI-compatible endpoint); the model delta is not yet recorded. The local jevos judge (`src/jev/`): checksum-verified install of the binary and the 630 MB model, one shared loopback server with attach and idle stop, a contrastive keep question at 7/8 recall on the labeled set and 2/10 report noise (from 3/10), and a heuristic fallback on every failure path. 21 new unit tests across release, judge, manager, and supervisor, plus an end-to-end install run against the real assets |
| Command output management | M | Done | 5.0 h | `src/cmd/{store,runner,corpus,service}.ts` plus `xerj_run` and `xerj_out`: two files per command under `.xerj/cmd/`, a manifest for exit codes, windowed plain-text index, debounced ingest, two caps (256 MiB files, 32 MiB index), host-result mirroring, the context block and the large-result hint. 21 unit tests across three suites and 2 integration tests; 1101 unit tests pass |
| LSP pool | L | Not started | — | Gated by `analysis.lsp.enabled` |
| Server installer | L | Not started | — | — |
| `xerj_callers`, `xerj_impact` | L | Not started | — | Needs the pool |
| `xerj_inspect` | L | Not started | — | Needs LSP and tree-sitter |
| `xerj_share` | L | Not started | — | Gated by `share.enabled` |
| Dreamer child sessions | XL | Not started | — | — |
| Notes and smart notes | XL | Not started | — | — |

**Tier S: fourteen of fifteen shipped, 14.9 h** against an 8 to 10 h
estimate. Two items landed on 2026-11-06 after the first twelve shipped: the
config example formatting (0.5 h) and `node.cpus` (1.5 h). The sidebar took
3 h against an 8 h plan; the overshoot is in the other items. The fifteenth,
local telemetry, is designed and not started.

Per-item estimates held within about half an hour except commit indexing, where
the `git log` record layout cost an extra hour and a half, and the auto-search
hint, where the dedupe test had to distinguish the hint pass from the retrieval
pass.

Tier M so far: **11.0 h** across eight items this pass, nine of fourteen with
the graph overview that predates it. Remaining, all deferred or gated: the
tree-sitter layer and the complexity work it enables (grammar source settled,
work deferred), fact mining (deferred by the user, gated by
`memory.extract`), `xerj_code` (needs a network gate, since `corpus add`
clones), and `xerj_ask` (gated by `hub.enabled` and `hub.network`).

## Settled decisions

No decision blocks work. Each one has a default that changes nothing until a
user asks for it:

| Question | Settled as |
|---|---|
| Who compacts? | The host. The plugin keeps a turn archive so its own recall survives compaction |
| Does the plugin write files? | No. It stays read-only: it locates and explains, the host and the model write |
| May a tool open a listener? | Only with `share.enabled: true`. Off by default, and the address and expiry are printed before anyone can reach it |
| May a tool reach the network? | Only with `hub.enabled` and `hub.network`. Off by default, and cached packs still answer while the network stays closed |
