// A shell command that pipes its output through a text filter is the habit
// `xerj_run` exists to replace: the filter keeps a slice and the rest is gone.
// The plugin cannot rewrite the host's bash call, but it can name the pattern
// in a one-line hint on the next model call.

/**
 * Pipes to tools that inspect or cut text. `sort`, `uniq`, and `wc` are left
 * out because their result is often the answer (a count), not a slice of a
 * larger document.
 */
const TEXT_FILTER = /\|\s*(?:head|tail|grep|egrep|fgrep|sed|awk|cut|less|more)\b/;

export function isFilteredCommand(command: string): boolean {
  return TEXT_FILTER.test(command);
}

/** The refusal a `cmd.blockPipes` hook returns, or null to allow the call. */
export function blockedPipeMessage(command: string): string | null {
  if (!isFilteredCommand(command)) return null;
  return (
    "This command pipes to a text filter, so XERJ would never see the full " +
    "output. Run the unfiltered command with xerj_run, then read any range " +
    "with xerj_out show or search it with xerj_out search. " +
    "Set cmd.blockPipes=false to allow pipes."
  );
}
