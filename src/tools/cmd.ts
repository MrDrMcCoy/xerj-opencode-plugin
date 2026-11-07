// Command output tools: run a command into the log directory, and read it back
// by range or by search instead of paginating a terminal.

import type { Config } from "../config.ts";
import type { Logger } from "../log.ts";
import type { CmdService } from "../cmd/service.ts";

export interface CmdToolOptions {
  readonly config: Config;
  readonly getCmd: () => CmdService | null;
  readonly logger: Logger;
}

const RUN_INPUT = {
  type: "object",
  properties: {
    command: {
      type: "string",
      description: "Shell command to run in the project root.",
    },
    timeout_ms: {
      type: "number",
      description: "Deadline in milliseconds (default from cmd.timeoutMs, 10 min).",
    },
  },
  required: ["command"],
  additionalProperties: false,
} as const;

const OUT_INPUT = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: ["list", "show", "search", "ingest"],
      description:
        "list recent commands; show lines of one; search the corpus; ingest a file the command wrote outside xerj_run.",
    },
    stem: { type: "string", description: "Command stem, for show and search." },
    start: { type: "number", description: "First line, one-based, for show." },
    end: { type: "number", description: "Last line, inclusive, for show." },
    query: { type: "string", description: "What to look for, for search." },
    k: { type: "number", description: "How many matches (1-20, default 8)." },
    limit: { type: "number", description: "How many commands to list (1-30, default 10)." },
    path: { type: "string", description: "Project-relative file to ingest." },
    command: { type: "string", description: "Label to store with an ingested file." },
  },
  required: ["action"],
  additionalProperties: false,
} as const;

const CHARS_PER_TOKEN = 4;
const LIST_COMMAND_CLIP = 80;

export function cmdTools(options: CmdToolOptions): ReadonlyArray<{
  name: string;
  description: string;
  input: unknown;
  options: { namespace: string };
  execute: (input: unknown, context: unknown) => Promise<unknown>;
}> {
  return [
    {
      name: "run",
      description:
        "Run one shell command and keep its output in the XERJ log directory instead of this window. Returns the exit code, duration, line and byte counts, and a stem; read the output with xerj_out show or xerj_out search. Use it instead of piping a command to head, tail, grep, sed, awk, or cut: the full output stays searchable and the window sees only the receipt.",
      input: RUN_INPUT,
      options: { namespace: "xerj" },
      execute: async (input) => {
        const args = input as { command: string; timeout_ms?: number };
        const service = options.getCmd();
        if (service === null) return unavailable();
        if (typeof args.command !== "string" || args.command.trim().length === 0) {
          return { content: "xerj_run needs a command.", metadata: { xerj: { ran: false } } };
        }

        const result = await service.run(args.command, {
          timeoutMs: args.timeout_ms,
        });
        const exit = result.exitCode === null ? "no exit code" : `exit ${result.exitCode}`;
        const flags = [
          result.timedOut ? "timed out" : null,
          result.truncated ? "truncated" : null,
          result.binary ? "binary output, not indexed" : null,
        ].filter((entry): entry is string => entry !== null);
        const receipt = [
          `ran · ${exit} · ${formatDuration(result.durationMs)} · ` +
            `${result.lines} lines · ${formatBytes(result.bytes)}`,
          `stem ${result.stem}${flags.length > 0 ? ` · ${flags.join(" · ")}` : ""}`,
          `read it with xerj_out show stem=${result.stem} start=1 end=120, ` +
            `or search it with xerj_out search stem=${result.stem} query="..."`,
        ].join("\n");

        return {
          content: receipt,
          metadata: {
            xerj: {
              ran: true,
              stem: result.stem,
              exitCode: result.exitCode,
              lines: result.lines,
              bytes: result.bytes,
              truncated: result.truncated,
              timedOut: result.timedOut,
            },
          },
        };
      },
    },
    {
      name: "out",
      description:
        "Read command output kept by xerj_run. action=list shows recent commands and their exit codes; action=show returns an exact line range from one command; action=search finds matching lines; action=ingest loads a file you wrote into the log corpus. Use these instead of re-running a command to see a different part of its output.",
      input: OUT_INPUT,
      options: { namespace: "xerj" },
      execute: async (input, context) => {
        const args = input as {
          action?: string;
          stem?: string;
          start?: number;
          end?: number;
          query?: string;
          k?: number;
          limit?: number;
          path?: string;
          command?: string;
        };
        const service = options.getCmd();
        if (service === null) return unavailable();

        switch (args.action) {
          case "list":
            return list(service, args.limit, args.command);
          case "show":
            return show(service, args.stem, args.start, args.end, options.config.cmd.showTokens);
          case "search":
            return search(service, args.query, args.stem, args.k, context);
          case "ingest":
            return ingest(service, args.path, args.command);
          default:
            return {
              content:
                "xerj_out needs action=list, show, search, or ingest.",
              metadata: { xerj: { ok: false } },
            };
        }
      },
    },
  ];
}

function list(service: CmdService, limit: number | undefined, filter: string | undefined): unknown {
  const count = clamp(limit ?? 10, 1, 30);
  const entries = service.list(count, filter);
  if (entries.length === 0) {
    return {
      content: "No commands have been recorded yet. Use xerj_run to keep one.",
      metadata: { xerj: { commands: 0 } },
    };
  }

  const lines = entries.map((entry) => {
    const exit = entry.exitCode === null ? "?" : String(entry.exitCode);
    const flags = entry.truncated ? " · truncated" : "";
    return (
      `${entry.stem}  exit ${exit}  ${formatAge(entry.at)}  ` +
      `${entry.lines} lines  ${formatBytes(entry.bytes)}${flags}\n` +
      `  ${clip(entry.command, LIST_COMMAND_CLIP)}`
    );
  });
  return {
    content: [`${entries.length} recent command${entries.length === 1 ? "" : "s"}:`, ...lines].join("\n"),
    metadata: { xerj: { commands: entries.length, stems: entries.map((entry) => entry.stem) } },
  };
}

async function show(
  service: CmdService,
  stem: string | undefined,
  start: number | undefined,
  end: number | undefined,
  showTokens: number,
): Promise<unknown> {
  if (typeof stem !== "string" || stem.length === 0) {
    return { content: "xerj_out show needs a stem from xerj_out list.", metadata: { xerj: { ok: false } } };
  }
  const entry = service.entry(stem);
  if (entry === null) {
    return {
      content: `No command has the stem ${stem}. Use xerj_out list for the stems on disk.`,
      metadata: { xerj: { ok: false } },
    };
  }
  const read = await service.show(stem, start, end);
  if (read === null) {
    return {
      content: `The output for ${stem} is missing or larger than cmd.maxFileBytes.`,
      metadata: { xerj: { ok: false } },
    };
  }

  const budget = Math.max(200, showTokens * CHARS_PER_TOKEN);
  const lines: string[] = [];
  let used = 0;
  for (const [index, line] of read.lines.entries()) {
    const numbered = `${read.from + index}| ${line}`;
    if (used + numbered.length + 1 > budget) break;
    lines.push(numbered);
    used += numbered.length + 1;
  }
  const last = read.from + Math.max(0, lines.length - 1);
  const omitted = read.total - (read.from - 1) - lines.length;
  const footer =
    omitted > 0
      ? `\n[${omitted} more lines; ask for a range with start and end]`
      : "";
  return {
    content:
      `cmd/${stem}-out.txt:${read.from}-${last} of ${read.total}\n` +
      `${lines.join("\n")}${footer}`,
    metadata: {
      xerj: {
        stem,
        from: read.from,
        to: last,
        total: read.total,
        exitCode: entry.exitCode,
      },
    },
  };
}

async function search(
  service: CmdService,
  query: string | undefined,
  stem: string | undefined,
  k: number | undefined,
  context: unknown,
): Promise<unknown> {
  if (typeof query !== "string" || query.trim().length === 0) {
    return { content: "xerj_out search needs a query.", metadata: { xerj: { ok: false } } };
  }
  const tool = context as { signal?: AbortSignal };
  const hits = await service.search(query, {
    stem: typeof stem === "string" && stem.length > 0 ? stem : undefined,
    k: clamp(k ?? 8, 1, 20),
    signal: tool.signal,
  });
  if (hits.length === 0) {
    return {
      content:
        "No command output matched. The corpus grows as commands finish; " +
        "try a shorter phrase, or xerj_out list to find the stem and show its range.",
      metadata: { xerj: { hits: 0 } },
    };
  }

  const lines = hits.map(
    (hit) =>
      `cmd/${hit.stem}-${hit.kind}.txt:${hit.line}: ${hit.text}` +
      (hit.exitCode === null ? "" : `  [exit ${hit.exitCode}]`),
  );
  return {
    content: lines.join("\n"),
    metadata: { xerj: { hits: hits.length, stems: [...new Set(hits.map((hit) => hit.stem))] } },
  };
}

async function ingest(
  service: CmdService,
  path: string | undefined,
  command: string | undefined,
): Promise<unknown> {
  if (typeof path !== "string" || path.length === 0) {
    return { content: "xerj_out ingest needs a path.", metadata: { xerj: { ok: false } } };
  }
  const entry = await service.ingest(path, command);
  if (entry === null) {
    return {
      content: `Could not ingest ${path}: it is outside the project, binary, or over cmd.maxFileBytes.`,
      metadata: { xerj: { ok: false } },
    };
  }
  return {
    content:
      `ingested ${path} as ${entry.stem} · ${entry.lines} lines · ${formatBytes(entry.bytes)}\n` +
      `read it with xerj_out show stem=${entry.stem}`,
    metadata: { xerj: { ok: true, stem: entry.stem } },
  };
}

function unavailable(): { content: string; metadata: Record<string, unknown> } {
  return {
    content: "Command output is not available; cmd.enabled is off or the node is still starting.",
    metadata: { xerj: { ok: false } },
  };
}

function clamp(value: number, min: number, max: number): number {
  const rounded = Math.round(value);
  return Number.isFinite(rounded) ? Math.min(max, Math.max(min, rounded)) : min;
}

function clip(text: string, max: number): string {
  const trimmed = text.replace(/\s+/g, " ").trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1)}…`;
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let amount = value;
  let unit = 0;
  while (amount >= 1024 && unit < units.length - 1) {
    amount /= 1024;
    unit += 1;
  }
  return `${amount.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0s";
  const seconds = ms / 1000;
  if (seconds < 10) return `${seconds.toFixed(1)}s`;
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function formatAge(at: number): string {
  return `${formatDuration(Date.now() - at)} ago`;
}
