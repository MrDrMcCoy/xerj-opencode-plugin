// Latest release of the technologies whose documentation URL carries a version.
// Only Node and Python have such URLs in the source table, and each publishes a
// small stable endpoint, so this stays two cheap requests instead of a registry
// lookup per dependency.

import type { TechRef } from "./detect.ts";
import type { Logger } from "../log.ts";
import { DEFAULT_DOCS_USER_AGENT } from "./user-agent.ts";

const NODE_RELEASES = "https://nodejs.org/dist/index.json";
const PYTHON_RELEASES = "https://endoflife.date/api/python.json";
// The CUDA archive page lists every version directory; it is the only public
// index of CUDA releases that needs no key.
const CUDA_ARCHIVE = "https://docs.nvidia.com/cuda/archive/";
// The ROCm docs landing page names its release in the title.
const ROCM_LATEST = "https://rocm.docs.amd.com/en/latest/";

const REQUEST_TIMEOUT_MS = 5_000;

export interface LatestOptions {
  readonly fetchImpl?: typeof fetch;
  readonly logger: Logger;
  readonly signal?: AbortSignal;
  /** Seconds a resolved answer is reused within one process. */
  readonly ttlMs?: number;
  /** Deadline for one release-metadata request. */
  readonly requestTimeoutMs?: number;
  /** `User-Agent` sent with every metadata request. */
  readonly userAgent?: string;
}

/** Newest published version per technology id, resolved at most once per TTL. */
export class LatestVersions {
  private readonly cache = new Map<string, { at: number; version: string | null }>();

  constructor(private readonly options: LatestOptions) {}

  async resolve(ref: TechRef): Promise<string | null> {
    if (
      ref.id !== "node" &&
      ref.id !== "python" &&
      ref.id !== "cuda" &&
      ref.id !== "rocm"
    ) {
      return null;
    }

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
    if (id === "cuda") return this.fetchCudaLatest(fetchImpl);
    if (id === "rocm") return this.fetchRocmLatest(fetchImpl);

    const url = id === "node" ? NODE_RELEASES : PYTHON_RELEASES;
    const response = await fetchImpl(url, {
      headers: { "user-agent": this.options.userAgent ?? DEFAULT_DOCS_USER_AGENT },
      signal: mergeSignal(
        this.options.signal,
        this.options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS,
      ),
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

  /** Highest `archive/<major>.<minor>.<patch>/` directory on the CUDA site. */
  private async fetchCudaLatest(fetchImpl: typeof fetch): Promise<string | null> {
    const response = await fetchImpl(CUDA_ARCHIVE, {
      headers: { "user-agent": this.options.userAgent ?? DEFAULT_DOCS_USER_AGENT },
      signal: mergeSignal(
        this.options.signal,
        this.options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS,
      ),
    });
    if (!response.ok) return null;

    const html = await response.text().catch(() => "");
    const versions = [...html.matchAll(/archive\/(\d+)\.(\d+)\.(\d+)\//g)]
      .map((match) => `${match[1]}.${match[2]}.${match[3]}`);
    if (versions.length === 0) return null;

    return versions.sort(compareVersions).at(-1) ?? null;
  }

  /** The release the ROCm docs landing page advertises, for example 10.1.0. */
  private async fetchRocmLatest(fetchImpl: typeof fetch): Promise<string | null> {
    const response = await fetchImpl(ROCM_LATEST, {
      headers: { "user-agent": this.options.userAgent ?? DEFAULT_DOCS_USER_AGENT },
      signal: mergeSignal(
        this.options.signal,
        this.options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS,
      ),
    });
    if (!response.ok) return null;

    const html = await response.text().catch(() => "");
    return /AMD ROCm (\d+\.\d+\.\d+)/.exec(html)?.[1] ?? null;
  }
}

/** Numeric comparison of dotted versions; the CUDA listing is not sorted. */
function compareVersions(left: string, right: string): number {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function mergeSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
}
