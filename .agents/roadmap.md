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
2. **Compaction replaces, it does not join.** Two plugins rewriting one
   session double-summarise and thrash the prompt cache. Absorbing
   compaction requires uninstalling Magic Context, and the plan treats it
   as a migration with a rollback point.
3. **Grammars are downloaded, not bundled.** Measured: the all-language
   WASM pack is 51.8 MB unpacked, `web-tree-sitter` 4.7 MB, and one
   native TypeScript grammar 38.8 MB. The plugin already owns a verified
   download path for the engine binary; grammars reuse it and live in the
   XERJ data root.
4. **Scope is the project.** Every new runtime reads only files under the
   canonical project root. A path outside it is refused, exactly as the
   indexer refuses one today.
5. **No silent outbound traffic.** Anything that leaves the machine,
   including the engine's own field report, is opt-in and off by default.

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
| `xerj_refs` | AFT callgraph, reduced | Reference count for a symbol from the indexed `code` field, cited as `path:line` | A query returns call sites for `buildTools` with no new process |
| `xerj_outline` | AFT outline | Symbol list for one file from existing records | One call replaces a whole-file read |
| `xerj_zoom` | AFT zoom | One symbol's body by name, with its exact range | Returns the declaration and its lines only |
| Commit indexing | Magic Context | Git log as documents: hash, author, date, subject, body, paths | "why did the sweep change" cites a commit |
| Auto-search hint | Magic Context | One fragment naming the matching file when the gate half-matches | A directive prompt costs one line, not one passage |
| Memory verification | Magic Context | Check memories whose paths, keys, or symbols no longer exist; mark stale, never delete | A memory pointing at a removed file reports stale |
| Memory curation | Magic Context | Merge near-duplicates, archive superseded facts, score by use | The store stops growing with restatements |
| `autoindex map` | XERJ engine | Panel view of what the corpus contains | The panel answers "what do you know" |
| `prjdocs` keyword surfacing | This plugin | Expose `eagerKeywords` in the panel and the command help | A user can add a term without editing JSON |

## Tier M: one to three weeks, high suitability

| Item | Source | What it does | Prerequisite |
|---|---|---|---|
| Import graph and cycles | AFT inspect | Parse import lines from indexed text, report cycles | None |
| Regex and glob search | AFT search | Literal and pattern search over project files | A local matcher; the engine has no regex query |
| tree-sitter layer, one language | AFT | Lazy grammar download, per-file cache, symbol ranges | Constraint 3; TypeScript first |
| Complexity and duplicates | AFT inspect | Node counts per function, structural hashing | The tree-sitter layer |
| `xerj_code` | XERJ engine | Retrieval over reference corpora (`corpus add/index/list`) | A corpus lifecycle view in the panel |
| `xerj_ask` and hub packs | XERJ engine | Answers from signed pre-indexed packs, with licence and pin named | Opt-in, network, cached catalogue |
| Graph overview in the panel | XERJ engine | Edge totals, hubs, detectors per brain | None; the endpoint is already used |

## Tier L: three to six weeks, high to medium suitability

| Item | Source | What it does | Risk |
|---|---|---|---|
| LSP pool | AFT | Per-language server from the project's own toolchain; definitions, references, call hierarchy, diagnostics | Process leaks, resident memory, missing servers |
| `xerj_callers`, `xerj_impact` | AFT callgraph | Real callers via `prepareCallHierarchy` | Depends on the pool; per-language coverage varies |
| `xerj_inspect` | AFT inspect | Diagnostics, unused exports, dead code, TODOs | Accuracy varies by language; must report confidence |
| `xerj_share` | XERJ engine | Read-only link with passcode and expiry | Opens a listener; off by default, explicit consent |

## Tier XL: more than six weeks

| Item | Source | What it does | Gate |
|---|---|---|---|
| Edit family: `xerj_edit`, `xerj_import`, `xerj_move`, `xerj_safety`, `xerj_conflicts` | AFT | Symbol-bounded edits, import management, moves, checkpoints, conflict resolution | Checkpoints and undo must exist and be tested before any write ships |
| Compaction: historian, compartments, `ctx_reduce`/`ctx_expand`, wrapup | Magic Context | Rewrite history into compartments with cache-stable injection | Magic Context uninstalled; a rollback path; cache stability proven over a week |
| Dreamer and historian child sessions | Magic Context | Idle-time curation, doc maintenance, primer refresh | Compaction shipped and stable |
| Notes and smart notes | Magic Context | Deferred intentions with surface conditions | A scheduler the plugin does not have yet |

## Deliberate non-goals

| Not doing | Why |
|---|---|
| Desktop app | A separate binary over another plugin's database; not a plugin feature |
| LSP auto-install matrix | Six platform targets for language servers duplicates the toolchain the project already has |
| Bash detach, wait, notifications | The host owns the shell; a second one competes with it |
| Silent field reports | Sends data outward; opt-in at most, never automatic |
| Bundling grammars in the npm package | 50 to 100 MB and a per-platform native build matrix |
| Rewriting `read` or `grep` inputs | Silent semantic changes break debugging |

## Risks and their handling

| Risk | Handling |
|---|---|
| Language server processes leak | One pool per project, pidfile, idle stop, and a test that asserts no process survives teardown. This plugin has leaked processes before; the check is mandatory |
| Grammar cache corrupts | Verify against a checksum before use, as the binary path does; a bad grammar is a logged skip, not a crash |
| Edit tools lose work | No write ships before checkpoints and undo; every write is atomic and reports the backup path |
| Double compaction | Absorbing compaction starts with uninstalling Magic Context, and the plugin refuses to compact when another compactor is detected |
| Prompt cache thrash | Compaction waits until injection is stable across a week of real sessions |
| Retrieval slows down | Every new query path is measured against the 400 ms budget; a path that misses it becomes a tool, not an injection |
| Scope creep | One plugin owning search, edits, memory, and compaction is large; each tier lands as a release with its own coverage gate |

## Sequencing and gates

1. **Tier S**, as one release. Gate: 85% coverage or better, live check that
   each new tool answers on this repository.
2. **Tier M**, in two releases: analysis without a parser first, then
   tree-sitter for one language. Gate: a grammar download verified on first
   use, and an unchanged incremental pass time.
3. **Tier L**, one language at a time. Gate: a week of live use with no
   process count growth.
4. **Tier XL**, edits before compaction. Gate: checkpoints proven by an
   interrupted write, then compaction with a rollback commit.
5. Every tier keeps the two rules this plugin already follows: nothing
   blocks `setup`, and every failure is visible in the panel.

## Open decisions for the user

1. **Compaction**: absorb it and uninstall Magic Context, or leave compaction
   to Magic Context and keep this plugin to retrieval, memory, and analysis.
2. **Share**: allow `xerj_share` at all, given it opens a listener.
3. **Hub packs**: allow network access for `xerj ask`, or keep the plugin
   entirely offline by default.
4. **Edits**: whether this plugin should write to files, or stay read-only.

Nothing in Tier S or M depends on decisions 1 and 4, so work can start
before they are answered.
