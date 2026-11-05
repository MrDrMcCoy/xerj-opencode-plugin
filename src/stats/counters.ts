// Per-process counters for events the plugin can observe directly. They reset
// when the server restarts, so the UI labels them as this server's lifetime.
// Index-run totals live in the corpus snapshots (persisted), not here.

export interface CounterSnapshot {
  readonly rpcCalls: number;
  readonly injectedTurns: number;
  readonly nodeSpawns: number;
  readonly http429: number;
  readonly indexRuns: number;
  /** Prompts whose passages the relevance gate dropped, so nothing injected. */
  readonly noiseSkips: number;
}

/** Counts events without changing them; callers never branch on a counter. */
export class Counters {
  private rpc = 0;
  private injected = 0;
  private spawns = 0;
  private limited = 0;
  private indexed = 0;
  private skipped = 0;

  /** A TUI poll or any other RPC call reached the server part. */
  noteRpc(): void {
    this.rpc += 1;
  }

  /** A retrieved block was added to a prompt. */
  noteInjection(): void {
    this.injected += 1;
  }

  /** A node process was started rather than attached to. */
  noteSpawn(): void {
    this.spawns += 1;
  }

  /** The node answered 429; autoindex waits these out on its own. */
  note429(): void {
    this.limited += 1;
  }

  /** One index pass finished, in any corpus. */
  noteIndexRun(): void {
    this.indexed += 1;
  }

  /**
   * Retrieval ran and the relevance gate kept nothing, so the turn injected
   * no context. Counted apart from a miss: the query never had a chance.
   */
  noteNoiseSkip(): void {
    this.skipped += 1;
  }

  snapshot(): CounterSnapshot {
    return {
      rpcCalls: this.rpc,
      injectedTurns: this.injected,
      nodeSpawns: this.spawns,
      http429: this.limited,
      indexRuns: this.indexed,
      noiseSkips: this.skipped,
    };
  }
}
