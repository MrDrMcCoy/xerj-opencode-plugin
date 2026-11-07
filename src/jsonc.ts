// JSON with comments and trailing commas, which is what OpenCode's config and
// the shared TUI preferences use. A failure returns an empty object: a broken
// file must not take a caller down with it.

export function parseJsonc(text: string): Record<string, unknown> {
  const withoutComments = text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
  const withoutTrailing = withoutComments.replace(/,(\s*[}\]])/g, "$1");

  try {
    const parsed: unknown = JSON.parse(withoutTrailing);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}
