// Builds the TUI files the way the host loads them.
//
// The panel's JSX imports go through a shim (`tui-jsx.js`) instead of the bare
// package: a plugin copy of @opentui/solid carries its own JSX factory with no
// renderer, which throws "No renderer found" on first render. The shim prefers
// the host's virtual runtime module and falls back to the local package.

const PANEL_ENTRY = "src/tui.tsx";
const SHIM_ENTRY = "src/tui-jsx.ts";
const PANEL_OUT = "dist/tui.js";
const SHIM_OUT = "dist/tui-jsx.js";

const run = (args: string[]): void => {
  const result = Bun.spawnSync(["bun", "build", ...args], {
    stdout: "inherit",
    stderr: "inherit",
  });
  if (result.exitCode !== 0) {
    throw new Error(`bun build ${args.join(" ")} failed (${result.exitCode})`);
  }
};

// The shim stays a separate file so its dynamic import survives the build.
run([
  PANEL_ENTRY,
  "--outfile",
  PANEL_OUT,
  "--target",
  "bun",
  "--packages",
  "external",
  "--external",
  "./tui-jsx.js",
  "--production",
]);

run([SHIM_ENTRY, "--outfile", SHIM_OUT, "--target", "bun", "--packages", "external", "--production"]);

// Point the panel's JSX runtime import at the shim.
const BARE_RUNTIME = "@opentui/solid/jsx-runtime";
let panel = await Bun.file(PANEL_OUT).text();
const pattern = /(["'])@opentui\/solid\/jsx-runtime\1/g;
panel = panel.replace(pattern, (_match, quote: string) => `${quote}./tui-jsx.js${quote}`);
await Bun.write(PANEL_OUT, panel);

if (new RegExp(`["']${BARE_RUNTIME}["']`).test(panel)) {
  throw new Error("panel still imports the bare JSX runtime");
}

const shim = await Bun.file(SHIM_OUT).text();
if (!shim.includes("opentui:runtime-module:")) {
  throw new Error("shim lost its virtual runtime import");
}

console.log(`built ${PANEL_OUT} and ${SHIM_OUT}; JSX runtime bound through the shim`);
