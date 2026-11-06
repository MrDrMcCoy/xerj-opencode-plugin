// Builds the standalone MCP server as a Node-compatible bundle, so `npx` and
// `bunx` both work: the file is ESM with a node shebang and no Bun-only API.
//
// `.mjs` because the package is `"type": "module"` and the bundle uses
// top-level await, which Node rejects in a `.js` file outside module scope.

const ENTRY = "src/mcp/main.ts";
const OUT = "dist/mcp.mjs";

const result = Bun.spawnSync(
  [
    "bun",
    "build",
    ENTRY,
    "--target",
    "node",
    "--format",
    "esm",
    "--outfile",
    OUT,
    // `#!/usr/bin/env node` so a shell, npx, and bunx all run it the same way.
    "--banner",
    "#!/usr/bin/env node",
  ],
  { stdout: "inherit", stderr: "inherit" },
);

if (result.exitCode !== 0) {
  throw new Error(`bun build ${ENTRY} failed (${result.exitCode})`);
}

const file = Bun.file(OUT);
const size = (await file.exists()) ? file.size : 0;
if (size === 0) throw new Error(`${OUT} is empty`);

// A bin entry has to be executable; npm keeps the mode bit from the tarball.
const { chmod } = await import("node:fs/promises");
await chmod(OUT, 0o755);

process.stdout.write(`built ${OUT} (${(size / 1024).toFixed(1)} kB)\n`);
