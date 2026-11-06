# Status

Updated: 2026-11-04

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
2. Investigate the live memory loss. On 2026-11-06 the memory index was absent
   (`exists: false`) while every corpus index survived, with no backup under
   `embed-backup/` and no warning in the ring. The new warning makes the next
   occurrence visible; the cause is still unknown. Suspects: the rc.101 data
   format change, or the embed-mode reconcile before the backup rule existed.
3. The web corpus reported `docs: 0 · records: 5` with an empty spool and no
   `xop-web-*` index. The stale-count fix covers the report, but nothing
   re-creates the corpus because the spool is empty; decide whether a missing
   spool index should clear the run record.
4. Publish the next release when the user asks. `v0.7.0` is released and
   `npm` serves it. `publish.yml` stages when the token requires it; approve
   the staged version at npmjs.com.
5. Known coverage gaps need a fake clock or several processes: `mcp/host.ts`
   runner tools, the plugin's own wiring inside a live setup, supervisor
   port-scan exhaustion, and watcher restart backoff.

## Work in progress

Nothing. M0–M6 and in-project storage are committed; only the restart,
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
