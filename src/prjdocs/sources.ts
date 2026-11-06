// Official documentation, keyed by the technology id detection produces. Only
// sources whose URL carries a version can be pruned by version; the rest are
// unversioned pages that stay until the crawler stops finding them.

import type { TechRef } from "./detect.ts";

export interface DocsSource {
  readonly id: string;
  /** Entry point for a given version; `undefined` means "unversioned". */
  readonly entry: string;
  /** True when the URL template contains a version placeholder. */
  readonly versioned: boolean;
  /** Unversioned entry, used when no version can be resolved. */
  readonly fallback?: string;
  /** Pages one run may index from this source. */
  readonly maxPages: number;
}

export interface DocsTarget {
  readonly id: string;
  readonly url: string;
  /** Version label used for pruning; "latest" when only one copy exists. */
  readonly version: string;
}

/** Substituted into `{major}`, `{minor}`, and `{version}`. */
const SOURCES: Readonly<Record<string, DocsSource>> = {
  typescript: {
    id: "typescript",
    entry: "https://www.typescriptlang.org/docs/handbook/intro.html",
    versioned: false,
    maxPages: 25,
  },
  node: {
    id: "node",
    entry: "https://nodejs.org/docs/latest-v{major}.x/api/",
    versioned: true,
    fallback: "https://nodejs.org/api/",
    maxPages: 20,
  },
  javascript: {
    id: "javascript",
    entry: "https://nodejs.org/api/",
    versioned: false,
    maxPages: 15,
  },
  python: {
    id: "python",
    entry: "https://docs.python.org/{minor}/library/index.html",
    versioned: true,
    fallback: "https://docs.python.org/3/library/index.html",
    maxPages: 20,
  },
  rust: {
    id: "rust",
    entry: "https://doc.rust-lang.org/stable/std/",
    versioned: false,
    maxPages: 20,
  },
  go: {
    id: "go",
    entry: "https://go.dev/doc/",
    versioned: false,
    maxPages: 15,
  },
  react: {
    id: "react",
    entry: "https://react.dev/reference/react",
    versioned: false,
    maxPages: 20,
  },
  vue: {
    id: "vue",
    entry: "https://vuejs.org/guide/introduction.html",
    versioned: false,
    maxPages: 15,
  },
  svelte: {
    id: "svelte",
    entry: "https://svelte.dev/docs/svelte/overview",
    versioned: false,
    maxPages: 15,
  },
  next: {
    id: "next",
    entry: "https://nextjs.org/docs",
    versioned: false,
    maxPages: 15,
  },
  express: {
    id: "express",
    entry: "https://expressjs.com/en/4x/api.html",
    versioned: false,
    maxPages: 10,
  },
  hono: {
    id: "hono",
    entry: "https://hono.dev/docs/",
    versioned: false,
    maxPages: 10,
  },
  vite: {
    id: "vite",
    entry: "https://vite.dev/guide/",
    versioned: false,
    maxPages: 10,
  },
  prisma: {
    id: "prisma",
    entry: "https://www.prisma.io/docs",
    versioned: false,
    maxPages: 10,
  },
  docker: {
    id: "docker",
    entry: "https://docs.docker.com/reference/",
    versioned: false,
    maxPages: 10,
  },
  terraform: {
    id: "terraform",
    entry: "https://developer.hashicorp.com/terraform/docs",
    versioned: false,
    maxPages: 10,
  },
  aws: {
    id: "aws",
    entry: "https://docs.aws.amazon.com/index.html",
    versioned: false,
    maxPages: 10,
  },
  gcp: {
    id: "gcp",
    entry: "https://cloud.google.com/docs",
    versioned: false,
    maxPages: 10,
  },
  azure: {
    id: "azure",
    entry: "https://learn.microsoft.com/en-us/azure/",
    versioned: false,
    maxPages: 10,
  },
  stripe: {
    id: "stripe",
    entry: "https://docs.stripe.com/api",
    versioned: false,
    maxPages: 10,
  },
  "solid-js": {
    id: "solid-js",
    entry: "https://docs.solidjs.com/",
    versioned: false,
    maxPages: 10,
  },
  bun: {
    id: "bun",
    entry: "https://bun.sh/docs",
    versioned: false,
    maxPages: 12,
  },
  deno: {
    id: "deno",
    entry: "https://docs.deno.com/runtime/",
    versioned: false,
    maxPages: 10,
  },
  vitest: {
    id: "vitest",
    entry: "https://vitest.dev/guide/",
    versioned: false,
    maxPages: 8,
  },
  jest: {
    id: "jest",
    entry: "https://jestjs.io/docs/getting-started",
    versioned: false,
    maxPages: 8,
  },
  playwright: {
    id: "playwright",
    entry: "https://playwright.dev/docs/intro",
    versioned: false,
    maxPages: 8,
  },
  pytest: {
    id: "pytest",
    entry: "https://docs.pytest.org/en/stable/",
    versioned: false,
    maxPages: 8,
  },
  django: {
    id: "django",
    entry: "https://docs.djangoproject.com/en/stable/",
    versioned: false,
    maxPages: 10,
  },
  flask: {
    id: "flask",
    entry: "https://flask.palletsprojects.com/en/stable/",
    versioned: false,
    maxPages: 8,
  },
  fastapi: {
    id: "fastapi",
    entry: "https://fastapi.tiangolo.com/",
    versioned: false,
    maxPages: 8,
  },
  sqlalchemy: {
    id: "sqlalchemy",
    entry: "https://docs.sqlalchemy.org/en/20/",
    versioned: false,
    maxPages: 8,
  },
  supabase: {
    id: "supabase",
    entry: "https://supabase.com/docs",
    versioned: false,
    maxPages: 8,
  },
  cloudflare: {
    id: "cloudflare",
    entry: "https://developers.cloudflare.com/workers/",
    versioned: false,
    maxPages: 8,
  },
  vercel: {
    id: "vercel",
    entry: "https://vercel.com/docs",
    versioned: false,
    maxPages: 8,
  },
  twilio: {
    id: "twilio",
    entry: "https://www.twilio.com/docs",
    versioned: false,
    maxPages: 8,
  },
  openai: {
    id: "openai",
    entry: "https://platform.openai.com/docs",
    versioned: false,
    maxPages: 10,
  },
};

/** The docs source for a technology, or null when none is known. */
export function docsSource(id: string): DocsSource | null {
  return SOURCES[id] ?? null;
}

/**
 * Entry URLs to crawl: the version the project declares and the latest known
 * version, when they differ. Unversioned sources produce one URL.
 */
export function docsTargets(
  ref: TechRef,
  latest: string | null,
): DocsTarget[] {
  const source = docsSource(ref.id);
  if (source === null) return [];

  if (!source.versioned) {
    return [{ id: source.id, url: source.entry, version: "latest" }];
  }

  const targets: DocsTarget[] = [];
  const versions = new Set<string>();
  for (const version of [ref.used, latest]) {
    if (version === null) continue;
    const label = versionLabel(source.id, version);
    if (label === null || versions.has(label)) continue;
    versions.add(label);
    targets.push({
      id: source.id,
      url: source.entry
        .replace("{major}", label.split(".")[0] ?? label)
        .replace("{minor}", label.split(".").slice(0, 2).join("."))
        .replace("{version}", label),
      version: label,
    });
  }

  // No version known: one unversioned copy is better than a URL with a
  // placeholder still in it.
  if (targets.length === 0) {
    return [{ id: source.id, url: source.fallback ?? source.entry, version: "latest" }];
  }
  return targets;
}

/**
 * The URL-shaped version label a source expects. Python wants `3.13`, Node
 * wants `22`, and anything with a full semver is trimmed to what the source
 * uses, because a patch release has no docs of its own.
 */
export function versionLabel(id: string, version: string): string | null {
  const parts = version.replace(/^[v=^~]+/, "").split(".");
  const major = parts[0];
  if (major === undefined || !/^\d+$/.test(major)) return null;

  if (id === "python") {
    const minor = parts[1];
    return minor !== undefined && /^\d+$/.test(minor) ? `${major}.${minor}` : null;
  }
  if (id === "node") return major;
  return version.replace(/^[v=^~]+/, "");
}

/** Pages kept from a target before the crawler moves on. */
export function maxPagesFor(id: string): number {
  return SOURCES[id]?.maxPages ?? 10;
}
