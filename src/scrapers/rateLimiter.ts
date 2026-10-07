import { defaultRequestTimeoutMs } from './requestTimeout';

export const defaultMinDelayMs = 2000;
export const defaultMaxDelayMs = 5000;
export const defaultBackoffBaseMs = 1000;
export const defaultBackoffMaxMs = 30000;
export const defaultMaxConsecutiveFailures = 3;
export const defaultBreakerTtlMs = 300000;
export const defaultRobotsUserAgent = 'weJobSearch';

export const conservativeMinDelayMs = 4000;
export const conservativeMaxDelayMs = 5000;

export interface RateLimitConfig {
  sourceName: string;
  minDelayMs?: number;
  maxDelayMs?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  maxConsecutiveFailures?: number;
  breakerTtlMs?: number;
  respectRobotsTxt?: boolean;
  robotsUserAgent?: string;
  robotsTxtFetcher?: (url: string) => Promise<string>;
  robotsCacheTtlMs?: number;
}

export interface RobotsGroup {
  userAgents: string[];
  allows: string[];
  disallows: string[];
  crawlDelayMs: number | null;
}

export interface RobotsRules {
  groups: RobotsGroup[];
}

export class RateLimitHardStopError extends Error {
  constructor(sourceName: string, consecutiveFailures: number) {
    super(
      `Rate limiter for source '${sourceName}' has stopped after ${consecutiveFailures} consecutive failures.`,
    );
    this.name = 'RateLimitHardStopError';
  }
}

export class RobotsTxtDisallowError extends Error {
  constructor(url: string) {
    super(`robots.txt disallows scraping ${url}`);
    this.name = 'RobotsTxtDisallowError';
  }
}

export class HttpStatusError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message?: string) {
    super(message ?? `HTTP request failed with status ${statusCode}`);
    this.name = 'HttpStatusError';
    this.statusCode = statusCode;
  }
}

interface ResolvedRateLimitConfig {
  sourceName: string;
  minDelayMs: number;
  maxDelayMs: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
  maxConsecutiveFailures: number;
  breakerTtlMs: number;
  respectRobotsTxt: boolean;
  robotsUserAgent: string;
  robotsTxtFetcher?: (url: string) => Promise<string>;
  robotsCacheTtlMs: number;
}

function resolveConfig(config: RateLimitConfig): ResolvedRateLimitConfig {
  return {
    sourceName: config.sourceName,
    minDelayMs: config.minDelayMs ?? defaultMinDelayMs,
    maxDelayMs: config.maxDelayMs ?? defaultMaxDelayMs,
    backoffBaseMs: config.backoffBaseMs ?? defaultBackoffBaseMs,
    backoffMaxMs: config.backoffMaxMs ?? defaultBackoffMaxMs,
    maxConsecutiveFailures: config.maxConsecutiveFailures ?? defaultMaxConsecutiveFailures,
    breakerTtlMs: config.breakerTtlMs ?? defaultBreakerTtlMs,
    respectRobotsTxt: config.respectRobotsTxt ?? true,
    robotsUserAgent: config.robotsUserAgent ?? defaultRobotsUserAgent,
    robotsTxtFetcher: config.robotsTxtFetcher,
    robotsCacheTtlMs: config.robotsCacheTtlMs ?? defaultRobotsCacheTtlMs,
  };
}

function isBackoffStatusCode(statusCode?: number | null): boolean {
  // The registry passes null for permanent failures (DNS refusal, deleted
  // detail, programmer errors): counted toward the breaker but never backed
  // off, since retrying them later changes nothing. It passes no status
  // (undefined) for transport-level failures, including timeouts, which stay
  // backoff-eligible.
  if (statusCode === null) {
    return false;
  }
  if (statusCode === undefined) {
    return true;
  }
  return statusCode === 429 || statusCode === 403 || (statusCode >= 500 && statusCode <= 599);
}

export const defaultRobotsCacheTtlMs = 10 * 60 * 1000;

export function jitteredDelayMs(minMs: number, maxMs: number): number {
  const range = Math.max(0, maxMs - minMs);
  return minMs + Math.floor(Math.random() * (range + 1));
}

export function conservativeDelayRange(): { minDelayMs: number; maxDelayMs: number } {
  return { minDelayMs: conservativeMinDelayMs, maxDelayMs: conservativeMaxDelayMs };
}

export function withConservativeDelayRange(config: RateLimitConfig): RateLimitConfig {
  return { ...config, ...conservativeDelayRange() };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function originFromUrl(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

function pathFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const raw = `${parsed.pathname}${parsed.search}`;
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  } catch {
    return '/';
  }
}

function percentDecodePath(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function parseRobotsTxt(text: string): RobotsRules {
  const groups: RobotsGroup[] = [];
  let current: RobotsGroup | null = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = (rawLine.split('#')[0] ?? '').trim();
    if (line.length === 0) {
      continue;
    }
    const match = /^([a-zA-Z\-]+)\s*:\s*(.*)$/.exec(line);
    if (match === null) {
      continue;
    }
    const directive = match[1].toLowerCase();
    const value = match[2].trim();
    if (directive === 'user-agent') {
      current = { userAgents: [value.toLowerCase()], allows: [], disallows: [], crawlDelayMs: null };
      groups.push(current);
    } else if (current !== null) {
      if (directive === 'disallow' && value.length > 0) {
        current.disallows.push(percentDecodePath(value));
      } else if (directive === 'allow' && value.length > 0) {
        current.allows.push(percentDecodePath(value));
      } else if (directive === 'crawl-delay') {
        const seconds = Number.parseFloat(value);
        if (Number.isFinite(seconds) && seconds >= 0) {
          current.crawlDelayMs = Math.round(seconds * 1000);
        }
      }
    }
  }
  return { groups };
}

// All groups whose User-agent line matches this crawler: the exact product
// token plus every wildcard group. Per the robots exclusion protocol as
// implemented by the major search engines, every matching group applies, so
// the caller merges them instead of stopping at the first match. A later
// wildcard block is still enforced for a named crawler.
export function findMatchingGroups(rules: RobotsRules, userAgent: string): RobotsGroup[] {
  const normalizedUserAgent = userAgent.toLowerCase();
  return rules.groups.filter(
    (group) => group.userAgents.includes(normalizedUserAgent) || group.userAgents.includes('*'),
  );
}

// Merged view of every matching group: union of allow/disallow lines, most
// conservative (largest) crawl delay. This is what enforcement consults, so a
// block listed only under a later wildcard group still binds a named crawler.
export function findMatchingGroup(rules: RobotsRules, userAgent: string): RobotsGroup | null {
  const matching = findMatchingGroups(rules, userAgent);
  if (matching.length === 0) {
    return null;
  }
  const merged: RobotsGroup = { userAgents: [], allows: [], disallows: [], crawlDelayMs: null };
  for (const group of matching) {
    merged.userAgents.push(...group.userAgents);
    merged.allows.push(...group.allows);
    merged.disallows.push(...group.disallows);
    if (group.crawlDelayMs !== null) {
      merged.crawlDelayMs =
        merged.crawlDelayMs === null ? group.crawlDelayMs : Math.max(merged.crawlDelayMs, group.crawlDelayMs);
    }
  }
  return merged;
}

export function robotsRuleMatchesPath(rule: string, path: string): boolean {
  if (rule.length === 0) {
    return true;
  }
  if (!path.startsWith(rule)) {
    return false;
  }
  if (rule.endsWith('/')) {
    return true;
  }
  return path.length === rule.length || path[rule.length] === '/';
}

export function isDisallowedByGroup(group: RobotsGroup, path: string): boolean {
  if (group.disallows.length === 0) {
    return false;
  }
  let bestMatchLength = -1;
  let bestMatchAllows = true;
  for (const allow of group.allows) {
    if (robotsRuleMatchesPath(allow, path) && allow.length > bestMatchLength) {
      bestMatchLength = allow.length;
      bestMatchAllows = true;
    }
  }
  for (const disallow of group.disallows) {
    if (robotsRuleMatchesPath(disallow, path) && disallow.length > bestMatchLength) {
      bestMatchLength = disallow.length;
      bestMatchAllows = false;
    }
  }
  return !bestMatchAllows;
}

export class RateLimiter {
  private readonly config: ResolvedRateLimitConfig;
  private lastRequestTimestamp = 0;
  private consecutiveFailures = 0;
  private nextBackoffDelayMs = 0;
  private breakerTrippedUntilTimestamp = 0;
  private delayEnvelopeOpen = false;
  private delayCount = 0;
  private readonly robotsCache = new Map<string, { rules: RobotsRules | null; fetchedAt: number }>();
  private readonly robotsFetches = new Map<string, Promise<RobotsRules | null>>();

  constructor(config: RateLimitConfig) {
    this.config = resolveConfig(config);
  }

  get sourceName(): string {
    return this.config.sourceName;
  }

  getConsecutiveFailures(): number {
    return this.consecutiveFailures;
  }

  getNextBackoffDelayMs(): number {
    return this.nextBackoffDelayMs;
  }

  // Pure getter (C5): reports the latch state without mutating it. After
  // the TTL elapses this returns false so the next search supplies the one
  // documented trial request; recordSuccess clears the latch on recovery and
  // recordFailure re-trips it on another failure. consecutiveFailures is
  // deliberately preserved across the TTL (Section 0A default) so the trial
  // outcome, not the clock, decides recovery.
  isStopped(): boolean {
    if (this.breakerTrippedUntilTimestamp === 0) {
      return false;
    }
    return Date.now() < this.breakerTrippedUntilTimestamp;
  }

  // Number of politeness delays this limiter has issued. Nested beforeRequest
  // calls that land inside a registry-owned delay envelope are suppressed and
  // do not increment the count, so one registry fetch yields exactly one.
  getDelayCount(): number {
    return this.delayCount;
  }

  assertNotStopped(): void {
    if (this.isStopped()) {
      throw new RateLimitHardStopError(this.config.sourceName, this.consecutiveFailures);
    }
  }

  // Single delay envelope (B7a): the registry owns the one politeness delay
  // per fetch. It calls beforeRequest once, opens the envelope, then invokes
  // the adapter; every per-request beforeRequest the adapter issues on this
  // same shared instance lands inside the envelope and skips its own delay
  // instead of doubling every jittered wait. The stop latch is still enforced
  // at every layer. Always pair with endDelayEnvelope in a finally block.
  beginDelayEnvelope(): void {
    this.delayEnvelopeOpen = true;
  }

  endDelayEnvelope(): void {
    this.delayEnvelopeOpen = false;
  }

  async beforeRequest(): Promise<void> {
    this.assertNotStopped();
    if (this.delayEnvelopeOpen) {
      return;
    }
    this.delayCount += 1;
    const now = Date.now();
    const elapsed = now - this.lastRequestTimestamp;
    let waitMs = jitteredDelayMs(this.config.minDelayMs, this.config.maxDelayMs);
    if (this.nextBackoffDelayMs > 0) {
      waitMs = Math.max(waitMs, this.nextBackoffDelayMs);
    }
    if (elapsed < waitMs) {
      await sleep(waitMs - elapsed);
    }
    this.lastRequestTimestamp = Date.now();
    this.nextBackoffDelayMs = 0;
  }

  recordSuccess(): void {
    this.consecutiveFailures = 0;
    this.nextBackoffDelayMs = 0;
    this.breakerTrippedUntilTimestamp = 0;
  }

  recordFailure(statusCode?: number | null): void {
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= this.config.maxConsecutiveFailures) {
      this.breakerTrippedUntilTimestamp = Date.now() + this.config.breakerTtlMs;
      return;
    }
    if (isBackoffStatusCode(statusCode)) {
      const backoffMs = Math.min(
        this.config.backoffBaseMs * 2 ** (this.consecutiveFailures - 1),
        this.config.backoffMaxMs,
      );
      this.nextBackoffDelayMs = backoffMs;
    }
  }

  reset(): void {
    this.consecutiveFailures = 0;
    this.nextBackoffDelayMs = 0;
    this.breakerTrippedUntilTimestamp = 0;
    this.lastRequestTimestamp = 0;
  }

  async assertPathAllowed(url: string): Promise<void> {
    if (!this.config.respectRobotsTxt) {
      return;
    }
    const origin = originFromUrl(url);
    if (origin === null) {
      return;
    }
    const rules = await this.robotsFor(origin);
    if (rules === null) {
      return;
    }
    const path = pathFromUrl(url);
    const group = findMatchingGroup(rules, this.config.robotsUserAgent);
    if (group !== null && isDisallowedByGroup(group, path)) {
      throw new RobotsTxtDisallowError(url);
    }
  }

  private async robotsFor(origin: string): Promise<RobotsRules | null> {
    const cached = this.robotsCache.get(origin);
    // A failed robots fetch caches null, but only for robotsCacheTtlMs: a
    // single transient timeout must not disable robots enforcement for the
    // rest of the process lifetime.
    if (cached !== undefined && Date.now() - cached.fetchedAt < this.config.robotsCacheTtlMs) {
      return cached.rules;
    }
    const inFlight = this.robotsFetches.get(origin);
    if (inFlight !== undefined) {
      return inFlight;
    }
    const fetchPromise = this.fetchRobots(origin).then(
      (rules) => {
        this.robotsCache.set(origin, { rules, fetchedAt: Date.now() });
        this.robotsFetches.delete(origin);
        return rules;
      },
      (error: unknown) => {
        // An HTTP failure fetching robots.txt (500/403 from the edge) must
        // not be cached as open rules for the TTL: fail closed without
        // caching so enforcement stays on and the next request retries.
        // Transport-level failures (timeouts, DNS) keep the documented
        // TTL-bounded fail-open below.
        if (error instanceof HttpStatusError) {
          this.robotsFetches.delete(origin);
          throw error;
        }
        this.robotsCache.set(origin, { rules: null, fetchedAt: Date.now() });
        this.robotsFetches.delete(origin);
        return null;
      },
    );
    this.robotsFetches.set(origin, fetchPromise);
    return fetchPromise;
  }

  private async fetchRobots(origin: string): Promise<RobotsRules> {
    const url = `${origin}/robots.txt`;
    const raw =
      this.config.robotsTxtFetcher !== undefined
        ? await this.config.robotsTxtFetcher(url)
        : await defaultRobotsFetch(url);
    return parseRobotsTxt(raw);
  }
}

async function defaultRobotsFetch(url: string): Promise<string> {
  const response = await fetch(url, { signal: AbortSignal.timeout(defaultRequestTimeoutMs) });
  // Only 404 maps to open rules (no robots file means nothing is disallowed).
  // Any other non-OK status (500/403 from the edge) throws so the caller can
  // fail closed instead of caching an open result for the TTL.
  if (response.status === 404) {
    return '';
  }
  if (!response.ok) {
    throw new HttpStatusError(response.status, `robots.txt request failed with status ${response.status}`);
  }
  return response.text();
}
