// JSON with comments and trailing commas, which is what OpenCode's config and
// the shared TUI preferences use. A failure returns an empty object: a broken
// file must not take a caller down with it.
//
// The scanner is string-aware. A regex that strips `//` everywhere also
// removes a protocol-relative URL or a Windows UNC path and corrupts the whole
// document.

export function parseJsonc(text: string): Record<string, unknown> {
  const withoutComments = stripComments(text);
  const withoutTrailing = stripTrailingCommas(withoutComments);

  try {
    const parsed: unknown = JSON.parse(withoutTrailing);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function stripComments(text: string): string {
  let out = "";
  let inString = false;
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] ?? "";

    if (inString) {
      out += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }

    if (char === '"') {
      inString = true;
      out += char;
      continue;
    }
    if (char === "/" && text[index + 1] === "/") {
      while (index < text.length && text[index] !== "\n") index += 1;
      out += "\n";
      continue;
    }
    if (char === "/" && text[index + 1] === "*") {
      index += 2;
      while (
        index < text.length &&
        !(text[index] === "*" && text[index + 1] === "/")
      ) {
        index += 1;
      }
      index += 1;
      continue;
    }
    out += char;
  }

  return out;
}

function stripTrailingCommas(text: string): string {
  let out = "";
  let inString = false;
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] ?? "";

    if (inString) {
      out += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
      continue;
    }
    if (char === ",") {
      let next = index + 1;
      while (next < text.length && /\s/.test(text[next] ?? "")) next += 1;
      if (text[next] === "}" || text[next] === "]") continue;
    }
    out += char;
  }

  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
