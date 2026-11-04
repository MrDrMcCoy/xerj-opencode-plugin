// Plugin log with a durable ring buffer. Every failure the user needs to see
// ends up in the TUI panel, and console output alone would disappear with the
// server process.

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEntry {
  readonly at: number;
  readonly level: LogLevel;
  readonly message: string;
  readonly meta?: unknown;
}

export interface KeyValueStorage {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
}

export interface Logger {
  debug(message: string, meta?: unknown): void;
  info(message: string, meta?: unknown): void;
  warn(message: string, meta?: unknown): void;
  error(message: string, meta?: unknown): void;
  entries(): Promise<ReadonlyArray<LogEntry>>;
  flush(): Promise<void>;
}

const LOG_KEY = "log/ring";
const DEFAULT_MAX_ENTRIES = 50;
const CONSOLE_LEVELS: ReadonlySet<LogLevel> = new Set(["warn", "error"]);

export interface LoggerOptions {
  readonly maxEntries?: number;
  readonly echoToConsole?: boolean;
  /** Storage key; scope it per project so warnings do not cross projects. */
  readonly key?: string;
}

export function createLogger(storage: KeyValueStorage, options: LoggerOptions = {}): Logger {
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const echo = options.echoToConsole ?? true;
  const key = options.key ?? LOG_KEY;
  let pending: Promise<void> = Promise.resolve();
  let ring: LogEntry[] = [];

  const load = async (): Promise<void> => {
    if (ring.length > 0) return;
    const stored = await storage.get(key).catch(() => undefined);
    if (Array.isArray(stored)) {
      ring = stored.filter(isEntry).slice(-maxEntries);
    }
  };

  const append = (level: LogLevel, message: string, meta?: unknown): void => {
    const entry: LogEntry = { at: Date.now(), level, message, meta };

    if (echo && CONSOLE_LEVELS.has(level)) {
      const line = `[xerj] ${level}: ${message}`;
      if (meta === undefined) console.error(line);
      else console.error(line, meta);
    }

    pending = pending
      .then(load)
      .then(async () => {
        ring = [...ring, entry].slice(-maxEntries);
        await storage.set(key, ring);
      })
      .catch(() => {
        // Logging must never break the caller.
      });
  };

  return {
    debug: (message, meta) => append("debug", message, meta),
    info: (message, meta) => append("info", message, meta),
    warn: (message, meta) => append("warn", message, meta),
    error: (message, meta) => append("error", message, meta),
    entries: async () => {
      await load();
      return ring;
    },
    flush: () => pending,
  };
}

function isEntry(value: unknown): value is LogEntry {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  return typeof entry.at === "number" && typeof entry.message === "string";
}
