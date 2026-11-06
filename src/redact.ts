// Best-effort secret scrubbing for text the plugin writes to disk: fetched
// pages, external files, and the short caller strings telemetry records.

const SENSITIVE_KEY =
  "pass(?:word|wd)?|secret|token|api[_-]?key|access[_-]?key|" +
  "private[_-]?key|client[_-]?secret|auth|credential";
const PRIVATE_KEY =
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g;

/** Best effort: a page or file can carry keys in prose, URLs, or config. */
export function redact(text: string): string {
  return text
    .replace(
      PRIVATE_KEY,
      "[redacted private key]",
    )
    .replace(
      new RegExp(
        `((?:["']?(?:${SENSITIVE_KEY})["']?)\\s*[:=]\\s*["'])` +
          `([^"'\\s]{4,})`,
        "gi",
      ),
      "$1[redacted]",
    )
    .replace(
      new RegExp(`^\\s*(${SENSITIVE_KEY})\\s*:\\s*\\S+`, "gim"),
      "$1: [redacted]",
    )
    .replace(/(Bearer\s+)[A-Za-z0-9._-]{8,}/g, "$1[redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]{16,}/g, "sk-[redacted]")
    .replace(/\bghp_[A-Za-z0-9]{20,}/g, "ghp_[redacted]")
    .replace(/\bxox[baprs]-[A-Za-z0-9-]{10,}/g, "xox[redacted]")
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, "AKIA[redacted]");
}

/** Clips to `max` characters after redaction, so a key is never cut in half. */
export function redactClip(text: string, max: number): string {
  const safe = redact(text);
  if (max <= 0) return "";
  return safe.length <= max ? safe : `${safe.slice(0, max - 1)}…`;
}
