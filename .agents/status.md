# Status

Updated: 2026-11-03

## Where things stand

- M0 is implemented and verified against a real XERJ `v1.0.0-rc.100` binary.
- `bun test test/unit` passes (57 tests); `tsc --noEmit` is clean.
- `bun scripts/smoke.ts` downloads, verifies, extracts, spawns a node on 9500,
  attaches to it, reads health and index metadata, and re-attaches without
  spawning a second node.
- Not yet loaded inside a running OpenCode server. The parts typecheck against
  `@opencode/plugin` 2.2.5; a live load is the M1 entry check.
- `xerj` is still not on `PATH`; the plugin manages its own copy under the data
  root, which is the intended behaviour.

## Layout

```
src/config.ts          options, defaults, clamping
src/paths.ts           XDG paths, prefix and namespace derivation
src/semver.ts          prerelease-aware comparison (rc.99 < rc.100)
src/platform.ts        release target selection
src/log.ts             durable ring-buffer logger
src/binary/release.ts  asset naming, checksums, release cache
src/binary/manager.ts  download, verify, extract, upgrade
src/node/client.ts     HTTP client, size parsing
src/node/supervisor.ts probe, spawn, attach, port selection, stop
src/rpc.ts             typed RPC contract + status types
src/index.ts           server part
src/tui.tsx            sidebar slot + /xerj commands
scripts/smoke.ts       end-to-end M0 check
test/unit/*.test.ts    pure-function tests
```

## Next actions

1. M1: run `autoindex --watch --no-graph` as a supervised process, record the
   last run in storage, expose docs/bytes/freshness through `xerj_status`.
2. Add `.opencode/opencode.json` dogfooding the plugin with
   `index.brain: [".agents"]` once indexing exists.
3. Load the plugin in a real OpenCode server and confirm the tool plus the
   sidebar slot render.

## Work in progress

Nothing. Working tree has M0 changes not yet committed.

## Blocked / unknown

- `/_memory` filter syntax and `recency_weight` behaviour (M3).
- `/_graph/<brain>/ego` response shape (M6).
- Whether nested plugin option objects survive OpenCode's option validation
  unchanged; if they are flattened, read them defensively.

## Verified

- Release assets for `v1.0.0-rc.100`: `xerj-<ver>-<target>.tar.gz` + `.sha256`
  (`<hex>  <filename>`), Linux musl default, archive root
  `xerj-<ver>-<target>/`, latest resolved by redirect.
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
