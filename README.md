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
        "node":    { "url": null, "port": 9200, "dataDir": null,
                     "idleMs": 1800000, "shutdownOnIdle": true },
        "index":   { "auto": true, "watch": true, "debounceMs": 800,
                     "periodicMs": 900000, "workers": null, "brain": [],
                     "hidden": [], "hiddenMaxBytes": 262144,
                     "semantic": true, "maxBytes": 2147483648,
                     "maxMinutes": 10 },
        "remote":  { "enabled": true, "maxBytes": 2000000 },
        "context": { "enabled": true, "maxTokens": 1500, "memoryTokens": 400,
                     "maxPassages": 4, "timeoutMs": 400 },
        "memory":  { "enabled": true, "captureTurns": true },
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
| `node.port` | Preferred port. The supervisor advances it if taken. |
| `node.idleMs` | Stop this project's node after this long with no session activity. |
| `node.shutdownOnIdle` | Set false to keep the node up after the last session closes. |
| `index.auto` | Run project, hidden, and brain indexing on startup. |
| `index.watch` | Refresh on file changes. Project-local state forces the plugin's own watcher with one-shot index runs; set false for polling only. |
| `index.brain` | Folders to index as second brains, e.g. `[".agents"]`. |
| `index.hidden` | Hidden folders to index as plain documents, e.g. `[".agents"]`. |
| `index.hiddenMaxBytes` | Per-file ceiling for hidden documents. |
| `index.semantic` | Include the semantic retrieval leg. |
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

## TUI

- Sidebar: docs and size, hit rate, tokens saved, freshness.
- `/xerj`: open the details panel. Also accepts `status`, `reindex`,
  `remember <text>`, and `search <query>`.
- `/xerj-reindex`, `/xerj-remember`, `/xerj-search`: direct commands.

## How retrieval works

1. A lexical leg queries `body`, which is the field that produces a passage.
2. A semantic leg runs when the index mapping is `semantic_text`.
3. The two legs are fused with reciprocal rank fusion in the plugin. The
   engine refuses passages on a server-side hybrid query, so fusion happens
   client-side.
4. Results are cut to the token budget and formatted with `path:line`
   citations.
5. Brain hits get one hop of neighbors, using only `pathcite` and `sequence`
   edges, capped and budgeted separately.
6. Brain paths are rewritten to project-relative paths before line resolution.
   A hidden whole-file hit is dropped when a brain section covers that path, so
   one file is cited from the precise section index.

Savings are measured, not asserted: the baseline is each cited file's size
capped at `stats.maxBaselineBytes`, counted once per session. Reading a file
subtracts the bytes actually read, so a partial read only removes what it
covered.

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
- `autoindex` skips hidden paths. `index.hidden` covers configured folders
  (`.agents`, `.github`) through a separate `_bulk` index. `.git`, `.xerj`,
  build output, virtualenvs, and secret-shaped files are always skipped.
- External files are indexed as plain text through `_bulk`; no AST or symbol
  extraction.
- Shell references are detected heuristically: every literal argument of a
  shell command that resolves to an existing regular file is indexed. Short
  option values, variables, globs, tilde paths, and redirection targets are
  not resolved, and `cd` is followed only within a simple
  `cd dir && ...` chain.
- `autoindex` cannot watch a graph, so brains reindex on startup and on
  `/xerj-reindex`, not on every edit.
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
