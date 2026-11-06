// Builds the standalone MCP server: one file, no plugin host, runnable as
// `bun dist/mcp.js` or through the `xerj-mcp` bin entry.
//
// Everything the server needs at runtime is bundled except the XERJ binary
// itself, which it downloads and manages as the plugin does.

const ENTRY = "src/mcp/main.ts";
const OUT = "dist/mcp.js";

const result = Bun.spawnSync(
  ["bun", "build", ENTRY, "--target", "bun", "--format", "esm", "--outfile", OUT],
  { stdout: "inherit", stderr: "inherit" },
);

if (result.exitCode !== 0) {
  throw new Error(`bun build ${ENTRY} failed (${result.exitCode})`);
}

const file = Bun.file(OUT);
const size = (await file.exists()) ? file.size : 0;
if (size === 0) throw new Error(`${OUT} is empty`);

process.stdout.write(`built ${OUT} (${(size / 1024).toFixed(1)} kB)\n`);
