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
- `bun test test/unit` passes (108 tests); `tsc --noEmit` is clean.

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
src/search/service.ts  two-leg retrieval, RRF, line resolution, formatting
src/stats/ledger.ts    measured savings with partial-read subtraction
src/memory/store.ts    project memory, ids, formatting
src/remote/spool.ts    fetched-page spool, external _bulk ingest, redaction
src/hooks/session.ts   prompt retrieval + memory recall + injection
src/tools/search.ts    search, def, status tools
src/rpc.ts             typed RPC contract + status types
src/index.ts           server part
src/tui.tsx            sidebar slot + /xerj commands
scripts/smoke.ts       end-to-end M0 check
test/unit/*.test.ts    pure-function tests
```

## Next actions

1. M5: TUI. Sidebar already exists; add the details panel, the memory count, and
   a live `stats.updated` subscription instead of the 5 s poll.
2. Confirm the prompt-to-context path on the next real user turn: `queries` in
   `xerj_status` should increment without a tool call, and the model should see
   the `<xerj-corpus>` and `<xerj-memory>` blocks.
3. Retrieval quality: a rare-term query still puts `package-lock.json` above the
   exact match. Consider skipping lockfiles at index time or in the baseline.

## Work in progress

Nothing. M0–M4 are committed; the next slice is M5 (TUI polish), then M6
(brain and anomaly).

## Blocked / unknown

- `/_graph/<brain>/ego` response shape (M6).

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
