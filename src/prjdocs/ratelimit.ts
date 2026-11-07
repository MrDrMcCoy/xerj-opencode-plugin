// Per-host request spacing for documentation crawls.
//
// One crawl is sequential, but a run may crawl several targets on one host at
// once (component guides, the Elasticsearch chapters, eager seeds). A shared
// limiter keeps that combined traffic to one request per interval and honours
// a server's `Retry-After` instead of hammering it.

export interface HostLimiterOptions {
  /** Minimum gap between two requests to one host. */
  readonly intervalMs: number;
  /** Random extra delay added to the gap, to avoid a mechanical rhythm. */
  readonly jitterMs?: number;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

export class HostRateLimiter {
  private readonly nextAt = new Map<string, number>();
  private readonly chains = new Map<string, Promise<void>>();

  constructor(private readonly options: HostLimiterOptions) {}

  get intervalMs(): number {
    return this.options.intervalMs;
  }

  /** Waits for this host's slot, then reserves the next one. */
  async wait(url: string): Promise<void> {
    const host = hostOf(url) ?? url;
    const previous = this.chains.get(host) ?? Promise.resolve();
    const run = previous.then(async () => {
      const gap = Math.max(0, (this.nextAt.get(host) ?? 0) - this.now());
      if (gap > 0) await this.sleep(gap);
      this.nextAt.set(host, this.now() + this.options.intervalMs + this.jitter());
    });
    // A failed wait must not stall the host's chain.
    this.chains.set(host, run.catch(() => {}));
    return run;
  }

  /** Pushes the host's next slot out, for `Retry-After` or a throttle. */
  noteRetryAfter(url: string, delayMs: number): void {
    const host = hostOf(url) ?? url;
    const until = this.now() + Math.max(0, delayMs);
    this.nextAt.set(host, Math.max(this.nextAt.get(host) ?? 0, until));
  }

  private jitter(): number {
    const max = this.options.jitterMs ?? 0;
    return max > 0 ? Math.floor(Math.random() * max) : 0;
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  private sleep(ms: number): Promise<void> {
    if (this.options.sleep !== undefined) return this.options.sleep(ms);
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

export function hostOf(url: string): string | null {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

/** `Retry-After` is seconds or an HTTP date; anything else means "unknown". */
export function retryAfterMs(value: string | null, now = Date.now()): number | null {
  if (value === null) return null;
  const seconds = Number(value.trim());
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1_000);
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - now) : null;
}
