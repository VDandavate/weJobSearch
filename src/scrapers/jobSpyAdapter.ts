import { HttpStatusError, RateLimiter, type RateLimitConfig, withConservativeDelayRange } from './rateLimiter';
import { LinkedInAdapter } from './adapters/linkedinAdapter';
import { HiringCafeAdapter } from './adapters/hiringCafeAdapter';
import { WellfoundAdapter } from './adapters/wellfoundAdapter';
import { WelcomeToTheJungleAdapter } from './adapters/welcomeToTheJungleAdapter';
import { BuiltInAdapter } from './adapters/builtInAdapter';
import { FlexJobsAdapter } from './adapters/flexJobsAdapter';

export interface RawPosting {
  sourceAggregator: string;
  companyName: string;
  roleTitle: string;
  location: string;
  jobUrl: string;
  description: string;
  hasFullDescription: boolean;
  postedAt: string | null;
  rawSalaryText?: string;
}

export interface SourceAdapter {
  readonly sourceName: string;
  search(keywords: string, location: string): Promise<RawPosting[]>;
  // Optional per-URL detail fetch backing the evaluate --jobUrl command
  // (SDD Requirement 2a/4.1). An adapter returns null when the URL host is not
  // its own domain (no network attempt); throws on a handled-but-failed
  // fetch so the registry can record the failure on the shared rate limiter.
  // Only sources with a public detail surface implement it - see each
  // adapter's own commentary for which URL shapes it accepts.
  fetchPostingByUrl?(url: string): Promise<RawPosting | null>;
  // Optional pure domain claim for the URL above. When present, the registry
  // uses it to route a detail fetch to the owning adapter before opening the
  // single delay envelope, so probing N detail-capable adapters for one URL
  // costs exactly one delay instead of one per probe.
  canFetchPostingUrl?(url: string): boolean;
}

export interface SourceSearchResult {
  sourceName: string;
  postings: RawPosting[];
  error: Error | null;
}

// Overall search budget (C3): one source's 1+N sequential gated detail
// fetches (LinkedIn detail chain) must not hang a search for minutes. Each
// per-source search races this budget; the loser resolves as a per-source
// error, never a hung batch. searchAll passes the remaining shared deadline
// so parallel sources share one wall-clock budget.
export const defaultOverallSearchBudgetMs = 90000;

export interface SearchBudgetOptions {
  budgetMs?: number;
}

function budgetTimeoutError(sourceName: string, budgetMs: number): Error {
  const timeout = new Error(
    `Source '${sourceName}' exceeded the overall search budget of ${budgetMs}ms`,
  );
  // Named like a transport timeout so limiter accounting treats it as
  // backoff-eligible (retryable), never permanent.
  timeout.name = 'TimeoutError';
  return timeout;
}

function withSearchBudget<T>(promise: Promise<T>, budgetMs: number, sourceName: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((resolveUnused, reject) => {
    timer = setTimeout(() => reject(budgetTimeoutError(sourceName, budgetMs)), budgetMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export class PostingUrlError extends Error {
  readonly url: string;

  constructor(message: string, url: string) {
    super(message);
    this.name = 'PostingUrlError';
    this.url = url;
  }
}

export class UnsupportedPostingUrlError extends PostingUrlError {
  constructor(url: string, supportedSourceNames: string[]) {
    super(
      `No registered adapter can fetch a single posting for '${url}'. ` +
        `evaluate supports URLs from: ${supportedSourceNames.join(', ') || '(none)'}.`,
      url,
    );
    this.name = 'UnsupportedPostingUrlError';
  }
}

export class PostingDetailUnavailableError extends PostingUrlError {
  readonly attemptedSources: string[];

  constructor(url: string, attemptedSources: string[]) {
    super(
      `An adapter claimed '${url}' but returned no posting detail ` +
        `(sources attempted: ${attemptedSources.join(', ')}). ` +
        `The URL is supported but the posting detail is currently unavailable.`,
      url,
    );
    this.name = 'PostingDetailUnavailableError';
    this.attemptedSources = attemptedSources;
  }
}

// Timeout-shaped transport failures stay backoff-eligible (B7b): Node reports
// AbortSignal.timeout() expiry as an AbortError/TimeoutError DOMException,
// never as an HttpStatusError.
function isTimeoutLikeError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
}

// Classify a fetch failure for limiter accounting: HTTP status when known,
// undefined (backoff-eligible) for timeout-like transport failures, null
// (counted, never backed off) for permanent or unrecognized errors.
function backoffStatusFor(error: unknown): number | null | undefined {
  if (error instanceof HttpStatusError) {
    return error.statusCode;
  }
  if (isTimeoutLikeError(error)) {
    return undefined;
  }
  return null;
}

export class JobSpyAdapterRegistry {
  private readonly adapters = new Map<string, SourceAdapter>();
  private readonly rateLimitConfigs = new Map<string, RateLimitConfig>();
  private readonly rateLimiters = new Map<string, RateLimiter>();

  register(adapter: SourceAdapter, rateLimitConfig?: RateLimitConfig, rateLimiter?: RateLimiter): void {
    if (this.adapters.has(adapter.sourceName)) {
      throw new Error(`An adapter for source '${adapter.sourceName}' is already registered`);
    }
    this.adapters.set(adapter.sourceName, adapter);
    if (rateLimitConfig !== undefined) {
      this.rateLimitConfigs.set(adapter.sourceName, rateLimitConfig);
    }
    if (rateLimiter !== undefined) {
      this.rateLimiters.set(adapter.sourceName, rateLimiter);
    }
  }

  isRegistered(sourceName: string): boolean {
    return this.adapters.has(sourceName);
  }

  getRegisteredSources(): string[] {
    return [...this.adapters.keys()];
  }

  getRateLimiter(sourceName: string): RateLimiter {
    const existing = this.rateLimiters.get(sourceName);
    if (existing !== undefined) {
      return existing;
    }
    const config = this.rateLimitConfigs.get(sourceName) ?? { sourceName };
    const limiter = new RateLimiter(config);
    this.rateLimiters.set(sourceName, limiter);
    return limiter;
  }

  async search(
    sourceName: string,
    keywords: string,
    location: string,
    options?: SearchBudgetOptions,
  ): Promise<RawPosting[]> {
    const adapter = this.adapters.get(sourceName);
    if (adapter === undefined) {
      const registered = this.getRegisteredSources().join(', ');
      throw new Error(
        `No adapter registered for source '${sourceName}'. Registered sources: ${registered || '(none)'}`,
      );
    }
    const limiter = this.getRateLimiter(sourceName);
    limiter.assertNotStopped();
    await limiter.beforeRequest();
    // Single delay envelope (B7a): the beforeRequest above is the one delay
    // for this fetch. The adapter gates every request on this same shared
    // instance, so those nested calls run inside the envelope and skip their
    // own delay instead of doubling the jittered wait.
    limiter.beginDelayEnvelope();
    try {
      const budgetMs = options?.budgetMs ?? defaultOverallSearchBudgetMs;
      const postings = await withSearchBudget(adapter.search(keywords, location), budgetMs, sourceName);
      // Honest success (C2): an empty parse is not a healthy batch. Markup
      // breaks that yield zero postings must not reset the breaker via
      // recordSuccess (which would also let them be cached as healthy).
      // Success means at least one posting parsed. An empty result is
      // accounted as a permanent failure: counted toward the breaker, never
      // backed off. Note: SourceAdapter has no explicit zero-results signal
      // channel, so a genuinely empty listing is accounted the same way; a
      // future explicit signal would branch here.
      if (postings.length > 0) {
        limiter.recordSuccess();
      } else {
        limiter.recordFailure(null);
      }
      return postings;
    } catch (error) {
      limiter.recordFailure(backoffStatusFor(error));
      throw error;
    } finally {
      limiter.endDelayEnvelope();
    }
  }

  async searchAll(
    keywords: string,
    location: string,
    options?: SearchBudgetOptions,
  ): Promise<SourceSearchResult[]> {
    // A tripped breaker stays latched across searchAll runs until breakerTtlMs
    // elapses. The next search after the TTL supplies one trial request: success
    // recovers the source, while another failure re-trips the breaker.
    // Every source races the same shared wall-clock deadline: a hung source
    // resolves as its own per-source error instead of stalling the batch.
    const deadline = Date.now() + (options?.budgetMs ?? defaultOverallSearchBudgetMs);
    const sources = this.getRegisteredSources();
    const results = await Promise.all(
      sources.map(async (sourceName) => {
        try {
          const remainingMs = Math.max(0, deadline - Date.now());
          const postings = await this.search(sourceName, keywords, location, {
            budgetMs: remainingMs,
          });
          return { sourceName, postings, error: null };
        } catch (error) {
          return { sourceName, postings: [], error: error as Error };
        }
      }),
    );
    return results;
  }

  private async adapterFetchOrNull(adapter: SourceAdapter, url: string): Promise<RawPosting | null> {
    if (adapter.fetchPostingByUrl === undefined) {
      return null;
    }
    const limiter = this.getRateLimiter(adapter.sourceName);
    limiter.assertNotStopped();
    await limiter.beforeRequest();
    // Single delay envelope (B7a): same envelope as search, so the
    // adapter's per-request gate on this shared instance adds no second wait.
    limiter.beginDelayEnvelope();
    try {
      const posting = await adapter.fetchPostingByUrl(url);
      if (posting === null) {
        // Claimed but empty: not a healthy fetch, so it must not reset the
        // limiter via recordSuccess. Accounted as a permanent failure —
        // counted toward the breaker, never backed off.
        limiter.recordFailure(null);
        return posting;
      }
      limiter.recordSuccess();
      return posting;
    } catch (error) {
      limiter.recordFailure(backoffStatusFor(error));
      throw error;
    } finally {
      limiter.endDelayEnvelope();
    }
  }

  // Backing for the evaluate --jobUrl command (SDD Section 4.1): route the URL
  // to whichever registered adapter's detail-fetch owns that domain and fetch
  // the single posting. Hosts no adapter claims produce a clear error instead
  // of a silent network attempt. The URL must be a valid http(s) URL up front
  // so a malformed address fails fast without touching any limiter.
  async fetchPostingByUrl(url: string): Promise<RawPosting> {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new PostingUrlError(`Not a valid URL: '${url}'`, url);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new PostingUrlError(`Unsupported URL protocol '${parsed.protocol}' for '${url}'`, url);
    }
    const detailSources = this.getRegisteredSources().filter(
      (sourceName) => this.adapters.get(sourceName)?.fetchPostingByUrl !== undefined,
    );
    // Single delay envelope (B7a): route first, delay once. Adapters that can
    // synchronously decline the URL are skipped before any limiter is touched,
    // so one detail fetch costs exactly one delay however many detail-capable
    // adapters are registered. Adapters without a claim hook keep the legacy
    // probe behavior and are always included.
    const claimedSources = detailSources.filter((sourceName) => {
      const adapter = this.adapters.get(sourceName);
      return adapter?.canFetchPostingUrl === undefined || adapter.canFetchPostingUrl(url);
    });
    const attemptedSources: string[] = [];
    for (const sourceName of claimedSources) {
      const adapter = this.adapters.get(sourceName);
      if (adapter === undefined) {
        continue;
      }
      const posting = await this.adapterFetchOrNull(adapter, url);
      if (posting !== null) {
        return posting;
      }
      attemptedSources.push(sourceName);
    }
    if (attemptedSources.length > 0) {
      throw new PostingDetailUnavailableError(url, attemptedSources);
    }
    throw new UnsupportedPostingUrlError(url, detailSources);
  }
}

/**
 * Build a registry with every accepted-risk source currently implemented.
 * LinkedIn is ported from .reference/aiJobSearch per SDD Section 1.3 and uses
 * the most conservative end of the 2-5s delay range (4-5s) under the accepted
 * risk posture (SDD Requirement 8). The caller constructs the adapter and the
 * limiter together so a single shared RateLimiter instance is owned by the
 * registry envelope: the registry issues the one politeness delay per fetch,
 * and every per-request adapter gate on that same instance runs inside the
 * envelope without adding a second wait.
 *
 * hiring.cafe is registered under the default 2-5s jittered delay with
 * robots.txt respected (its /jobs/ and /job/ paths are robots-allowed). Note:
 * hiring.cafe ToS Section 5 restricts re-publication of its material; this
 * adapter is an accepted-risk scrape per the Step 3b decision, using only
 * public unauthenticated pages. It fetches only the first listing page.
 *
 * Wellfound is registered under the default 2-5s jittered delay with robots.txt
 * respected (its /role/ SEO listing paths are robots-allowed and sitemapped).
 * Note: Wellfound's Talent General Terms Article III explicitly prohibits
 * scraping; this adapter is an accepted-risk scrape per the Step 3c decision
 * (same discipline as hiring.cafe), using only public unauthenticated pages
 * over plain HTTP — no login, no bot-detection/CAPTCHA bypass. Guest sessions
 * cannot paginate or use the /jobs/ filter surface (sign-in wall), so only the
 * first role-listing page is fetched.
 *
 * Welcome to the Jungle is registered under the default 2-5s jittered delay
 * with robots.txt respected (its sitemaps, company pages, and job pages are
 * robots-allowed; the adapter builds no query-string URLs and only reads the
 * robots-allowed `job-listings` sitemaps plus server-rendered job detail
 * pages over plain HTTP). Note: WTTJ's site CGUs (27 Apr 2026) explicitly
 * prohibit scraping and automated data extraction; this adapter is an
 * accepted-risk scrape per the Step 3d decision (same discipline as
 * hiring.cafe and Wellfound) using only public unauthenticated pages — no
 * login, no JS execution, no CAPTCHA/bot-detection bypass, and no referer
 * spoofing to defeat the Algolia search API's referer allow-list. A bounded
 * prefix of sitemap entries is fetched per search.
 *
 * Built In is registered under the default 2-5s jittered delay with robots.txt
 * respected (its /jobs/ and /job/ paths are robots-allowed; we never build the
 * robots-blocked ?search= query URLs or metro-hub listing directories). Note:
 * Built In's Community Terms of Use (May 23, 2025) explicitly prohibit bots
 * and scraping; this adapter is an accepted-risk scrape per the Step 3e
 * decision (same discipline as hiring.cafe, Wellfound, and WTTJ), using only
 * public unauthenticated server-rendered pages over plain HTTP — no login, no
 * JS execution, no CAPTCHA/bot-detection bypass.
 *
 * FlexJobs is registered under the most conservative 4-5s delay range
 * (withConservativeDelayRange) with robots.txt respected (robots.txt allows the
 * /remote-jobs listing path; the adapter builds URL on an allowed path). Note:
 * FlexJobs is a subscription service whose paywall is the product — the full
 * posting description, employer details, and applying sit behind the paid
 * membership, and the /publicjobs/{slug} detail and /search surfaces return
 * HTTP 403 (Akamai edge) under a plain unauthenticated GET. This adapter stays
 * on the robots-allowed first listing page, which server-renders a Next.js
 * __NEXT_DATA__ JSON island with per-job records (employer name, ISO posted
 * date, salaryRange string, remote flags, and a ~200-character teaser).
 * FlexJobs' ToS (Jan 16, 2025) explicitly prohibit scraping and bots; this
 * adapter is an accepted-risk scrape per the Step 3f decision (same discipline
 * as the other five), using only public unauthenticated pages over plain HTTP
 * — no login, no session/cookie handling, no CAPTCHA or bot-detection bypass.
 * Built last and with the most conservative rate limiting of the six.
 */
export function createDefaultRegistry(): JobSpyAdapterRegistry {
  const registry = new JobSpyAdapterRegistry();
  const linkedinLimiter = new RateLimiter(
    withConservativeDelayRange({ sourceName: 'linkedin', respectRobotsTxt: false }),
  );
  const linkedinAdapter = new LinkedInAdapter(linkedinLimiter);
  registry.register(linkedinAdapter, undefined, linkedinLimiter);
  const hiringCafeLimiter = new RateLimiter({ sourceName: 'hiringCafe' });
  const hiringCafeAdapter = new HiringCafeAdapter(hiringCafeLimiter);
  registry.register(hiringCafeAdapter, undefined, hiringCafeLimiter);
  const wellfoundLimiter = new RateLimiter({ sourceName: 'wellfound' });
  const wellfoundAdapter = new WellfoundAdapter(wellfoundLimiter);
  registry.register(wellfoundAdapter, undefined, wellfoundLimiter);
  const welcomeToTheJungleLimiter = new RateLimiter({ sourceName: 'welcomeToTheJungle' });
  const welcomeToTheJungleAdapter = new WelcomeToTheJungleAdapter(welcomeToTheJungleLimiter);
  registry.register(welcomeToTheJungleAdapter, undefined, welcomeToTheJungleLimiter);
  const builtInLimiter = new RateLimiter({ sourceName: 'builtIn' });
  const builtInAdapter = new BuiltInAdapter(builtInLimiter);
  registry.register(builtInAdapter, undefined, builtInLimiter);
  const flexJobsLimiter = new RateLimiter(
    withConservativeDelayRange({ sourceName: 'flexJobs', respectRobotsTxt: true }),
  );
  const flexJobsAdapter = new FlexJobsAdapter(flexJobsLimiter);
  registry.register(flexJobsAdapter, undefined, flexJobsLimiter);
  return registry;
}
