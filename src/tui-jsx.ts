// JSX runtime shim for the TUI entry.
//
// The host publishes its single OpenTUI/Solid runtime as a virtual module. A
// plugin that imports the bare package instead loads a second copy whose JSX
// factory has no renderer, which throws "No renderer found" on first render.
// Prefer the host runtime; fall back to the local package for a bare Bun run
// where the virtual registry does not exist.

const VIRTUAL_JSX_RUNTIME =
  "opentui:runtime-module:" + encodeURIComponent("@opentui/solid/jsx-runtime");

interface JsxRuntime {
  readonly jsx: unknown;
  readonly jsxs: unknown;
  readonly jsxDEV?: unknown;
  readonly Fragment: unknown;
}

async function loadRuntime(): Promise<JsxRuntime> {
  try {
    return (await import(VIRTUAL_JSX_RUNTIME)) as JsxRuntime;
  } catch {
    return (await import("@opentui/solid/jsx-runtime")) as JsxRuntime;
  }
}

const runtime = await loadRuntime();

export const jsx = runtime.jsx;
export const jsxs = runtime.jsxs;
export const jsxDEV = runtime.jsxDEV;
export const Fragment = runtime.Fragment;
