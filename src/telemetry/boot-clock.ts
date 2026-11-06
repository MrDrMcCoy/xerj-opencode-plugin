// The earliest point the plugin can observe, imported before anything else in
// `src/index.ts`, so boot timings include the plugin's own import cost.

export const BOOT_AT = Date.now();
export const BOOT_MONO = performance.now();

/** Milliseconds since this module loaded. */
export function bootMs(): number {
  return Math.round(performance.now() - BOOT_MONO);
}
