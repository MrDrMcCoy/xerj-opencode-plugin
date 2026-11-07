# Status

Updated: 2026-11-06

## Where things stand

- Project-scoped node lifecycle shipped (unreleased): one node per project
  under `<project>/.xerj/nodes/<prefix>/` by default (or under `storage.root`),
  with a persisted port, pid, log, peer heartbeats and its own engine data dir.
  Port selection uses one spawn lock at `<data root>/nodes/.port-lock`, because
  the managed binary and its default port scan are shared by every project.
  Two runtimes on the same node directory attach to the same pid. The node
  stops when the last recorded session emits `session.deleted`, after
  `node.idleMs` (default 30 min) with no activity, or when this plugin instance
  is torn down — each only when a peer heartbeat with a live session exists.
  Counting running-but-idle instances was a deadlock: every instance deferred
  to the other and none ever stopped. A new session and a session close now
  publish their heartbeat immediately, so two instances cannot both defer on
  stale counts. A dead socket re-ensures the node once and retries, and status
  reports a node another process started. Verified live: spawn, attach (same
  pid), idle stop (no answer), restart on the same port with the index intact
  and the doc still searchable. 245 unit tests pass.
- Plugin state now follows the project node: the autoindex journal, watcher
  ownership and brain state all resolve under the node dir inside the project
  storage root. The engine's `autoindex --watch` refuses a state dir inside the
  watched tree, so project-local storage uses the plugin's own recursive
  watcher and one-shot index runs with a 30 s poll fallback. Ownership is
  claimed before the first pass, so an edit made during a long index is still
  seen; a shared instance polls for ownership and takes over when the owner
  stops, and a one-shot run no longer releases the local watcher's claim.
- Existing projects migrate on setup: data in the old global layout
  (`<data root>/nodes/<prefix>`, `<data root>/spool/<web prefix>`) is moved
  into `<project>/.xerj` once, after stopping any node still running from the
  old tree. An empty target directory left by another part of setup (the spool
  is now constructed after the move) is replaced rather than treated as
  already-migrated. Legacy project memory is copied separately into the node
  data dir when the target is empty. A refused `storage.root` path falls back
  to `.xerj` and is reported in warnings. The peer heartbeat starts after the
  move: its first write creates the node directory, and a non-empty target
  would make the migration treat the empty project tree as already populated.
- A resident watcher killed by a signal used to report `idle` forever, with
  no error and no restart, because every signal exit was treated as our own
  stop. Only a stop this supervisor requested is idle now; a signaled watcher
  is restarted with backoff. Unit test covers a SIGTERM to the resident child.
- Concurrent projects each run their own node. Starting two projects at once
  takes one spawn lock at the data root (per-project locks still let both pick
  the same free port), and attach requires the listening pid to equal this
  project's recorded pid — a project whose port was taken by another node now
  starts elsewhere instead of adopting it. Verified live with two simultaneous
  starts: distinct ports, distinct pids, separate engine data, each corpus
  visible only to its own node; a third project pointing its port file at the
  second node refused to adopt it.
- Plugin storage is one namespace for the whole server, and the plugin loads
  once per open location, and one server can load it twice for one project (the
  repo and a subdirectory). The lifetime ledger and the log ring key on the
  project prefix plus a hash of the location directory
  (`stats/lifetime:<prefix>:<loc>`, `log/ring:<prefix>:<loc>`), so neither the
  project nor the location can overwrite another instance's counters or
  warnings. Each location's panel reports its own usage.
- Legacy memory is migrated on setup. The memory index still lives in the old
  global engine data dir (`<data root>/data/.xerj-memory-…`); `migrateMemoryIndex`
  copies it into the project node's data dir when the destination is empty, and
  stops a running node once so the copied index is enumerated on restart.
  The running instance reports `memory: 0` until 0.5.3 loads.
- Secret handling was hardened after an audit found the external corpus
  holding `/data/ai/opencode/service.json`. Credential files (`service.json`,
  `credentials.json`, `auth.json`, `id_rsa`, `.ssh`/`.aws`/`.docker` trees and
  the existing `.env`/key set) are refused before reading, and redaction now
  covers private key blocks, `AKIA` keys, and `password`/`token`/`secret`
  key-value shapes in JSON, YAML, and TOML. The leaked external index was
  deleted; hidden ingest applies the same filters and redacts bodies.
- M0 is implemented and verified against a real XERJ `v1.0.0-rc.100` binary.
- M1 is implemented and verified live: the project index is built by a
  supervised `autoindex --watch --no-graph` process. Adding a file moved the
  corpus from 304 to 305 records in one pass; deleting it moved it back; the
  generation counter incremented each time. Current index: 304 records,
  ~550 KB, state `watching`, no restarts.
- M2 is implemented and verified live: `xerj_search` and `xerj_def` return
  cited passages. `xerj_def` printed `src/search/service.ts:281 [function]` with
  the declaration. A search for "Reciprocal rank fusion" cited line 280, which
  is the line the comment is on. The ledger counted the query, the
  hit, the returned bytes, and the savings; reading a cited file reduced the
  savings by exactly the bytes read.
- M3 is implemented and verified live: `xerj_remember` stored a decision,
  `xerj_recall` returned it with its kind, a repeated remember reused the same
  id, and `xerj_forget` retracted it. Kind filtering happens in the plugin
  because `/_memory` metadata filters returned zero on every variant tried.
- Prompt-time memory recall is wired next to passage retrieval and deduped per
  session. Like the retrieval injection, it has not been observed in a live
  turn yet.
- The TUI is confirmed live after the restart: `rpcCalls` moved 6 -> 13 with no
  tool traffic in between, so the sidebar and panel reach the server part.
  `injectedTurns` reached 1, so the prompt hook retrieved and the context hook
  spliced a block into a real turn.
- Automatic memory capture from compaction is verified live. A scratch session
  was compacted through `POST /api/session/:id/compact`; the plugin received
  `session.compaction.ended` and stored exactly one `summary` memory
  (`topic: session summary`, the scratch session id, `created` one second after
  the request). Short summaries and repeat events were covered by the unit
  tests, and a stubbed event source against the live node confirmed the
  dedupe and the `summary` kind.
- The npm install's TUI half failed while the server half worked. Cause: the
  published package shipped `src/tui.tsx`, so the host transformed JSX in
  development mode and imported `@opentui/solid/jsx-dev-runtime`, which
  resolved only from the plugin's own `node_modules`; npm skips optional peer
  dependencies, so the import threw and the sidebar never registered. The TUI
  entry is now prebuilt (`bun build --production --packages external` into
  `dist/tui.js`) and imports `@opentui/solid/jsx-runtime`, the specifier the
  host provides to plugins. `prepack` regenerates it.
- The host pins the resolved package version per install epoch: after 0.4.3
  was published the plugin registry still reported `version: 0.4.1`,
  `outdated: true`, and the cache directory was untouched, so a restart keeps
  loading the old build. Purging
  `cache/npm/@mrdrmccoy/xerj-opencode-plugin@latest/` forces a re-resolve.
- Upgrading a TUI plugin's runtime dependencies requires the new install tree:
  the host installs `dependencies` and skips optional peers, so the cache must
  contain `@opentui/solid` before the entry's `jsx-runtime` import can resolve.
- Per-process counters are live: rpc calls, injected turns, node spawns, 429s,
  and index runs, shown in the panel and the status snapshot.
- Brain neighbor expansion was measured. On a fixture brain with a `pathcite`
  edge it found the answer that direct hits missed (0 -> 1). On this repo's
  `.agents` corpus it added nothing in 5 of 5 queries, because the hidden
  corpus already indexes those files. Two bugs surfaced: the ego endpoint
  ignores a comma-joined node list, and a `pathcite` target is a bodyless
  whole-file record.
- The context hooks are confirmed in a live turn: `injectedTurns` counted 1
  without any tool call.
- M4 is implemented and verified live: `xerj_index` fetched `example.com`
  (663 bytes) into the web spool, the web watcher indexed it, and a later
  search returned it at rank 2 with its source line. An external file at
  `/tmp/opencode/external-note.md` was ingested through `_bulk` and became
  searchable under the external index.
- The journal lives at `<node dir>/data/state/<prefix>/`, inside the project
  storage root. The engine's `--watch` refuses a state dir inside the watched
  tree because journal writes would restart the pass forever, so project-local
  storage runs one-shot indexes behind the plugin's own watcher.
- Hidden folders are now indexed. `index.hidden: [".agents"]` walks the folder,
  skips secrets and binaries, and bulks text into `<prefix>-hidden-docs` with
  project-relative paths. Deletions reconcile by id, and a recursive watcher
  with a 30 s poll fallback keeps it current. `.agents` produced 4 documents.
- Files outside the project are indexed when `read` touches them or when any
  `bash` command references them by literal path. The parser takes every
  literal argument of every simple command and keeps those that stat to an
  existing file, so `grep todo a.md` and `./scripts/gen.sh` count like
  `cat a.md`. Short option values, variables, globs, tilde paths, and
  redirection targets are skipped; a simple `cd dir && ...` moves the cwd.
  The ingest runs in the background, skips an unchanged mtime+size, and
  reuses one id per path. A `read`, a `cat`, and a `grep` over probe files
  became searchable without `xerj_index`, and a fetched URL spools the same
  way: the hook returned in 0 ms and the page was searchable after the web
  watcher's next pass.
- Duplicate hidden/brain hits are gone. Brain paths are rewritten to the
  project (`plan.md` becomes `.agents/plan.md`) before line resolution, and a
  hidden whole-file hit is dropped when a brain section covers the same path.
- M5 is implemented: the sidebar follows the RPC `updated` event with a 30 s
  fallback, a `session.panel` claim renders the details view, and `/xerj` plus
  `/xerj-reindex`, `/xerj-remember`, `/xerj-search` cover the commands. The
  server part gained `remember` and `search` RPC methods and the status now
  carries datasets, memory count, top cited files, and recent warnings.
- The TUI was exercised with a stub host: 4 commands registered, 2 slot claims,
  event refresh, panel open, search alert, and remember toast all fired. Actual
  rendering needs a real terminal, which this session cannot observe.
- The panel now has a close affordance. `escape` is bound to a keymap command
  that exists only while this plugin's panel is open, the footer carries a
  clickable `✕ close` box wired to the slot input's `close`, and `/xerj`
  toggles instead of reopening. Five TUI tests cover the location, the client
  swap, the close command's gating, and the toggle.
- The TUI reported "offline" in the sidebar and "waiting for the XERJ server
  part" in the panel while every server-side tool worked. Two faults, both
  failing client-side, so the server logged no request: the sub-client was
  captured once at setup and died with the server restart, and calls omitted
  `context.location`, which the per-location RPC lookup requires. Both fixed in
  0.3.1: the client is read per call, the location is passed per call, the
  event subscription is armed after the first success and re-armed after a
  failure, and the real error text replaces the fixed "not loaded" line.
  Confirmed server-side that the same call returns 400 without a location and
  200 with one; the TUI half needs a reload to pick up the new module.
- M6 brain and anomaly are implemented. `index.brain` builds one graph per
  folder with a one-shot `autoindex --brain` run; status and the panel report
  docs, live edges, and age; brain hits expand one hop through
  `pathcite`/`sequence` edges (two neighbors, 600 chars). `xerj_anomaly`
  creates a stable detector and scores it on demand, returning only flagged
  buckets.
- Verified live: `.agents` produced 28 docs and 33 edges; a search for
  "savings numbers look like marketing" cited `plan.md` and added one
  `[via sequence]` neighbor. A planted 16-bucket CPU series flagged exactly
  minute 12 (actual 96, expected 20.25, z 65.1, score 100).
- Binary management is multi-platform: target triples for Linux (musl or gnu),
  macOS, and Windows; Rosetta shells and x64 Node on Windows ARM64 resolve to
  the native arm64 build; installs live under `bin/<ver>-<target>/`; a
  post-install `--version` probe rejects a binary that cannot exec; and
  `binary.path` bypasses download entirely. Verified on Linux x86_64 with the
  smoke run (install into a temp root) and a fresh-import status check
  (`target: x86_64-unknown-linux-musl`). The server hosting this session still
  holds the previous module (0.1.0), so `xerj_status` here will only show
  `target` after a restart.
- The plugin is live in this OpenCode server: `xerj_status` answers, the node
  auto-starts on 9200, and plugin options arrive intact (nested objects are not
  flattened). Reloading the config re-attached to the running node instead of
  spawning a second one.
- The index root is `ctx.location.project.canonical`, not the session directory:
  a session opened in `.agents/` was deriving
  `xop-agents-<hash>` before the fix.
- `bun test test/unit` passes (236 tests); `tsc --noEmit` is clean.
- `bun test test/integration` passes (9 tests) against a real node: corpus
  membership, `.env` and binary exclusion, deletion and rename reconciliation,
  passage lookup, memory round-trip, namespace isolation, node identity and
  re-attach. It also passes inside podman with `--pids-limit=-1`; the default
  pid cap makes XERJ's scan pool fail with `EAGAIN`.
- CI exists at `.github/workflows/ci.yml`: typecheck plus unit on Ubuntu, and an
  integration job that prefers podman, falls back to docker, then to the bare
  runner.
- Released 2026-11-04: `main` pushed to `github.com:MrDrMcCoy/xerj-opencode-plugin`,
  annotated tags `v0.4.0` and `v0.4.1`, both GitHub releases published. CI ran
  and passed on the first push: both jobs green, and the integration job used
  podman on the hosted runner (`podman info` succeeded), so 9 integration tests
  ran in `docker.io/oven/bun:1.4.4`.
- Published to npm: `@mrdrmccoy/xerj-opencode-plugin@0.4.0`, then `0.4.1` with
  repository, homepage, and issue metadata. `latest` points at 0.4.1, the
  tarball carries 33 files (src plus README and LICENSE), and the package was
  absent from the registry before the first publish.
- Config discovery verified with `opencode debug config`: the global
  `~/.config/opencode/opencode.jsonc` plus the project's `opencode.json`; a
  project `opencode.jsonc` is read only when no `opencode.json` exists.

## Layout

```
src/config.ts          options, defaults, clamping
src/paths.ts           XDG paths, prefix and namespace derivation
src/semver.ts          prerelease-aware comparison (rc.99 < rc.100)
src/platform.ts        release target selection
src/log.ts             durable ring-buffer logger
src/binary/release.ts  asset naming, checksums, release cache
src/binary/detect.ts   host target detection (Rosetta, Windows ARM64)
src/binary/manager.ts  download, verify, extract, upgrade
src/node/client.ts     HTTP client, size parsing
src/node/supervisor.ts probe, spawn, attach, port selection, stop
src/node/runtime.ts    per-project node handle, ensure/detect/stop
src/lifecycle.ts       session and idle tracking, peer heartbeats, shutdown
src/index/corpus.ts    layout, command line, run-document parsing
src/index/watcher.ts   supervised watch process + periodic fallback
src/index/brain.ts     one-shot brain runs, run-document parsing
src/index/hidden.ts    hidden-folder scan, bulk index, deletion reconciliation
src/search/brains.ts   one-hop neighbor expansion for brain hits
src/search/service.ts  two-leg retrieval, RRF, line resolution, formatting
src/stats/ledger.ts    measured savings with partial-read subtraction
src/memory/store.ts    project memory, ids, formatting
src/memory/migrate.ts  legacy memory index migration into the node data dir
src/remote/spool.ts    fetched-page spool, external _bulk ingest, redaction
src/remote/shell.ts    conservative shell-reference path parser
src/hooks/session.ts   prompt retrieval + memory recall + injection
src/tools/search.ts    search, def, memory, index, anomaly, status
src/telemetry/anomaly.ts  stable detectors, scoring, formatting
src/ui/format.ts       sidebar lines and panel sections (pure)
src/rpc.ts             typed RPC contract + status types
src/index.ts           server part
src/tui.tsx            sidebar slot + /xerj commands
scripts/smoke.ts       end-to-end M0 check
test/unit/*.test.ts    pure-function tests
```

## Next actions

1. Restart OpenCode to load the uncommitted-honesty work: a corpus whose index
   vanished reports `missing`, the memory row says `index missing`, and a
   startup warning fires when a project corpus exists without a memory index.
   The same restart loads the cleared-run marker and the two corpus fixes
   above (rooted index names, semantic leg scoped to vector indices), so the
   ring should stop repeating `archive index mapping not created` and
   `semantic leg failed`.
2. Memory loss is explained and the data is back (2026-11-06). The index was
   not corrupt: a lexical node was serving the project's data dir while the
   memory index held neural vectors, so `recoverMemoryIndex` read the mismatch
   as damage, backed the index up to `embed-backup/unreadable/`, and deleted
   it. The backup was intact, was restored in place, and vector recall answers
   again with all 47 memories. The repair now requires a failed query rather
   than a non-green health reading, and it keeps a correctly-moded index in
   place: when the index's recorded backend equals `index.neural`, the plugin
   warns instead of resetting, because that combination usually means the node
   is in another mode. The node still cannot serve the index until it runs the
   right mode, but the store is no longer destroyed by the wrong one.
3. Publish the next release when the user asks. `v0.7.0` is released and
   `npm` serves it. `publish.yml` stages when the token requires it; approve
   the staged version at npmjs.com.
4. Known coverage gaps need a fake clock or several processes: `mcp/host.ts`
   runner tools, the plugin's own wiring inside a live setup, supervisor
   port-scan exhaustion, and watcher restart backoff.

## Work in progress

The roadmap is implemented: local judge and autotune, window extraction,
tree-sitter complexity, the hub tools, reference corpora, share links, the LSP
pool, call hierarchy, inspect, the dreamer child session, and notes. The user
opened the defaults, including the dreamer and notes. Nothing is pushed. The
dreamer child session still needs a live host verification; every other path
has unit or integration coverage.

The local distillation judge is the default and needs a restart to load.
Distillation is on by default with `memory.distill.judge: "local"`, so setup
starts a background install of the jevos binary and its 630 MB OpenVINO INT8
model under `<data root>/jev/`, then keeps one loopback server for the
installation. Each candidate is one request
with the sentence as the state, one contrastive keep question, and a five-way
kind choice. Live against the model: 10 of 11 durable sentences kept and 9 of
10 archived progress reports rejected, cold start 4.5 s, first judgement
1.6 s, later ones about 190 ms on four threads. Every failure path (unsupported platform, offline install, a server
that does not answer, a slow judgement) keeps the heuristic verdict. Next:
restart OpenCode with `judge: "local"` set and confirm the install lands, the
first turn falls back until it finishes, the log names the server port, and
`xerj_telemetry op=memory.distill` reports `local` promotions. Every
judgement is also one `memory.distill.judge` record; `bun run tune:local`
prints the live keep rate and score histogram and writes a JSONL corpus.

Local telemetry is implemented (Tier S, done). Every operation, boot phase,
crash, restart, service-state transition, and CPU/RSS sample lands in bounded
NDJSON files under `<data root>/telemetry`. The five-state model
(`starting`, `ready`, `busy`, `degraded`, `stopped`) drives the sidebar badge,
the panel `State` section, and the `xerj_telemetry` report. Tool and RPC calls
are timed generically at registration. Next: restart OpenCode to load the web
corpus and state-tracker fixes, confirm the badge settles on `ready` for this
project with no `ready <-> degraded` pair in `lifecycle.state`, and check that
retrieval p50/p95 with telemetry on stay within noise of off.

Originally: design in `roadmap.md` (Tier S, about 12 h). It records every operation's type, duration, outcome, idle/busy load,
and up to 160 characters of redacted caller text into bounded NDJSON files
under `<data root>/telemetry`, keeps a per-type ring of samples plus a per-day
rollup, tracks boot phases, crashes, and restarts through a per-instance
marker, samples CPU and RSS for the node, the watcher, and any one-shot index
process into `samples/<date>.ndjson` every `telemetry.sampleMs` (15 s, 0
disables), and publishes a five-state service model (`ready`, `busy`,
`degraded`, `starting`, `stopped`) to both the UI and the report. On by
default, local only, capped at 128 MiB.

Nothing else. M0–M6 and in-project storage are committed; only the restart,
publish, and live TUI verification remain.

## Blocked / unknown

- Whether the model benefits from neighbor expansion in practice; the
  mechanism works, but no task has been measured with and without it.

## Verified

- Release assets for `v1.0.0-rc.100`: `xerj-<ver>-<target>.tar.gz` + `.sha256`
  (`<hex>  <filename>`), Linux musl default, archive root
  `xerj-<ver>-<target>/`, latest resolved by redirect.
- Target selection covers Linux x86_64/aarch64 (musl or gnu), macOS
  x86_64/arm64, and Windows x86_64/arm64 (zip, `xerj.exe`, `LOCALAPPDATA`).
  Rosetta shells and x64 Node on Windows ARM64 get the native arm64 build.
  Installs are target-scoped and probed before use; `binary.target`,
  `binary.libc`, and `binary.path` are covered by unit tests. Only Linux x86_64
  has been exercised end to end.
- Node identity: `GET /` → `cluster_name: "xerj"`; `version.number` is the ES
  wire version `8.13.0`, not the release.
- `--port P` claims P, P+1 and P+2; `--auto-port` is opt-in.
- `autoindex --no-graph` reconciles deletes, renames and additions across runs;
  `--json` emits one run document; exit 4 is a decision request.
- `autoindex` refuses a single file; hidden files and directories are skipped
  unconditionally, so `.agents/` is reachable only through the brain.
- `xerj brain` hardcodes prefix `ax` and has no `--prefix`; use
  `autoindex --brain <name> --prefix <p>` instead.
- `_cat/indices?format=json` fields and human size strings; `_stats` is not a
  route.
- `xerj gain --json` shape (searches, hit_rate, took_ms, top_indices).
- `GET /_memory/<namespace>?size=1` returns `count` with a one-entry page, so
  the panel counts memories without paging through them.
- `_cat/indices` groups cleanly into project (`<prefix>-*`), hidden
  (`<prefix>-hidden-*`), web, external, brain (`xop-<brain>-*`), and memory;
  the memory index is exactly `.xerj-memory-<namespace>`.
- `PUT` on an existing index returns 409, not 400. Both the hidden and external
  ingesters accept either and continue.
- Hidden indexing writes `<prefix>-hidden-docs` with `path` relative to the
  project, so citations keep `.agents/...`; a rescan deletes ids whose files
  are gone.
- A `read` outside the project root ingests in the background; the mtime+size
  stamp prevents re-bulking an unchanged file.
- `bash`/`shell` reads are parsed as literal file references confirmed by
  `stat`, not by command whitelist; redirection targets and short-option
  values are skipped.
- Brain hits are rewritten to project-relative paths before line resolution;
  a hidden whole-file hit is dropped when a brain section covers that path.
- `/_graph/<brain>/ego` needs `?node=<id[,id]>`; POST is 405. It returns edges
  and neighbor ids, not text; anchor by id from the brain docs index.
- `PUT /_ml/anomaly_detectors/<id>` + `POST .../_score` returns
  `anomaly_count`, `bucket_count`, and `anomalies[]` with timestamp, actual,
  expected, z-score, and score. Warm-up buckets are not flagged.

## Log

- 2026-11-07: `cmd.blockPipes` (off by default) registers an
  `execute.before` hook. With the key on, a host `bash`/`shell` call whose
  command pipes to head, tail, grep, sed, awk, or cut is rejected with a
  message pointing at `xerj_run` and `xerj_out`. The plugin's own `xerj_run`
  is not rejected. The default stays the softer route: the first-call
  instruction and the per-command hint. The README example and option table,
  a config test, the setup hook test, and the filter tests cover it. 1,337
  unit tests (1 skip) pass; typecheck clean.

- 2026-11-07: The command-output instruction now names the habit it
  replaces: do not pipe a command to head, tail, grep, sed, awk, or cut to
  look at part of its output; run the command with `xerj_run` and read it
  with `xerj_out show`/`search`. The old wording only said "long output",
  which a `| grep` does not look like. A host `bash`/`shell` command that
  uses one of those filters queues a `<xerj-cmd-hint>` for the next model
  call even when the filtered result is short, because the full output never
  reached the plugin. `sort`, `uniq`, and `wc` are not flagged: their result
  is often the answer. The `xerj_run` description says the same.

- 2026-11-07: Second audit pass. Fixed: `readProjectFile` accepted a path
  that escaped the project (`../../.ssh/id_rsa`), which `xerj_imports`,
  `xerj_inspect`, and the LSP inspect path could reach; it now resolves the
  path and refuses anything outside the root, and the LSP path uses the same
  helper for the boundary and size cap. `CmdService.ingest` resolved the path
  for its boundary check and then read the caller's original string, so a
  relative ingest depended on the server's working directory. An invalid
  `index.workers` returned the minimum instead of the engine default. A
  reindex now rebuilds the indexers when a failed bootstrap left them null,
  and the URL-change restart catches a stop failure.

  New tests: the walk skip list, root boundary, and size cap; relative and
  absolute ingest; `index.workers` fallback and clamping; `noteNodeCrash`
  dedupe; the jevos supervisor start/health/stop path. Coverage is 90.7%
  lines and 84.9% functions; 1,328 unit tests (1 skip) and 14 integration
  tests pass.

  New open findings:
  `xerj_find` compiles a model-supplied regex and runs it on the main thread
  with no deadline; a catastrophic-backtracking pattern can hang the plugin,
  and the file's comment claiming it "refuses a code block that would take
  longer than a turn" is false. A worker with a deadline or a nested-quantifier
  rejection is the fix.
  `telemetry.report` parses the whole ops log (up to about 40 MB with four
  rotations) on a status poll; the 5-second cache means a 30-second TUI poll
  pays it. The rings and rollups exist so the report need not scan the log.
  `writePrefs` uses one `<file>.xerj-tmp` name for every writer, so two
  plugin instances can race on the rename.
  `readProjectFile` is lexical: a symlink inside the project pointing outside
  is followed. A `realpath` check on the direct-call paths would close that.
  `recordedNodeCrashes` is an unbounded module-level Set, one key per crash.
  `searchAst` accumulates the full `ast-grep` output without a byte cap.

- 2026-11-07: The audit findings are addressed. `stopNode` now proves the
  port owner before signalling a pid, so a reused pid is left alone. The LSP
  pool records a per-project, per-language pidfile, sweeps a stale one only
  when the command line still names the server, and removes it on stop.
  Binary installs record their owner pid and use a 15-minute wait over a
  10-minute stale window, so a crashed install is reclaimed at once and a
  slow one is not stolen. `xerj_status` is compact, the line cache is bounded
  and cleared on every corpus run, the bootstrap retry is tested, the sidebar
  threshold matches the box's inner width, an empty memory is rejected, and a
  failed telemetry rotation no longer resets the byte count.

  New tests: a fake stdio LSP server (handshake, call hierarchy, pidfile,
  teardown, stale pid), `runEngine` output caps and timeout, grammar install
  against a loopback tarball (good pack, hash mismatch, no `out/`),
  `detectRuntime` branch selection, `/proc` and `ps` process counters, the
  sampler's `forget`, the real tree-sitter parser (skipped without the pack),
  the bootstrap retry with a mocked clock, and the jevos install against a
  fixture release served on loopback. Coverage is 89.8% lines and 84.1%
  functions; `bunfig.toml` enforces 85/80 and CI runs `--coverage`.
  `package-lock.json` is removed, `watch:tui` and a README note close the
  stale-bundle gap. 1,315 unit tests (1 skip) and 14 integration tests pass;
  typecheck clean. The structural split of `src/index.ts` and
  `src/tools/search.ts` remains a separate refactor; it is a readability
  issue, not a correctness one.

- 2026-11-07: Audit pass. Fixed: `xerj_status` now returns a compact summary
  (251 characters, about 63 tokens, against 10.4 KB and 2.6k tokens) with
  `full: true` for the old JSON; `SearchService` drops its line cache on
  `invalidate()` and bounds it at 128 files, so an edit no longer leaves a
  citation on the old line; a failed bootstrap retries on a status call
  instead of staying error for the life of the process; an orphaned doc
  comment and one `as never` cast are cleaned up. 1,284 unit and 14
  integration tests pass.

  Open findings, highest value first:
  `stopNode` reads the pidfile and signals that pid without proving the port
  owner, so a reused pid can receive SIGTERM; `ensureNode` and `detectNode`
  do check ownership. The LSP pool has no pidfile or stale-pid cleanup even
  though the roadmap's risk table says it does, so a hard crash can leave a
  language server behind. The binary install lock treats a crashed lock as
  stale after 10 minutes while the waiter gives up after 5, so one crashed
  install blocks the next for two windows. `package-lock.json` is stale at
  0.3.0 while `package.json` and `bun.lock` are 0.7.0. CI runs no coverage
  gate, so the 86.3% lines / 81.7% functions baseline can regress silently.
  `dist/tui.js` is rebuilt only by `prepack`, so a source change leaves the
  working-tree dogfood bundle stale until a manual `bun run build:tui`; that
  is what made the last sidebar fix look absent.

- 2026-11-07: The degraded badge had three causes, all fixed, and the
  dreamer is verified live. (1) Bun's `fetch` rejects a refused connection with
  a `TypeError` that has no `cause` and no `code`; `isTransportError` only read
  `cause`, so the retry that re-ensures a stopped node never fired and every
  request failed on the dead socket. It now also checks the message for the
  syscall error name. (2) `NodeRuntime.ensure()` and `detect()` returned a
  cached handle without checking its pid; a detached node that died without an
  exit event kept answering with a dead URL. The handle is now reaped when the
  pid is gone, and the status snapshot drops the stale handle. (3) The plugin
  teardown stopped the node even with `shutdownOnIdle: false`, so a reload
  killed a node another instance was using; it now stops only when the key is
  on and no peer holds a session. Binary installs also serialize on one lock
  under the cache root, and a failed bootstrap is retried on the next status
  call instead of leaving the plugin degraded for the life of the process.

  Live: the neural node was restarted in the right mode, the project corpus and
  71 memories came back, and the badge settled on `ready` (9,131 docs, 9
  datasets). The dreamer child session
  `ses_e48199287ffeiqN5x07yb0GLjC` checked 70 memories, flagged 5 stale, used
  exactly three tool calls, and stored one primer as `813525f95cbabb33`; the
  denied `edit`/`write`/`bash`/`shell`/`webfetch` permissions held. One
  `xerj_remember` hit a node restart mid-run and the child retried with a
  shorter text, which is the transient failure the retry fix removes. 1,276
  unit tests pass and typecheck is clean.

- 2026-11-07: Global state moved to the OpenCode cache root. `cacheRoot` is
  `$XDG_CACHE_HOME/opencode/xerj` on Linux, `~/Library/Caches/opencode/xerj`
  on macOS, and `%LOCALAPPDATA%\opencode\cache\xerj` on Windows. The managed
  binary, release cache, port lock, grammars, language servers, jevos model,
  reference corpora, hub catalogue/packs, and telemetry live there. Project
  state stays in `<project>/.xerj` (node data, spool, archive, cmd, notes,
  dreamer). The hub gets `XERJ_HUB_HOME`, code gets `XERJ_CODE_HOME`, and the
  npm language-server install gets `npm_config_cache`, so none of them fall
  back to `~/.xerj`, `~/npm`, or the source directory.

  Existing installs are migrated once from the old XDG data root: project
  storage and memory are checked in the old root as well as the cache root.
  TUI preferences remain in the host's shared
  `$XDG_CONFIG_HOME/opencode/tui-preferences.jsonc`, because that file is
  shared with other plugins; it is configuration, not cache or project state.
  Explicit `xerj_dataset` paths, external `xerj_index` reads, shell reads, and
  system doc roots are deliberate file operations and keep their given paths.
  1274 unit and 14 integration tests pass; typecheck clean. Nothing is pushed
  or released.

- 2026-11-07: The sidebar guards variable-length text. A row whose label and
  value exceed `SIDEBAR_COMPACT_WIDTH` (34 cells) moves the value to its own
  line and wraps it, so an error, path, or job summary cannot squeeze the
  label. The state badge, failure line, empty-state lines, and panel lines wrap
  at the container width; grouped values wrap on character boundaries so a
  long unbroken token cannot overflow. `sidebarRowLayout` is pure and tested,
  and the render test asserts a long corpus error produces a wrapped element.
  Two new render/layout tests; 1273 unit tests pass, typecheck clean. Nothing
  is pushed or released.

- 2026-11-07: Telemetry now carries per-operation and per-feature cost.
  Every span records `cpuMs` from `process.cpuUsage()`, RSS before and after
  with the delta, and the process peak, in addition to wall time. The report
  groups records into feature rows (retrieval, memory, index, analysis, hub,
  code, share, cmd, graph, archive, and so on) with wall time, CPU, RSS,
  returned bytes, saved bytes, hits, and promotions, ordered by CPU.
  `xerj_telemetry` prints those rows, a per-process block for node, watcher,
  index, language servers, and jevos, and a ledger benefit line; `sort=cpu`
  orders operations by total CPU.

  Process samples now include `lsp` and `jev`; the process block is built per
  kind. In-process CPU is process-wide, so concurrent features share a figure;
  one-shot subprocesses are measured by wall time, not CPU. Five cost tests
  cover feature mapping, cost merging, span fields, feature rollup, and
  per-kind process summaries; 1271 unit tests pass, typecheck clean. Nothing
  is pushed or released.

- 2026-11-07: The dreamer has a manual command. `/xerj-dreamer`, `/xerj
  dreamer`, and the palette run the RPC `dreamer`, which calls
  `Dreamer.runNow(sessionID, true)` for the latest session. A manual run
  bypasses the 24-hour interval; the idle path still honors it. The RPC
  returns the child id, the verification and curation counts, and a readable
  reason when it cannot start. The TUI stub and the RPC payload suite cover
  the call; 1267 unit tests pass, typecheck clean. Nothing is pushed or
  released.

- 2026-11-07: Dreamer child sessions and notes shipped, both on by default.
  The dreamer registers `experimental.idle`, waits `idleMs` (10 min), runs
  memory verification and curation, then creates a child of the idle session
  titled `XERJ dreamer` with edit/write/bash/shell/webfetch denied. Its model
  is `memory.dreamer.model` as `provider/model`; null inherits the parent. It
  asks for at most three tool calls, about 4k tokens, and one primer via
  `xerj_remember`; the last run lives in `.xerj/dreamer.json`, and the run is
  telemetry `memory.dreamer`.

  Notes live in `.xerj/notes.jsonl` (0600) with conditions, tags, hits, and
  last hit. `xerj_notes` adds, lists, removes, and searches them. The prompt
  hook injects at most one matching note as `<xerj-note>`, once per session,
  and charges it to the context budget. Four dreamer tests, four note store
  tests, and one hook test cover the paths; 1265 unit and 14 integration tests
  pass, typecheck clean. Nothing is pushed or released.

- 2026-11-07: The defaults changed at the user's request:
  `node.shutdownOnIdle: false`, `memory.extract.enabled: true`,
  `cmd.inject: true`, `analysis.treeSitter.enabled: true`,
  `analysis.lsp.enabled: true`, `code.enabled: true`, `hub.enabled: true`,
  `hub.network: true`, and `telemetry.anomaly: true`. `share.enabled` stays
  false, `code.network` stays false, and `hub.hosted` stays `off`, so share and
  cloning remain deliberate, and questions never leave the machine. The README
  example, option table, roadmap gate table, setup/MCP tool lists, and config
  tests follow. 1254 unit and 14 integration tests pass; typecheck clean.
  Nothing is pushed or released.

- 2026-11-07: `xerj_inspect` now covers unused exports. When
  `analysis.treeSitter.enabled` is on, `analysis/exports.ts` counts every
  identifier per file and reports exported top-level names that no other file
  mentions again, labelled heuristic because a string reference or dynamic
  import can make a live export look unused. Three module tests. 1254 unit
  tests pass and typecheck is clean. Nothing is pushed or released.

- 2026-11-07: The LSP pool, the pinned TypeScript installer, and the
  `xerj_callers`/`xerj_impact` tools are implemented behind
  `analysis.lsp.enabled` (off); `xerj_inspect` is always registered for TODOs
  and adds diagnostics when the gate is open. The client speaks JSON-RPC over
  stdio, answers server requests, and covers workspace symbols, document
  symbols, call hierarchy, definitions, references, and publishDiagnostics.
  The pool resolves a configured command, project `node_modules`, PATH, or
  `<data root>/lsp`, installs the pinned
  `typescript-language-server@6.0.3` + `typescript@5.9.3` with
  `--ignore-scripts`, opens up to 500 TypeScript files (tsserver only indexes
  what the client opened), caps concurrent servers, and stops idle ones.
  Verified against the real server on a two-file fixture: one caller for the
  target, one impact hop, clean shutdown. Five LSP tool tests plus two config
  tests; 1251 unit tests pass and typecheck is clean. Nothing is pushed or
  released.

- 2026-11-07: `xerj_code` and `xerj_share` are implemented behind their gates
  (both off). `xerj_code` wraps the engine's `xerj code` and `xerj corpus
  list/add/index`; `code.network` gates cloning, `XERJ_CODE_HOME` is
  `<data root>/code`, and the query passes corpus, mode, `-k`, `--full`, and
  `--lang` with `--url` to the plugin node. `xerj_share` wraps `xerj share`
  create/list/revoke with expiry, claims, optional passcode and label; no
  tunnel is offered. Eight service/tool tests and two config tests; 1244 unit
  tests pass and typecheck is clean. Nothing is pushed or released.

- 2026-11-07: The tree-sitter layer and `xerj_complexity` are implemented
  behind `analysis.treeSitter.enabled` (off). The first call downloads the
  pinned `tree-sitter-wasms` 0.1.13 tarball (4.4 MB compressed, about 50 MB
  unpacked) from npm, verifies its sha512 in streaming, extracts it into
  `<data root>/grammars/0.1.13/out`, and reuses it for every project. The
  analyzer lazily loads `web-tree-sitter`, maps `.ts`/`.tsx` and ten other
  extensions to their grammars, parses files under `maxParseBytes`, and
  reports the largest functions by named-node count plus groups of
  structurally identical functions. A failed download names the reason and
  leaves the rest of the plugin working.

  Verified against the real pack and a real TypeScript tree: `search.ts`
  parsed 8 functions, the largest at 320 nodes and 620 lines. Four module
  tests and one tool test cover extension mapping, sorting, duplicate
  grouping, the injected parser, the gate, and the tool output; 1234 unit
  tests pass and typecheck is clean. Nothing is pushed or released.

- 2026-11-07: `xerj_ask` and `xerj_hub` are implemented behind `hub.enabled`
  (off). They wrap the engine's own `xerj ask`/`xerj hub`; the plugin holds no
  pack, signature, or catalogue code. `xerj_ask` passes `--offline` and
  `--hosted off` when `hub.network` is false, points `--url` at the plugin's
  node, and formats the JSON answer with corpus, pin, age, licence, hits, and
  warnings. `xerj_hub` covers `sync`, `find`, and `status`; `sync` is refused
  while the network is off, and `find` never fetches.
  Defaults are the accepted set: `hub.enabled: false`, `hub.network: false`,
  `hub.hosted: "off"`, `https://hub.xerj.org`, 1200 tokens, 120 s. Exit 3/4/5/6
  map to verification, ambiguity, no public key, and no catalogue messages.
  Verified live against the managed rc.101 binary and the cached catalogue: a
  cached pack answered with `retext-intensify · pin 9450bee5 · MIT`, `find`
  returned candidates, and `status` reported the pack. Seven service/tool tests
  and three config tests; 1229 unit tests pass, typecheck clean. Nothing is
  pushed or released.

- 2026-11-07: Window extraction shipped behind `memory.extract` (off). The
  `compaction` hook already sees the messages a summary will replace, so the
  plugin flattens the user and assistant text with the archive's own
  `captureWindow`, runs the same candidate extractor and judge as a turn, and
  writes up to `maxFacts` durable sentences with `source: extract:<judge>` and
  `derived: true`. It reuses `memory.distill.judge`, `minConfidence`, and
  `modelMaxCalls`; the write is fire-and-forget, so a slow judge never delays
  the summary. Extracted memories count toward `maxPerProject` and retire by
  the same confidence-and-age rule; `memory.extract` telemetry reports
  candidates, promoted, duplicates, rejected, and calls per window.

  The gate stays off because the window has not had a precision measurement;
  only the turn pipeline has. The labelled set and `replay:judge` are the path
  to that measurement. Five module tests cover the store path, the fact cap,
  duplicates, the heuristic route, and the hook; 1219 unit tests pass and
  typecheck is clean. Nothing is pushed or released.

- 2026-11-07: Autotune is implemented and on by default. Ten minutes after
  setup, and every 24 hours after, the autotuner replays the fixed labelled
  set through the live jevos model, sweeps nine thresholds, and adopts one only
  when its F1 beats the active floor by `margin` (5 points). It never learns
  from unlabelled turns; the fixed set is a stability check, so a stable model
  leaves the floor alone. The chosen value and the evidence live in
  `<data root>/jev/autotune.json`; changing `local.threshold` in config
  discards the saved value, and `autotune.enabled: false` removes the pass.
  The pass costs about twenty short judgements and runs in the background.
  The panel's Memory section reports the floor, whether it was autotuned, the
  date, and F1. The labelled set moved to `src/memory/labels.ts` so the
  runtime and the scripts use one copy. Five autotune tests cover adoption,
  the margin, too few answers, state reload, and a changed config; 1226 unit
  tests pass and typecheck is clean. Nothing is pushed or released.

- 2026-11-06: The local judge has a tuning loop and a measured floor. Every
  captured judgement can be replayed through four keep questions and nine
  thresholds with `bun run replay:judge`; labels added to the JSONL survive a
  later `tune:local` run, and `--labeled` uses the built-in set when the live
  file is empty. On the labelled reports the current wording scores 88%
  precision and 88% recall at 0.20 against 78% and 88% at 0.15, so the default
  floor moved to 20. The plain "durable fact" wording trails at 62% F1, which
  is the evidence for keeping the contrastive question. 4 new unit tests
  cover the confusion matrix, inverted wordings, missing answers, and the best
  threshold; 1205 unit tests pass and typecheck is clean. Nothing is pushed or
  released.

- 2026-11-06: The local judge is now the default: live-context distillation is
  on (`memory.distill.enabled: true`) and `memory.distill.judge` is `local`.
  A setup therefore starts the jevos install in the background on first run;
  `memory.distill.enabled: false` removes the download and the server, and
  `local.path` skips the download when the model is already on disk. The
  judge's first turn does not wait for the install: the supervisor race is
  capped by `local.timeoutMs`, so the heuristic answers until the server is
  up.

  Every judgement now writes a `memory.distill.judge` telemetry record with
  the model's score and verdict, the heuristic's kind and score, the final
  kind, the origin, the threshold, the session, the outcome, and up to 160
  characters of the redacted sentence. It shares the existing ops log,
  rotation, 128 MiB cap, and flush timer, so there is no new file or process.
  `bun run tune:local` reads every rotated ops file, filters by project prefix
  on request, prints the keep rate, mean score by verdict, a score histogram,
  and the latest borderline samples, and writes one JSONL row per judgement to
  `~/.cache/opencode/xerj-tune/judge-samples.jsonl`. Unit tests cover the
  parser, the summary, and one tuning record per candidate; the setup and
  integration fixtures disable distillation so tests never fetch the model.
  1200 unit tests pass and typecheck is clean. Nothing is pushed or released.

- 2026-11-06: The local distillation judge shipped behind
  `memory.distill.judge: "local"` (still off by default). The plugin downloads
  the jevos v5 binary and OpenVINO INT8 model (about 27 MB and 630 MB) into
  `<data root>/jev/`, verifies both against the release `SHA256SUMS.txt`,
  extracts into a partial tree, probes the binary with its own usage exit, and
  renames the tree into place. The install is shared by every project in the
  installation and runs in the background from setup, so no turn waits on it;
  until it lands, and on every failure, distillation keeps the heuristic
  verdict. One loopback server is started on `local.port` (8017) or the first
  free port in 8017-8099, attaches to a healthy server instead of starting a
  second, and stops after `local.idleMs` without a judgement.

  Each candidate is one request with the sentence as the state: one `noul`
  question and one five-way `choice`. The question is contrastive, "a lasting
  project rule or fact, rather than a report of what was just done", because
  the plain "durable fact" wording accepted 24 of 40 candidates mined from this
  project's own turn archive, most of them progress reports. On the labeled
  set the contrastive wording accepts 7 of 8 memories and cuts report noise
  from 3 of 10 to 2 of 10; on a hand-labeled history sample it kept 10 of 11
  durable sentences and rejected 9 of 10 reports. Putting the turn around the
  sentence lowered every score, so the state is the sentence. Cold start is
  4.5 s, the first judgement 1.6 s, later ones about 190 ms on four threads.
  The server runs with a 512-token context and no state cache, which keeps it
  at about 1.2 GB resident instead of 2.1 GB.

  The install path was run end to end with the real assets served locally:
  download, checksum, extraction, layout, and probe all pass, and a second
  `ensure` reuses the tree. That run found three defects, now fixed and
  covered by tests: the streaming hash read only the first chunk, the model
  zip used the binary's archive kind, and the binary folder had the same name
  as the binary it contained.

  `DISTILL_EVAL_JEVOS_URL` runs the local judge through the existing harness,
  which now also reports a labeled set of recoverable summaries so the keep
  wording can be compared on two fronts. Telemetry gains a `local` count in the
  `distill` report block, and the panel line only prints a judge's count while
  it is non-zero, so the common heuristic-only install is unchanged. 21 new
  unit tests cover the release metadata, the judge, the manager, and the
  supervisor; 1193 unit tests pass and typecheck is clean. Nothing is pushed
  or released.

- 2026-11-06: The memory-index reset no longer destroys a correctly-moded
  store. `recoverMemoryIndex` reads `embedding_execution.json` before acting:
  when the recorded backend equals `index.neural`, an unreadable index is left
  in place with a warning naming the likely cause (the node is running another
  mode) and the backup path to use if it is genuinely corrupt. The index is
  still backed up and reset when the recorded backend differs from the config,
  which is the mode-change case the repair exists for. Two tests cover both
  directions; the pre-existing behavior is unchanged when the metadata is
  missing.

- 2026-11-06: Two follow-ups on distillation. Turn capture and distillation
  were coupled: the listener only started when `memory.captureTurns` was true,
  so a project that wanted typed memories without a summary of every turn got
  neither. The listener now starts when any of its three consumers runs (the
  Q/A summary, distillation, the turn archive), and `captureSummary` suppresses
  only the summary. A test covers distillation with capture off.

  The heuristic judge has a golden set: 8 labeled sentences (decisions,
  constraints, conventions, preferences, facts) and 7 that must never be
  promoted (questions, hedges, plans, code blocks). It recalls and classifies
  8/8 with 0 false positives, and the floors are 80% / none so a cue change
  cannot quietly start storing noise. The measurement harness is
  `bun run eval:distill`: it prints the heuristic's recall, false positives,
  and class accuracy (8/8, 0/7, 8/8), and runs the model judge over the same
  set when given an OpenAI-compatible endpoint and key. A script cannot borrow
  the host's model, so the delta is the user's run to make.

- 2026-11-06: The model judge for live-context distillation is implemented.
  `judge: "model"` now sends each cue-bearing candidate through the host's
  model with the turn clipped to 1,200 characters and a 4 s deadline, one call
  per candidate up to `modelMaxCalls` (3) per turn. It asks for a JSON verdict
  (`keep`, `kind`, `score`); prose around the object is tolerated. A missing
  host model, an unusable answer, a timeout, or a candidate past the call cap
  keeps the heuristic verdict, so a transient failure never drops a memory.

  Cost is measured per judge: the `memory.distill` span now carries `calls` and
  `chars`, the report sums them, and the line reads
  `distilled N memories (heuristic A, model B, 3 calls / 4k chars) · recalled R`.
  That is enough to compare the two routes on the same corpus; the precision
  measurement on a labeled set is still pending, which is the remaining gate
  before recommending the model route.

  The panel's Telemetry section now carries the same line
  (`distilled N · heuristic A · model B · calls C · recalled R`), so the
  effectiveness pair is visible without running the tool. 18 distill and panel
  tests cover parsing, invalid answers, timeouts, fallback, the call cap, and
  the rendered line.

- 2026-11-06: Live context distillation shipped behind `memory.distill.enabled`
  (off). After each turn the plugin classifies sentences from that turn's own
  prompt and answer as decision, constraint, convention, preference, or fact,
  and writes the ones that clear `minConfidence` (55) to memory. It never reads
  the message window: the compaction hook remains the only place that does.
  Questions, hedges, plans, and fenced code are rejected, and a `path:line` or
  config key raises the score. A short turn counts too, because distillation
  runs before the 400-character turn-capture floor.

  Two judges share the write path. `heuristic` is the local filter and costs
  nothing; `model` is a seam that falls back to the heuristic with a debug line
  until the model call is wired. Every memory carries `source: distill:<judge>`
  and `confidence`, so the two can be compared later.

  Retirement is by evidence and budget, never by relevance: the hourly sweep
  keeps `maxPerProject` (200) distilled memories, removing the lowest
  confidence and then the oldest; verification marks stale citations and
  curation flags duplicates. Explicit memories are never touched.

  Telemetry separates the judges: a `memory.distill` span carries `judge`,
  `candidates`, `promoted`, `duplicates`, `rejected`, and duration, a second
  carries `phase: retire` and `retired`, and `memory.recall` carries `distilled`.
  The report adds `distilled N memories (heuristic A, model B) · recalled R`.
  The heuristic judge's cost is a few dozen microseconds per turn; the model
  route will be measured against it on the same corpus. 1158 unit tests pass.

- 2026-11-06: README rewritten around what each feature does and how it works.
  It now has a table of contents with subsection links and a back-to-top link at
  the end of every top-level section (23 of them, verified against the heading
  anchors). New sections cover the project index and its watcher, memory,
  command output, fetched pages and external files, the analysis tools, and
  anomaly scoring; the TUI section describes the current collapsible box,
  state line, jobs row, and completion notices instead of the old four-line
  block. The tools table lists all 22 plugin tools, the MCP section is renamed
  to `### MCP tools` and lists its 19, and a duplicated telemetry block under
  the MCP arguments was removed. `README.md` is 1,302 lines; the config block
  still parses against `DEFAULT_CONFIG`.

- 2026-11-06: Documentation crawls are rate limited per host, and completions
  now announce themselves. One `HostRateLimiter` is created per docs run and
  shared by every crawl in it, so component guides and the builtin chapters
  that hit the same host take one slot each at `prjdocs.requestIntervalMs`
  (250 ms) plus `prjdocs.requestJitterMs` (100 ms) of jitter. A 429 or 503
  reads `Retry-After` (seconds or an HTTP date), pushes that host's next slot
  out by up to 30 s, and retries the page once. Before this, a run could reach
  one host from several target crawls at once with no spacing.

  Every documentation request sends `prjdocs.userAgent`, defaulting to a
  crawler token documentation hosts already admit; before this the string was
  a hard-coded plugin name that unknown-agent filters throttle. It is also
  sent by the repo listing, raw markdown fetches, chapter discovery, and the
  latest-release resolver, which each had their own copy of the old string.

  Completion notices are status-driven, so they fire whoever started the run:
  the TUI baselines the first status it sees, then toasts on any later change
  of `index.lastRunAt`, `docs.prjdocs.lastRunAt`, or `docs.sysdocs.lastRunAt`.
  The first index pass after startup therefore announces itself, a manual
  `/xerj-reindex` or docs command supplies its richer message through a
  pending notice, and an agent-triggered `xerj_prjdocs` or `xerj_sysdocs` gets
  the default one. `src/ui/notify.ts` holds the pure decision; five tests
  cover the baseline, the initial pass, the pending text, and the default.
  1142 unit tests pass, typecheck clean, `dist/tui.js` rebuilt.

- 2026-11-06: Command output management shipped, on by default. `xerj_run`
  keeps every command's text as `<stem>-cmd.txt` and `<stem>-out.txt` under
  `<project>/.xerj/cmd/`, and `xerj_out` lists, shows an exact range, searches,
  or ingests a file the agent wrote. The corpus is `<prefix>-cmd-docs`, plain
  `text`, split into 200-line / 16 KiB windows with no embedding; only the
  indexed text is redacted, the raw pair keeps what the command printed.

  The manifest carries what the files cannot: exit code, duration, line count,
  redacted command, and the window starts, so a re-index is incremental and a
  pruned stem can delete its documents. Two caps: `cmd.maxBytes` (256 MiB for
  the pairs) and `cmd.maxIndexBytes` (32 MiB for the index); the hourly and
  post-ingest sweep deletes the oldest complete stem, files and documents
  together. `cmd.maxFileBytes` (32 MiB) stops one runaway command from being
  parsed.

  The model gets the instruction on its first call, and again after
  `session.compaction.ended`, plus one `<xerj-cmd-hint>` line after a mirrored
  result past `cmd.hintLines` (40). Host `bash`/`shell` results are mirrored so
  history covers commands the wrapper did not run. A failed write or a full
  disk logs once and leaves retrieval untouched.

  Two findings while building it: the runner must use `bash -c`, not `bash
  -lc`, because a login profile printed the working directory into the capture;
  and the store's first boot must recover a `-out.txt.part` into a completed
  pair rather than skipping it, or a killed command leaves no entry.

  Verified live in this session: `xerj_run` returned
  `ran · exit 4 · 0.0s · 3 lines · 24 B` with a stem, `xerj_out list` showed
  the exit code, `show` returned `cmd/<stem>-out.txt:1-3 of 3`, and `search`
  found the marker at line 2 with `[exit 4]`. 1129 unit tests and 14
  integration tests pass, typecheck clean.

- 2026-11-06: The sidebar header carries only the fold arrow and the label.
  The state badge and the plugin version moved to their own lines at the top
  of the open block, so the top line no longer changes width as the service
  moves between ready, busy, and degraded. A collapsed sidebar is the header
  plus the summary rows, with the `Jobs` row when something is running; the
  failing-corpus `⚠` line stays visible in both views. Tests cover the
  expanded and collapsed trees, and the real renderer shows `▼ XERJ`,
  `◐ busy · indexing · 12s`, `v0.7.0` above the sections.

- 2026-11-06: The sidebar crash is found and fixed. The new fallback and ring
  reported `undefined is not an object (evaluating 'e.process.cpuPercent')`, so
  the failure was upstream of the render: the host rebuilds the `status`
  response from the declared output schema, and that schema omitted `process`,
  `frameworks`, `embeddings`, and the memory index's `exists` and `stale`. The
  TUI received `process: undefined`, took the branch that formats counters, and
  threw. `src/rpc.ts` now declares all of them.

  The same omission made the memory row read `missing` for a healthy store,
  because `exists` never arrived. Any field added to `StatusSnapshot` without a
  schema line would disappear the same way.

  `test/unit/ui.test.ts` gained a guard: it rebuilds the status fixture from
  the declared output schema — the same properties the host keeps — asserts the
  fields the panels read survive, and asserts both views render. It fails
  against the old schema with the sidebar's own error. 1101 unit tests pass.

- 2026-11-06: The sidebar now reports what it does. The TUI half has no
  filesystem access and the host logs no slot render failures, so a sidebar
  that fails on the host left nothing behind. A new `uiLog` RPC carries the
  TUI's own lines, in batches, to the server half, which appends them to
  `rings/ui.sidebar.ndjson` in the same telemetry store as the operation
  rings: clipped, redacted, capped by `samplesPerType`, and tagged with the
  project prefix and the instance id.

  The sidebar records setup, the loaded preferences, each status read, the
  parsed view (badge and row counts), and each render. Both slot bodies catch
  their own failures, log the message and stack, and return one plain line, so
  a fault inside the view leaves a record and a readable block. A failed send
  keeps the buffer for the next attempt, so lines written before the first
  status read are not lost. The ticker reads a plain counter rather than the
  reactive state, since it runs outside render.

  A verbose render log would otherwise cost one timed RPC per line and appear
  in the operation ring and the rollup, so a flush sends one batch and the
  handler caps it at 100 entries. 1100 unit tests pass, typecheck clean.

  Next: restart the CLI, because the TUI bundle is loaded at CLI start, then
  read `~/.local/share/opencode/xerj/telemetry/rings/ui.sidebar.ndjson`.

- 2026-11-06: The missing memory index was a false positive, and the store is
  restored. On boot the plugin logged `memory index was unreadable and has been
  reset`, backed `.xerj-memory-proj-…` up to `embed-backup/unreadable/` and
  deleted it, then reported it missing. The backup held all 47 entries and the
  neural vectors were intact; the index was restored in place, and a recall on
  the live node returns the telemetry design memory with its score. Nothing was
  lost.

  Cause: the node answering for that data dir was started lexical while the
  memory index held neural vectors, so the engine refused the index and
  `recoverMemoryIndex` read the refusal as corruption. The corpus indices
  survived because the embed-mode reconcile only drops `xop-*` when the
  recorded mode changes, and the recorded mode never did.

  `recoverMemoryIndex` now proves damage before acting: it runs one query and
  repairs only when that query fails. Cluster health is not evidence, because a
  stale or half-open index reports red and still answers, and memory cannot be
  rebuilt from the corpus, so a false positive costs the whole store. A
  non-green index that answers is left alone. Two tests cover both sides;
  1093 unit tests pass, typecheck clean.

  The remaining hazard is real but narrow: a node in a different embed mode
  still makes the index unreadable, and the plugin cannot tell the mode from
  the node because the banner does not carry it. Recorded under Next actions
  with the operational rule.

- 2026-11-06: Three defects behind one boot-time debug line, all fixed. The
  ring showed `archive index mapping not created` on every boot beside a healthy
  `index.archive` span, so the line looked like a settled condition.

  `ArchiveIndex` and `CommitIndex` passed a bare index name to
  `XerjClient.put` while every other caller passed a rooted path. The client
  concatenates base and path, so the URL's port read as `9267xop-…` and fetch
  rejected it as an invalid URL; the catch called that "already present" and
  logged at debug. `_bulk` then created both indices by dynamic inference, so
  `ax_path`, `hash`, `author`, `session`, and `role` are `text` rather than
  `keyword`. Retrieval was unaffected because the service reads those fields
  from `_source`, but the declared mapping never applied. The client now roots
  a path that lacks a leading slash, both indexers pass the rooted form, and a
  mapping failure that is not 400/409 warns with its reason. Verified live: a
  bare index name creates `/xop-…-docs` with the declared `keyword` field, and
  a repeat put answers 409 and logs at debug. The two live indices keep their
  inferred mapping until the index and its manifest or state file are removed
  together, which no code path needs today.

  The same ring showed `semantic leg failed; keeping lexical only` on every
  search after the docs corpora landed. The semantic query named the full index
  pattern, and the engine refuses a `semantic` query for a pattern in which any
  index maps `body` as plain text, which the system-docs, commit, and archive
  corpora do by design. Retrieval had been lexical-only since. The leg now
  names only the indices whose mapping says `semantic_text`, and skips itself
  when there are none. Verified live: the query answers with hits on the
  project index and 400s with "it is not a `semantic_text` field" when the docs
  index joins the pattern.

  The recall cost of the dead leg is measured. On an isolated node started from
  a copy of this project's engine data (362 MB, `--embed-mode neural`, its own
  port) the labeled 60-prompt eval scored 26/60 at 335 KB with the pre-fix leg
  and 39/60 at 299 KB with the fix, back to back on one corpus. Restoring the
  leg also cut injected bytes by 11%, because fusion promotes the file the
  lexical hits were burying. 1092 unit tests pass, typecheck clean. Neither fix
  is loaded in the running server; both need the OpenCode restart.

- 2026-11-06: The stale web run record is fixed, and the badge no longer flaps.
  The live store showed `ready -> degraded · index is missing; the last pass
  wrote 5 records` and back again roughly every thirty seconds. Three causes,
  all fixed.

  The web corpus spool had lost every page and its `xop-web-*` index was gone,
  but the stored run record still claimed five records. Nothing recreates that
  corpus because an empty spool has nothing to index, so the record alone made
  a healthy service read as broken. `RemoteSpool.isEmpty()` reports whether any
  page is spooled, `CorpusService.clearRun()` forgets a run and its stored key,
  and the web indexer calls both before it starts. Two tests.

  A snapshot also computed the badge twice, once from run records before the
  node was asked and once from the datasets after, and both recorded a
  transition. The first pass cannot see a missing index, so every poll logged a
  `ready -> degraded` and `degraded -> ready` pair. `StateTracker` in
  `src/telemetry/state.ts` separates `view` (no side effect) from `settle` (one
  transition per snapshot); the base pass defers and the full pass settles.
  Four tests.

  The missing index itself had a third cause. An embedding-mode change drops
  every `xop-*` index but removed only the project corpus's journal, so every
  other corpus kept a journal describing documents whose index was gone.
  Reproduced on rc.101 with a scratch prefix: delete the index, keep the
  journal, and the next pass replays the previous run document (same run id and
  generation, `records_total: 2`) while no index exists; remove the journal and
  the same pass rebuilds the index from the files. `reconcileEmbedMode` now
  removes the whole journal root, and a test asserts a sibling corpus's journal
  goes with it.

  Running the integration suite then found that the registration-time
  wrapper had been calling every tool with one argument, dropping the context
  that carries the session id and the abort signal. Every measured tool had
  lost both since telemetry landed. The wrapper moved to
  `src/tools/measure.ts`, forwards both arguments, and has its own tests.

  This closes status item 3. The live server still runs the module from before
  the fix, so the logged flap continues until the next OpenCode restart; the
  config loads the working tree, so a restart picks it up. 1085 unit and 12
  integration tests pass; typecheck clean.

- 2026-11-06: Local telemetry confirmed live after an OpenCode restart. The
  store appears at `~/.local/share/opencode/xerj/telemetry`: `ops.ndjson`
  (255 KB after the first 20 minutes), 16 type rings, per-instance rollups, a
  day of CPU/RSS samples, and one boot marker per live location. Boot, ready,
  and indexed records share a boot id and arrive in that order; the previous
  process's marker produced one `plugin` crash record, and a stale node pidfile
  produced one `node` crash record. Tool, RPC, hook, index, binary, and node
  spans all appear. The live day report shows 20+ operation types with idle and
  busy p50/p95, ten boots, sane process CPU/RSS, and a non-zero ready dwell.

  Four defects were found and fixed from the live data: the boot record could
  land after `ready`; dwell never counted the open interval of the current
  state, so a settled service read as zero; process figures mixed every node
  pid the installation ever sampled and extrapolated two minutes into tens of
  gigabytes per day; and the base status path accused startup of a missing
  memory index. Unit and integration setup now disable telemetry so their
  fixture prefixes cannot pollute the real store, and the already-written
  fixture records were removed. 1074 unit tests pass.

  Telemetry also surfaced a real, known defect in the product: the web corpus
  is `degraded · index is missing; the last pass wrote 5 records`. The spool is
  empty and no `xop-web-*` index exists, so the run record outlived its index
  and nothing recreates it. That is status item 3 below, still open.

- 2026-11-06: Defaults and timeouts pass. `node.cpus` now defaults to `odd`
  instead of leaving affinity alone, so every XERJ process shares a CPU subset
  with the editor by default; an explicit `null` or `"all"` still disables
  the change, and a malformed value warns and falls back to `odd`.
  `memory.retain.days` now defaults to 0, which the retention code already
  treats as unlimited; the 2 GiB size cap still applies. Thirteen timeout keys
  joined the options: `binary.detectTimeoutMs` (2000),
  `binary.commandTimeoutMs` (60000), `binary.requestTimeoutMs` (10000),
  `node.clientTimeoutMs` (5000), `node.writeTimeoutMs` (120000),
  `node.probeTimeoutMs` (800), `node.startupTimeoutMs` (30000),
  `node.stopGraceMs` (5000), `remote.fetchTimeoutMs` (10000),
  `context.recallTimeoutMs` (120), `context.hintTimeoutMs` (150),
  `prjdocs.requestTimeoutMs` (15000), and `prjdocs.latestTimeoutMs` (5000).
  `XerjClient` took an options object so the read and write deadlines travel
  together without a five-argument positional constructor; `EnsureNodeOptions`
  and `NodeRuntimeOptions` carry the probe, startup, and stop grace values;
  the binary manager, docs crawler, latest-version resolver, and `xerj_index`
  URL fetch all read their configured deadline instead of a module constant.
  The shipped defaults are unchanged, so nothing behaves differently until a
  key is set. Internal scheduling intervals (retry backoff, heartbeats, poll
  periods, cache TTLs, debounce, flush delay) stay constants: they schedule
  work rather than bound an operation. Unit tests grew to 1027 with a timeout
  block covering defaults, overrides, and clamping; the README options block
  and parity test carry every new key, and `plan.md` §3 shows `cpus: "odd"`.
  Typecheck clean. No release was tagged or pushed.

- 2026-11-06: The pre-compaction window archive is implemented. The
  `compaction` hook receives `event.messages` before the host builds its
  summary, so `archive/window.ts` flattens the text and tool-result bodies the
  summary is about to replace and appends them to the turn archive first. It
  keeps the newest 40 messages or about 200 KB, whichever binds first, and
  clips a single oversized message rather than dropping it. Media, reasoning,
  and compaction parts are skipped because they are large, private, or not
  project text. A `system` record marks where the captured block starts, so
  `xerj_expand` shows `S:` for it; `TurnRole` gained `tool` and `system`, and
  the expansion labels them `T` and `S`. Message ids are remembered per
  session, so a retried compaction appends nothing; a message without an id
  gets a hash of its role and text. Only sessions this instance prompted are
  captured, the tracked-session map is bounded at 200, and a failed write is
  logged so compaction still completes. `TurnArchive.appendBatch` writes the
  whole window and prunes once instead of paying a stat per message. Eleven
  module tests cover flattening, part filtering, dedupe, the no-id fallback,
  both limits, the marker, ownership, and the failure path. 1023 unit tests
  pass; typecheck clean. No release was tagged or pushed.

- 2026-11-06: Post-compaction rehydration is implemented, so the defect that
  motivated it is closed: the host's summary drops the passages a session was
  working from, and the plugin no longer goes quiet at exactly that point. On
  `session.compaction.ended` the session's current `path:line` working set is
  snapshotted and the dedupe sets are cleared. On the next model call,
  `src/rehydrate.ts` re-reads up to three of those files and appends a
  `<xerj-recall>` block with a 24-line window around each cited line, capped at
  `context.rehydrateTokens * 4` bytes (600 tokens by default). The block is
  charged to the ledger through `onCost`, its keys join the session dedupe set,
  and it is sent once. A fresh retrieval with real hits supersedes it, because
  the new question has already been answered from the index. Paths are resolved
  against the project root and refused outside it; URLs, index ids, missing
  files, and files above 1 MiB are skipped silently. The read is raced against
  a 120 ms deadline so a slow disk cannot delay a turn; a miss injects nothing.
  `context.rehydrate` (default true) and `context.rehydrateTokens` (default
  600, 0 disables) are the new keys, added to the README block and table, and
  the parity test now covers them.
  The summariser's own request is suppressed through a new
  `session.hook("model.request")` registration: `kind: "compaction"` marks the
  session and the `context` hook returns before injecting anything; the next
  non-compaction request clears the mark. Before this, the corpus block was
  also being offered to the compaction request, which is wasted tokens. A
  prepared block for a message the compaction swallowed is dropped on
  `session.compaction.ended`. Ten module tests and five hook tests cover the
  window, the three-citation limit, exclusion, path refusal, the byte cap, the
  snapshot, the one-shot behaviour, the fresh-retrieval supersede rule, the
  deadline, and both sides of the suppression. 1012 unit tests pass; typecheck
  clean. No release was tagged or pushed.

- 2026-11-06: The last two Tier S items are implemented, so the tier is
  fourteen of fourteen. `node.cpus` accepts an index list with inclusive ranges
  (`"0-3,8"`), `odd`, `even`, or a percentage; `null` and `"all"` leave affinity
  alone. `src/node/priority.ts` owns parsing, resolution, and application.
  Linux reads the process's real affinity mask from `/proc/self/status` and
  applies `taskset -a -pc <list> <pid>` so the scan pool's threads are covered;
  a cgroup or a parent `taskset` therefore narrows the available indices rather
  than being overwritten. Windows builds a 64-bit `ProcessorAffinity` mask and
  emits bit 63 as a negative `IntPtr`; a set that needs a second processor group
  warns and is skipped. macOS warns once because it has no per-process CPU
  selection. A percentage is a share of that available set (the affinity mask
  on Linux, `os.availableParallelism()` elsewhere), rounded down to at least
  one CPU. The key is wired into the node, project and web watchers, and
  brain runs; brain runs also gained the `priority` they had been missing.
  `index.workers` capping is not implemented: the engine already defaults to
  its own worker count, and the roadmap row's capping sentence was dropped.
  Verified live on this 64-CPU host: a spawned `sleep` was pinned to CPU 0 and
  `taskset -pc` reported `current affinity list: 0`. 29 new unit tests cover
  parsing, formatting, resolution, platform application, and warnings; 994 unit
  tests pass, typecheck clean.
  The README options block is now one key per line with comments and includes
  all 61 defaults; `test/unit/config-example.test.ts` flattens
  the block and compares every key and value with `DEFAULT_CONFIG`, so a new
  option cannot land without updating the example. `plan.md` §3 is a short,
  readable subset that points at the README for the full set. No release was
  tagged or pushed.

- 2026-11-06: Two Tier S roadmap items added at the user's request, neither
  started. `node.cpus` is the CPU-affinity key: one string accepting explicit
  logical CPUs and inclusive ranges (`"0-3,8"`), `odd`, `even`, or a percentage
  of the available CPUs with the count rounded down to at least one; `null`
  leaves affinity alone. The design records the platform split (`taskset -a -pc`
  on Linux so the scan pool's threads are covered, `ProcessorAffinity` on
  Windows with a 64-CPU mask ceiling, and a single warning on macOS, which has
  no per-process selection), resolves percentages with
  `os.availableParallelism()` so a cgroup quota counts, and caps `index.workers`
  to the resolved set. Parsing and application belong in `src/node/priority.ts`
  beside `applyPriority`. The second item rewrites the complete-default options
  block in the README and the copy in `plan.md` §3 as one key per line; the
  README block omits 21 defaults today (verified against `DEFAULT_CONFIG`: 39 of
  60 keys present, nothing extra) and the `plan.md` copy is staler still, with
  `context.maxPassages` reading 4 against a default of 8. Its done criterion is
  a parity test. No code changed.

- 2026-11-06: Root cause of the `/xerj-prjdocs` failure found and fixed. It was
  never the node or the crawler: `valueSchema` marked every declared property as
  required, so the host rejected the call with `rpc.invalid_input` before the
  handler ran. The command sends `{}` for an ordinary run, but the schema
  demanded `eager`, and in the working tree also `keywords`; `/xerj-wrapup` had
  the same fault with `sessionID`. Reproduced against the live server on 0.7.0:
  `{"input":{}}` answers `Missing key at ["eager"]`. So a normal
  `/xerj-prjdocs` never worked through the RPC in any published version, and it
  left no trace because the rejection happens outside the plugin.
  `valueSchema`/`object` now accept the optional keys; the unit suite validates
  the exact payloads the TUI sends against the same definition the host uses,
  and the TUI stub client validates every call. Verified end to end on a
  private server: `{}` now returns `{"targets":1,"indexed":1,...}`. Also fixed
  `describe()` to read the plain `{type, message}` shape the RPC client throws,
  which otherwise printed `[object Object]`. 965 unit and 12 integration tests
  pass, typecheck clean.

- 2026-11-06: `/xerj-prjdocs` failed in another project with a generic toast.
  The message was the defect: every command catch discarded the reason, so
  "could not read project documentation" could have been an unavailable RPC, a
  node that did not start, or a crawl error. All five catches (project docs,
  system docs, reindex, remember, search, wrapup) now print the cause, the
  server part logs failures into the ring so the panel shows them, and a node
  that refuses to start reports its startup error. The indexer itself was
  exercised against a scratch React project (715 pages), an empty folder, and a
  folder with a malformed `package.json`: all three complete, so the failure is
  not in detection or crawling. The most likely remaining cause is a cold node
  on that project's first run, where the embedding model has to be fetched; the
  next attempt will say so. 956 unit and 12 integration tests pass.

- 2026-11-06: Tier S complete: the sidebar rebuild landed (3.0 h against an 8 h
  plan). `src/ui/prefs.ts` reads and writes the shared
  `tui-preferences.jsonc` under key `xerj` with a JSONC-tolerant parser and a
  merge that leaves AFT's and Magic Context's blocks intact; `order` is not
  offered because this host's slots take `prepend`/`append` only.
  `sidebarView` in `src/ui/format.ts` is a pure function producing a header, three
  collapsed rows, and five sections (corpora, session, savings, runtime, health)
  with tone hints, so every figure stays server-owned. `src/tui.tsx` renders a
  bordered box with a `▼ XERJ` badge, version, header click to collapse, an
  inline `⚠` for an error or warning, and a 150 ms refresh debounce. The
  collapse signal lives in the setup closure, so a view switch does not reset it.
  Two defects were caught by the new tests: the render tests wrote the real
  user preferences file (now isolated through
  `OPENCODE_TUI_PREFERENCES_FILE`), and the sidebar re-rendered once per event
  rather than once per burst. 955 unit and 12 integration tests pass, typecheck
  clean. Tier S is twelve of twelve at 12.9 h estimated.

- 2026-11-06: Sidebar rebuild added to the roadmap as the last Tier S item, not
  started. Read from the installed packages (`aft-opencode` 0.62.0,
  `opencode-magic-context` 0.49.23): both render a full component into
  `sidebar.content` with a single-border box, a `▼ LABEL` accent badge header,
  a version on the right, click-to-collapse through `onMouseDown`, a three-row
  summary when collapsed, named sections with right-aligned values when
  expanded, and preferences in `$OPENCODE_CONFIG_DIR/tui-preferences.jsonc`
  under a per-plugin key with an echo guard against their own file watcher.
  Ours renders four muted strings with no border, header, state, or prefs. The
  roadmap row carries the mapping to our existing `StatusSnapshot` sections
  (corpora, session, savings, runtime, health), the 150 ms debounce, inline
  failure rows, the `xerj` prefs key, and about 8 h across five pieces. Tier S
  reads eleven of twelve done.

- 2026-11-06: Post-compaction rehydration added to the roadmap as a Tier M item,
  not started, deferred by the user. Design: on `session.compaction.ended`
  snapshot the per-session injected `path:line` set, which is cleared today, then
  on the next `context` call prefer those paths and inject two or three passages
  once, under `context.rehydrateTokens` (600) and a `<xerj-recall>` marker. It
  closes a real gap: after compaction the model often continues the same turn,
  so no new prompt arrives and nothing is retrieved until it does. Alternatives
  are costed in the row (summary-seeded retrieval about 4 h, model-judged about a
  day plus a gate). One defect the analysis surfaced is recorded there too: the
  `context` hook cannot see the request kind, so injection may run while the
  summariser itself is being called; `model.request` with `kind: "compaction"`
  is the available signal to suppress it. Tier M is seven of fourteen items done.

- 2026-11-06: Roadmap now carries both halves of pre-compaction work as separate
  Tier M items, neither started, at the user's request. `Pre-compaction window
  archive` fixes the design: flatten the text parts of `event.messages` into the
  existing archive, last N messages or about 200 KB, deduped by message id
  against compaction retries, media parts skipped, and a marker so `xerj_expand`
  shows where the captured block starts. `Fact mining from the compaction
  window` carries both routes with costs (heuristic about 2 h, one bounded model
  call about 3 to 4 h) and the conditions before it defaults on: a precision
  measurement, a `derived` memory kind, reuse of the stale flag, and a new
  `memory.extract` gate, off by default. Tier M is seven of thirteen items done, six of them from this pass.

- 2026-11-06: Checked what a plugin can see when compaction starts. `ctx.session.hook("compaction", handler)` is a real hook and its event is `SessionCompaction`, which extends `SessionContext`: the handler receives `messages` and `system` before the summary exists, so the whole window is available, including tool calls, tool output, and intermediate assistant text that the turn archive never records. `SessionCompaction.result` also lets a plugin supply its own `summary` or a `native.messages` replacement window and skip the model request; that is the compaction engine already listed as a non-goal, so it stays unused. `session.compaction.ended` still fires afterwards with only the summary text. Recorded in the roadmap as Tier M `Pre-compaction capture`, not started: archive the window behind a size cap and, separately, mine it for durable facts. No code changed.

- 2026-11-06: Grammar source decided, and the reference-corpus surface checked.
  The user accepted the full `tree-sitter-wasms` pack (0.1.13, 51.8 MB, all
  languages), so the tree-sitter item is no longer blocked; it downloads once
  through the verified path into `<data root>/grammars/<version>/` with a pinned
  checksum beside the cache. Work on it is deferred at the user's request and
  `analysis.treeSitter.enabled` stays closed. Separately, `xerj --help` on
  rc.100 was checked for the reference-corpus feature: `xerj corpus` exists with
  `add`, `own`, `build`, `sign`, `keygen`, `index`, and `list`. `add` clones a
  git URL and writes into `corpora/<name>/`, so `xerj_code` needs network
  consent and a gate of its own; it is not an always-on tool. No code changed
  in this entry.

- 2026-11-06: History search over the turn archive (Tier M, 1.0 h). Each
  archived turn is one document in `<prefix>-archive-docs`, idempotent by a hash
  of session and ordinal, with a manifest at `<node dir>/archive/index.json` so
  a turn that pruning removed also leaves the index. The corpus joins the search
  prefixes, so `xerj_search` reaches earlier conversation, and it appears as its
  own `archive` dataset instead of inflating the project row. Five module tests.
  939 unit and 12 integration tests pass, typecheck clean. Tier M now has six of
  nine items done (7.5 h estimated): import graph, regex and glob search,
  structural search, the archive, expand, and history search. Remaining: the
  tree-sitter layer with the complexity work it enables, `xerj_code`, and
  `xerj_ask`.

- 2026-11-06: Tier M started and four items done (6.5 h estimated). Added
  `xerj_imports` (import graph and cycles without a parser: relative
  specifiers with extension swapping, Python modules, same-module Go paths,
  Rust `crate::` paths, unresolved specifiers counted rather than guessed),
  `xerj_find` (regex with line numbers and glob path search over the same tree
  the indexer reads), `xerj_ast` (structural search through `ast-grep` when
  installed, pattern passed as an argument, `run` never a rewrite), and the
  turn archive plus `xerj_expand` (`archive/turns.ts`, one NDJSON file per
  session under the node directory, bounded by `context.archive.maxBytes`).
  Tool surface is now nineteen, up from fifteen: imports, find, ast, and
  expand joined it. 934 unit and 12 integration tests pass, typecheck clean.
  Remaining in Tier M: history search over the archive, the tree-sitter layer
  (blocked on the grammar source), complexity and duplicates, `xerj_code`, and
  `xerj_ask`.

- 2026-11-06: Tier S complete (9.9 h estimated, eleven items). Added since the
  last entry: the data map in the panel (record kinds from a `terms`
  aggregation), `prjdocs.eagerKeywords` surfaced in the status, panel, and
  command description, the auto-search hint (`search({ hint: true })` skips the
  word gate with a 150 ms deadline and injects one `<xerj-hint>` line naming the
  candidate), and memory curation (`memory/curate.ts`: an exact duplicate of an
  automatic summary is dropped, any other repeat is flagged `duplicateOf` and
  never deleted). Also fixed the MCP integration test, which still expected
  twelve tools after refs, outline, and zoom were added. 891 unit and 12
  integration tests pass, typecheck clean. The roadmap's progress table carries
  status, estimate, and the commit for each item.

- 2026-11-06: Tier S begun: seven of eleven items shipped, with the time spent
  recorded per item in `roadmap.md`. Done: the compaction dedupe reset
  (`165af5c`, 0.5 h), `/xerj-wrapup` (`ea98e68`, 0.5 h), `xerj_refs`,
  `xerj_outline`, and `xerj_zoom` (`5a42bae`, 2.0 h together), git history as a
  corpus (`7336268`, 2.5 h, including the `git log` record-layout fix), and
  memory verification (`baac28d`, 1.5 h). The tree stands at 877 unit tests,
  typecheck clean. Remaining in S: the auto-search hint, memory curation,
  `autoindex map` in the panel, and surfacing `prjdocs.eagerKeywords` in the
  panel and command help. Tier M is untouched; the grammar source decision
  still gates the tree-sitter item. Estimated 7.2 h spent against 8 to 10 h for
  the tier, and the per-item estimates held within about half an hour except
  commit indexing.

- 2026-11-06: Toolchains assumed present (0.7.0 plan). The installer no longer
  treats a missing compiler as a reason to withhold a language: gopls and
  clangd publish their own binaries, so the server installs and loads whether
  or not `go` or `clang` exists, and no preflight check looks for them. If a
  server later needs its compiler, the first query returns that server's own
  error for that language and every other language keeps working; the panel
  names the failure. The compilers themselves remain the project's dependency
  management and are never installed. clangd's size is flagged as large (it
  ships inside LLVM release archives) and is measured before a version is
  pinned. Risks gained the load-without-toolchain case and the
  loads-but-cannot-answer case, replacing the old preflight row; the non-goal
  now says the plugin never gates a language on the toolchain being present.

- 2026-11-06: LSP servers auto-detect and auto-install (0.7.0 plan). With
  `analysis.lsp.servers` empty, the plugin now detects the project's languages
  and resolves a server in one order: the configured command, the project's
  `node_modules/.bin`, `PATH`, then the plugin's cache; if none is found and
  `analysis.lsp.autoInstall` (default true) is set, it installs a pinned server
  into `<data root>/lsp/<language>/<version>/` and probes it with `--version`.
  A non-empty `servers` map still names commands and turns auto-install off.
  Registry measurements: the npm set totals about 26 MB (typescript 2.5 MB,
  pyright 19.5 MB, vscode-langservers-extracted 0.9 MB,
  yaml-language-server 1.2 MB, bash-language-server 2.3 MB), each recorded in
  the roadmap. Safety rules: pinned version and checksum beside the cache,
  `--ignore-scripts` for npm installs, a probe before first use, an install
  target outside the project, and one daily retry after a failure. Go and
  clangd need toolchains the plugin will not install, so those languages are
  reported instead; the non-goal changed from "auto-installing language
  servers" to "installing a language toolchain". Tier L gained a server
  installer row and sequencing gained an offline-install gate.

- 2026-11-06: Gate behaviour made explicit (0.7.0 plan). Added a "What enabling
  a gate does" subsection with a row per key: at the default configuration no
  language is detected for analysis, no grammar is requested, no server probed,
  no process started, no port opened, no network call made. Enabling
  `analysis.treeSitter.enabled` detects the project's languages and downloads
  their grammars once into `<data root>/grammars/<language>/`, checksum-verified
  and cached, with a failed download disabling only that language. Enabling
  `analysis.lsp.enabled` downloads nothing: it resolves a server from
  `servers[language]`, then `<project>/node_modules/.bin`, then `PATH`, and a
  missing one logs a warning naming the key while other languages keep working.
  Two rules state the split (grammars are ours and download; language servers
  are the project's and never install) and that enabling a gate never writes to
  the project. The grammar source is left as a Tier M decision between the
  pinned `tree-sitter-wasms` pack (51.8 MB, 0.1.13) and per-language release
  assets, with a pinned version and checksum either way. The LSP non-goal now
  reads "auto-installing language servers" and names the dependency management
  it leaves to the project.

- 2026-11-06: `xerj_share` and `xerj_ask` are configurable, off by default
  (0.7.0 plan). Three keys joined the gate block: `share.enabled` (false)
  registers the share tool, `hub.enabled` (false) registers `xerj_ask` and the
  hub commands, and `hub.network` (false) allows the catalogue and pack
  downloads, leaving already-cached packs as the only thing that answers. The
  gate section now covers a listener and network access, not only runtimes, and
  its closed matrix gained both rows (share: not registered; ask: not
  registered, or cached-only when the network stays closed). Tier M and Tier L
  rows name their keys, the closed-default rationale names an open port and a
  remote catalogue, and constraint 6 names the keys that permit outbound
  traffic. The open-decisions section became a Settled decisions table: who
  compacts, whether the plugin writes, whether a tool may open a listener, and
  whether a tool may reach the network. The config block was parse-checked as
  JSON.

- 2026-11-06: Edits are a non-goal (0.7.0 plan). The roadmap's edit family is
  gone from the tiers, the config block, the gate table, the closed-behaviour
  matrix, the risks, and the open decisions. A sixth constraint states the
  invariant: the plugin is read-only, so a bug costs a bad citation rather than
  a file. The reasons are recorded in non-goals: a plugin that writes can lose
  work through a partial write, a wrong range, or a concurrent writer, and a
  checkpoint stack beside git gives two recovery stories that disagree. Only
  one edit feature had a unique benefit (bulk AST replace), and the read-only
  routes cover the rest: `xerj_zoom` supplies exact text for the host's `edit`,
  `xerj_refs` shows every site first, and `ast-grep` search lists matches. A
  read-only structural search joined Tier M, gated on the binary being on
  `PATH`. Tier XL now holds only dreamer curation and notes; two open decisions
  remain, share and hub network access. Tier S and M are unchanged in order.

- 2026-11-06: Roadmap change: the host keeps compaction (0.7.0 plan). Constraint
  2 now states that compaction belongs to the harness, so the plugin keeps an
  append-only turn archive and reads the host's summary from
  `session.compaction.ended`; nothing rewrites a message. Tier S gained the
  defect it exposed (the per-session injected-location set never clears, so
  after a host compaction the plugin skips passages the summary dropped) and
  `/xerj-wrapup` as a thin trigger of the host's compact endpoint. Tier M gained
  the archive, `xerj_expand`, and history search, bounded by
  `context.archive.maxBytes` (64 MB) with `context.archive.enabled` on, since
  they are data rather than a runtime and therefore not capability gates. The
  compaction engine (compartments, `ctx_reduce`, `/ctx-recomp`, cache-TTL
  mutation scheduling) became a non-goal with a revisit condition: only if the
  host exposes a compaction API a plugin may drive. Risks dropped double
  compaction and gained archive growth, archive surprise, and the hidden-passage
  case. Open decisions fell from four to three: compaction is settled.

- 2026-11-06: Roadmap gates (0.7.0 plan change). Every capability that adds a
  parser or a resident process now sits behind a closed configuration gate,
  named per capability and never a build flag: `analysis.treeSitter.enabled`,
  `analysis.lsp.enabled`, `analysis.edits.enabled`, and later
  `context.compact`, `memory.curate`, `context.notes`. The roadmap gained a
  Capability gates section with the config block, a key table, a per-capability
  closed-behaviour matrix (a gated tool is not registered, `xerj_inspect`
  degrades to its index-only part, retrieval is byte-identical), and five rules:
  no registration when closed, no retrieval dependency, gates named in status
  and panel, first use downloads visibly with a checksum, and no residue. Tier
  M, L, and XL tables carry a Gate column; sequencing now requires each tier to
  ship closed and prove both directions with a test. Risks gained rows for a
  gate opening unnoticed, an open gate with a missing toolchain, and a gated
  tool leaking processes; non-goals gained never enabling `analysis.*` by
  default and never letting one key control two capabilities. The open
  decisions lost their blocking character: each now has a safe default.

- 2026-11-06: Wrote `.agents/roadmap.md`: a formal, prioritized plan for
  absorbing the CortexKit plugins and exposing more engine features. Sources
  measured from the installed packages (`opencode-magic-context` 0.49.23,
  `aft-opencode` 0.62.0). Candidates are scored on suitability (does it improve
  retrieval, tokens, or access) and effort in working weeks; tiers run S (one
  week) through XL (more than six). Five constraints shape it: the host exposes
  22 plugin domains and no LSP, so a language-server pool would be ours to run;
  compaction replaces Magic Context rather than joining it; grammars download
  lazily through the existing verified-download path instead of shipping 52 to
  100 MB in the package; every runtime reads only the canonical project root;
  and nothing leaves the machine without an explicit opt-in. Baselines are
  recorded (p50 2.5 ms and p95 82 ms retrieval, 970 MB node RSS, 105 s cold
  index, 4.5 s type-check of 132 files, 88.3% coverage). Non-goals are named
  with reasons: desktop app, LSP auto-install matrix, a second shell, silent
  field reports, bundled grammars, and rewriting `read`/`grep` inputs. Four
  decisions are left open to the user: compaction, share, hub network access,
  and whether the plugin writes files. Tier S and M depend on none of them.
  `plan.md` gained a pointer to the roadmap and lost a stale claim that the
  plugin ships no MCP server.

- 2026-11-06: Coverage and structure pass (0.7.0). `PrjdocsIndexer.run` was at
  cyclomatic complexity 39 after the keyword work; the three target-collection
  steps (builtins, keywords, detected techs) are methods now and `run` reads as
  a sequence. New tests: process sampling edge cases, the ecosystem detector,
  documentation sources for the automation stack, keyword targets that resolve
  to nothing, a duplicate or one-letter keyword that must not search, and the
  sidebar and panel branches for no runs, an unknown file count, an embedding
  pass, day-scale idle stops, a single session, a node with no idle deadline,
  and a negative net token cost. Unit coverage 88.3% of lines, 89.8% with
  integration; 844 unit and 12 integration tests pass; no duplicated code.
  Remaining uncovered code is the MCP host runner tools (a subprocess), the
  plugin's own wiring inside a live setup, and supervisor/watcher paths that
  need a fake clock.

- 2026-11-06: Automation ecosystems, eager keywords, and the panel's new
  figures (0.7.0). Detection covers Ansible (`ansible.cfg`, `site.yml`,
  `roles/`, `hosts:`/`become:` markers, `ansible.*` modules), community
  collections (`requirements.yml` with `collections:`, `community.*`
  references), NetBox (`pynetbox`, `netboxcommunity/netbox` images,
  `NETBOX_*`), and the HashiCorp products (Terraform blocks and `.tf`,
  `.tfvars`; Vault `path` blocks and `VAULT_*`; Consul `service`/`connect`
  blocks; Nomad `job` blocks and `.nomad`; Packer `source` blocks and
  `.pkr.hcl`; Vagrant `Vagrant.configure` and `Vagrantfile`; Boundary and
  Waypoint from their environment and CLI markers). New module
  `src/prjdocs/ecosystems.ts`. Each has a source bounded to its own path.
  Measured documents: Ansible 60, collections 80, NetBox 24, Terraform 56,
  Vault 50, Consul 50, Nomad 50, Packer 40, Vagrant 30, Boundary 30,
  Waypoint 20.
  Eager mode accepts `prjdocs.eagerKeywords` and a `keywords` argument on
  `xerj_prjdocs` and the MCP tool: each term is searched through the
  discovery path and crawled even when the project does not use it.
  The panel reports datasets by size with their share, documented
  frameworks with documents and bytes, the node's CPU and RSS (sampled from
  `/proc`, `src/process-stats.ts`), and whether embeddings are being built;
  the sidebar appends `embedding` during a pass. Project-doc documents now
  store `bytes`, so the framework sizes are measured rather than estimated;
  existing documents show 0 until the next run. 834 unit and 12 integration
  tests pass.

- 2026-11-06: GPU stack coverage raised from a front page to the collections
  (0.7.0). Sources can name component seeds: CUDA's cuBLAS, cuFFT, cuSPARSE,
  cuSOLVER, cuRAND, NPP, libdevice, maths API, cudla, best practices, compiler
  guide, cuDNN, and NCCL; ROCm's HIP, rocBLAS, hipBLASLt, MIOpen, RCCL,
  rocFFT, hipFFT, rocPRIM, hipCUB, rocSPARSE, rocSOLVER, rocRAND, rocWMMA,
  composable_kernel, and rocDecode; oneAPI's specification plus oneTBB,
  oneDNN, and oneCCL; Vulkan's guide and specification chapters; SYCL's spec.
  Each seed is crawled inside its own directory with at least eight pages and
  a shared budget: 200 CUDA, 150 ROCm, 120 Vulkan, 80 oneAPI, 40 SYCL. CUDA's
  page limit is 8 MB because its library guides are single multi-megabyte
  pages, and its programming guide alone is 3.5 MB.
  Seeds crawl four at a time: seventeen simultaneous requests to
  docs.nvidia.com came back empty, while the same seeds batched returned their
  guides. ROCm now resolves its newest release from its docs landing page
  (`AMD ROCm 10.1.0`), so a pinned 10.1 and the latest collapse into one target.
  Measured: CUDA 126 docs/16.0 MB, ROCm 150/1.3 MB, SYCL 29/1.4 MB, oneAPI
  80/0.4 MB, Vulkan 112/9.2 MB — 497 documents and 28.4 MB for a project using
  all five, against 73 before. 807 unit and 12 integration tests pass.

- 2026-11-06: Intel oneAPI awareness (0.7.0). Detection reads the oneAPI
  headers and namespaces (oneMKL, oneDNN, oneTBB), the Level Zero API
  (`level_zero/ze_api.h`, `zeInit`), `dpcpp`/`icpx`, `ONEAPI_ROOT`, an
  `intel/oneapi-*` base image, and Intel's packages (`mkl`,
  `intel-extension-for-pytorch`, `scikit-learn-intelex`,
  `oneccl_bindings_for_pytorch`). The SYCL stack no longer reads a oneAPI
  toolkit version from `intel/oneapi-basekit`; that belongs to oneAPI.
  The docs source is the UXL Foundation specification, because Intel's own
  site answers non-browser clients with Access Denied (measured: 403 body,
  477 bytes). That section shares its host with foundation news, so
  `DocsSource` gained an unversioned `prefix`, and the crawl stays inside
  `/specifications/oneapi/`: 3 pages, 18 KB, nothing outside. 801 unit and
  12 integration tests pass.

- 2026-11-06: GPU compute documentation (0.7.0). `/xerj-prjdocs` now detects
  CUDA, ROCm, SYCL, and Vulkan from kernel files (`.cu`, `.cuh`, `.hip`, shader
  extensions), toolchain headers, distinctive calls (`__global__`,
  `hipMalloc`, `vkCreate*`, `sycl::queue`), build markers
  (`find_package(Vulkan)`, `nvcc`, `hipcc`, `-fsycl`), version pins in
  Dockerfiles and CMake, and their packages (`cupy`, `pycuda`, `ash`,
  `vulkano`, `adaptivecpp`). New module `src/prjdocs/gpu.ts`.
  CUDA and ROCm are versioned: CUDA resolves its newest release from the
  archive listing and uses the `archive/<x.y.z>/` hub, ROCm the
  `docs-<x.y.z>` path, and a project that pins nothing falls back to the
  current guide. The CUDA programming guide is a single 3.5 MB page that the
  crawler's 2 MB limit drops, which is why the entry is the hub that links
  every guide. A versioned target now carries `urlPrefix`, so a crawl cannot
  follow a page's links into another version: without it the ROCm 6.2 crawl
  pulled `latest/`. SYCL uses the Khronos landing page plus the specification
  with a 6 MB page limit. Measured live: CUDA hub 12 pages/569 KB, ROCm 6.2
  12 pages with zero outside its version path, SYCL 1.3 MB, Vulkan guide
  12 pages/64 KB. 797 unit tests pass, `src/prjdocs/gpu.ts` at 100%.
  The memory index deletion was the user's own reset, not a defect.
Pinned by 24 new tests across detection, sources, latest-version
resolution, and the indexer, including an end-to-end case where a CUDA
project requests only `docs.nvidia.com` archive pages for its pinned
version.

- 2026-11-06: Cleanup pass (0.7.0, after the release tag). `src/manifest.ts` now
  holds the manifest reader and writer the project-docs and system-docs
  indexers both kept, which removes 46 duplicated lines and keeps one rule for
  a corrupt file. Exports with no importer became module-internal (`docsSource`,
  `documentId`, `bodyHash`, `scanProject`, `corpusModePath`, the MCP protocol
  constants, two formatting helpers, the harness logger), and the unused
  `DumpEntry` interface is gone. `prjdocs/sources.ts` used an inline `import()`
  type that the parser rejected; a normal type import replaced it. Six manifest
  tests cover a missing file, a round trip, a corrupt file, non-object values,
  directory creation, and a failed write that logs. Unit coverage 87.8% of
  lines, 94.0% of functions; 768 unit tests pass. Remaining gaps need a fake
  clock or several processes: `mcp/host.ts` runner tools, the plugin's own
  wiring in a live setup, supervisor port-scan exhaustion, and watcher restart
  backoff.

- 2026-11-06: v0.7.0 tagged, pushed, and staged on npm. The first tag run
  failed on two sysdocs tests that passed locally: neither isolated `roots`, so
  the indexer also scanned `/usr/share/man`, which timed out one test and made
  another prune pages it never wrote. Fixed by an empty root list; the file now
  runs in 36 ms. The tag was moved (never published) after that fix and again
  after two workflow fixes. The `NPM_TOKEN` in the `npm` environment is
  staging-scoped: `npm publish` returns E403/E_STAGE_REQUIRED, `npm stage
  publish` (npm 11, so the job installs it) puts the version in the staging
  area, and a second stage answers 409 "Cannot stage previously published
  version", which the workflow now treats as success. 0.7.0 is staged and
  awaits approval at npmjs.com; `npm view` still reports 0.6.8 as latest. The
  GitHub release points at tag `v0.7.0` (c66ebba).

- 2026-11-05: Eager mode covers the whole Elasticsearch guide (0.7.0). In eager
  mode the reference crawl seeds from the guide's `index.html` instead of
  `rest-apis.html`, follows links one level deeper, and filters links, so
  concepts, configuration, and operations pages come in. Release notes,
  migration guides, and deprecated-API pages are excluded both as seeds and as
  links, because they describe versions other than the one the node serves.
  `crawlDocs` gained `urlFilter` for that. Measured: default 632 API pages in
  38 s, eager 1437 pages in 114 s with zero excluded pages. 759 unit tests pass.

- 2026-11-05: Coverage pass on this week's modules (0.7.0). New branches: the
  Elasticsearch chapter discovery plus its fallback list, a failing chapter that
  does not stop the others, the `urlPrefix` boundary, asset links never
  followed, and the title fallback for markdown without a heading; dataset
  export and import through the tool, including a created index and skipped
  lines; the hidden indexer's `start()` watcher, a new file reaching it through
  the debounce, and an empty root list; the system docs indexer not recreating
  an index, a mapping failure as a warning, manifest rows dropped after a prune,
  an uncompressed info page beside a non-gzip one, truncation, and a corrupt
  manifest rewritten. The MCP integration test now expects twelve tools, which
  it had missed since the dataset tool landed. 756 unit and 12 integration tests
  pass; coverage 88.8% lines, 95.1% functions. Remaining gaps need a fake clock
  or multiple processes: supervisor port-scan exhaustion and waitForNode,
  watcher restart backoff to the maximum, and the plugin's own wiring inside a
  live setup.

- 2026-11-05: The Elasticsearch reference was a sliver, not the API. Ten
  documents was the page budget, and the crawl from `index.html` spent it on
  chapter summaries while following every same-origin link, which pulled in
  company blog posts. Fixed three ways: the crawl starts at `rest-apis.html`,
  takes the chapter indexes it links, and crawls each chapter separately with a
  share of the budget; `crawlDocs` gained `urlPrefix` so links outside the docs
  branch are never followed; and `prjdocs.builtinRefreshDays` (7) keeps the
  minute-long crawl to a weekly refresh, holding the existing pages in the
  manifest while it waits. Live: 632 API pages in 38 s including
  `indices-create-index`, `docs-bulk`, `cat`, and `query-dsl-term-query`; the
  corpus went from 1500 mixed blog and guide documents to 632 API pages, 869
  stale ones pruned. New defaults: `builtinElasticsearchPages` 2500,
  `builtinXerjPages` 200, `builtinRefreshDays` 7. 739 unit tests pass.

- 2026-11-05: `/xerj-prjdocs` always includes XERJ's own docs and the matching
  Elasticsearch reference (0.7.0). `src/prjdocs/builtin.ts` lists every `.md`
  under `docs/` in `xerj-org/xerj` through the GitHub tree API (one request),
  fetches the raw files six at a time, and titles each by its first heading; the
  ES source crawls the reference branch for the node's wire version, so 8.13.0
  means `reference/8.13`. Config: `prjdocs.builtin` (true), `builtinXerjPages`
  (200), `builtinElasticsearchPages` (20). Builtins are off unless the caller
  asks, so library calls and tests stay offline; the command and the MCP tool
  opt in from config. Verified live: 179 XERJ pages plus 10 ES pages in one
  run, 201 pages in 7 s; "agentic memory recipe" cites
  `recipes/agentic-memory.md`, and the ES documents carry version 8.13.
  736 unit tests pass.

- 2026-11-05: README covers every surface (0.7.0). The TUI section is now a
  command table: `/xerj` with its `status`, `reindex`, `remember`, and `search`
  subcommands, plus `/xerj-reindex`, `/xerj-remember`, `/xerj-search`,
  `/xerj-prjdocs [eager]`, and `/xerj-sysdocs`, the panel's three ways to
  close, and the RPC methods behind them. The MCP section gained client setup
  for Claude Code and Cursor, the entry arguments, the twelve-tool table, a
  sample session, and the structuredContent note. The overview now lists the
  graph corpus, system docs, library docs, datasets, and MCP; the data section
  names both documentation manifests; and the stale "upgrades require the same
  major" limitation is corrected to the actual `auto` rule.

- 2026-11-05: Dataset management and dump import/export (0.7.0). `xerj_dataset`
  has six actions (list, describe, create, delete, export, import) and is shared
  by the plugin and the MCP server through `buildTools`, so both surfaces gained
  it at once. Export pages through `_search` and writes the `_bulk` dump format
  (action line plus source line), which `elasticdump` and `_bulk` read back;
  import streams line by line, creates a missing target index, batches writes,
  counts malformed lines as skipped, and generates ids when a dump has none.
  Indexes the plugin maintains (`xop-*`, `.xerj-*`, `.xerj_*`) are reported as
  managed and need `force` to delete. Verified on the live node: create with a
  mapping, two documents, export to NDJSON, delete, import back, counts read 2
  and the mapping survived. 21 service tests and 8 tool tests; 727 unit tests
  pass.

- 2026-11-05: Pre-release parity and a CI build check (0.7.0). The plugin now
  exposes the same eleven tools as the MCP server: `reindex`, `sysdocs`, and
  `prjdocs` joined the eight. The three bodies live in runners that the RPC
  methods, the TUI commands, and the tools all call, so the surfaces can no
  longer drift. CI gained a `build` job that builds both bundles and runs the
  MCP entry point under Node with `--help` plus a real handshake, which is the
  failure that reached a release once and that the suites cannot see.
  Verified locally: the Node handshake lists all eleven tools, and the README
  tool and config tables carry every new key. 698 unit and 12 integration tests
  pass.

- 2026-11-05: Coverage pass (0.7.0). Measured across unit and integration:
  85.55% to 88.69% lines, 92.62% to 94.96% functions, 698 tests. New suites:
  counters, the latest-version resolver, and the MCP host (settings, paths, the
  static tool list, and a boot that attaches to a stand-in node instead of
  spawning). New branches: memory-index repair with a refused list or delete,
  hidden indexing of an oversized document, the empty-folder warning firing
  once and clearing, a run queued during a run, a mapping error that is not
  400/409, crawler plain-text and markdown extraction plus size and status
  limits, a discovered URL cached across a restart, project-doc ingest failure
  and re-ingest after a change, system-doc extraction failure and a failed
  prune, supervisor lock contention with a held and a stale lock, an
  out-of-range preferred port, and the Node runtime's detect,
  missing-binary, invalidate, and stop paths. The MCP host stays at 55%
  because its boot path runs in a subprocess coverage cannot see; the two
  integration tests drive it for real.

- 2026-11-05: Standalone MCP server (0.7.0). `xerj-mcp` speaks JSON-RPC over
  stdio so agents that do not run OpenCode reach the same services:
  `src/mcp/protocol.ts` handles initialize, ping, tools/list, and tools/call;
  `server.ts` is the line-delimited transport; `host.ts` builds the binary,
  node, corpora, memory, ledger, and tools from a project directory alone.
  Eleven tools: the plugin's eight plus `reindex`, `sysdocs`, and `prjdocs`.
  `initialize` and `tools/list` answer from static definitions, and the node
  starts behind the first call that needs it, so a client never waits to
  connect. Settings come from `XERJ_BIN`, `XERJ_STORAGE_ROOT`, and
  `XERJ_NODE_URL`; the ledger and log ring live in `mcp-kv.json` under the
  storage root. `dist/mcp.js` is built by `scripts/build-mcp.ts` and shipped as
  the `xerj-mcp` bin (verified in the pack file list). 15 unit tests cover the
  protocol, transport, and storage; 2 integration tests spawn the real entry
  point against a real binary and assert the eleven-tool list plus a status
  call that starts the node. 648 unit and 12 integration tests pass.
  The bundle is `dist/mcp.mjs`, built for Node with a `node` shebang and mode
  0755, because npx could not start the Bun-targeted build (`// @bun` plus a
  `Bun.file` call, and top-level await in a `.js` file of a `"type": "module"`
  package). The default manifest reader now uses `node:fs/promises`. Verified
  from a packed tarball: `npx --no-install xerj-mcp --help`, `bunx xerj-mcp
  --help`, and a handshake through npx returning all eleven tools. Publishing
  0.7.0 is what makes the `@latest` form work from the registry.

- 2026-11-05: `.github/workflows/publish.yml` (0.7.0). A `v*` tag now calls
  `ci.yml` as a reusable workflow (it gained `workflow_call`), so the tag runs
  the same typecheck, unit, and integration jobs as `main`; only a green run
  reaches the publish job. That job refuses a tag that disagrees with
  `package.json`, skips a version the registry already has, and otherwise runs
  `npm publish --access public --provenance` with `NPM_TOKEN`. Both workflow
  files parse, and the two guards were exercised locally: `v0.7.0` matches the
  manifest while `v9.9.9` is rejected, and `npm view` reports 0.6.8 as
  published and 0.7.0 as not. The workflow is committed but not pushed, so
  GitHub has not run it yet; the `NPM_TOKEN` secret must exist before the
  first tag push. `NPM_TOKEN` lives in the `npm` GitHub environment, so the
  publish job declares `environment: npm`; an environment-less job cannot see
  an environment secret and would fail at authentication.

- 2026-11-05: `/xerj-prjdocs eager` (0.7.0). Eager mode removes the two limits
  that keep an ordinary run small - page type and link depth - and replaces
  them with judgement. Each page goes to `ctx.experimental.generate.text` (the
  host's stateless model call) and is kept, with its links followed, only on a
  `yes`; the entry page is always kept so a site whose wording matches nothing
  still seeds. Judgements cache by URL and are capped at
  `prjdocs.eagerModelCalls` (150); past the cap or with no model, a
  deterministic heuristic decides (name match with separators ignored,
  documentation path, or two project terms). Unknown dependencies are searched
  with `ctx.websearch.query` and crawled from the first documentation host,
  cached in `prjdocs-discovered.json`. `prjdocs.eagerMaxPages` is 120,
  `prjdocs.eagerMaxDepth` is 12, and `prjdocs.eager` is off by default.
  Measured on docs.solidjs.com with the heuristic judge: 25 pages, 169 KB,
  9 s, three levels deep. Model and search paths are typechecked against the
  host SDK but have not been exercised live (the running module predates
  them). 633 unit and 10
  integration tests pass.

- 2026-11-05: Project documentation corpus and `/xerj-prjdocs` (0.7.0).
  Detection reads `package.json`, `requirements.txt`, `Cargo.toml`, and
  `go.mod`, plus the runtime pins that name a version (`.nvmrc`,
  `.node-version`, `.python-version`, `.tool-versions`,
  `rust-toolchain.toml`, `engines`, `go`, `requires-python`), then maps each
  technology to one official docs entry in `src/prjdocs/sources.ts` (33
  sources). Node and Python get a URL per version, longest-lived versions
  resolved from `nodejs.org/dist/index.json` and `endoflife.date`; the rest are
  unversioned sites with an 8 to 25 page budget. The crawler stays on one
  origin, goes two levels deep, skips assets and non-HTML, and records `url`,
  `title`, `tech`, `version`, `fetched_at` per page, so a page for a version
  the project no longer uses is pruned next run. Verified live: two
  technologies and 12 pages in about a second; `.nvmrc` 22 -> 20 indexed the 20
  pages and pruned the 5 from 22; removing the pin pruned the rest. Bodies are
  plain `text`, so nothing is embedded. 608 unit and 10 integration tests pass.

- 2026-11-05: System documentation corpus and `/xerj-sysdocs` (0.7.0). The
  command walks `MANPATH`/`INFOPATH` (then the system roots), keeps the first
  copy of each name and section, strips roff control lines while keeping
  section headings, and bulk-loads each page into `xop-sys-<host hash>`. A
  manifest of path, mtime, size, and id makes repeat runs cheap: measured here,
  3648 pages in 5.8 s (33 MB of text), then 83 ms for a no-op run, with a
  removed page pruned by id. `body` is plain `text` rather than
  `semantic_text`, so nothing is embedded: thousands of long pages would take
  hours with the local model and buy little on reference prose. The corpus
  joins the search prefixes (a `filesystem mount` query cites `man/mount.8`)
  and appears as the `sysdocs` dataset.

  Roots beyond `MANPATH` are searched in precedence order, so a user-installed
  page shadows the distribution copy: `$XDG_DATA_HOME`, `~/.nix-profile/share`,
  `NIX_PROFILES`, `/run/current-system/sw`, `HOMEBREW_PREFIX`, the Homebrew
  defaults, then `/usr/local/share` and `/usr/share`. A root that does not
  exist costs nothing. Verified with `XDG_DATA_HOME` pointed at a scratch tree:
  a page there was discovered and won for a name the system also provides;
  Linuxbrew's `share/man` is empty on this machine, so the corpus stays at 3648
  pages and a repeat run is 90 ms with everything skipped. Config:
  `sysdocs.maxDocs`, `maxBytesPerDoc`, `manDirs`, `infoDirs`. 578 unit and 10
  integration tests pass.

- 2026-11-05: The project corpus is one graph (0.6.9). `index.graph`
  (default on) runs `autoindex --brain <project>-<hash>` instead of
  `--no-graph`, so a single corpus carries sections, symbols, `path:line`,
  and edges: 1064 documents and 254 edges over 97 files here, with
  `.xerjignore` and `--exclude` honored and deletions reconciled (all
  measured). The engine refuses `--watch` in graph mode, so a graph project
  refreshes through the plugin's own directory watcher: 1.7 s per edit
  incrementally, 105 s cold with neural embeddings. A corpus built in one
  mode cannot be continued in the other, so `reconcileCorpusMode` records
  the mode at `<node dir>/corpus-mode` and drops only the project corpus
  and its journal when it changes (hidden documents, web spool, external
  files, and memory stay). Retrieval expands project hits one hop, but only
  along `pathcite`: measured here, `sequence` neighbors cost 11.5 KB per run
  and changed nothing, while `pathcite` cost 2.3 KB. Recall is unchanged
  between the flat and graph corpora (51 of 60 either way); the graph's
  value on this tree is the edge data, not a ranking gain. 554 unit and 10
  integration tests pass.

- 2026-11-05: Answerability measured, node-layer tests, and shared integration
  setup. The benchmark now pins an anchor token for twenty prompts and reports
  how often the answer text itself is in the block: 14 of 20, with 3 citing the
  file while cutting the answer and 3 never citing it. Raising the per-file
  section cap changes neither number, so the loss is file selection, not
  section selection. Search latency on the live corpus is p50 2.5 ms, p95
  82 ms against the 400 ms injection deadline. Two ranking experiments were
  measured and reverted: preferring code over prose for implementation
  questions (no gain, 20% more noise bytes) and demoting plan documents (no
  gain). The `/proc/net/tcp` and `lsof` port parsers are now pure functions
  with fixture tests, and the SIGKILL escalation is tested against a process
  that traps SIGTERM. Integration tests share one binary resolver and logger.
  543 unit and 10 integration tests pass; 86% lines, 94% functions.

- 2026-11-05: Log rotation, disk reporting, failure-path tests, retrieval
  docs, and a bigger benchmark. `node.logMaxBytes` (8 MiB default, 0 off)
  rotates the engine log to `node.log.1` at spawn; it had reached 3.9 MB in
  one day and had no bound. `status.disk` reports engine-data and log bytes
  with a bounded walk, shown in the panel's Index section. Three real setup
  failures are now tested (a binary that cannot report a version, a visible
  `storage.root`, an unwritable workspace); with the end-to-end test counted,
  `src/index.ts` is 74% lines and the tree 87%. The README explains the whole
  retrieval chain (legs, gates, demotion, one section per file, session
  dedupe, budget, tool vs context surface) and how to measure a change. The
  benchmark grew to 60 prompts: baseline 50/60 on a current index. Demoting
  plan and design documents was measured and reverted. 536 unit and 10
  integration tests pass.

- 2026-11-05: Brains in the corpus list, live retention, TUI render coverage,
  and a test-leak fix. Brain corpora now appear in `corpora` with their edge
  count, so one list answers "is every corpus working"; the end-to-end test
  configures `.agents` as a brain and `.github` as a hidden folder, which also
  proves the no-double-index rule. Retention was exercised against a live node
  (two summaries pruned by a size cap, a decision kept). The TUI render bodies
  now run under a recorded JSX runtime, so the sidebar line, the corpora rows,
  the close hint, and the foreign-panel null are asserted: `src/tui.tsx` 79%
  lines, 97% functions. A node leak was found and fixed: thirty-four XERJ
  nodes and twenty-two watchers had accumulated from unit setup tests that
  resolved the managed binary and bootstrapped a real runtime; those tests now
  point at a missing binary, and the end-to-end test waits for its node to
  exit. A file-agreement ranking experiment produced no recall gain and was
  reverted. 523 unit and 10 integration tests pass; overall 86% lines.

- 2026-11-05: Corpus health, an empty-scan warning, and a third search leg.
  `xerj_status` now carries `corpora`: name, state, document count, last
  run, and error per corpus, rendered in the panel, so a corpus that writes
  nothing is visible instead of reading as `watching` with 0 docs. A hidden
  scan that yields no documents from a configured folder warns once, which
  is the signal that was missing for an hour after the neural rebuild. The
  sidebar shows the count of prompts the relevance gate skipped. A third
  search leg matches the index's `name` and `title` fields (the function a
  record is about, and its file), fused with the other two through RRF:
  34 of 40 benchmark prompts find the expected file, up from 33, with
  slightly fewer bytes and no change on directive prompts. The end-to-end
  setup test now drives every ingest path (hidden folder, external read
  through `execute.after`, status and search tools, reindex, remember),
  lifting `src/index.ts` to 70% lines and the tree to 87.2%. 518 unit and
  10 integration tests pass.

- 2026-11-05: Reproducible evaluation and the work it justified. `bun run
  eval` (scripts/eval.ts) measures 40 labeled questions against a live
  index; its own source is ignored so it cannot win the queries it
  measures. Measured: eight injected passages instead of six finds the
  expected file in 33 of 40 prompts (was 31) for 5% more bytes; one
  section per file on the context surface cuts 4% of bytes with no
  recall loss; chronicle files (changelogs, status logs, journals) are
  demoted like generated files because they name every feature. A
  strict-match third leg and a coverage floor on trusted hits were tried
  and dropped (no gain, more bytes). An end-to-end integration test drives
  the real `setup` with a real binary: it indexes a project, answers a
  search, and stops cleanly, lifting `src/index.ts` coverage from 49% to
  65%. Verified live: web spool (5 docs) and external ingest (11 docs)
  both accept writes and are searchable after the timeout fix. Overall
  coverage 86.8% lines. 510 unit tests and 10 integration tests pass.

- 2026-11-05: Live audit of the loaded 0.6.4 found the hidden corpus empty.
  Cause: the client gave every request five seconds, and a write carrying a
  `semantic_text` field is embedded before it is acknowledged, which takes
  seconds per document on a neural node. The embed-mode change had dropped
  `xop-*`, and every hidden re-upload timed out after the engine accepted it,
  leaving a mapping and no documents. Writes (`bulk`, `bulkDelete`, index
  creation) now allow two minutes while reads keep the short timeout. Verified
  by running the real indexer against the live node: the four `.agents`
  documents are back and searchable. Also verified live: `node.priority` is
  applied (nice 19 and idle I/O class on the node and the resident watcher),
  memory is healthy with 12 entries, and `npm` now serves 0.6.4.

- 2026-11-05: Coverage and readability pass. The server part gained its
  first tests (`test/unit/setup.test.ts` drives the real `setup` against a
  stub host): tools, hooks, RPC methods, the overbroad-root refusal, a
  configuration warning, and the handlers' not-ready answers, so the layer
  where both shipped wiring faults lived is now guarded. The tool-result
  hook moved to `src/hooks/tool-results.ts`, one function per signal, with
  fourteen tests; it had none because it was only reachable through a live
  server. Lifecycle, client, anomaly, and retention suites reached their
  failure branches. Overall lines 83% -> 85.5%, functions 91%: `src/index.ts`
  from 0 to 49%, `client.ts` 73 -> 81%, `lifecycle.ts` 70 -> 88%,
  `anomaly.ts` 69 -> 100%, `tui.tsx` 71 -> 74%. TUI render functions stay
  untested: the JSX runtime refuses to run without the host renderer, so
  only the pure line and panel builders are covered.
  Readability: `candidatesFrom`, `pickNeighbors`, `comparePrerelease`,
  `bootstrapRuntime`, `indexerStart`, and the turn-capture handler were
  split into named steps; the highest remaining complexity is 15. Dead
  helpers and stale exports are gone. Hidden indexing now skips folders a
  brain already covers, compared by resolved path. 502 unit and 9
  integration tests pass.

- 2026-11-05: Memory retention. Capture writes one summary per substantive
  turn and nothing removed them, so the store grew without limit.
  `memory.retain` bounds automatic summaries by age, count, and bytes; the
  three apply in one pass and whichever binds first wins. Defaults are 180
  days, 500 summaries, and 2 GiB. Explicit memories (facts, decisions,
  preferences, fixes, notes) never expire, and an undated entry cannot be
  aged out but still counts toward the size caps. One sweep runs at startup
  and hourly after, logging what it removed; a failed sweep never throws.
  Ten plan tests and two runner tests cover it. The default count cap is 0
  (disabled) by user decision: age and size alone decide retention, so the
  2 GiB ceiling is reachable instead of being masked by a count limit.

- 2026-11-05: Third batch (0.6.4). Every XERJ process now runs at a
  configurable priority: `node.priority` is `low` by default, POSIX gets
  nice 19/0/-10, Linux adds idle-class I/O through `ionice` for `low`, and
  Windows sets the Idle/Normal/High class through PowerShell. Each call is
  best effort and never blocks startup. The hidden corpus now defaults to
  the docs folders that exist (`.agents`, `.github`, `.claude`), so project
  notes are searchable with no configuration; an explicit `index.hidden`
  list still wins. Coverage rose from 83% to 85%: the tool surface went
  from 37% to 88% lines and `tui.tsx` from 47% to 71%, with the remaining
  tools and ten TUI command paths tested. Dead code removed
  (`readPeerHeartbeats`, `spoolDir`) and six module-internal helpers are no
  longer exported. The watcher's duplicated stop body is shared, and the
  shell tokenizer (complexity 26) is split into per-rule helpers. Two
  orphaned `index/lastRun` kv entries were deleted, and ten stale plugin
  cache epochs (0.4.5 through 0.6.3) were removed. The package version is
  0.6.4 because the global config already pins that epoch; the 0.6.4 cache
  tree was built from the working tree and the old epochs deleted.

- 2026-11-05: Second improvement batch on 0.6.3, all measured on the live
  neural index. The semantic leg now vouches for its top three hits when
  they share at least one word with the prompt (`trustSemantic`, set only
  when `index.neural` is on): on 40 labeled prompts the expected file
  survived 36 times instead of 31, for 3% more bytes, and the one-word
  anchor kept ten directive prompts at 12.4 KB instead of 19.8 KB. The
  context hook stops re-injecting a `path:line` the session already holds,
  and its per-session tracking is capped (200 sessions LRU, 512 locations
  each) after the unbounded sets were found to grow for the life of the
  server. The search tool's empty result now states what the index holds
  and suggests `xerj_def` instead of saying only "No passages matched";
  the tool surface gained its first four tests. Setup warns when a
  project's `.agents`, `.github`, or `.claude` notes exist but are not
  indexed, since the engine skips hidden folders silently. Freshness
  verified live end to end: an appended README line was searchable within
  12 s and gone within 10 s of the revert. 390 unit tests and 9
  integration tests pass; typecheck clean.

- 2026-11-05: Audit of the loaded 0.6.3 on rc.101 found the memory index
  refusing to open. The neural reconcile dropped only `xop-*` indices, so
  the memory index kept its lexical vectors and the engine answered
  "holds vectors produced by embedding backend lexical" — every remember
  and recall returned nothing while the panel looked healthy. A mode
  change now backs up the memory index to `embed-backup/<old mode>/`
  before dropping it, recall and capture failures log at `warn`, and
  startup repairs an unhealthy memory index into
  `embed-backup/unreadable/`. The live index was backed up by hand and
  rebuilt; remember/recall/forget round-trip on the node.

  Retrieval measured against the 20-prompt labeled set on the live neural
  index: the context surface found the expected file in 16 prompts at
  6 passages and 0.5 coverage, up from 13 at the old 4 passages and 0.6.
  Terms now also match their stem, so "generated" matches "generate".
  Ten directive-style prompts injected the same bytes at both ratios.
  `context.maxPassages` defaults to 6. Prompt storage: harness markers
  (`mc:…`) are skipped and a repeated prompt replaces its earlier memory.
  The panel now counts prompts the gate skipped as noise, which explains
  a hit rate that counts directive prompts as misses. 376 unit tests and
  9 integration tests pass; typecheck clean.

- 2026-11-05: `binary.version: "auto"` now tracks the newest non-draft
  release at or above 1.0.0-rc.1 across majors, read from the GitHub
  releases list (redirect fallback). Pins still install exactly that
  version. Commit 665b7a1; 363 unit tests pass. The cached 0.6.2 epoch is
  synced and `release-cache.json` was removed, so the next OpenCode start
  installs rc.101 and rebuilds the project index in neural mode (rc.101
  changes its data format; reset accepted by the user).

- 2026-11-05: Improvement pass on the loaded 0.6.2 (committed as 0.6.3,
  synced into the cached 0.6.2 epoch, not tagged or published). Memory
  never grew: compaction is rare under Magic Context, and the one summary
  could never be recalled because `formatMemories` dropped lines longer
  than its budget. Long memories are clipped now, each turn whose final
  answer is 400+ chars is stored with its prompt (`memory.captureTurns`),
  capture is limited to sessions this instance prompted (the event stream
  is server-wide), and recalled memories must cover half the prompt's
  terms. Cost no longer double-charges passages already in
  `bytesReturned`. Pre-gate citations are dropped once (citations
  version 2) and generated files never list as top cited. Status gains
  `lastFiles`; the sidebar shows files instead of a record count that
  looked like a mismatch with docs. Ranking: tests sort after sources on
  the context surface, legs fetch 2k so demotion can promote, and
  duplicate `path:line` hits are dropped. The injection wrapper tells
  the model a passage is current file text. 355 unit tests pass. Not yet
  observed live: `session.text.ended`/`session.execution.succeeded`
  delivery to the turn capture (schema-verified only).

- 2026-11-05: Hit-rate and token-cost pass. Measured the two legs on the
  live corpus: the lexical embedder scores every passage between 0.6 and
  0.8 and RRF has no absolute scale, so directives such as "push to github,
  i will handle npm" injected lockfile and LICENSE passages at full budget
  and still counted as hits. The context surface now keeps a passage only
  when its text or path carries 60% of the prompt's content terms
  (`contentTerms`/`dropUncovered` in `src/search/rank.ts`), prompts with
  fewer than two content terms skip retrieval, and license boilerplate is
  treated as generated. On nine probe prompts the noise queries inject
  nothing and the real questions keep their passages. Also committed the
  `--fresh` recovery for a journal bound to another node URL (the live
  `autoindex exited 1` state); a manual one-shot pass now exits 0 at
  generation 9. 339 unit tests pass.

- 2026-11-04: Post-release audit. OpenCode restarted and now runs the
  patched 0.6.0 epoch: heartbeats carry `sessions` (1 live session), the
  ledger counted queries and hits again (14 queries, 12 hits, 86% hit
  rate), and the log rings are clean since the restart — the
  `autoindex exited 1` contention storm is gone. Node stopped on the old
  process teardown and restarted cleanly with the index intact. Verified
  end to end that an edit triggers a pass within seconds; a no-change
  pass replays the previous run document, so an unchanged `lastRun` is
  expected, not staleness. CI green on the pushed main (37 s); v0.6.0
  tagged and released on GitHub.

- 2026-11-04: Second audit of the loaded instance. The node is healthy
  (port 9200, pid live, cluster green, 844 docs, generation 35), but the
  running server still executes the pre-patch module: heartbeats carry no
  `sessions` field and the ledger stays at `sessions: 0`, so the 076f343
  `onActivity` fix is on disk in the cached epoch but needs an OpenCode
  restart to load. Real code bug found and fixed (aa3f9c9): a one-shot
  autoindex pass that overlaps another pass on the same state dir fails its
  flock with "already in use by another process" and exits 1, and the
  supervisor only recognised the resident `--watch` phrasing ("already
  owns"), so the collision counted a failure and flooded both instances'
  log rings with `autoindex exited 1` warnings. Contention detection now
  covers both phrasings; one-shot contention retries quietly after 5 s.
  Regression test drives a fake engine failing twice then succeeding.
  329 unit tests pass, tsc clean. Patched epoch re-synced.

- 2026-11-04: Two regressions in the project-local watcher and the upgrade.
  (1) The local watcher was started after the first index pass, so an edit
  during a long initial scan waited for the periodic fallback; ownership is
  now claimed first, a losing instance polls for the claim and takes over when
  the owner stops, and a one-shot run no longer releases it. (2) Peer
  heartbeats started before the migration, and their first write created the
  node directory, so the migration saw a non-empty target and skipped the move.
  The heartbeat now starts after the move. A dry run on a copy of this
  project's 11 MB legacy node directory moved the engine data, journal,
  memory index and web spool with the index intact. 245 unit tests pass.
- 2026-11-04: Two faults in the new in-project layout. (1) Every plugin
  instance writes a heartbeat, so with two locations open neither idle timer
  ever stopped the node: each saw a live peer and deferred to it since idle
  peers cannot run timers. Heartbeats now carry the instance's session count,
  a peer counts only while it holds a session, and a new session or close
  publishes immediately. Older heartbeats without a count stay conservative.
  (2) `RemoteSpool.init()` ran before `migrateProjectStorage`, so the spool
  directory existed as an empty target and the legacy web pages were left
  behind; the spool is constructed after the move and an empty target is
  replaced. Six new unit tests; 242 pass.
- 2026-11-04: Per-project XERJ storage moved into `<project>/.xerj` by
  default. `storage.root` selects another location; a visible directory inside
  the project is refused because the watcher would index its own writes. The
  node, engine data, journal, spool and memory now follow that root, while the
  binary, release cache and shared port lock stay global. Existing projects
  migrate once on setup. The engine's `--watch` cannot use a state dir inside
  the watched tree, so project-local storage runs one-shot indexes behind the
  plugin's own recursive watcher. Live check on a scratch project: `ensure()`
  created `<project>/.xerj/nodes/<prefix>/{data,node.log,node.pid,port}` and
  no node directory under the global root. 237 unit tests pass; version 0.6.0.

- 2026-11-04: Audit of the loaded 0.5.2 instance. The lifetime ledger and log
  ring were shared across locations (`queries: 0` on a 20-RPC session), so both
  are keyed by project and location now. Legacy memory was stranded in the old
  global engine data dir (`memory: 0`), so setup migrates it into the node data
  dir and restarts a running node once. The external corpus held
  `/data/ai/opencode/service.json`; credential names and directories are now
  refused before reading, redaction covers private keys, `AKIA` keys and
  `password`/`token`/`secret` shapes, hidden bodies are redacted, and the leaked
  external index was deleted. 226 unit tests and 9 integration tests pass;
  version 0.5.3.

- 2026-11-04: Concurrent-project isolation confirmed and hardened. Port pick
  and spawn now share one lock at the data root (two projects starting together
  otherwise both bind the same free port and one attaches to the other's node),
  and attach requires the port's listening pid to match this project's recorded
  pid, so a reused port is never adopted. Verified live with two simultaneous
  starts plus a stale-port third project; five new unit tests cover socket
  ownership. 220 unit tests pass.

- 2026-11-04: Project-scoped node lifecycle. One node per project
  (`<data root>/nodes/<prefix>/`), persisted port and pid, per-project engine
  data, peer heartbeats, and three shutdown paths (last `session.deleted`,
  idle timeout, plugin teardown) gated on live peers. Client retries once
  after a dead socket and status detects a node another process started.
  Verified live: spawn -> attach (same pid) -> idle stop -> restart with the
  index intact. 206 unit tests pass.

- 2026-11-04: Two instances of the plugin run in one server, one per open
  location, and both competed for the same journal. The winner watched; the
  loser retried against it forever and reported "starting". A process-wide
  set of state directories now grants ownership, later instances report
  "shared", and `PLUGIN_VERSION` reads the manifest so it cannot drift again
  (0.4.6 shipped claiming 0.4.5). 192 unit tests pass.
- 2026-11-04: Injection drops generated files (lockfiles, minified assets,
  build output) unless the query names the file; tool searches still return
  them after demotion. A watcher that survives 3 s reports `watching` before
  its first run document lands, so a large first pass no longer reads as
  `starting`. 190 unit tests pass.
- 2026-11-04: v0.4.0 pushed, tagged, and released on GitHub; CI green
  including the containerized integration job on podman. Published to npm as
  0.4.0, then 0.4.1 with repository metadata after the account's web 2FA login
  refreshed the token.
- 2026-11-03: Ranking demotes generated files (score x0.35 unless named), the
  integration harness runs 9 tests against a real node in podman, CI exists
  (podman -> docker -> bare runner), compaction capture subscribes to
  `session.compaction.ended`, counters are reported, and brain expansion was
  measured and fixed (one ego request per seed; bodyless pathcite targets
  resolve to their first section).

- 2026-11-03: Refined plan written; scope split into M0–M6 with M0–M2 as the
  first vertical slice. Stats and savings defined as measured quantities.
- 2026-11-03: Open questions settled: loopback `--insecure`, fetched documents
  persist, npm scope `@mrdrmccoy`, repo dogfoods whole with `.agents` as the
  example brain. No design blockers remain.
- 2026-11-03: Verification item 1 resolved. Binary upgrade rule corrected to
  full semver with numeric prerelease ordering; the minor-only rule could
  never fire while the project is on `1.0.0-rc.*`.
- 2026-11-03: Verification items 2–5 and 7–10 resolved against a real binary;
  plan corrected for `--watch`, `autoindex --brain`, hidden-directory skipping,
  the exit-4 decision gate, and the wire-version trap.
- 2026-11-03: M0 implemented: config, paths, semver, platform, logger, binary
  manager, node supervisor, RPC contract, status tool, TUI sidebar. Smoke test
  passes end to end.
- 2026-11-03: M0 verified inside the running OpenCode server: the plugin loads
  from `opencode.json`, `xerj_status` answers, options are intact, the node is
  shared across reloads. Index root corrected to the project canonical path.
- 2026-11-03: M1 implemented and verified live: supervised watch indexing,
  run-document parsing, periodic fallback, `reindex` RPC, freshness and counts
  in `xerj_status`. Journal moved to the data root after `--watch` refused a
  state dir inside the watched tree.
- 2026-11-03: M2 implemented and verified live. Hybrid retrieval runs as two
  legs fused in the plugin because `_passage` is refused for a server-side
  `hybrid` query. Line citations resolve exactly for whole-file records and
  fall back to the section start otherwise. Savings subtract partial reads and
  cap each file's baseline at 128 KB.
- 2026-11-03: M4 implemented and verified live: URL spool plus a second
  watcher, external files through `_bulk`, mapping-cache invalidation on corpus
  changes, per-prefix journal keys. `xerj_index` covers both.
- 2026-11-03: M3 implemented and verified live: remember/recall/forget with
  stable ids, memory recall wired into prompt-time injection, kind filtering
  moved client-side after `/_memory` metadata filters returned nothing.
  Automatic compaction capture deferred: the hook runs before the summary.
- 2026-11-03: Binary management made platform-aware. `binary.target` and
  `binary.libc` are configurable, host detection handles Rosetta and Windows
  ARM64, installs are target-scoped and probed, `binary.path` bypasses
  download, and the status snapshot reports the target. Smoke installs into a
  temp root and a fresh-import status check both pass; the live server keeps
  the old module until restart.
- 2026-11-03: M5 implemented: event-driven sidebar, details panel, four TUI
  commands, RPC `remember`/`search`, and status fields for datasets, memory,
  top cited files, and recent warnings. Stub-host run passed; live rendering
  is the remaining check.
- 2026-11-03: M6 implemented. Brain indexing runs one-shot and on reindex,
  reports live edge totals from the graph overview, and expands one hop for
  retrieval. Anomaly scoring uses stable detector ids. Both verified against
  the running node; the README and config reference are written, and only the
  publish step remains.
- 2026-11-03: Hidden corpus and automatic external reads added. `.agents`
  indexes as 4 plain documents alongside the brain copy; reading a file under
  `/tmp` indexes it without an explicit tool. Existing indices answer 409,
  which both ingesters now tolerate.
- 2026-11-03: Shell reads and duplicate collapse added. `bash` parsing covers
  cat-like commands with literal paths; brain sections replace hidden
  whole-file duplicates and now cite `.agents/...` paths.
- 2026-11-04: Plugin state re-rooted on the project node directory: the
  autoindex journal, watcher ownership and brain state now live under
  `<data root>/nodes/<prefix>/`. Clearing the node data reclaimed the orphaned
  `xop-agents-…` and edge indices from the pre-lifecycle layout. A signaled
  resident watcher now restarts with backoff instead of reporting `idle`
  forever. Live corpus restored at 777 project docs plus the 69-doc catalog.
  222 unit tests pass.

- 2026-11-04: Audit of the loaded 0.6.0 instance found the session hooks'
  `onActivity` option never wired in `src/index.ts`, so prompt turns never
  recorded a session (`sessions: 0`) and any `session.deleted` fired a
  last-session shutdown while sibling sessions were active; tool calls masked
  it via `execute.after`. Wired and committed (076f343); unit tests 245 pass,
  tsc clean. Also observed: the legacy global root still holds this project's
  old node dir, web spool and memory index (migration leaves the source when
  the target is non-empty — disk garbage, no behaviour impact), and a stale
  `autoindex exited 1` lastError from the bootstrap race.
