// HTTP client for the XERJ node. This is the only module besides the binary
// manager that opens sockets; everything above it speaks domain types.

export class NodeRequestError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly body?: string,
  ) {
    super(message);
    this.name = "NodeRequestError";
  }
}

export interface MemoryHit {
  readonly id: string;
  readonly text: string;
  readonly metadata: Record<string, unknown>;
  readonly score: number | null;
}

export interface MemorySummary {
  readonly count: number;
  readonly exists: boolean;
}

export interface MemoryRecord {
  readonly id: string;
  readonly text: string;
  readonly metadata: Record<string, unknown>;
}

export interface IndexSummary {
  readonly index: string;
  readonly docs: number;
  readonly bytes: number;
  readonly health: string;
}

export interface NodeInfo {
  readonly clusterName: string;
  /** The Elasticsearch wire version XERJ reports, not the XERJ release. */
  readonly wireVersion: string;
}

const DEFAULT_TIMEOUT_MS = 5_000;
// A write that carries a `semantic_text` field is embedded before it is
// acknowledged, and the neural embedder needs seconds per document. Reads and
// searches stay on the short timeout so a stalled node cannot block a turn.
const WRITE_TIMEOUT_MS = 120_000;
const HTTP_NOT_FOUND = 404;

/** Observes responses without changing them; used for 429 accounting. */
export interface ClientObserver {
  onResponse?(status: number): void;
}

export interface XerjClientOptions {
  /** Deadline for a read or search. */
  readonly timeoutMs?: number;
  /** Deadline for a write; a semantic write embeds before it acknowledges. */
  readonly writeTimeoutMs?: number;
  readonly observer?: ClientObserver;
  readonly resolver?: ClientResolver;
}

/**
 * Keeps the client pointed at a live node. `ensure` returns the current base
 * URL, starting the node when it is not running; `invalidate` drops a cached
 * handle after a connection failure so the next call re-probes.
 */
export interface ClientResolver {
  ensure(): Promise<string>;
  invalidate?(): void;
}

export class XerjClient {
  private current: string;
  private readonly timeoutMs: number;
  private readonly writeTimeoutMs: number;
  private readonly observer: ClientObserver | undefined;
  private readonly resolver: ClientResolver | undefined;

  constructor(readonly baseUrl: string, options: XerjClientOptions = {}) {
    this.current = baseUrl;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.writeTimeoutMs = options.writeTimeoutMs ?? WRITE_TIMEOUT_MS;
    this.observer = options.observer;
    this.resolver = options.resolver;
  }

  /** Replaces the base URL after the node was restarted on another port. */
  setBaseUrl(baseUrl: string): void {
    this.current = baseUrl;
  }

  /** GET / — identifies the node by its cluster name, not by the port. */
  async info(): Promise<NodeInfo | null> {
    const response = await this.request("/");
    if (!response.ok) return null;

    const body = await response.json().catch(() => null);
    if (!isRecord(body)) return null;
    if (body.cluster_name !== "xerj") return null;

    const version = isRecord(body.version) ? body.version.number : undefined;
    return {
      clusterName: "xerj",
      wireVersion: typeof version === "string" ? version : "unknown",
    };
  }

  async health(): Promise<string | null> {
    const response = await this.request("/_cluster/health");
    if (!response.ok) return null;
    const body = await response.json().catch(() => null);
    if (!isRecord(body) || typeof body.status !== "string") return null;
    return body.status;
  }

  async indices(): Promise<ReadonlyArray<IndexSummary>> {
    const response = await this.request("/_cat/indices?format=json");
    if (!response.ok) {
      throw new NodeRequestError("could not list indices", response.status);
    }

    const body = await response.json().catch(() => null);
    if (!Array.isArray(body)) return [];

    return body.flatMap((entry): IndexSummary[] => {
      if (!isRecord(entry) || typeof entry.index !== "string") return [];
      return [
        {
          index: entry.index,
          docs: toNumber(entry["docs.count"]),
          bytes: parseSize(entry["store.size"]),
          health: typeof entry.health === "string" ? entry.health : "unknown",
        },
      ];
    });
  }

  /** Drops one index; a 404 counts as already gone. */
  async deleteIndex(index: string): Promise<void> {
    const response = await this.request(`/${encodeURIComponent(index)}`, {
      method: "DELETE",
    });
    if (response.ok || response.status === HTTP_NOT_FOUND) return;
    throw new NodeRequestError(`could not delete index ${index}`, response.status);
  }

  /** Total documents across every index matching `<prefix>-*`. */
  async count(prefix: string): Promise<number> {
    const indices = await this.indices();
    return indices
      .filter((entry) => entry.index.startsWith(`${prefix}-`))
      .reduce((total, entry) => total + entry.docs, 0);
  }

  async search(index: string, body: unknown, signal?: AbortSignal): Promise<unknown> {
    return this.post(`/${encodeIndexPattern(index)}/_search`, body, "search failed", signal);
  }

  /** Flattened `field -> type` map per index matching the pattern. */
  async mappings(pattern: string): Promise<Record<string, Record<string, string>>> {
    const body = await this.get(`/${encodeIndexPattern(pattern)}/_mapping`, "mapping failed");
    if (!isRecord(body)) return {};

    const result: Record<string, Record<string, string>> = {};
    for (const [index, value] of Object.entries(body)) {
      if (!isRecord(value) || !isRecord(value.mappings)) continue;
      const properties = value.mappings.properties;
      if (!isRecord(properties)) continue;

      const fields: Record<string, string> = {};
      flattenProperties(properties, "", fields);
      result[index] = fields;
    }
    return result;
  }

  /** Creates or replaces a document. A semantic mapping can load the model. */
  async put(path: string, body: unknown, label: string): Promise<void> {
    const response = await this.request(
      path,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
      this.writeTimeoutMs,
    );

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new NodeRequestError(label, response.status, text.slice(0, 500));
    }
  }

  async bulkDelete(index: string, ids: ReadonlyArray<string>): Promise<void> {
    if (ids.length === 0) return;

    const lines = ids
      .map((id) => JSON.stringify({ delete: { _index: index, _id: id } }))
      .join("\n");

    const response = await this.request(
      `/_bulk?refresh=true`,
      {
        method: "POST",
        headers: { "content-type": "application/x-ndjson" },
        body: `${lines}\n`,
      },
      this.writeTimeoutMs,
    );

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new NodeRequestError("bulk delete failed", response.status, text.slice(0, 500));
    }
  }

  async bulk(
    index: string,
    actions: ReadonlyArray<{ id: string; source: Record<string, unknown> }>,
  ): Promise<void> {
    if (actions.length === 0) return;

    const lines = actions
      .flatMap((action) => [
        JSON.stringify({ index: { _index: index, _id: action.id } }),
        JSON.stringify(action.source),
      ])
      .join("\n");

    const response = await this.request(
      `/_bulk?refresh=true`,
      {
        method: "POST",
        headers: { "content-type": "application/x-ndjson" },
        body: `${lines}\n`,
      },
      this.writeTimeoutMs,
    );

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new NodeRequestError("bulk failed", response.status, text.slice(0, 500));
    }
  }

  async get(
    path: string,
    label = `request failed: ${path}`,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const response = await this.request(path, signal ? { signal } : undefined);
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new NodeRequestError(label, response.status, text.slice(0, 500));
    }
    return response.json();
  }

  async memoryStore(
    namespace: string,
    body: { text: string; metadata: Record<string, unknown>; id?: string },
  ): Promise<{ id: string; created: boolean }> {
    const result = await this.post(
      `/_memory/${encodeURIComponent(namespace)}`,
      body,
      "memory store failed",
    );
    if (!isRecord(result) || typeof result.id !== "string") {
      throw new NodeRequestError("memory store returned no id");
    }
    return { id: result.id, created: result.created === true };
  }

  async memoryRecall(
    namespace: string,
    body: { query: string; k: number; recency_weight?: number },
  ): Promise<ReadonlyArray<MemoryHit>> {
    const result = await this.post(
      `/_memory/${encodeURIComponent(namespace)}/_recall`,
      body,
      "memory recall failed",
    );
    if (!isRecord(result) || !Array.isArray(result.hits)) return [];

    return result.hits.flatMap((hit): MemoryHit[] => {
      if (!isRecord(hit) || typeof hit.id !== "string" || typeof hit.text !== "string") return [];
      return [
        {
          id: hit.id,
          text: hit.text,
          metadata: isRecord(hit.metadata) ? hit.metadata : {},
          score: typeof hit.score === "number" ? hit.score : null,
        },
      ];
    });
  }

  /** Counts entries without paging through them; `size=1` returns the total. */
  async memorySummary(namespace: string): Promise<MemorySummary> {
    const result = await this.get(
      `/_memory/${encodeURIComponent(namespace)}?size=1`,
      "memory list failed",
    );
    if (!isRecord(result)) return { count: 0, exists: false };
    return {
      count: toNumber(result.count),
      exists: result.exists === true,
    };
  }

  /** One page of a namespace, newest first is not guaranteed; callers sort. */
  async memoryList(namespace: string, size: number): Promise<ReadonlyArray<MemoryRecord>> {
    const result = await this.get(
      `/_memory/${encodeURIComponent(namespace)}?size=${Math.max(1, size)}`,
      "memory list failed",
    );
    if (!isRecord(result) || !Array.isArray(result.entries)) return [];

    return result.entries.flatMap((entry): MemoryRecord[] => {
      if (!isRecord(entry) || typeof entry.id !== "string" || typeof entry.text !== "string") {
        return [];
      }
      return [
        {
          id: entry.id,
          text: entry.text,
          metadata: isRecord(entry.metadata) ? entry.metadata : {},
        },
      ];
    });
  }

  async memoryForget(namespace: string, id: string): Promise<boolean> {
    const response = await this.request(
      `/_memory/${encodeURIComponent(namespace)}/${encodeURIComponent(id)}`,
      { method: "DELETE" },
    );
    if (!response.ok) return false;
    const result = await response.json().catch(() => null);
    return isRecord(result) && result.forgotten === true;
  }

  async post(
    path: string,
    body: unknown,
    label: string,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const response = await this.request(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new NodeRequestError(label, response.status, text.slice(0, 500));
    }

    return response.json();
  }

  private async request(
    path: string,
    init?: RequestInit,
    timeoutMs = this.timeoutMs,
  ): Promise<Response> {
    const base = await this.resolveBase();

    try {
      return await this.send(base, path, init, timeoutMs);
    } catch (error) {
      // A stopped node is expected: the idle timer shuts it down. Re-ensure and
      // retry once, unless the caller cancelled or the failure was not a
      // transport problem.
      if (!this.resolver || init?.signal?.aborted || !isTransportError(error)) {
        throw error;
      }

      this.resolver.invalidate?.();
      const retryBase = await this.resolver.ensure();
      this.current = retryBase;
      return this.send(retryBase, path, init, timeoutMs);
    }
  }

  private async resolveBase(): Promise<string> {
    if (!this.resolver) return this.current;
    this.current = await this.resolver.ensure();
    return this.current;
  }

  private send(
    base: string,
    path: string,
    init?: RequestInit,
    timeoutMs = this.timeoutMs,
  ): Promise<Response> {
    return fetch(`${base}${path}`, {
      ...init,
      signal: init?.signal ?? AbortSignal.timeout(timeoutMs),
    }).then((response) => {
      this.observer?.onResponse?.(response.status);
      return response;
    });
  }
}

/** `fetch` rejects with a TypeError whose cause is the socket error. */
function isTransportError(error: unknown): boolean {
  if (!(error instanceof TypeError)) return false;
  const cause = (error as { cause?: unknown }).cause;
  const code =
    typeof cause === "object" && cause !== null
      ? (cause as { code?: unknown }).code
      : undefined;
  return (
    code === "ECONNREFUSED" ||
    code === "ECONNRESET" ||
    code === "EHOSTUNREACH" ||
    code === "ENETUNREACH"
  );
}

/** Parses human byte sizes from `_cat/indices` (`1.2mb`, `42.7kb`, `0b`). */
export function parseSize(value: unknown): number {
  if (typeof value !== "string") return 0;

  const match = /^([\d.]+)\s*(b|kb|mb|gb|tb|pb)?$/i.exec(value.trim());
  if (!match?.[1]) return 0;

  const amount = Number(match[1]);
  if (!Number.isFinite(amount)) return 0;

  const unit = (match[2] ?? "b").toLowerCase();
  const scale: Record<string, number> = {
    b: 1,
    kb: 1024,
    mb: 1024 ** 2,
    gb: 1024 ** 3,
    tb: 1024 ** 4,
    pb: 1024 ** 5,
  };

  return Math.round(amount * (scale[unit] ?? 1));
}

function toNumber(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Keeps `*`, `,` and name characters intact while encoding the rest. */
function encodeIndexPattern(value: string): string {
  return value
    .split("")
    .map((character) =>
      /[A-Za-z0-9*_,.-]/.test(character) ? character : encodeURIComponent(character),
    )
    .join("");
}

/** Flattens nested object properties into `parent.child` type entries. */
function flattenProperties(
  properties: Record<string, unknown>,
  prefix: string,
  out: Record<string, string>,
  depth = 0,
): void {
  if (depth > 3) return;

  for (const [name, definition] of Object.entries(properties)) {
    if (!isRecord(definition)) continue;
    const path = prefix ? `${prefix}.${name}` : name;
    if (typeof definition.type === "string") {
      out[path] = definition.type;
      if (definition.type === "object" && isRecord(definition.properties)) {
        flattenProperties(definition.properties, path, out, depth + 1);
      }
    } else if (isRecord(definition.properties)) {
      flattenProperties(definition.properties, path, out, depth + 1);
    }
  }
}
