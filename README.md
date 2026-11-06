# XERJ for OpenCode

Local code and documentation search, agent memory, and retrieval accounting
for OpenCode V2, backed by [XERJ](https://github.com/xerj-org/xerj).

The plugin downloads and manages a XERJ binary, runs a private node on loopback,
keeps a project index current with a filesystem watcher, and gives the model
cited passages instead of whole files. Nothing leaves the machine.

## What it does

- **Search.** `xerj_search` returns passages with `path:line` citations, not
  file listings. `xerj_def` finds a declaration by symbol.
- **Context injection.** Once per prompt, relevant passages and memories are
  spliced into the system context for that turn. It has a hard token budget
  and a deadline; a slow retrieval injects nothing rather than stalling.
- **Memory.** `xerj_remember`, `xerj_recall`, and `xerj_forget` keep durable
  project facts across sessions.
- **Remote ingest.** Pages fetched during a session are spooled and indexed, so
  a URL read today is searchable tomorrow. Any shell command that references
  a file outside the project also indexes it.
- **Hidden trees.** `index.hidden` indexes folders that `autoindex` skips, such
  as `.agents` or `.github`, as plain searchable documents.
- **Second brain.** Opt in with `index.brain` to build a graph over a docs
  folder. Hits expand one hop along citation and sequence edges.
- **Accounting.** `xerj_status` reports queries, hit rate, bytes returned, and
  measured token savings. The sidebar and `/xerj` panel show the same numbers.
- **Anomaly scoring.** `xerj_anomaly` flags spikes in a numeric metric series
  using XERJ's on-demand detector. It is batch scoring, not monitoring.

## Requirements

- OpenCode V2 with plugin support.
- Linux x86_64/aarch64, macOS x86_64/arm64, or Windows x86_64/arm64.
- No XERJ install needed: the plugin manages its own binary under
  `~/.local/share/opencode/xerj/` (or `%LOCALAPPDATA%` on Windows).
- Linux installs use the static musl build by default.

Only Linux x86_64 has been exercised end to end. The other release targets are
selected, downloaded, and probed for execution, but not tested in CI.

## Install

The plugin is published as `@mrdrmccoy/xerj-opencode-plugin`. Add it to any
OpenCode config file, global or project:

```jsonc
// ~/.config/opencode/opencode.jsonc   (all projects)
// or <project>/opencode.json          (one project)
{
  "plugins": [
    {
      "package": "@mrdrmccoy/xerj-opencode-plugin",
      "options": {
        "index": { "hidden": [".agents"] }
      }
    }
  ]
}
```

The host fetches the package on first load and caches it under
`~/.cache/opencode/`. No separate install command is needed.

### From a local checkout

A checkout works the same way. Clone it, install its dev dependencies, and
point `package` at the directory:

```bash
git clone https://github.com/xerj-org/xerj-opencode-plugin.git \
  ~/src/xerj-opencode-plugin
cd ~/src/xerj-opencode-plugin
bun install      # dev dependencies; the host supplies @opencode/plugin
```

```jsonc
// ~/.config/opencode/opencode.jsonc   (all projects)
// or <project>/opencode.json          (one project)
{
  "plugins": [
    {
      "package": "/home/you/src/xerj-opencode-plugin",
      "options": {
        "index": { "hidden": [".agents"] }
      }
    }
  ]
}
```

Use an absolute path. A relative `package` resolves against the project holding
the config, not against the checkout, so `"./"` works only when the config and
the checkout share a directory. That is what this repository does in its own
`opencode.json`.

The server and RPC entries are TypeScript sources that the host compiles when
it loads them. The TUI entry ships prebuilt (`dist/tui.js`) because it must bind
to the host's JSX runtime rather than resolve its own copy; `prepack`
regenerates it.

After adding the entry, restart OpenCode once. The first start downloads XERJ,
creates `<project>/.xerj`, and builds the project index in the background.
`xerj_status` reports when it is ready. `opencode debug config` lists the
config files that were read, which is the quickest way to confirm the entry was
picked up.

## Where the config goes

OpenCode reads two config documents and applies them in order:

| Scope | Path | Notes |
|---|---|---|
| Global | `~/.config/opencode/opencode.jsonc` | Applies to every project. `$XDG_CONFIG_HOME` replaces `~/.config` when set. |
| Project | `<project>/opencode.json` | Applies to that project only. |

Each directory holds one document: when both `opencode.json` and
`opencode.jsonc` exist, `opencode.json` wins. In a directory without
`opencode.json`, `opencode.jsonc` is read instead. The same rule applies in the
global config directory, which is why the examples above name
`opencode.jsonc` there. This is what `opencode debug config` reports:

```bash
opencode debug config        # prints every config source with its path
opencode debug paths         # prints the global config, data, cache, state dirs
```

## Configuration

Options go under the plugin entry, inside `options`. Never at the document
root: a top-level `context` key is ignored by the plugin.

Every option has a default, so the file only needs the keys that differ. A
malformed value warns and falls back instead of failing plugin load. Nested
objects merge per key, so `{"context": {"maxTokens": 800}}` keeps the other
context defaults.

This is the complete set with its defaults, in
`~/.config/opencode/opencode.jsonc` (all projects) or `<project>/opencode.json`
(one project):

```jsonc
{
  "plugins": [
    {
      "package": "@mrdrmccoy/xerj-opencode-plugin",
      "options": {
        "binary":  { "version": "auto", "path": null, "target": null,
                     "libc": "musl" },
        "storage": { "root": null },
        "node":    { "url": null, "priority": "low", "port": 9200,
                     "dataDir": null, "idleMs": 1800000,
                     "shutdownOnIdle": true },
        "index":   { "auto": true, "watch": true, "debounceMs": 800,
                     "periodicMs": 900000, "workers": null, "brain": [],
                     "hidden": [], "hiddenMaxBytes": 262144,
                     "semantic": true, "neural": true, "maxBytes": 2147483648,
                     "maxMinutes": 10 },
        "remote":  { "enabled": true, "maxBytes": 2000000 },
        "context": { "enabled": true, "maxTokens": 1500, "memoryTokens": 400,
                     "maxPassages": 8, "timeoutMs": 400 },
        "memory":  { "enabled": true, "captureTurns": true,
                     "retain": { "days": 180, "maxCount": 0,
                                 "maxBytes": 2147483648 } },
        "stats":   { "enabled": true, "bytesPerToken": 4,
                     "maxBaselineBytes": 131072 },
        "telemetry": { "anomaly": false }
      }
    }
  ]
}
```

The same entry works with a checkout path instead of the package name; see
[Install](#install).

| Key | Meaning |
|---|---|
| `binary.version` | `auto` tracks the latest release; any other value pins it. |
| `binary.path` | Use this binary; skip download, upgrade, and platform checks. |
| `binary.target` | Explicit release triple, e.g. `aarch64-apple-darwin`. |
| `binary.libc` | `musl` (default) or `gnu` on Linux. |
| `storage.root` | Per-project XERJ root. Defaults to `<project>/.xerj`; relative paths resolve inside the project, absolute paths may point elsewhere. |
| `node.url` | Attach to this node and never spawn one. |
| `node.logMaxBytes` | Size at which `node.log` rotates to `node.log.1`; `0` disables rotation. Default 8 MiB. |
| `node.priority` | CPU and I/O priority for every XERJ process: `low` (default), `normal`, or `high`. `low` is nice 19 plus idle-class I/O on Linux, the idle priority class on Windows. |
| `node.port` | Preferred port. The supervisor advances it if taken. |
| `node.idleMs` | Stop this project's node after this long with no session activity. |
| `node.shutdownOnIdle` | Set false to keep the node up after the last session closes. |
| `index.auto` | Run project, hidden, and brain indexing on startup. |
| `index.watch` | Refresh on file changes. Project-local state forces the plugin's own watcher with one-shot index runs; set false for polling only. |
| `index.brain` | Folders to index as second brains, e.g. `[".agents"]`. |
| `index.hidden` | Hidden folders to index as plain documents. Empty means "the docs folders that exist": `.agents`, `.github`, `.claude`. Set a list to choose exactly what is indexed. |
| `index.hiddenMaxBytes` | Per-file ceiling for hidden documents. |
| `prjdocs.maxTargets` | Documentation sites crawled in one run. Default 40. |
| `prjdocs.maxPages` | Pages per site; `0` uses the per-source default (8 to 25). |
| `prjdocs.eager` | Eager mode: no page-type or depth limit, model-judged relevance, and search for unknown technologies. Default `false`. |
| `prjdocs.eagerMaxPages` | Pages per site in eager mode. Default 120. |
| `prjdocs.eagerMaxDepth` | Link depth in eager mode. Default 12. |
| `prjdocs.eagerModelCalls` | Model judgements per run; the heuristic covers the rest. Default 150. |
| `sysdocs.maxDocs` | Pages indexed per run. Default 5000. |
| `sysdocs.maxBytesPerDoc` | Bytes kept per page, head first. Default 64 KiB. |
| `sysdocs.manDirs` | Extra man roots, searched before the machine roots. Empty means `MANPATH` only. |
| `sysdocs.infoDirs` | Extra info roots, searched before the machine roots. Empty means `INFOPATH` only. |
| `memory.retain.days` | Days an automatic summary is kept; `0` disables the age cap. |
| `memory.retain.maxCount` | Summaries kept regardless of age; `0` disables the count cap. |
| `memory.retain.maxBytes` | Bytes of summary text kept; `0` disables the size cap. |
| `index.graph` | Index the project as one graph corpus (a "super brain"): sections, symbols, `path:line`, and edges. On by default; `false` restores the flat `--no-graph` corpus with the engine's own watcher. A change rebuilds the project corpus once. |
| `index.semantic` | Include the semantic retrieval leg. |
| `index.neural` | Embed passages with the node's neural model (`--embed-mode neural`). Set `false` for lexical embeddings. Changing it rebuilds the project index once; neural indexing is roughly ten times slower than lexical. |
| `remote.enabled` | Spool and index fetched pages. |
| `context.enabled` | Inject retrieved context; the kill switch. |
| `context.maxTokens` | Ceiling for injected passages. |
| `context.memoryTokens` | Ceiling for injected memories. |
| `context.timeoutMs` | Retrieval deadline; miss it and inject nothing. |
| `memory.captureTurns` | Store each substantive turn's final answer (400+ characters) as a `summary` memory, paired with its prompt. Needs `context.enabled`, which records the prompts. |
| `stats.maxBaselineBytes` | Cap on the baseline credited per cited file. |
| `telemetry.anomaly` | Reserved; background telemetry is not implemented. |

## Tools

| Tool | Input | Use |
|---|---|---|
| `xerj_search` | `query`, `k?`, `max_tokens?` | Find passages before reading files. |
| `xerj_def` | `symbol`, `k?` | Find a declaration by name. |
| `xerj_status` | — | Node, index, memory, and accounting state. |
| `xerj_remember` | `text`, `kind?`, `topic?` | Store a durable fact. |
| `xerj_recall` | `query`, `k?` | Retrieve memories by meaning. |
| `xerj_forget` | `id` | Retract a memory. |
| `xerj_index` | `url?` or `path?` | Index a page or external file now. |
| `xerj_anomaly` | `index`, `time_field?`, `function?`, `field?`, `bucket_span?`, `threshold?` | Score a metric series and return flagged buckets. |
| `xerj_dataset` | `action` (`list`, `describe`, `create`, `delete`, `export`, `import`), `index?`, `path?`, `mapping?`, `force?`, `pageSize?`, `batchSize?` | Manage extra indexes and move data in or out as an Elasticsearch-compatible NDJSON dump. |
| `xerj_reindex` | — | Run an incremental pass over the project, fetched pages, and hidden folders now. |
| `xerj_sysdocs` | — | Index this machine's man and info pages; unchanged pages are skipped and vanished ones pruned. |
| `xerj_prjdocs` | `eager?` | Index official docs for the project's languages, frameworks, and cloud APIs at the versions it uses. |

## TUI

- Sidebar: docs and size, hit rate, tokens saved, freshness.
- `/xerj`: open the details panel. Also accepts `status`, `reindex`,
  `remember <text>`, and `search <query>`.
- `/xerj-reindex`, `/xerj-remember`, `/xerj-search`: direct commands.

## How retrieval works

A search runs three legs and fuses them:

1. **Lexical**: `match` on `body`, the field that produces a passage.
2. **Semantic**: runs when the index mapping is `semantic_text`, so a question
   phrased differently from the code can still land.
3. **Symbol and title**: `multi_match` weighting `name` (the function or type a
   record is about) and `title` (its file or section) above `body`, so a file
   that defines the concept outranks prose that mentions it.

The legs are fused with reciprocal rank fusion in the plugin, because the
engine refuses passages on a server-side hybrid query. The fused pool is twice
the requested size, so demotion and filtering can promote something that
ranked lower.

Then the context surface decides what is worth a token:

- **Relevance gate.** A passage survives only when its text or path carries
  half the prompt's content terms, matched by stem so "generated" finds
  "generate". The top three semantic hits get a pass when they share a term,
  which is what lets the semantic leg answer a paraphrase.
- **Prompt gate.** A prompt under 12 characters, a slash command, or one made
  only of filler ("continue", "go ahead") retrieves nothing. Prompts the gate
  drops are counted as `noiseSkips`, not as misses, so the hit rate reflects
  real attempts.
- **Demotion, not removal.** Lockfiles, minified assets, build output, license
  boilerplate, and chronicle files (changelogs, status logs, journals) sink
  unless the prompt names them. Chronicles name every feature and answer
  nothing, so they would otherwise match any question.
- **One section per file.** A long README cannot spend the whole budget; the
  first matching section stays and the rest give way.
- **Per-session dedupe.** A `path:line` already injected in this session is not
  injected again, so a follow-up question does not pay twice for one section.
- **Budget.** `context.maxPassages` passages within `context.maxTokens`, split
  evenly so one whole-section match cannot hide the others.

Send a question to `xerj_search` and the same legs run with the tool surface:
no relevance gate, no budget discard, and generated files kept but demoted,
because there the caller asked explicitly.

Brain hits get one hop of neighbors, with their own budget. Configured brains
follow `pathcite` and `sequence` edges; the project-wide graph follows only
`pathcite`, because adjacent-section edges added tokens without adding answers
when measured here. Brain paths are rewritten to project-relative paths before
line resolution, and a hidden whole-file hit is dropped when a brain section
covers the same file, so one file is cited from its precise section.

### Measuring a change

`bun run eval` runs 60 labeled questions against a live index and reports how
often the expected file survives, the bytes it costs, and every miss:

```
bun run eval
bun run eval --k 8 --surface tool --json
```

It prints two numbers: how often the expected file is cited, and how often the
answer text itself arrived (a token each prompt pins). The second is the one
that says whether the injected block is useful rather than merely on target,
and it separates a file that was never picked from a section that was cut.

Defaults match what the plugin ships. Run it against a current index: a file
added since the last pass is missing from the corpus, and the miss it causes
looks like a ranking fault. A one-prompt change is inside the noise of a
60-prompt set; treat a single point as unproven.

Savings are measured, not asserted: the baseline is each cited file's size
capped at `stats.maxBaselineBytes`, counted once per session. Reading a file
subtracts the bytes actually read, so a partial read only removes what it
covered.

## Project documentation

`/xerj-prjdocs` reads the project's manifests and file extensions, then crawls
the official documentation for what it finds into
`xop-<project>-prjdocs-docs`.

Detection is deliberate, not clever:

- **Languages** come from file extensions and from the files that pin a runtime:
  `.nvmrc`, `.node-version`, `.python-version`, `.tool-versions`,
  `rust-toolchain.toml`, `engines` in `package.json`, `go` in `go.mod`, and
  `requires-python` in `pyproject.toml`.
- **Frameworks** come from `package.json` dependencies, `requirements.txt`,
  `Cargo.toml`, and `go.mod`, matched against a known list.
- **Cloud APIs** come from dependency names: `@aws-sdk/*`, `@google-cloud/*`,
  `@azure/*`, `stripe`, `twilio`, `@supabase/*`, `wrangler`, `vercel`, and the
  like.

Each technology maps to one entry URL. Versioned sources (Node, Python) produce
one URL for the version the project declares and one for the latest release,
resolved from `nodejs.org/dist/index.json` and `endoflife.date`; everything else
is an unversioned site with a page budget of 8 to 25.

The crawler stays on the site it started from, follows links two levels deep,
skips assets and non-HTML responses, and stops at its page budget. A document
carries `url`, `title`, `tech`, `version`, and `fetched_at`, so a page for a
version the project no longer uses is **pruned** on the next run, as is a page
that moved. Unchanged pages are skipped by body hash.

Measured here: two technologies, 12 pages, 1 s; moving `.nvmrc` from 22 to 20
indexed the 20 pages and pruned the 5 from 22; removing the pin pruned the rest.

### Eager mode

`/xerj-prjdocs eager`, or `prjdocs.eager: true`, trades the safety limits for
reach:

- **No page-type limit.** Plain text, markdown, and JSON are indexed alongside
  HTML.
- **A wider depth.** Links are followed up to `prjdocs.eagerMaxDepth` (12) and
  `prjdocs.eagerMaxPages` pages per site (120).
- **Model-judged relevance.** Each page is shown to the current model, which
  answers `yes` or `no`; the page is kept and its links followed only when it
  says `yes`. The entry page is always kept so the crawl can start. Judgements
  are cached per URL and capped at `prjdocs.eagerModelCalls` (150) per run;
  past the cap, and whenever the model is unavailable, a deterministic
  heuristic decides: a page that names the technology, sits under a
  documentation path, or matches two of the project's own terms is relevant.
- **Documentation search for unknown technologies.** A dependency with no
  entry in the source table is searched for with the host's web search, and the
  first result on a documentation host is crawled. Discovered URLs are cached,
  so a later run does not search again.

Eager mode is off by default because it costs model calls and network traffic.
Measured on `docs.solidjs.com` with the heuristic judge: 25 pages and 169 KB in
9 s, reaching pages three levels below the entry.

## Extra indexes and dumps

`xerj_dataset` manages the indexes on this node beyond the plugin's own
corpora, and moves data in and out in the format `_bulk` and `elasticdump`
use.

```
xerj_dataset  action=list
xerj_dataset  action=create index=notes mapping='{"properties":{"body":{"type":"text"}}}'
xerj_dataset  action=export index=notes path=/tmp/notes.ndjson
xerj_dataset  action=import path=/tmp/notes.ndjson index=notes-copy
xerj_dataset  action=delete  index=notes-copy
```

A dump is one action line and one source line per document, which is what
`_bulk` reads back:

```
{"index":{"_index":"notes","_id":"1"}}
{"body":"alpha note","n":1}
```

Export pages through `_search` (`pageSize`, 500 by default) and stops at
500,000 documents. Import streams the file line by line, creates the target
index if it is missing, writes in batches (`batchSize`, 500 by default), and
counts malformed lines as skipped rather than failing the run. Documents
without `_id` get a generated id.

Indexes the plugin maintains (`xop-*`, `.xerj-*`, `.xerj_*`) are marked
`managed` in `list`, and `delete` refuses them unless `force` is true: dropping
one loses a corpus the plugin rebuilds only on a full reindex.

## Standalone MCP server

Agents that do not run OpenCode can use the same index over MCP. The package
ships an `xerj-mcp` executable that speaks JSON-RPC on stdio:

```json
{
  "mcpServers": {
    "xerj": {
      "command": "npx",
      "args": [
        "-y",
        "@mrdrmccoy/xerj-opencode-plugin",
        "xerj-mcp",
        "--project",
        "/path/to/repo"
      ]
    }
  }
}
```

The executable needs nothing but Node 20 or later: it is an ESM bundle with a
`node` shebang, so `npx`, `bunx`, and a direct call all work.

```
npx -y @mrdrmccoy/xerj-opencode-plugin@latest xerj-mcp --project /path/to/repo
bunx @mrdrmccoy/xerj-opencode-plugin@latest xerj-mcp --project /path/to/repo
node ./node_modules/@mrdrmccoy/xerj-opencode-plugin/dist/mcp.mjs --project .
```

Tools: `search`, `def`, `status`, `remember`, `recall`, `forget`, `index`,
`anomaly`, `reindex`, `sysdocs`, and `prjdocs`. They are the same tools the
OpenCode plugin registers, plus the three corpus runners the plugin exposes
only as commands.

The handshake touches nothing: `initialize` and `tools/list` answer
immediately, and the binary download, node start, and index pass happen behind
the first call that needs them. Diagnostics go to stderr, so every line of
stdout is JSON-RPC.

Settings come from the environment because there are no plugin options:

| Variable | Meaning |
| --- | --- |
| `XERJ_BIN` | Use this XERJ binary and never download one. |
| `XERJ_STORAGE_ROOT` | Project state directory; defaults to `<project>/.xerj`. |
| `XERJ_NODE_URL` | Attach to a running node instead of spawning one. |

The server runs one node per project, exactly as the plugin does, so an
OpenCode session and an MCP client on the same project share it.

## Releasing

Pushing a tag that matches `package.json` publishes to npm:

```
git tag -a v0.7.0 -m "v0.7.0"
git push origin main --follow-tags
```

`.github/workflows/publish.yml` runs on any `v*` tag. It first calls
`ci.yml` (typecheck, unit, and integration tests against a pinned binary), and
only a green run reaches the publish job, so a tag that would have failed CI
never lands on the registry.

The publish job stops if the tag and the manifest disagree, skips silently when
that version is already published, and otherwise runs
`npm publish --access public --provenance`.

`NPM_TOKEN` is read from the `npm` GitHub environment, so the job declares
`environment: npm` and any protection rules on that environment (required
reviewers, branch or tag restrictions) apply before it publishes.

## System documentation

`/xerj-sysdocs` indexes the man and info pages this machine can resolve into
their own corpus (`xop-sys-<host hash>`).

Roots are searched in this order, and the first copy of a name wins, so a page
you installed shadows the distribution's copy:

1. `MANPATH` and `INFOPATH`, when set.
2. `sysdocs.manDirs` and `sysdocs.infoDirs`, when configured.
3. `$XDG_DATA_HOME` (or `~/.local/share`), then `~/.nix-profile/share`.
4. `NIX_PROFILES`, then `/run/current-system/sw` for a NixOS system profile.
5. `HOMEBREW_PREFIX`, then `/home/linuxbrew/.linuxbrew`, `/opt/homebrew`, and
   `/usr/local` for Homebrew.
6. `/usr/local/share` and `/usr/share`.

A root that does not exist is skipped, so a machine without Nix or Homebrew
pays nothing for either. The corpus keeps `path`, `abs_path`, `title`, `source`,
and `mtime` per page, so a citation reads `man/git.1`.

A manifest records each page's path, mtime, size, and document id, so a first
run indexes everything (3648 pages in about six seconds here, 33 MB) and later
runs skip unchanged pages in under 100 ms. A page that disappeared from disk is
deleted from the corpus.

`body` is plain `text`, not `semantic_text`, so no page is embedded. A machine
holds thousands of long pages, embedding them with the local model takes hours,
and reference prose already carries the words people search for.

## Data locations

```
~/.local/share/opencode/xerj/bin/<version>-<target>/xerj
~/.local/share/opencode/xerj/nodes/.port-lock  shared port lock
<project>/.xerj/                               storage root by default
<project>/.xerj/nodes/<prefix>/                node port, pid, log, heartbeats
<project>/.xerj/nodes/<prefix>/data/           engine storage and journal
<project>/.xerj/spool/<prefix>/                fetched pages
```

Set `storage.root` to an absolute path to keep a project's data elsewhere. A
configured path inside the project must be under a dot-directory; a visible
engine data directory would be indexed by the watcher and feed its own writes
back into the next pass. A refused path falls back to `.xerj` and appears in
the status warnings.

The node is scoped to the project and stops when the last session closes, after
`node.idleMs` with no activity, or when the plugin unloads. Indexing and memory
survive the stop; the next request restarts the node on the same port with the
same data.

## Limitations

- XERJ is pre-1.0. The plugin pins a release and isolates every call behind
  `node/client.ts`; upgrades require the same major and never downgrade.
- `autoindex` skips hidden paths in every mode, including with `--no-ignore`,
  so `index.hidden` covers configured folders (`.agents`, `.github`) through a
  separate `_bulk` index. That is the one corpus a project graph cannot absorb.
  `.git`, `.xerj`, build output, virtualenvs, and secret-shaped files are
  always skipped.
- External files are indexed as plain text through `_bulk`; no AST or symbol
  extraction.
- Shell references are detected heuristically: every literal argument of a
  shell command that resolves to an existing regular file is indexed. Short
  option values, variables, globs, tilde paths, and redirection targets are
  not resolved, and `cd` is followed only within a simple
  `cd dir && ...` chain.
- The engine cannot watch a graph (`--watch` requires `--no-graph`), so a
  graph project refreshes through the plugin's own directory watcher, and a
  folder brain reindexes on startup and on `/xerj-reindex`.
- A corpus built in one mode cannot be continued in the other: switching
  `index.graph` rebuilds the project corpus once (about two minutes on this
  repository with neural embeddings).
- Anomaly scoring has no datafeed, timer, or alerting.

## Development

```bash
bun install
bun test test/unit        # pure functions, no node needed
bun test test/integration # real node on a scratch data root (~5 s)
bun scripts/smoke.ts      # download, spawn, attach, stop
bun run typecheck
```

Integration tests need a XERJ binary once; it is cached in
`~/.cache/opencode/xerj-int` (override with `XERJ_CACHE`, or point `XERJ_BIN`
at an existing build). CI runs the unit suite on Ubuntu and the integration
suite inside a container, preferring podman and falling back to docker.

The repo dogfoods its own plugin through `opencode.json`: `.agents` is indexed
both as a hidden corpus and as the example brain, which exercises the
duplicate-collapse path in retrieval.

## License

Apache-2.0.
