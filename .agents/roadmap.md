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
5. **No silent outbound traffic.** Anything that leaves the machine,
   including the engine's own field report, is opt-in and off by default.

## Capability gates

Two candidates add a parser and a resident process. Both are off by default
and both are opt-in per project, so an install that wants only retrieval
behaves exactly as it does today. A gate is a configuration setting, not a
build flag: the same published package carries the capability.

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
        },
        "edits": { "enabled": false }
      }
    }
  }]
}
```

| Key | Default | Effect |
|---|---|---|
| `analysis.treeSitter.enabled` | `false` | Parse project files for symbol ranges, complexity, duplicates, and structural search |
| `analysis.treeSitter.languages` | `[]` | Grammars to download. Empty means the languages detection already found |
| `analysis.treeSitter.maxParseBytes` | 1 MiB | Files above this are skipped, so a bundled asset is never parsed |
| `analysis.lsp.enabled` | `false` | Start language servers for definitions, references, call hierarchy, diagnostics |
| `analysis.lsp.servers` | `{}` | Command per language. Empty means the toolchain already installed in the project |
| `analysis.lsp.idleMs` | 5 min | Stop a server that answered nothing for this long |
| `analysis.lsp.maxServers` | 2 | Cap concurrent servers, so one project cannot fill memory |
| `analysis.lsp.timeoutMs` | 2 s | Per-request deadline; a miss returns no result rather than delaying a turn |
| `analysis.edits.enabled` | `false` | Writes. Requires checkpoints, and requires one of the two gates above |

Defaults are closed because each capability adds weight a retrieval plugin
should not impose: 52 to 100 MB of grammars, or a process holding hundreds of
megabytes. The plugin's contract is that nothing blocks `setup`, and a closed
gate keeps that true.

### Behaviour when a gate is closed

| Capability | Needs | Closed |
|---|---|---|
| `xerj_refs`, `xerj_outline`, `xerj_zoom` | Index only | Available: these never need a gate |
| Import graph, cycles | Index only | Available |
| `xerj_complexity`, structural search | tree-sitter | Tool not registered |
| `xerj_callers`, `xerj_impact` | LSP | Tool not registered |
| `xerj_inspect` | LSP, tree-sitter | Registered with the index-only part (TODOs); diagnostics and unused exports are omitted and named as gated |
| Edit family | tree-sitter or LSP, plus edits | Tool not registered |
| Retrieval, injection, memory, docs corpora | Nothing gated | Identical with every gate closed |

Five rules make the gates trustworthy:

1. A tool whose gate is closed is never registered, so it costs no prompt
   tokens and cannot fail in the middle of a turn.
2. No retrieval path depends on a gated capability. With every gate closed,
   injection output is byte-identical to today's.
3. Status and the panel name each gate and the key that opens it.
4. Opening a gate downloads what it needs on first use, verified by checksum,
   and the download is visible in the panel rather than a silent wait.
5. A closed gate leaves no residue: no process, no cached parse, no file read
   beyond the project scan the index already performs.

Tier XL adds gates of its own, closed the same way: `memory.curate` for the
dreamer's memory work and `context.notes` for notes and smart notes. They
follow the same five rules.

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

## Tier M: one to three weeks, high suitability

| Item | Source | What it does | Prerequisite | Gate |
|---|---|---|---|---|
| Import graph and cycles | AFT inspect | Parse import lines from indexed text, report cycles | None | None: index only |
| Regex and glob search | AFT search | Literal and pattern search over project files | A local matcher; the engine has no regex query | None |
| tree-sitter layer, one language | AFT | Lazy grammar download, per-file cache, symbol ranges | TypeScript first | `analysis.treeSitter.enabled` |
| Complexity and duplicates | AFT inspect | Node counts per function, structural hashing | The tree-sitter layer | `analysis.treeSitter.enabled` |
| `xerj_code` | XERJ engine | Retrieval over reference corpora (`corpus add/index/list`) | A corpus lifecycle view in the panel | None |
| `xerj_ask` and hub packs | XERJ engine | Answers from signed pre-indexed packs, with licence and pin named | Cached catalogue | None; network consent is asked on first use |
| Graph overview in the panel | XERJ engine | Edge totals, hubs, detectors per brain | None; the endpoint is already used | None |
| Turn archive | Magic Context, reduced | Append raw turns to `<project>/.xerj`, pruned by `context.archive.maxBytes` | Retention sweep at startup | `context.archive.enabled`, on by default |
| `xerj_expand` | Magic Context, reduced | Return the original `U:`/`A:` text for an archive range | The archive | `context.archive.enabled` |
| History search | Magic Context, reduced | `xerj_search` over archived turns as an extra corpus | A second index prefix | `context.archive.enabled` |

## Tier L: three to six weeks, high to medium suitability

| Item | Source | What it does | Risk | Gate |
|---|---|---|---|---|
| LSP pool | AFT | Per-language server from the project's own toolchain; definitions, references, call hierarchy, diagnostics | Process leaks, resident memory, missing servers | `analysis.lsp.enabled` |
| `xerj_callers`, `xerj_impact` | AFT callgraph | Real callers via `prepareCallHierarchy` | Depends on the pool; per-language coverage varies | `analysis.lsp.enabled` |
| `xerj_inspect` | AFT inspect | Diagnostics, unused exports, dead code, TODOs | Accuracy varies by language; must report confidence | `analysis.lsp.enabled`; `analysis.treeSitter.enabled` for the full result |
| `xerj_share` | XERJ engine | Read-only link with passcode and expiry | Opens a listener; off by default, explicit consent | None; consent is per invocation |

## Tier XL: more than six weeks

| Item | Source | What it does | Gate | Precondition |
|---|---|---|---|---|
| Edit family: `xerj_edit`, `xerj_import`, `xerj_move`, `xerj_safety`, `xerj_conflicts` | AFT | Symbol-bounded edits, import management, moves, checkpoints, conflict resolution | `analysis.edits.enabled`, plus one of the two above | Checkpoints and undo must exist and be tested before any write ships |
| Dreamer child sessions | Magic Context | Idle-time curation, doc maintenance, primer refresh | `memory.curate` | Memory curation shipped and stable |
| Notes and smart notes | Magic Context | Deferred intentions with surface conditions | `context.notes` | A scheduler the plugin does not have yet |

## Deliberate non-goals

| Not doing | Why |
|---|---|
| Desktop app | A separate binary over another plugin's database; not a plugin feature |
| LSP auto-install matrix | Six platform targets for language servers duplicates the toolchain the project already has |
| Bash detach, wait, notifications | The host owns the shell; a second one competes with it |
| Silent field reports | Sends data outward; opt-in at most, never automatic |
| Bundling grammars in the npm package | 50 to 100 MB and a per-platform native build matrix |
| Enabling `analysis.*` by default | The gate exists so an install that wants retrieval pays nothing for a parser or a server |
| A gate that silently widens | A gate covers one capability and one key; no key controls two capabilities, and no build flag changes what is registered |
| Compaction engine: compartments, `ctx_reduce`, `/ctx-recomp`, cache-TTL mutation scheduling | The host already compacts. Rewriting messages duplicates that work, thrashes the prompt cache, and carries the plan's highest data risk for no retrieval gain. Revisit only if the host exposes a compaction API a plugin may drive |
| Rewriting `read` or `grep` inputs | Silent semantic changes break debugging |

## Risks and their handling

| Risk | Handling |
|---|---|
| Language server processes leak | One pool per project, pidfile, idle stop, and a test that asserts no process survives teardown. This plugin has leaked processes before; the check is mandatory |
| Grammar cache corrupts | Verify against a checksum before use, as the binary path does; a bad grammar is a logged skip, not a crash |
| Edit tools lose work | No write ships before checkpoints and undo; every write is atomic and reports the backup path |
| Host compaction hides an injected passage | The dedupe set resets on `session.compaction.ended`, so the next turn may re-inject what the summary dropped |
| The turn archive grows without bound | `context.archive.maxBytes` (64 MB) prunes oldest turns at startup, and the panel reports the size |
| An archive surprises a user | It is local, mode 0700, inside the project's own `.xerj`, and `context.archive.enabled: false` removes it |
| Retrieval slows down | Every new query path is measured against the 400 ms budget; a path that misses it becomes a tool, not an injection |
| Scope creep | One plugin owning search, edits, archive, and memory is large; each tier lands as a release with its own coverage gate |
| A gate opens without a decision | Gates default to closed, an upgrade never turns one on, and the panel prints the key that is closed |
| A gate is open but its toolchain is missing | One probe at enable time; a missing server or grammar logs once, names the key, and leaves the capability off rather than retrying per call |
| A gated tool leaks memory or processes | The LSP pool has an idle stop and a server cap; a test asserts zero surviving processes after teardown |

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
   process count growth, and a test that a closed gate starts no server.
4. **Tier XL**, edits and curation. Gate: checkpoints proven by an
   interrupted write before any other write ships, and curation proven by a
   dry run that names what it would change.
5. Every tier ships with its gates closed by default, and the release notes
   name each key. Opening a gate is the user's decision per project, not a
   default that arrives with an upgrade.
6. Every tier keeps the two rules this plugin already follows: nothing
   blocks `setup`, and every failure is visible in the panel.

## Open decisions for the user

Three remain, each with a safe default, so none blocks work:

1. **Share**: allow `xerj_share` at all, given it opens a listener. Default:
   the tool is absent until invoked with consent.
2. **Hub packs**: allow network access for `xerj ask`. Default: offline; the
   first request asks and remembers the answer.
3. **Edits**: whether this plugin writes to files. Default:
   `analysis.edits.enabled` closed, so the plugin stays read-only.

Compaction is no longer an open question. The host keeps it, and this plugin
keeps an archive so its own recall survives it.
