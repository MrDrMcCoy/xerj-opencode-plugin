# Implementation plan

This refines `goals.md` into a buildable design. Goals stay the source of
intent; this file decides *how*, in what order, and what counts as done.
Forward-looking work, including capability absorbed from sibling plugins, is
in `roadmap.md`.

## 1. What the plugin is

One OpenCode V2 plugin package with three parts:

| Part | Entry | Runs in | Responsibility |
|---|---|---|---|
| Server | `.` → `src/index.ts` | OpenCode server | binary + node lifecycle, indexing, retrieval, memory, hooks, tools, accounting |
| RPC | `./rpc` → `src/rpc.ts` | shared contract | typed `stats`, `search`, `memory`, `reindex` methods + `stats.updated` event |
| TUI | `./tui` → `src/tui.tsx` | terminal UI | sidebar stats, `/xerj` commands, details panel |

No GUI part in v1. The server part talks HTTP to the node directly so it can
shape output, enforce token budgets, and account for every byte. A standalone
MCP server (`dist/mcp.mjs`, the `xerj-mcp` bin) exposes the same tools to
agents that do not run OpenCode; it shares the project's node and its ledger.

### Layers

```
TUI  ──RPC──►  server part
                  ├── hooks (prompt, context, tool.execute.*)
                  ├── tools (xerj_*)
                  ├── stats/accounting
                  └── services
                        ├── retrieval (query, format, inject)
                        ├── memory (store, capture)
                        ├── index (corpus, scheduler, remote, brain)
                        ├── node (supervisor, client)
                        └── binary (release, manager)
```

Rules: UI never touches HTTP or the filesystem; hooks and tools never spawn
processes directly; only `binary/` and `node/` may exec or open sockets.

## 2. Decisions

These are defaults, not laws. Each is one config key away from the other
choice.

| # | Decision | Rationale |
|---|---|---|
| D1 | Node runs `--insecure` on `127.0.0.1` only, data dir `0700` | Matches every documented recipe; TLS + key management buys nothing on a single-user loopback socket. Auth-on can be added later if a shared-host case appears. |
| D2 | One node per project, shared by that project's sessions | The project index, its watcher, and its memory belong together; separating projects isolates crashes, ports, and idle shutdown. Two OpenCode processes on one project attach to the same node. |
| D3 | The node's lifetime follows its project's sessions | It stops when the last session closes, or after `node.idleMs` (30 min) with no activity, and restarts on demand with the index intact. A user-level node would never go idle. |
| D4 | Native tools, not MCP | Token budgets, citation formatting, and savings accounting need control over the response. |
| D5 | Index with `autoindex --no-graph` | That path reconciles additions, changes, deletions and renames incrementally. The graph path refuses deletions. |
| D6 | Second brain is opt-in and separate | `xerj brain <folder>` builds its own edge index. Running it over the whole repo duplicates indexing. |
| D7 | Lexical embedder by default | Offline, deterministic, no 90 MB download. Neural is opt-in and documented as re-index-required. |
| D8 | Context injection is on, budgeted, and killable | This is the product. It gets a hard token cap, a score threshold, per-turn dedupe, and `context.enabled=false`. |
| D9 | `.xerj/` holds all of a project's XERJ state | The engine data, journal, node runtime files and spool live under `<project>/.xerj`, inside the indexed tree but hidden, which every ingester skips. A visible path would be indexed and feed its own writes back forever. |
| D10 | Savings are measured, not asserted | Baseline = full size of each cited file, counted once per session, and only for files the model did not read anyway. |
| D11 | Fetched documents persist across sessions | Re-fetching a URL is a no-op, and yesterday's page is still searchable today. Bounded by `remote.maxBytes`, redacted, and killable with `remote.enabled=false`. |
| D12 | Package name `@mrdrmccoy/xerj-opencode-plugin` | Matches the repo owner. No unscoped-name risk, and the scoped name installs the same way from any project. |

## 3. Configuration

Plugin options in `opencode.json(c)`; every value has a default. The README
lists the complete set with defaults; this is the shape:

```jsonc
{
  "plugins": [
    {
      "package": "@mrdrmccoy/xerj-opencode-plugin",
      "options": {
        "binary": {
          "version": "auto"
        },
        "storage": {
          "root": null
        },
        "node": {
          "priority": "low",
          "cpus": null
        },
        "index": {
          "graph": true,
          "hidden": [".agents"]
        },
        "context": {
          "maxPassages": 8
        }
      }
    }
  ]
}
```

`binary.version: "auto"` means "latest minor, pin the resolved patch".
`binary.target` pins a release triple (for example `aarch64-apple-darwin`);
`binary.libc` chooses the Linux build. `binary.path` bypasses download and
detection entirely. `node.url` set means "attach, never spawn".

`storage.root` is the per-project XERJ root. It defaults to
`<project>/.xerj`; a relative value resolves against the project and an
absolute value may point anywhere, so a shared or external volume is one key
away. A configured path inside the project must be under a dot-directory: a
visible engine data dir would be indexed by the watcher, which feeds its own
writes back into the next pass forever. A refused path falls back to `.xerj`
and is reported in `warnings`.

This repo dogfoods its own plugin. `opencode.json` at the repo root loads it
from the working tree; a published install uses the scoped package name:

```jsonc
{
  "plugins": [{
    "package": "./",
    "options": { "index": { "brain": [".agents"] } }
  }]
}
```

`.agents` is then indexed twice, once as project docs and once as a brain. Two
markdown files is an acceptable duplicate for the dogfood; revisit if the tree
grows.

## 4. Paths and identity

```
data root     ~/.local/share/opencode/xerj               (binary only, 0700)
binary        <data root>/bin/<ver>-<target>/xerj
storage root  <project>/.xerj                          (storage.root)
node dir      <storage root>/nodes/<prefix>/           (one per project)
engine data   <node dir>/data/                         (engine storage)
port          <node dir>/port                          (resolved, persisted)
pid           <node dir>/node.pid
lock          <data root>/nodes/.port-lock            (shared by all projects)
spool         <storage root>/spool/<prefix>/           (remote documents)
journal       <node dir>/data/state/<prefix>/journal.ndjson
```

The global data root still owns the managed binary, the release cache, and the
port lock, because they are shared by every project in that installation and
installing one binary per project would repeat a large download. Project state
follows `storage.root`.

The port lock stays at the global data root even when storage is configured
elsewhere: the binary and its default port scan are global, so two projects
with different storage roots would otherwise both pick the same free port.

Index prefix, stable per canonical project path:

```
slug   = basename(canonical path), lowercased, non-[a-z0-9] → "-", max 24
hash   = sha256(canonical path)[0..8]
prefix = "xop-" + slug + "-" + hash        e.g. xop-xerj-opencode-plugin-1a2b3c4d
```

Remote documents get `xop-web-<hash>`, external single files
`xop-ext-<hash>`. One prefix is one folder; that is a XERJ invariant.

`autoindex` refuses a single file (`... is not a directory`), so external
single-file ingest has to go through `_bulk`. Hidden files and directories are
skipped unconditionally, so `.env`, `.git`, and this repo's own `.agents/`
never reach the project corpus; `index.hidden` indexes listed folders through
`_bulk` and `index.brain` adds graph edges, which is why the two settings are
not redundant.

`.xerj/.gitignore` contains `*` so project state never lands in git.

The journal lives inside the node directory, which is under `.xerj`. The
engine's `autoindex --watch` refuses a `--state-dir` inside the watched tree:
every pass writes the journal, those writes are filesystem events, and the
events would start the next pass forever. Our own watcher uses one-shot runs
behind a debounce instead, and skips `.xerj` explicitly (as do the hidden and
external ingesters), so the journal loop cannot form. The engine's refusal is
still why watch mode is not used by default.

Upgrades: a project whose data still sits in the old global layout
(`<data root>/nodes/<prefix>`, `<data root>/spool/<web prefix>`) is moved into
`storage.root` once on setup. A node still running from the old tree is
stopped first so it cannot keep writing into the directory being moved.
Project memory is copied separately into the node data dir when the target is
empty, because an already-running node enumerated its indices at startup and
would not see the copied index until it restarted. The spool is constructed
after the move: its constructor creates the spool directory, and an eagerly
created empty target would otherwise make the move skip the legacy pages. The
peer heartbeat starts after the move too, for the same reason: its first write
creates the node directory, which would make a non-empty target.

## 5. Binary management

1. If `binary.path` is set, probe it with `--version` and use it as-is. No
   download, no upgrade, no platform gate: a self-built binary for an
   unpublished platform has to work.
2. Otherwise pick the target triple. `binary.target` wins when set; else derive
   it from the host: `binary.libc` selects `unknown-linux-{musl,gnu}`, macOS
   checks Rosetta, and Windows trusts `PROCESSOR_ARCHITECTURE` so an x64 Node on
   ARM64 installs the native build.
3. Look for an installed binary under `<bin>/<ver>-<target>/xerj`. The target is
   part of the directory name so one data root can hold several platforms
   without one overwriting another. Probe it with `--version` to confirm it
   runs.
4. If `version` is pinned, install that version for the target and stop.
5. Else resolve the latest release at most once per 24 h through the
   `https://github.com/xerj-org/xerj/releases/latest` redirect (read the tag
   from the final URL). This avoids the api.github.com rate limit.
6. Compare full semver, **including prerelease identifiers numerically**:
   `1.0.0-rc.99 < 1.0.0-rc.100`. Upgrade when remote > installed and the major
   matches; never downgrade. A minor-only rule would never fire here, because
   every rc release keeps minor at 0.
7. Download `xerj-<ver>-<target>.<ext>` and its `.sha256` sidecar. Require 64
   lowercase hex; a missing or malformed checksum aborts the install (fail
   closed, same as the official installer).
8. Extract into `<bin>/<ver>-<target>.partial/`, expect
   `xerj-<ver>-<target>/xerj` (or a recursive search for `xerj`), `chmod 0755`,
   then `rename()` the directory into `<bin>/<ver>-<target>`. Probe the result
   with `--version`: a binary for the wrong architecture installs and then
   fails to exec, so the probe is the real check. Remove the partial on
   failure.
9. On any failure: keep the current binary, log once, surface in TUI as
   `xerj: binary upgrade failed` with the reason. Never block startup.

The official installer remains a fallback (`XERJ_VERSION` + `XERJ_INSTALL_DIR`
pinned into a temp dir), under the same verify-then-rename contract. The `.deb`
assets are ignored: no root, no dpkg.

Platform coverage: Linux x86_64/aarch64 (musl), macOS x86_64/arm64, Windows
x86_64/arm64. Extraction uses `tar -xf`, which handles both `.tar.gz` and `.zip`
(bsdtar on Windows 10+). The binary name switches to `xerj.exe` on Windows, and
the data root uses `LOCALAPPDATA`. Only Linux x86_64 has actually been run; the
other targets are selected correctly but untested.

## 6. Node lifecycle

The node is scoped to one project, not to the user or the server. Everything a
second process needs to find it lives in a project node directory:

```
node dir   <storage root>/nodes/<prefix>/         (0700)
port       <node dir>/port                        (persisted, last used)
pid        <node dir>/node.pid
lock       <data root>/nodes/.port-lock           (mkdir is atomic, 60 s stale)
log        <node dir>/node.log
clients    <node dir>/clients/<instance>.json      (peer heartbeats)
data dir   <node dir>/data/                       (engine storage)
```

`NodeRuntime.ensure()`:

1. If `node.url` is set, attach to it and never spawn. The idle timer is off
   in that mode: the plugin does not own that node.
2. Probe the persisted port. If this project's node answers with
   `cluster_name: "xerj"`, attach. Ownership, not the banner, decides: the
   listening socket's pid must equal the pid recorded in this project's
   `node.pid`, because another project can take the same port after this one
   stops, and adopting it would read that project's corpus and later kill its
   node.
3. Take the spawn lock at the global data root. Port choice and spawn are
   shared by every project using that installation, so one lock covers them;
   per-project locks would still let two first starts pick the same free port.
   The lock is retried for up to the startup timeout and is stale after 60 s.
4. Re-check the persisted port under the lock, then pick a free port triple and
   spawn detached:
   `xerj --insecure --data-dir <data dir> --port <port> --bind 127.0.0.1`,
   stdio to the node log, then poll health for up to 30 s. Persist the port and
   the pid once it answers, so a restart attaches instead of spawning again. A
   configured `node.port` is honoured when its triple is free, even outside the
   default scan range.

Detection and resume: `detectNode(nodeDir)` reports `running`, `port`, `pid`
and the banner state without starting anything. The status snapshot uses it
when this process holds no handle, so an idle-stopped corpus that another
OpenCode process has since started reports `running` instead of `stopped`.
A client request that fails on a dead socket calls `ensure()` once and retries,
so a stopped node is restarted on demand.

Teardown is session-scoped. Every prompt, tool call and RPC touches the
lifecycle and records its session id. Three things stop the node:

- the host emits `session.deleted` for the last recorded session of this
  project, or
- no session activity for `node.idleMs` (default 30 minutes), or
- the plugin instance itself is torn down.

Each path checks the peer heartbeats first: an instance writes
`<node dir>/clients/<instanceId>.json` every 15 s with its session count, an
entry is stale after 90 s or when its pid is gone, and only a peer that still
holds a session defers the shutdown to its own deadline. Counting every live
process instead would deadlock two idle instances, each deferring to the
other. A new session and a session close publish the count immediately rather
than waiting for the next periodic write. `node.shutdownOnIdle=false` keeps
the node up. Stopping sends
`SIGTERM`, waits five seconds, then `SIGKILL`s and removes the pidfile. The
node directory and engine data stay, so the next request restarts the node on
the same port with the same index.

A process-wide claim on the project's state directory means one plugin instance
owns the watcher; the others report `shared`.

Verified on `v1.0.0-rc.100`:

- The server has `--port P`, which also claims `P+1` (native REST) and `P+2`
  (gRPC). `--auto-port` is opt-in; the default fails when a port is taken. The
  supervisor therefore checks all three ports before spawning.
- `GET /` returns Elasticsearch-shaped JSON with `cluster_name: "xerj"`.
  Identify a node by that field, never by the port. `version.number` is the
  *wire* version (`8.13.0`), not the XERJ release; the release comes from the
  binary.
- `xerj --version` prints `xerj v1.0.0-rc.100`, so the installed version is
  parsed from that line.
- End to end: spawn, attach from a second runtime with the same node directory
  (same pid), idle stop, restart on the same port with the same index.

## 7. Indexing

### Project corpus

On setup, asynchronously:

```
xerj autoindex <project root>
  --url <node> --prefix <prefix> --state-dir <node dir>/data/state/<prefix>
  --no-graph --json --progress none
```

Add `--no-semantic` when `index.semantic=false`. Cap `--workers` when
configured. Exit codes: `0` clean, `3` completed-with-junk (success — do not
retry), `4` needs-a-decision (nothing indexed; a JSON decision request is on
stdout), `1` failure (record, retry with backoff, surface once).

### Refresh: prefer `--watch`

`autoindex --watch` is the better trigger than a debounce loop: OS watches per
indexed directory, no polling, the same ignore rules, and a `--debounce` quiet
period (default 400 ms). It requires `--no-graph`, which is the mode we use
anyway. The plan is:

| Trigger | Action |
|---|---|
| plugin setup | start `autoindex --watch --no-graph` as a supervised resident process |
| watcher exits | restart with exponential backoff (1 s → 60 s, max 5), then fall back to periodic runs |
| `write`/`edit`/`patch` tool result | mark dirty; the watcher picks it up |
| periodic timer | only when the watcher is unavailable |
| `/xerj reindex` | run `--watch` once more, or a one-shot run when watch is disabled |

Watch mode is one process per project. With several projects open that is
acceptable (each is idle when nothing changes), but `index.watch=false` must
exist for users who disagree. Ownership is claimed before the first pass, so
an edit that lands during a long initial index is still seen; an instance that
loses the claim polls for it and takes over when the owner stops. A one-shot
run shares the ownership key but must not release it.
A resident watcher that dies by signal is
restarted with backoff like any other crash; only a stop this supervisor
requested reports `idle`, because a killed watcher would otherwise leave the
corpus frozen with no error.

The plugin loads once per open location, so one server can hold several
instances for the same project. A module-level set of state directories grants
watch ownership inside the process: the first instance spawns the watcher, the
rest report `shared` and start nothing. Two `--watch` processes cannot share a
journal, and a loser that keeps retrying reads as `starting` forever while
indexing is actually fine.

Before the first index, write `.xerjignore` defaults if absent:

```
.env
.env.*
*.pem
*.key
**/secrets/**
```

XERJ already honors `.gitignore`, nested gitignore, `.git/info/exclude`, and a
built-in list (`node_modules`, `target`, `dist`, …). This file only adds
secret-shaped names.

### Refresh triggers

| Trigger | Action |
|---|---|
| plugin setup | full incremental run in background |
| `write`, `edit`, `patch`, `apply_patch` tool result | mark dirty, debounce 5 s |
| `bash` tool result | mark dirty, debounce 30 s (no path info) |
| periodic timer | incremental run every `periodicMs` |
| `/xerj reindex` | incremental run now; `--fresh` variant for a rebuild |

A single-flight queue per prefix: at most one `autoindex` process, at most one
queued rerun. Runs are `nice -n 10`; the node's 429 back-pressure is handled by
`autoindex` itself (it re-offers rejected records).

### Hidden documents

`autoindex` skips hidden files and directories unconditionally, so a configured
`.agents` or `.github` tree never reaches the project corpus. `index.hidden`
lists folders to index as plain documents:

- `HiddenIndex` scans each folder recursively, skipping `.git`, `.xerj`,
  `node_modules`, build output, virtualenvs, and secret-shaped names (`.env*`,
  `*.pem`, `*.key`, `*.p12`, `*.pfx`, `*.crt`, `secrets/`).
- Text files only, at most `index.hiddenMaxBytes` each, at most 2000 files.
- Documents go through `_bulk` into `<prefix>-hidden-docs` with `path`
  relative to the project, `abs_path`, `mtime`, and `hidden: true`. The mapping
  makes `body` `semantic_text`.
- Ids are `sha256(relative path)`, so an edited file replaces its document and
  a scan deletes ids that disappeared.
- `fs.watch(..., {recursive:true})` with a 1.5 s debounce drives refreshes; if
  recursive watch is unavailable it polls every 30 s. Startup and
  `/xerj-reindex` always run a scan.
- The index matches the project prefix, so search covers it and citations keep
  the `.agents/...` path. Datasets label it `hidden` and exclude it from the
  `project` row so totals do not double count.

### Remote documents

`webfetch` and any tool whose input has a `url` and whose result is text
(>= 200 chars) spool their content when `remote.enabled`. The spool is
fire-and-forget, like the shell and external ingests: the hook writes in the
background and invalidates the mapping cache when a document lands.

```
<data dir>/spool/<web prefix>/<sha256(url)[0..20]>.md
```

The file carries its own provenance (`# title`, `Source:`, `Fetched:`) so it
needs no sidecar, which would otherwise be indexed as a second dataset. The
same URL replaces its earlier file. A second watcher runs
`autoindex <spool dir> --prefix xop-web-<hash> --no-graph`; both watchers keep
separate journal records because the storage key includes the prefix.

Bounded by `remote.maxBytes`; truncated on a character boundary. Redaction
covers bearer tokens, `sk-`/`ghp_`/`xox`/`AKIA` keys, private key blocks, and
key/value config shapes (`password`, `token`, `secret`, `api_key`, and the
like). Credential files are never ingested: `.env*`, `*.pem`/`*.key`/`*.p12`,
`service.json`, `credentials.json`, `auth.json`, `id_rsa`, and anything under
`.ssh`, `.aws`, `.gnupg`, `.kube`, or `.docker`. The name check runs before the
file is read, and the same filters cover hidden and external ingests.

External files go through `_bulk` into `xop-ext-<hash>-docs` (autoindex refuses
a single file). The mapping declares `body` as `semantic_text` so passages work;
fields are `path`, `abs_path`, `mtime`, `title`. Plain text only; no AST.

A file outside the project root is indexed automatically when the `read` tool
reads it: the hook fires the ingest in the background so the read is not
delayed, and an mtime+size stamp prevents re-bulking an unchanged file.
`xerj_index path` forces the same path on demand. Ids are stable per absolute
path, so an edited file replaces its document instead of leaving a stale
version.

The same applies to any shell command. `bash` and `shell` results are parsed
conservatively: every literal argument of every simple command is a candidate
file reference, and only arguments that resolve to an existing regular file
are ingested. `grep todo src/a.ts`, `wc -l notes.md`, and `./scripts/gen.sh`
count the same as `cat file.md`. A short option's value is skipped
(`head -n 20`, `grep -e pattern`), variables, globs, tilde paths, and
redirection targets are not resolved, and a simple `cd dir && ...` moves the
working directory for later commands. Only paths outside the project are
ingested, in the background, with the same mtime+size skip and stable id as
explicit `xerj_index` calls.

A prefix with no indices answers 404 on `_mapping`; that is not a failure for
the other corpora. The mapping cache is invalidated when any watcher reports a
run and after an explicit ingest, because a new index is invisible until the
cache expires.

### Second brain (opt-in)

`index.brain: ["docs", "notes"]`. Do **not** use `xerj brain`: it hardcodes
the `ax` prefix, has no `--prefix`, and would collide with the only other
folder under `ax`. Use the autoindex path instead:

```
xerj autoindex <dir> --prefix xop-<brain>-<hash> --brain <name> --state-dir ...
```

That writes documents under the given prefix and edges to
`.xerj-memory-<name>-edges`, which is exactly what the graph tools read.

`src/index/brain.ts` derives one spec per folder: graph name
`slug(basename)-<hash4>`, prefix `xop-<name>-<hash6>`. The hash keeps two
projects' `agents` brains from sharing one global edge index. It runs once after the
project watcher starts, but only when `index.auto` is true, and again on
`/xerj-reindex`. Graph mode cannot watch: `--watch` requires `--no-graph`.

After a run, take live totals from `/_graph/<name>/overview`. `edges.total` is
the graph's real size; the run document's `edges_written` counts only that
pass. Keep `docs` from the run's `records_total`, because `nodes.total` counts
section records, not files. Status carries `brains[]`; the panel lists docs,
edges, age, and errors; datasets gain `brain:<name>`.

Verified edge types on this repo's `.agents`: `pathcite`, `sequence`,
`same_dir`. Neighbor expansion uses only `pathcite` and `sequence`;
`same_dir` says two files share a folder, which is not evidence. One hop, at
most two neighbors, 600 characters each.

`GET /_graph/<brain>/ego?node=<id>&hops=1&direction=both` requires `node`
(POST is 405). One node per request: a comma-joined `node=a,b` answers with an
empty `edges` array, so callers query each seed and merge. It returns `edges`
and `neighbors[{id, hop, via_edge}]` but no text, so resolve ids through the
brain's docs index with an `ids` query. A `pathcite` target is the file's
whole-file record, which has no `body`; fetch its first section record
(`term ax_path` + `exists body`, sorted by `start_line`) instead.

`GET /_graph/<brain>/overview` returns `nodes_index`, node and edge counts,
`types`, `detectors`, and `hubs`; `nodes.total` counts section records, not
files, so do not label it as a file count in the UI.

## 8. Retrieval and context injection

### Query path

1. Prompt hook records `{sessionID, text, messageID}` and runs retrieval once,
   with `context.timeoutMs` as a hard deadline.
2. Two legs over the project prefix: a `multi_match` over `body` (the field
   that produces `_passage`) and a `semantic` query on `body` when the mapping
   says it is `semantic_text`.
3. Fuse the legs with RRF in the plugin. The engine refuses `_passage` for a
   server-side `hybrid` query, so fusion is the only way to keep passages and
   both signals. Dedupe by `index:id:passage`.
4. Cut at `context.maxTokens` with an equal per-hit share, so one whole-section
   match cannot hide the other results. Drop nothing on score: RRF scores have
   no absolute scale.
5. Format with `path:line` citations. Symbol records carry `code` but no
   `_passage`; they belong to `xerj_def`, not the search leg.
6. Cache by `(sessionID, messageID)`; the context hook splices the block in
   once and marks the turn as injected.
7. When a hit belongs to a configured brain, expand one hop. Related passages
   get their own budget slice (min 800 chars, a quarter of the total), because
   direct hits already fill the budget; appending without reserving hid them.
   Neighbors cite as `path:line [via pathcite|sequence]`.
8. Brain documents are relative to the brain folder; rewrite them to the
   project-relative path before resolving lines, so citations read
   `.agents/plan.md` and the file read is the right one.
9. A hidden document is a whole file, so drop it when a brain section from the
   same path survives. The section keeps its precise line and graph expansion;
   hidden documents still cover folders no brain indexes.
10. Injection drops generated files (a lockfile, minified asset, or build
    output) unless the query names the file. Demotion alone only reorders
    them; a lockfile passage still matches on dependency names and crowds the
    one shared turn budget. Tool searches keep them, because the caller asked.

### Context hook

`session.hook("context")`:

- On the first model call of a session, append a `<xerj-corpus>` system part:
  dataset map from `autoindex-catalog`, doc counts, freshness, and one line
  telling the model when to prefer `xerj_search` over reading whole files.
  Budget 300 tokens, refresh when the index generation changes.
- On every call, append `<xerj-context>` with the cached retrieval block for
  the current turn, if any and if not already injected.
- Never touch `event.messages`; never delete tools.

If retrieval missed the `timeoutMs` deadline, inject nothing. Tools remain.

### Tool surface

| Tool | Input | Notes |
|---|---|---|
| `xerj_search` | `query`, `k?`, `max_tokens?` | `body` passages, lexical + semantic legs |
| `xerj_def` | `symbol`, `lang?`, `kind?`, `k?` | go-to-definition with signature |
| `xerj_remember` | `text`, `kind`, `topic?` | project namespace |
| `xerj_recall` | `query`, `k?` | relevance + recency blend |
| `xerj_forget` | `id` | retraction |
| `xerj_status` | — | node, index, freshness, counters |
| `xerj_index` | `path?` / `url?`, `force?` | explicit ingest |

Namespaced as `xerj` with a one-line description that says when to use it
("search the indexed project instead of reading files"). Tool results carry
`metadata.xerj = {hits, bytes, files}` so accounting and the TUI do not have to
parse prose.

Deliberately not done: rewriting `read`/`grep` inputs. Silent semantic changes
to built-in tools break trust and debugging. Guidance lives in the system part.

## 9. Memory

Namespace: `proj-<slug>-<hash8>`; global `user` for cross-project preferences.

Writes:

- `xerj_remember` (explicit, model-driven), with a kind and optional topic.
- Retraction on `xerj_forget`.

Automatic capture from compaction uses `session.compaction.ended`, which
carries the generated summary in `data.text`. `startCompactionCapture`
subscribes in the background (aborted on shutdown), skips summaries under 120
characters, clips at 4000, and stores one `summary` memory per text. The
`compaction` hook itself still cannot be used: it runs before the summary
exists. The id is the hash of the text, so a repeated event is idempotent.

IDs are `sha256(namespace + text)[0..16]`, so re-remembering the same fact is
idempotent. Metadata: `kind`, `topic`, `source`, `sessionID`, `created`.

Memory predates the node-scoped layout at `<data root>/data/`, which was the
old global engine data dir. `migrateMemoryIndex` copies the project's memory
index into the project node's data dir on setup when the destination is empty.
A node that is already running has enumerated its indices, so the migration
stops it once; the next `ensure()` re-attaches with the copied memory visible.

Reads:

- Prompt-time recall, top 3, `recency_weight: 0.2`, injected under
  `context.memoryTokens`. Only above `minScore`.
- `xerj_recall` for explicit lookups.
- Graph-aware recall when a brain is configured
  (`graph: {mode: "restrict", seeds, hops: 1}`).

Memory is never dumped wholesale. `GET /_memory/{ns}` is for the TUI details
panel only, capped at 20 entries.

## 10. Stats, hit rate, savings

Counters (durable in `ctx.storage`, mirrored per session):

```
queries, hits
bytes_returned, baseline_bytes, bytes_read, saved_bytes, tokens_saved
files_cited, files_read
citations per file (top cited files)
docs and store size per dataset (project, web, external, memory)
```

Counters for index runs, node spawns, 429s, and injection counts are tracked in
`src/stats/counters.ts`, reported in the panel's usage section and in the
status snapshot. They are per-process: they reset on restart, and the UI says
so.

`ctx.storage` is one namespace for the whole server, and the plugin loads once
per open location, so the lifetime ledger and the log ring key on the project
prefix plus a hash of the location directory
(`stats/lifetime:<prefix>:<loc>`, `log/ring:<prefix>:<loc>`). The project part
keeps other projects out; the location part matters because one server can
load this plugin twice for one project (the repo and a subdirectory), and those
two instances would otherwise overwrite each other's counters and warnings.
Each instance therefore reports its own usage; the panel is per location.

Definitions:

- **hit**: a query that returned at least one passage to the model (injected
  or through a tool). With RRF there is no absolute score to threshold on.
- **hit rate** = `hits / queries`, per session and lifetime.
- **baseline bytes**: for each cited file, its size capped at
  `stats.maxBaselineBytes` (128 KB), counted once per session. Reading the
  file later subtracts the bytes actually read, not the whole file: a partial
  read only removes what it covered.
- **saved bytes** = `baseline − bytes_returned`, floored at 0.
- **tokens saved** = `saved / bytesPerToken`, rendered with `~`.
- **top cited files**: each file gains one citation per query that cited it,
  deduped within the query. Counts are persisted with the ledger.
- **datasets**: indices grouped by prefix: project (`<prefix>-*` minus
  hidden), hidden (`<prefix>-hidden-*`), web (`xop-web-*`), external
  (`xop-ext-*`), brain (`xop-<brain>-*`), memory
  (`.xerj-memory-<namespace>`). Sizes parse the human strings from
  `_cat/indices`.
- **recent**: the last four warn/error entries from the logger's ring buffer,
  shown in the panel's health section.

Index size and doc counts come from `_cat/indices?format=json`; freshness from
the last successful `autoindex` run document (generation, records, timestamp).
`xerj gain` is the node's own accounting and is used as a cross-check, not as
the source.

Verified sources on `v1.0.0-rc.100`:

- `xerj gain --json` returns `searches`, `with_hits`, `zero_hit`, `hit_rate`,
  `took_ms: {p50, p95}`, `top_indices[]`, and
  `excluded_machine_searches: {counting_probes, catalog_sweeps}`. That is the
  node-side hit rate; read it instead of recomputing it.
- Search responses carry `_savings: {bytes, measured, note}` describing
  `_source` narrowing inside that response, and `_xerj.hints` when a request
  would pull whole files. Record `_savings.bytes` as
  `responseNarrowingBytes`; it is not a file-level baseline.
- `_cat/indices?format=json` fields: `health`, `status`, `index`, `uuid`,
  `pri`, `rep`, `docs.count`, `docs.deleted`, `store.size`, `pri.store.size`.
  Sizes are human strings (`1.2mb`).
- `_stats` is not a route: a bare `GET /_stats` is parsed as an index name and
  400s. Use `_cat/indices` plus `/_stats/index` when needed.
- `autoindex status` does not list indices under a custom prefix and has no
  `--json`. Do not parse its text; query `_cat/indices` and keep our own
  last-run record.

## 11. TUI

`sidebar.content` (append), four lines, reactive to the RPC `updated` event
with a 30 s poll fallback for missed events:

```
XERJ  ● ready · 1,284 docs · 12.4 MB
q 37  hit 78%  ~1.9M tok saved
idx 2m ago · 1,284 records
▸ /xerj for details
```

The third line reports the last run's record count, not a change count: the
run document gives totals, and a change delta would need a second source.

Details panel: a `session.panel` append claim that renders only when
`input.name` is `xerj.stats`, so other plugins' panels are unaffected.
Sections: node, binary, index, datasets, memory, usage (saved/baseline/
returned/read), top cited files, health (config warnings, recent ring-buffer
warnings and errors). `ui.panel.open("xerj.stats")` selects it; when no
session can host a panel the command falls back to an alert with the same
text.

Commands (keymap layer, `palette: true`, slash names):

| Command | Action |
|---|---|
| `/xerj` | open the panel; subcommands `status`, `reindex`, `remember`, `search` |
| `/xerj-reindex` | queue an incremental project and web run, toast on completion |
| `/xerj-remember` | prompt for text, store a memory |
| `/xerj-search` | prompt for a query, show cited passages in a dialog |

The panel closes three ways: `escape`, the `✕ close` button in its footer, or
running `/xerj` again. The escape binding is a keymap command enabled only
while `ui.panel.current()` is this plugin's panel, so it cannot shadow the
host's escape handling elsewhere. The button calls the slot input's `close`,
so it stays correct if the host stops honouring `ui.panel.close()`.

`ctx.command.transform` on the server part is deliberately not used. A
server-side command cannot open a panel or a dialog, so it could only toast or
emit a synthetic message. The TUI owns the commands; the server part owns the
RPC methods they call.

### RPC access from the TUI

The lookup is per location and the client is replaceable, so both facts have to
be honoured on every call:

- Pass `context.location` as the call options. Without it the server answers
  `rpc.unavailable` even though this project's copy is registered, because a
  registered RPC belongs to the location that loaded the plugin.
- Read `context.client` inside the call, never capture the sub-client at setup.
  The host swaps the client when the server restarts, and a captured
  sub-client rejects without sending anything, which the UI cannot tell apart
  from an unloaded plugin.
- Subscribe to `updated` after the first successful poll, not at setup, and
  drop the subscription on failure so the next success re-arms it. Events do
  not survive a restart either.
- Surface the failure text in the sidebar and in the empty panel. A fixed
  "not loaded" line hid the real reason for both faults above.
- Declare an input property as optional in `src/rpc.ts` when a caller may omit
  it. The host validates the call against that schema before the handler runs:
  a required key the TUI does not send fails with `rpc.invalid_input`, which is
  logged nowhere and looks like a broken command. `test/unit/rpc-inputs.test.ts`
  pins the exact payloads the TUI sends, and the TUI's stub client validates
  every call against the definition.

## 12. Telemetry and anomaly detection

The on-demand detector is a tool, not a background job. `xerj_anomaly` takes
`index`, and optional `time_field` (`@timestamp`), `function`
(`count|mean|min|max|sum`, default `count`), `field` (required unless `count`),
`bucket_span` (`1h`), and `threshold` (`3`).

Each call derives a stable detector id from that configuration, `PUT`s the
config (create or replace), then `POST`s `_score` with the threshold override.
The response carries `anomaly_count`, `bucket_count`, `anomaly_threshold`, and
an `anomalies[]` of flagged buckets with `timestamp_iso`, `actual`, `expected`,
`z_score`, and `anomaly_score`. Only those buckets are formatted (max 10).

This is the recipe as a feature: no datafeed, no timer, no alerting. A caller
that wants monitoring scores a window on a schedule.

Background telemetry detectors are still deferred. `telemetry.anomaly` is not
consumed; with no datafeed the plugin would have to write its own series and
summon its own timer, which is more machinery than the feature earns today.

## 13. Failure and degraded modes

| Failure | Behaviour |
|---|---|
| binary download fails | plugin loads; tools return a clear "xerj unavailable" error; TUI shows the reason |
| node won't start | same; one retry per session, then stop trying |
| index run fails | keep the old index; retry with exponential backoff (max 3), then wait for the next trigger |
| node 429 | `autoindex` waits it out; retrieval returns a retryable error |
| index too large | `--dry-run`/`index_budget` before the first run; refuse above `index.maxBytes` with an actionable message |
| retrieval timeout | inject nothing for that turn |
| storage corrupt | reset the key, log, continue |

Every failure is logged to the plugin's storage ring buffer (last 50) and
visible in the panel. Nothing throws out of `setup`.

## 14. Testing

- Unit (`bun test`): semver compare, asset selection, prefix derivation, budget
  trimming, savings math (including the "model read it anyway" subtraction),
  context assembly, dedupe, config validation, redaction.
- Integration (podman, per AGENTS.md): a pinned xerj binary, temp data dir, a
  fixture repo with a deleted file, a renamed file, a binary blob, a `.env`, a
  large file. Assert: clean index, junk recorded, deletion reconciled,
  `.env` absent from the index, search returns the right `path:line`, memory
  store/recall/forget round-trips, namespace isolation holds.
- Hook tests with a fake context object: no injection when disabled, no
  duplicate passages across turns, deadline respected.
- TUI: render the slot and panel against a stub RPC; assert the strings and the
  command registration.
- Ranking: generated-file demotion is covered by `test/unit/rank.test.ts`.
  The integration fixture has no lockfile, so the two layers do not overlap:
  ordering is a unit concern, corpus membership is an integration concern.
- Integration harness (`test/integration/harness.ts`): one node on a scratch data
  root, the pinned binary cached under `XERJ_CACHE` (default
  `~/.cache/opencode/xerj-int`), `XERJ_BIN` to reuse an existing build. The
  fixture has a deletion, a rename, an addition, a `.env`, a binary blob, and a
  large text file. Documents are found by `ax_path`, the field XERJ actually
  stores; `path` is only the basename.
- CI (`.github/workflows/ci.yml`): unit job on Ubuntu, integration job that
  runs the suite inside a container, preferring podman and falling back to
  docker, then to the bare runner. The container needs `--pids-limit=-1`:
  XERJ's scan pool fails with `EAGAIN` under the default cap.

## 15. Milestones

| M | Scope | Done when |
|---|---|---|
| M0 | package skeleton (server + RPC + TUI), config, paths, storage, binary manager, node supervisor | `opencode` loads the plugin on a clean machine, downloads and starts a node, `xerj_status` answers |
| M1 | project corpus: prefix, `.xerj` state, first index, debounced refresh, status | a fresh repo indexes without intervention; editing a file changes search results within 10 s; deleting a file removes its docs |
| M1b | hidden corpus: `index.hidden` folders through `_bulk`, deletion reconciliation | editing `.agents/plan.md` changes its hidden document; a deleted file disappears |
| M4b | external reads: a `read` or any `bash` command referencing a file outside the project indexes it automatically | reading or `grep`-ing a file under `/tmp` makes it searchable without `xerj_index` |
| M2 | retrieval: `xerj_search`/`xerj_def`, formatting, context injection, budgets, accounting | the model answers a repo question from a citation without reading the file; counters match the transcript |
| M3 | memory: namespace, remember/recall/forget, compaction capture, prompt-time recall | a fact stored in one session is recalled in the next; forget removes it; namespaces don't leak |
| M4 | remote: spool + web index, external single files, `xerj_index` | fetching a URL makes its content searchable in the same session |
| M5 | TUI: sidebar, panel, commands, RPC events | sidebar shows live docs/hit rate/savings; `/xerj` opens the panel |
| M6 | opt-in brain, anomaly tool, telemetry detectors, docs, release | brain neighbors appear for a docs hit; anomaly tool flags a planted spike; README + config reference published |

Ship M0–M2 before anything else. That slice is the whole value proposition;
M3–M6 are multipliers.

## 16. Verification backlog

Confirm against a real binary before relying on these.

- [x] **1. Release assets.** Verified 2026-11-03 against `v1.0.0-rc.100`.
  Assets are `xerj-<ver>-<target>.tar.gz` (+ `.deb`), each with a `.sha256`
  sidecar in `<hex>  <filename>` form, 64 lowercase hex. Targets:
  `x86_64|aarch64-unknown-linux-{gnu,musl}`, `x86_64|aarch64-apple-darwin`,
  `x86_64|aarch64-pc-windows-msvc`. Linux installs default to musl. The archive
  holds `xerj-<ver>-<target>/xerj`. Latest is resolved by redirect, not the API.
- [x] **2. `autoindex --no-graph`.** Verified: the flag exists, `--json` emits
  one run document with `generation`, `files_*`, `records_*`, `junk_*`, and the
  recovery fields. A delete, a rename and an addition all reconciled on the
  next run with the same state dir: the old docs disappeared, the renamed file
  appeared under its new path, and counts stayed correct. Exit 0/3/4/1 as
  documented; `4` prints a JSON decision request and needs `--approve`.
  `autoindex status` has no `--json` and does not list custom-prefix indices.
- [x] **3. `autoindex` on a single file** is refused with
  `... is not a directory`; external files go through `_bulk`.
- [x] **4. `xerj brain`** hardcodes the `ax` prefix and has no `--prefix`, so
  two brains collide. Use `autoindex --brain <name> --prefix <p>` instead;
  verified it writes documents under `<p>-*` and edges to
  `.xerj-memory-<name>-edges`.
- [x] **5. `_cat/indices?format=json`** carries `docs.count` and `store.size`
  (human units). `_stats` is not a route.
- [x] **6. `/_memory`.** Store, recall (text), list, and forget work. `id` is
  caller-supplied and re-storing is idempotent by id. **Metadata filters do not
  match**: `term`, `match`, `metadata.kind.keyword`, and `bool.must` all
  returned zero hits on v1.0.0-rc.100, so kind filtering happens in the plugin.
  `recency_weight` is accepted (a recall with `0.2` returned normally).
- [x] **7. `/_graph/<brain>/overview` and `ego`.** Overview carries
  `nodes.total`, `edges.total`, `types`, `detectors`, `hubs`. Ego requires
  `?node=<id>` (POST is 405) and one node per call: a comma-joined list returns
  no edges. It returns `edges` plus `neighbors[{id, hop, via_edge}]`; neighbors
  have no text, and a `pathcite` target is a bodyless whole-file record, so
  resolve either through the docs index (an `ids` query, or the target's first
  section for file records).
- [x] **11. `_passage` cannot be combined with `hybrid`.** The engine refuses
  it (`search_phase_execution_exception`: fusion has no single winning
  passage). Run the legs separately and fuse in the plugin. `_passage` is also
  absent for plain-`text` symbol records (`code`), which belong to `xerj_def`.
- [x] **12. `_passage.start_offset`** is a byte offset into the record field.
  When the record starts at line 1 it maps onto the file, so the exact line is
  readable; a section record that starts later falls back to its start line.
- [x] **14. Hidden corpus, shell references, and automatic external reads.**
  Verified: `.agents` produced 4 hidden docs and a query cited
  `.agents/plan.md`; a `read`, a `cat`, and a `grep` over probe files made
  their phrases searchable without `xerj_index`; editing then deleting a
  hidden probe changed and removed its document. An existing index answers
  `PUT` with 409, not 400, and both ingesters tolerate it.
- [x] **15. Hidden/brain duplicates.** Brain paths are rewritten to
  project-relative before line resolution, and a hidden whole-file hit is
  dropped when a brain section covers the same path. Verified: a `.agents`
  query cited only `.agents/plan.md` sections, not the hidden whole file.
- [x] **13. Multi-platform binary selection.** Six release triples are computed
  (Linux x86_64/aarch64 musl or gnu, macOS x86_64/arm64, Windows
  x86_64/arm64 zip). Rosetta shells and x64 Node on Windows ARM64 resolve to
  the native build. Installs are target-scoped (`<ver>-<target>`), the
  post-install `--version` probe rejects a binary that cannot exec, and
  `binary.path` bypasses download entirely. Verified on Linux x86_64:
  `x86_64-unknown-linux-musl` was selected, installed, and probed.
- [x] **8. `xerj gain --json`** shape verified (searches, hit_rate, took_ms,
  top_indices, excluded_machine_searches).
- [x] **9. Node identity** is `cluster_name: "xerj"` in `GET /`. The banner's
  `version.number` is the ES wire version (8.13.0), not the XERJ release.
  `--port P` claims P, P+1 and P+2; no auto-port unless `--auto-port`.
- [x] **10. `<project>/.xerj` writability**: created from `setup` with `mkdir`;
  a read-only workspace fails there and is reported, not thrown.

## 17. Risks

| Risk | Mitigation |
|---|---|
| XERJ is pre-1.0; CLI/HTTP shifts | pin a version, isolate every call behind `node/client.ts` and `index/corpus.ts`, integration tests against the pin, upgrade behind a config flag. Prerelease ordering is numeric (`rc.99 < rc.100`), so a string compare is a bug. |
| Indexing large repos is slow/CPU heavy | budget pre-check, worker cap, `nice`, ignore defaults, background-only |
| Injected context hurts model quality | hard token caps, score threshold, dedupe, kill switch, measure on fixture tasks before widening budgets |
| Loopback `--insecure` is a superuser endpoint | loopback-only bind, 0700 data dir, documented, auth-on option |
| Savings numbers look like marketing | measured baseline, subtract files the model read anyway, show `~`, publish the formula |
| Plugin slows prompt admission | retrieval deadline, cache, background index, nothing blocking in `setup` |

## 18. Settled decisions

Resolved 2026-11-03:

1. **Node auth**: `--insecure` on loopback (D1). No auth mode in v1, and no
   `node.auth` key until a shared-host case exists.
2. **Fetched documents**: indexed automatically and persisted (D11).
3. **Package**: `@mrdrmccoy/xerj-opencode-plugin` on npm (D12).
4. **Dogfood**: this repo is indexed whole; `.agents/` is the example brain.

Nothing here blocks M0. The next thing to resolve is the verification backlog
(§16), not more design.
