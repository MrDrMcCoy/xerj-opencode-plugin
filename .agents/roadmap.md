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
   prompt cache. This plugin therefore keeps its own append-only archive of
   raw turns and reads the host's summary from `session.compaction.ended`,
   which it already subscribes to. Expand and history search work over the
   archive; nothing here rewrites a message.
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
   writing, so a bug here can cost a bad citation but not a file.
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
      "hub": { "enabled": false, "network": false }
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

Defaults are closed because each capability adds something a retrieval plugin
should not impose on its own: 52 to 100 MB of grammars, a process holding
hundreds of megabytes, an open port, or traffic to a remote catalogue. The
plugin's contract is that nothing blocks `setup`, and a closed gate keeps
that true.

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

Ship these first. None adds a runtime, a grammar, or a write path.

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
| **CPU affinity (`node.cpus`)** | This plugin | Confine every XERJ process to a chosen CPU set: explicit indices and inclusive ranges, `odd`, `even`, or a percentage of the CPUs available to the process, rounded down | `node.cpus: "0-3,8"` confines the node and every index run on Linux, `"50%"` resolves against the available CPU count, and an unset value or an unsupported platform behaves as it does today |

### CPU affinity value syntax

`node.cpus` takes one string:

- `"0-3,8,10-11"` uses those logical CPUs; ranges are inclusive.
- `"odd"` and `"even"` take every CPU in the plugin's affinity mask whose index
  is odd or even.
- `"50%"` takes the lowest-numbered `floor(50% * available)` CPUs, at least
  one, where `available` counts the CPUs in the plugin's own affinity mask.
- `null` (the default) or `"all"` makes no affinity change.

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
| Silent field reports | Sends data outward; opt-in at most, never automatic |
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
| Pre-compaction window archive | M | Not started | — | Deferred by the user. The `compaction` hook receives `event.messages` before the summary exists; flattening the text parts into the existing archive keeps tool output that a summary compresses away. Design is fixed: last N messages or about 200 KB, whichever comes first, deduped by message id against compaction retries, media parts skipped, and a marker so `xerj_expand` shows where the captured block starts |
| Fact mining from the compaction window | M | Not started | — | Deferred by the user. Two routes: a heuristic pass over the same window (patterns for decisions, constraints, config keys, commands that worked) at about 2 h, or one model call bounded by a token budget at about 3 to 4 h. Needs a precision measurement before it defaults on, a `derived` memory kind, and reuse of the stale flag; gated by `memory.extract`, off by default |
| Post-compaction rehydration | M | Done | 2.0 h | `src/rehydrate.ts` builds the block from the three newest citations, re-reading a 24-line window inside the project root and capping the result at `context.rehydrateTokens` (600); `session.compaction.ended` snapshots the working set, the `model.request` hook suppresses the summariser's own call, and a fresh retrieval with hits supersedes the recall. Ten module tests and six hook tests |
| History search | M | Done | 1.0 h | `archive/index.ts` bulk-loads one document per turn into `<prefix>-archive-docs`, idempotent by session and ordinal, with a manifest so a pruned turn leaves the index; the archive is now a search prefix and its own dataset row; five module tests |
| LSP pool | L | Not started | — | Gated by `analysis.lsp.enabled` |
| Server installer | L | Not started | — | — |
| `xerj_callers`, `xerj_impact` | L | Not started | — | Needs the pool |
| `xerj_inspect` | L | Not started | — | Needs LSP and tree-sitter |
| `xerj_share` | L | Not started | — | Gated by `share.enabled` |
| Dreamer child sessions | XL | Not started | — | — |
| Notes and smart notes | XL | Not started | — | — |

**Tier S complete: fourteen of fourteen, 14.9 h** against an 8 to 10 h
estimate. Two items landed on 2026-11-06 after the first twelve shipped: the
config example formatting (0.5 h) and `node.cpus` (1.5 h). The sidebar took
3 h against an 8 h plan; the overshoot is in the other items.

Per-item estimates held within about half an hour except commit indexing, where
the `git log` record layout cost an extra hour and a half, and the auto-search
hint, where the dedupe test had to distinguish the hint pass from the retrieval
pass.

Tier M so far: **9.5 h** across seven items this pass, eight of fourteen with
the graph overview that predates it. Remaining, all deferred or gated: the
tree-sitter layer and the complexity work it enables (grammar source settled,
work deferred), the pre-compaction window archive and fact mining (both
deferred by the user), `xerj_code` (needs a network gate, since `corpus add`
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
