// Latest release of the technologies whose documentation URL carries a version.
// Only Node and Python have such URLs in the source table, and each publishes a
// small stable endpoint, so this stays two cheap requests instead of a registry
// lookup per dependency.

import type { TechRef } from "./detect.ts";
import type { Logger } from "../log.ts";

const NODE_RELEASES = "https://nodejs.org/dist/index.json";
const PYTHON_RELEASES = "https://endoflife.date/api/python.json";

const REQUEST_TIMEOUT_MS = 5_000;

export interface LatestOptions {
  readonly fetchImpl?: typeof fetch;
  readonly logger: Logger;
  readonly signal?: AbortSignal;
  /** Seconds a resolved answer is reused within one process. */
  readonly ttlMs?: number;
}

/** Newest published version per technology id, resolved at most once per TTL. */
export class LatestVersions {
  private readonly cache = new Map<string, { at: number; version: string | null }>();

  constructor(private readonly options: LatestOptions) {}

  async resolve(ref: TechRef): Promise<string | null> {
    if (ref.id !== "node" && ref.id !== "python") return null;

    const ttl = this.options.ttlMs ?? 6 * 60 * 60 * 1000;
    const cached = this.cache.get(ref.id);
    if (cached !== undefined && Date.now() - cached.at < ttl) return cached.version;

    const version = await this.fetchLatest(ref.id).catch((error: unknown) => {
      this.options.logger.debug("could not resolve the latest version", String(error));
      return null;
    });
    this.cache.set(ref.id, { at: Date.now(), version });
    return version;
  }

  private async fetchLatest(id: string): Promise<string | null> {
    const fetchImpl = this.options.fetchImpl ?? fetch;
    const url = id === "node" ? NODE_RELEASES : PYTHON_RELEASES;
    const response = await fetchImpl(url, {
      headers: { "user-agent": "xerj-opencode-plugin (documentation indexer)" },
      signal: mergeSignal(this.options.signal, REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) return null;

    const data: unknown = await response.json().catch(() => null);
    if (!Array.isArray(data) || data.length === 0) return null;

    const first: unknown = data[0];
    if (typeof first !== "object" || first === null) return null;
    const record = first as Record<string, unknown>;

    // Node publishes `{"version":"v22.3.0"}`, endoflife.date `{"latest":"3.13.5"}`.
    const raw = id === "node" ? record.version : record.latest;
    if (typeof raw !== "string") return null;

    const cleaned = raw.replace(/^v/, "");
    return /^\d+(\.\d+)*$/.test(cleaned) ? cleaned : null;
  }
}

function mergeSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
}
