// Entry point for `xerj-mcp`: a standalone MCP server over stdio, for agents
// that do not run OpenCode.
//
//   xerj-mcp [--project <dir>] [--url <node url>]
//
// Nothing is written to stdout except JSON-RPC, so a client can parse every
// line. Diagnostics go to stderr.

import { resolve } from "node:path";
import { McpHost } from "./host.ts";
import { serve } from "./server.ts";

interface Args {
  readonly projectRoot: string;
  readonly nodeUrl: string | undefined;
}

function parseArgs(argv: ReadonlyArray<string>): Args {
  let projectRoot = process.cwd();
  let nodeUrl: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--project" || argument === "-C") {
      const value = argv[index + 1];
      if (value !== undefined) {
        projectRoot = resolve(value);
        index += 1;
      }
      continue;
    }
    if (argument === "--url") {
      const value = argv[index + 1];
      if (value !== undefined) {
        nodeUrl = value;
        index += 1;
      }
      continue;
    }
    if (argument === "--help" || argument === "-h") {
      process.stderr.write(
        "usage: xerj-mcp [--project DIR] [--url NODE_URL]\n" +
          "Speaks MCP over stdio. The project directory defaults to the cwd.\n",
      );
      process.exit(0);
    }
  }

  return { projectRoot, nodeUrl };
}

const args = parseArgs(process.argv.slice(2));
const host = new McpHost({ projectRoot: args.projectRoot, nodeUrl: args.nodeUrl });

// The node start is slow, so it runs behind the first tool call rather than
// behind the handshake: a client never waits to initialize.
host.start().catch((error: unknown) => {
  process.stderr.write(`[xerj-mcp] startup failed: ${String(error)}\n`);
});

void serve({
  input: process.stdin,
  output: process.stdout,
  source: {
    tools: () => host.tools(),
    instructions: () =>
      "Local XERJ index for this project. Use xerj_search and xerj_def before " +
      "reading whole files; the same index covers system and library docs.",
  },
  onReady: () => {
    process.stderr.write(`[xerj-mcp] ready in ${args.projectRoot}\n`);
  },
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void host.stop().finally(() => process.exit(0));
  });
}
