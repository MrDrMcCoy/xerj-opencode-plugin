// Deciding whether a crawled page is worth keeping and worth following. Eager
// crawling removes the depth and page-type limits, so something has to decide
// where to spend the budget; that is what the model is for, with a deterministic
// heuristic when no model is reachable.

export interface JudgeContext {
  /** Technology the crawl is for, e.g. `react`. */
  readonly tech: string;
  /** Version label, or `latest`. */
  readonly version: string;
  /** Words the project uses, used by the heuristic fallback. */
  readonly terms: ReadonlyArray<string>;
}

export interface JudgeVerdict {
  readonly relevant: boolean;
  /** Short explanation, logged when a page is dropped. */
  readonly reason: string;
  /** True when a model answered rather than the heuristic. */
  readonly byModel: boolean;
}

export interface JudgeOptions {
  /** Stateless model call: `{ prompt }` in, `{ text }` out. */
  readonly generate?: (prompt: string) => Promise<string>;
  /** Model calls allowed per run; the heuristic covers the rest. */
  readonly maxModelCalls?: number;
  readonly logger: {
    debug(message: string, detail?: unknown): void;
  };
}

/** Pages the heuristic considers structurally likely to be documentation. */
const DOC_PATH = /(\/docs?\/|\/api\/|\/reference\/|\/guide\/|\/manual\/|\/tutorial|\/handbook\/|\/learn\/)/i;
/** Pages that are almost never documentation content. */
const NOISE_PATH = /(\/blog\/|\/news\/|\/pricing|\/careers|\/login|\/signin|\/cart|\/shop\/|\/terms|\/privacy)/i;

/**
 * Judges pages for one documentation target. Model verdicts are cached by URL,
 * so a page reached twice costs one call, and the call budget is a hard cap per
 * run: beyond it the heuristic answers, which keeps an eager crawl bounded even
 * on a site with thousands of pages.
 */
export class PageJudge {
  private readonly cache = new Map<string, JudgeVerdict>();
  private calls = 0;

  constructor(
    private readonly context: JudgeContext,
    private readonly options: JudgeOptions,
  ) {}

  async judge(url: string, title: string, text: string): Promise<JudgeVerdict> {
    const cached = this.cache.get(url);
    if (cached !== undefined) return cached;

    const heuristic = this.heuristic(url, title, text);
    const verdict = await this.byModel(url, title, text).catch((error: unknown) => {
      this.options.logger.debug("relevance model unavailable", String(error));
      return null;
    }) ?? heuristic;

    this.cache.set(url, verdict);
    return verdict;
  }

  /** True when the model has been asked as often as this run allows. */
  get exhausted(): boolean {
    return this.calls >= (this.options.maxModelCalls ?? 200);
  }

  private async byModel(
    url: string,
    title: string,
    text: string,
  ): Promise<JudgeVerdict | null> {
    const generate = this.options.generate;
    if (generate === undefined || this.exhausted) return null;

    this.calls += 1;
    const answer = await generate(promptFor(this.context, url, title, text));
    const verdict = parseAnswer(answer);
    if (verdict === null) return null;

    return {
      relevant: verdict,
      reason: verdict ? "model: relevant" : "model: not relevant",
      byModel: true,
    };
  }

  private heuristic(url: string, title: string, text: string): JudgeVerdict {
    if (NOISE_PATH.test(url)) {
      return { relevant: false, reason: "path looks like site chrome", byModel: false };
    }

    const haystack = `${url} ${title} ${text.slice(0, 2_000)}`.toLowerCase();
    // `solid-js` appears in prose as "SolidJS", and `@aws-sdk` as "AWS SDK", so
    // the comparison ignores separators on both sides.
    const global: RegExp = new RegExp("[^a-z0-9]", "g");
    const compact = (value: string): string => value.replace(global, "");
    const tech = this.context.tech.toLowerCase().replace(/^@/, "");
    const mentionsTech =
      haystack.includes(tech) || compact(haystack).includes(compact(tech));

    // A page that names the technology and looks like documentation is kept;
    // one that names it without a documentation shape is still kept when the
    // path says docs, because landing pages often do not repeat the name.
    if (mentionsTech) {
      return { relevant: true, reason: "names the technology", byModel: false };
    }
    if (DOC_PATH.test(url)) {
      return { relevant: true, reason: "documentation path", byModel: false };
    }

    const matched = this.context.terms.filter((term) => haystack.includes(term));
    if (matched.length >= 2) {
      return {
        relevant: true,
        reason: `matches ${matched.length} project terms`,
        byModel: false,
      };
    }

    return { relevant: false, reason: "no technology or project terms", byModel: false };
  }
}

/** The prompt for one page. Short on purpose: this runs once per kept page. */
export function promptFor(
  context: JudgeContext,
  url: string,
  title: string,
  text: string,
): string {
  return [
    `You are indexing official documentation for "${context.tech}" (version ${context.version}).`,
    "Answer with exactly one word: yes if this page is official documentation or reference",
    `material for ${context.tech}, otherwise no.`,
    "",
    `URL: ${url}`,
    `Title: ${title}`,
    `Text: ${text.slice(0, 1_200)}`,
  ].join("\n");
}

/** `yes`/`no` from a model answer, tolerating punctuation and capitals. */
export function parseAnswer(answer: string): boolean | null {
  const first = answer.trim().toLowerCase().split(/[^a-z]+/).find((word) => word.length > 0);
  if (first === "yes" || first === "true") return true;
  if (first === "no" || first === "false") return false;
  return null;
}

/** Words from the project's own identifiers, used by the heuristic. */
export function projectTerms(texts: ReadonlyArray<string>, limit = 40): string[] {
  const counts = new Map<string, number>();
  for (const text of texts) {
    for (const word of text.toLowerCase().split(/[^a-z0-9]+/)) {
      if (word.length < 4 || STOP_WORDS.has(word)) continue;
      counts.set(word, (counts.get(word) ?? 0) + 1);
    }
  }

  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, limit)
    .map(([word]) => word);
}

const STOP_WORDS = new Set([
  "that",
  "this",
  "with",
  "from",
  "have",
  "when",
  "then",
  "than",
  "they",
  "will",
  "your",
  "which",
  "there",
  "their",
  "about",
  "into",
  "over",
  "also",
  "such",
  "each",
  "more",
  "most",
  "some",
  "only",
  "other",
  "these",
  "those",
  "used",
  "using",
  "true",
  "false",
  "null",
  "string",
  "number",
  "const",
  "function",
  "return",
  "export",
  "import",
]);
