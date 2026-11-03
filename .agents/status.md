# Status

Updated: 2026-11-03

## Where things stand

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
- The context hooks (prompt retrieval + system injection) are registered and
  typechecked, but the prompt-to-context path has not been observed in a live
  turn yet. That happens on the next user message.
- M4 is implemented and verified live: `xerj_index` fetched `example.com`
  (663 bytes) into the web spool, the web watcher indexed it, and a later
  search returned it at rank 2 with its source line. An external file at
  `/tmp/opencode/external-note.md` was ingested through `_bulk` and became
  searchable under the external index.
- The journal lives at `<data root>/state/<prefix>/`, not in `.xerj`:
  `--watch` refuses a state dir inside the watched tree, because journal writes
  are filesystem events that would restart the pass forever.
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
  all became searchable without `xerj_index`.
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
- `bun test test/unit` passes (162 tests); `tsc --noEmit` is clean.

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
src/index/corpus.ts    layout, command line, run-document parsing
src/index/watcher.ts   supervised watch process + periodic fallback
src/index/brain.ts     one-shot brain runs, run-document parsing
src/index/hidden.ts    hidden-folder scan, bulk index, deletion reconciliation
src/search/brains.ts   one-hop neighbor expansion for brain hits
src/search/service.ts  two-leg retrieval, RRF, line resolution, formatting
src/stats/ledger.ts    measured savings with partial-read subtraction
src/memory/store.ts    project memory, ids, formatting
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

1. Review the README against shipped behaviour, then publish only with
   explicit consent. The scoped npm name is not live yet.
2. Verify the details panel and the four commands in a real terminal session;
   the stub host stops where the renderer starts.
3. Retrieval quality: a rare-term query still puts `package-lock.json` above the
   exact match. Consider skipping lockfiles at index time or in the baseline.
4. The shell parser does not follow `xargs`, command substitution, pipelines
   that transform paths, or `cd` through a pipeline; those reads stay
   unindexed. An argument that merely mentions a file (`echo a.md`) is
   indexed too, by design: reference, not access, is the signal.

## Work in progress

Nothing. M0–M6 are implemented and committed; only the publish step and live
TUI verification remain.

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
