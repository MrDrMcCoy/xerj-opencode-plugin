// The host validates an RPC call against the declared input schema before the
// handler runs. A required key the caller has no way to know about turns every
// call into `rpc.invalid_input`, so tests validate the payloads the TUI sends
// against the same schema the host uses.
//
// The validator covers the subset of JSON Schema this plugin declares and
// throws on any other keyword: a schema that grows a keyword this file does not
// understand must fail loudly instead of passing everything.

export type Schema = Record<string, unknown>;

const NULL_TYPE = "null";

function typesOf(schema: Schema): string[] {
  const declared = schema.type;
  if (typeof declared === "string") return [declared];
  if (Array.isArray(declared)) return declared.map(String);
  return [];
}

function matchesType(type: string, value: unknown): boolean {
  switch (type) {
    case "object":
      return typeof value === "object" && value !== null && !Array.isArray(value);
    case "array":
      return Array.isArray(value);
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
    case NULL_TYPE:
      return value === null;
    default:
      throw new Error(`unsupported schema type: ${type}`);
  }
}

const KNOWN_KEYWORDS = new Set([
  "type",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "enum",
]);

/** Returns one message per violation; an empty array means the value fits. */
export function validate(schema: Schema, value: unknown, path = "input"): string[] {
  for (const keyword of Object.keys(schema)) {
    if (!KNOWN_KEYWORDS.has(keyword)) {
      throw new Error(`unsupported schema keyword at ${path}: ${keyword}`);
    }
  }

  const declared = typesOf(schema);
  if (declared.length > 0 && !declared.some((type) => matchesType(type, value))) {
    return [`${path} must be ${declared.join(" or ")}`];
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    return [`${path} is not one of ${schema.enum.join(", ")}`];
  }

  if (schema.type === "array" || declared.includes("array")) {
    if (!Array.isArray(value)) return [];
    const items = schema.items as Schema | undefined;
    if (items === undefined) return [];
    return value.flatMap((entry, index) => validate(items, entry, `${path}[${index}]`));
  }

  if (!declared.includes("object") && schema.type !== "object") return [];
  if (typeof value !== "object" || value === null || Array.isArray(value)) return [];

  const properties = (schema.properties ?? {}) as Record<string, Schema>;
  const required = Array.isArray(schema.required) ? schema.required.map(String) : [];
  const present = value as Record<string, unknown>;
  const problems: string[] = [];

  for (const key of required) {
    if (!(key in present) || present[key] === undefined) {
      problems.push(`${path} is missing ${key}`);
    }
  }

  if (schema.additionalProperties === false) {
    for (const key of Object.keys(present)) {
      if (!(key in properties) && present[key] !== undefined) {
        problems.push(`${path} has an unknown key ${key}`);
      }
    }
  }

  for (const [key, nested] of Object.entries(properties)) {
    if (present[key] === undefined) continue;
    problems.push(...validate(nested, present[key], `${path}.${key}`));
  }

  return problems;
}
