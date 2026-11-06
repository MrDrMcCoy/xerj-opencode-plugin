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
- **One graph corpus.** `index.graph` indexes the project as a single corpus
  with sections, symbols, `path:line`, and reference edges, refreshed by the
  plugin's own watcher. `index.hidden` adds folders the engine skips, such as
  `.agents` or `.github`; a folder configured in `index.brain` is indexed once,
  as a graph, not twice.
- **System documentation.** `/xerj-sysdocs` indexes this machine's man and info
  pages, including user, Homebrew, and Nix roots, skipping unchanged pages and
  pruning pages that vanished.
- **Library documentation.** `/xerj-prjdocs` reads the project's manifests and
  runtime pins, then crawls official docs for its languages, frameworks, and
  cloud APIs at the versions it uses, pruning other versions. `eager` widens
  the crawl and judges pages with the current model.
- **Your own datasets.** `xerj_dataset` lists, creates, and deletes extra
  indexes, and imports or exports them as Elasticsearch-compatible NDJSON
  dumps.
- **MCP.** The same twelve tools are available to agents that do not run
  OpenCode, through a standalone `xerj-mcp` server on stdio.
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
| `prjdocs.builtin` | Always index XERJ's own docs and the Elasticsearch reference for this node's version. Default `true`. |
| `prjdocs.builtinXerjPages` | Markdown files taken from the XERJ repository. Default 200. |
| `prjdocs.builtinElasticsearchPages` | Crawl budget for the Elasticsearch reference; 2500 yields about 630 API pages. Default 2500. |
| `prjdocs.builtinRefreshDays` | Days before the always-on sources are crawled again. Default 7; `0` always refreshes. |
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

The sidebar shows four lines: node state with document and size counts, queries
with hit rate and prompts the relevance gate skipped, tokens saved, and index
freshness. Every command is also in the palette.

| Command | What it does |
| --- | --- |
| `/xerj` | Open the details panel: node, binary, index, corpora, datasets, memory, usage, counters, top cited files, and health. |
| `/xerj status` | Same as `/xerj`. |
| `/xerj reindex` | Run an incremental pass over the project and report the record count. |
| `/xerj remember <text>` | Store a durable fact in project memory. |
| `/xerj search <query>` | Search the index and show cited passages in a dialog. |
| `/xerj-reindex` | Incremental pass over the project, fetched pages, and hidden folders. |
| `/xerj-remember <text>` | Store a memory (prompts for the text when empty). |
| `/xerj-search <query>` | Search and show cited passages (prompts when empty). |
| `/xerj-prjdocs [eager]` | Index official docs for the project's languages, frameworks, and cloud APIs. Add `eager` for the wider, model-judged crawl. |
| `/xerj-sysdocs` | Index this machine's man and info pages. |

The panel closes three ways: `escape`, the **✕ close** button in its footer, or
running `/xerj` again.

The TUI talks to the server part over RPC (`status`, `reindex`, `search`,
`remember`, `sysdocs`, `prjdocs`, and an `updated` event the sidebar follows),
so the commands work in any OpenCode window on the same project.

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
- **GPU compute stacks** come from what only that toolchain uses:

  | Stack | Proof |
  |---|---|
  | CUDA | `.cu` or `.cuh` files, `cuda_runtime.h`, `cublas`/`cudnn`/`nccl` headers, `__global__`, `cudaMalloc`, `nvcc`, `CUDAExtension`, or `cupy`/`pycuda`/`cuda-python` |
  | ROCm | `.hip` files, `hip/hip_runtime.h`, `rocblas`/`hipblas`/`miopen` headers, `hipMalloc`, `hipcc`, or a `rocm/dev-*` base image |
  | SYCL | `sycl/sycl.hpp`, `CL/sycl.hpp`, `sycl::queue`, `-fsycl`, `SYCL_DEVICE_FILTER`, or `adaptivecpp` |
  | oneAPI | `oneapi/mkl.hpp`, `mkl.h`, `dnnl.hpp`, `oneapi/tbb/*`, `level_zero/ze_api.h`, `zeInit`, `dpcpp`/`icpx`, `ONEAPI_ROOT`, `intel/oneapi-*` images, or `intel-extension-for-pytorch`/`scikit-learn-intelex`/`mkl` |
  | Vulkan | `.glsl`/`.vert`/`.frag`/`.comp`/`.slang` shaders, `vulkan/vulkan.h`, `vkCreate*`, `find_package(Vulkan)`, `glslang`/`shaderc`, or the `ash`/`vulkano` crates |

  A GPU stack is reported only when a header, build file, kernel extension, or
  version pin proves it. A project that merely mentions CUDA in prose does not
  get its documentation.

  Each stack is a collection, not one URL, so a crawl names its component
  guides: CUDA's cuBLAS, cuFFT, cuSPARSE, cuSOLVER, cuRAND, NPP, cuDNN, and
  NCCL; ROCm's HIP, rocBLAS, MIOpen, RCCL, rocFFT, rocPRIM, rocSPARSE, and the
  rest of its `projects/` tree; oneAPI's specification plus oneTBB, oneDNN, and
  oneCCL; Vulkan's guide and specification chapters. The per-stack budget is 200
  pages for CUDA, 150 for ROCm, 120 for Vulkan, 80 for oneAPI, and 40 for
  SYCL, with at least eight pages per component. Seeds are crawled four at a
  time: one vendor host serves every guide, and seventeen simultaneous requests
  come back empty.

Each technology maps to one entry URL. Versioned sources (Node, Python, CUDA,
ROCm) produce one URL for the version the project declares and one for the
latest release; oneAPI's specification is unversioned and stays inside the
foundation's specification section rather than its news pages. Intel's own
documentation site refuses non-browser clients, so oneAPI reads the UXL
Foundation specification, which is where that specification is maintained. Node and Python resolve theirs from `nodejs.org/dist/index.json`
and `endoflife.date`, CUDA from its archive listing, and ROCm from the
`docs-<version>` path; a version the project does not pin falls back to the
current guide. Everything else is an unversioned site with a page budget of 8
to 25.

Two sources are indexed on every run, whatever the project uses:

- **XERJ's own documentation.** Every markdown file under `docs/` in the
  `xerj-org/xerj` repository, recipes included, fetched from the source rather
  than a rendered site. This is what answers "how does the engine do X".
- **The Elasticsearch reference** for the version this node emulates. The node
  reports its wire version (`8.13.0`), the branch follows it (`8.13`), and a
  version change prunes the old pages on the next run. The crawl starts from
  `rest-apis.html`, takes the chapter indexes it links, and crawls each one
  separately, because one breadth-first pass over the whole site spends its
  budget on chapter summaries and reaches no endpoints. Links outside the
  branch are not followed, so the company blog and other products stay out.

Eager mode (`/xerj-prjdocs eager`, or `prjdocs.eager: true`) widens the
Elasticsearch crawl from the API chapters to the whole guide, keeping the API
pages and adding concepts, configuration, and operations. Three families stay
out because they describe versions other than the one in use: release notes,
migration guides, and deprecated APIs. The same rule filters links, so a
chapter that cites a migration page does not drag it in.

Set `prjdocs.builtin: false` to skip both, and size them with
`prjdocs.builtinXerjPages` (200) and `prjdocs.builtinElasticsearchPages`
(2500, which yields roughly 630 API pages). `prjdocs.builtinRefreshDays`
(7) is how long those pages stay current: the reference crawl takes about a
minute, so it runs on that window rather than on every command, and the
existing pages are kept in the meantime.

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

### Client setup

Any MCP client works; the entry is the same everywhere.

**Claude Code** (`.mcp.json` in the project, or the CLI):

```json
{
  "mcpServers": {
    "xerj": {
      "command": "npx",
      "args": ["-y", "@mrdrmccoy/xerj-opencode-plugin@latest", "xerj-mcp", "--project", "."]
    }
  }
}
```

```
claude mcp add xerj -- npx -y @mrdrmccoy/xerj-opencode-plugin@latest xerj-mcp --project .
```

**Cursor** (`~/.cursor/mcp.json`) uses the same shape. **Anything else** that
spawns a command over stdio works the same way; point it at `xerj-mcp`.

### Arguments

| Argument | Meaning |
| --- | --- |
| `--project <dir>`, `-C <dir>` | Project to index. Defaults to the working directory. |
| `--url <node url>` | Attach to a running node instead of spawning one. |
| `--help`, `-h` | Print usage on stderr and exit. |

### Tools

The MCP server exposes twelve tools, the same set the OpenCode plugin
registers, so a prompt written for one works in the other:

| Tool | Arguments | What it does |
| --- | --- | --- |
| `search` | `query`, `k?`, `max_tokens?` | Cited passages from the project, docs, and memory corpora. |
| `def` | `symbol`, `k?` | A declaration by name with its signature. |
| `status` | — | Node, index, corpora, memory, and accounting. |
| `remember` | `text`, `kind?`, `topic?` | Store a durable fact. |
| `recall` | `query`, `k?` | Retrieve memories by meaning. |
| `forget` | `id` | Retract a memory. |
| `index` | `url?` or `path?` | Index a page or a file from outside the project. |
| `anomaly` | `index`, plus the detection options | Flag spikes in a numeric series. |
| `dataset` | `action`, `index?`, `path?`, `mapping?`, `force?` | Manage extra indexes and import or export NDJSON dumps. |
| `reindex` | — | Incremental pass over the project now. |
| `sysdocs` | — | Index the machine's man and info pages. |
| `prjdocs` | `eager?` | Index official docs for what the project uses. |

A typical session, in tool-call form:

```
xerj_search {query: "where is the idle timeout configured"}
xerj_def    {symbol: "stopNode"}
xerj_dataset{action: "export", index: "my-notes", path: "/tmp/notes.ndjson"}
xerj_dataset{action: "import", path: "/tmp/notes.ndjson", index: "notes-copy"}
```

The handshake touches nothing: `initialize` and `tools/list` answer
immediately, and the binary download, node start, and index pass happen behind
the first call that needs them. Diagnostics go to stderr, so every line of
stdout is JSON-RPC.

A call returns MCP text content plus `structuredContent` when the tool has
machine-readable output (counts, hits, and paths), so a client can show the
prose or use the numbers.

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

## Data locations

```
~/.local/share/opencode/xerj/bin/<version>-<target>/xerj
~/.local/share/opencode/xerj/nodes/.port-lock  shared port lock
<project>/.xerj/                               storage root by default
<project>/.xerj/nodes/<prefix>/                node port, pid, log, heartbeats
<project>/.xerj/nodes/<prefix>/data/           engine storage and journal
<project>/.xerj/spool/<prefix>/                fetched pages
<project>/.xerj/nodes/<prefix>/sysdocs/        man and info manifest
<project>/.xerj/nodes/<prefix>/prjdocs/        documentation crawl manifest
```

Datasets you create with `xerj_dataset`, and the documentation corpora, live
inside the engine data directory; `xerj_status` reports their document counts
and sizes, and the panel lists them under Corpora and Datasets.

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

- XERJ is pre-1.0. Every call is isolated behind `node/client.ts`, and
  `binary.version: "auto"` tracks the newest release at or above
  `1.0.0-rc.1` without ever downgrading. Pin a version to freeze it.
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
