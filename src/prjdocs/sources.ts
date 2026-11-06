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
  /**
   * Largest page the crawl accepts. A single-page specification exceeds the
   * crawler default, and dropping it would leave the stack undocumented.
   */
  readonly maxBytes?: number;
  /** Link prefix for an unversioned site that shares its host with noise. */
  readonly prefix?: string;
  /**
   * Component guides to crawl as well as the entry. A toolkit is a collection:
   * one URL reaches the overview, not cuBLAS, MIOpen, or oneTBB.
   */
  readonly seeds?: ReadonlyArray<string>;
}

export interface DocsTarget {
  readonly id: string;
  readonly url: string;
  /** Version label used for pruning; "latest" when only one copy exists. */
  readonly version: string;
  /**
   * Pages supplied directly instead of crawled, for sources that are a
   * repository or an API dump rather than a site.
   */
  readonly collect?: () => Promise<CrawledPage[]>;
  /** Per-source page size limit, passed through to the crawler. */
  readonly maxBytes?: number;
  /**
   * Link prefix a versioned crawl stays inside. A docs site often links other
   * versions from every page, and following those mixes versions in one corpus.
   */
  readonly urlPrefix?: string;
  /** Component guides to crawl alongside `url`, each within its own directory. */
  readonly seeds?: ReadonlyArray<{ readonly url: string; readonly prefix?: string }>;
}

/** Substituted into `{major}`, `{minor}`, and `{version}`. */
import type { CrawledPage } from "./crawl.ts";

/** Guides the CUDA toolkit ships, relative to the archive directory. */
const CUDA_COMPONENTS = [
  "cuda-c-programming-guide",
  "cuda-c-best-practices-guide",
  "cuda-compiler-driver-nvcc",
  "cuda-runtime-api",
  "cuda-driver-api",
  "cuda-math-api",
  "cudla-api",
  "libdevice-users-guide",
  "floating-point",
  "cublas",
  "cufft",
  "curand",
  "cusolver",
  "cusparse",
  "npp",
].map((name) => `https://docs.nvidia.com/cuda/archive/{version}/${name}/index.html`);

/** cuDNN and NCCL publish outside the toolkit archive, without versions. */
const CUDA_DEEP_LEARNING = [
  "https://docs.nvidia.com/deeplearning/cudnn/latest/",
  "https://docs.nvidia.com/deeplearning/nccl/user-guide/docs/",
];

/** ROCm libraries, each published under its own `projects/<name>` path. */
const ROCM_COMPONENTS = [
  "HIP",
  "rocBLAS",
  "hipBLASLt",
  "MIOpen",
  "rccl",
  "rocFFT",
  "hipFFT",
  "rocPRIM",
  "hipCUB",
  "rocSPARSE",
  "hipSPARSE",
  "rocSOLVER",
  "hipSOLVER",
  "rocRAND",
  "hipRAND",
  "rocWMMA",
  "composable_kernel",
  "rocDecode",
].map((name) => `https://rocm.docs.amd.com/projects/${name}/en/docs-{version}/`);

const VULKAN_COMPONENTS = [
  "https://docs.vulkan.org/spec/latest/index.html",
  "https://docs.vulkan.org/guide/latest/index.html",
];

const ONEAPI_COMPONENTS = [
  "https://uxlfoundation.org/specifications/oneapi/",
  "https://uxlfoundation.github.io/oneTBB/",
  "https://uxlfoundation.github.io/oneDNN/",
  "https://uxlfoundation.github.io/oneCCL/",
];

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
  cuda: {
    id: "cuda",
    // The archive hub links every guide; the seeds name them, so a budget is
    // not spent on release notes and installation pages.
    entry: "https://docs.nvidia.com/cuda/archive/{version}/index.html",
    versioned: true,
    fallback: "https://docs.nvidia.com/cuda/index.html",
    maxPages: 200,
    // The programming guide and the three largest library guides are single
    // multi-megabyte pages, so the cap has to clear them.
    maxBytes: 8_000_000,
    seeds: [...CUDA_COMPONENTS, ...CUDA_DEEP_LEARNING],
  },
  rocm: {
    id: "rocm",
    entry: "https://rocm.docs.amd.com/en/docs-{version}/",
    versioned: true,
    fallback: "https://rocm.docs.amd.com/en/latest/",
    maxPages: 150,
    seeds: ROCM_COMPONENTS,
  },
  oneapi: {
    id: "oneapi",
    // The specification lives on the UXL Foundation site; the rest of that
    // host is foundation news, so the crawl stays in this section.
    entry: "https://uxlfoundation.org/specifications/oneapi/",
    versioned: false,
    prefix: "https://uxlfoundation.org/specifications/oneapi/",
    maxPages: 80,
    // oneTBB, oneDNN, and oneCCL publish their own guides on the same
    // foundation's pages.
    seeds: ONEAPI_COMPONENTS,
  },
  sycl: {
    id: "sycl",
    // The landing page links the specification, which is one 4 MB document.
    entry: "https://registry.khronos.org/SYCL/",
    versioned: false,
    maxPages: 40,
    maxBytes: 6_000_000,
    seeds: [
      "https://registry.khronos.org/SYCL/specs/sycl-2020/html/sycl-2020.html",
    ],
  },
  vulkan: {
    id: "vulkan",
    entry: "https://docs.vulkan.org/guide/latest/index.html",
    versioned: false,
    maxPages: 120,
    // The specification is published chapter by chapter, not as one page.
    seeds: VULKAN_COMPONENTS,
  },
  openai: {
    id: "openai",
    entry: "https://platform.openai.com/docs",
    versioned: false,
    maxPages: 10,
  },
};

/** The docs source for a technology, or null when none is known. */
function docsSource(id: string): DocsSource | null {
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
    return [
      {
        id: source.id,
        url: source.entry,
        version: "latest",
        maxBytes: source.maxBytes,
        urlPrefix: source.prefix,
        seeds: seedTargets(source.seeds, null),
      },
    ];
  }

  const targets: DocsTarget[] = [];
  const versions = new Set<string>();
  for (const version of [ref.used, latest]) {
    if (version === null) continue;
    const label = versionLabel(source.id, version);
    if (label === null || versions.has(label)) continue;
    versions.add(label);
    const url = source.entry
      .replace("{major}", label.split(".")[0] ?? label)
      .replace("{minor}", label.split(".").slice(0, 2).join("."))
      .replace("{version}", label);
    targets.push({
      id: source.id,
      url,
      // Versioned sites link other versions from every page, so the crawl
      // stays inside the directory of the version it started from.
      urlPrefix: versionPrefix(url),
      version: label,
      maxBytes: source.maxBytes,
      seeds: seedTargets(source.seeds, label),
    });
  }

  // No version known: one unversioned copy is better than a URL with a
  // placeholder still in it.
  if (targets.length === 0) {
    return [
      {
        id: source.id,
        url: source.fallback ?? source.entry,
        version: "latest",
        maxBytes: source.maxBytes,
      },
    ];
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
  if (id === "cuda" || id === "rocm") {
    // Both publish per patch release, and their URLs use all three parts:
    // 12.4 becomes 12.4.0, while 12.10.1 stays as it is.
    const minor = parts[1] ?? "0";
    const patch = parts[2] ?? "0";
    return `${major}.${minor}.${patch}`;
  }
  return version.replace(/^[v=^~]+/, "");
}

/**
 * Component guides for one version, each with the directory its crawl stays
 * inside. A seed that still carries a placeholder is dropped rather than
 * crawled at a path that cannot exist.
 */
function seedTargets(
  seeds: ReadonlyArray<string> | undefined,
  label: string | null,
): Array<{ url: string; prefix?: string }> {
  if (seeds === undefined) return [];

  const resolved: Array<{ url: string; prefix?: string }> = [];
  const seen = new Set<string>();
  for (const seed of seeds) {
    const url = seed
      .replace("{major}", label?.split(".")[0] ?? "")
      .replace("{minor}", label?.split(".").slice(0, 2).join(".") ?? "")
      .replace("{version}", label ?? "");
    if (url.includes("{")) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    resolved.push({
      url,
      prefix: label === null ? undefined : versionPrefix(url),
    });
  }

  return resolved;
}

/** The directory a versioned URL lives in, with a trailing slash. */
function versionPrefix(url: string): string {
  const cut = url.lastIndexOf("/");
  return cut === -1 ? url : url.slice(0, cut + 1);
}

/** Pages kept from a target before the crawler moves on. */
export function maxPagesFor(id: string): number {
  return SOURCES[id]?.maxPages ?? 10;
}
