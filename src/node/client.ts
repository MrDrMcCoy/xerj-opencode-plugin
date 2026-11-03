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

export class XerjClient {
  constructor(
    readonly baseUrl: string,
    private readonly timeoutMs = DEFAULT_TIMEOUT_MS,
  ) {}

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

  async get(path: string, label = `request failed: ${path}`): Promise<unknown> {
    const response = await this.request(path);
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new NodeRequestError(label, response.status, text.slice(0, 500));
    }
    return response.json();
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

  private request(path: string, init?: RequestInit): Promise<Response> {
    return fetch(`${this.baseUrl}${path}`, {
      ...init,
      signal: init?.signal ?? AbortSignal.timeout(this.timeoutMs),
    });
  }
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
