import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  JobSpyAdapterRegistry,
  defaultOverallSearchBudgetMs,
  type RawPosting,
  type SourceAdapter,
} from './jobSpyAdapter';
import { parseSearchCards } from './adapters/linkedinAdapter';
import { LinkedInAdapter } from './adapters/linkedinAdapter';
import { WelcomeToTheJungleAdapter } from './adapters/welcomeToTheJungleAdapter';
import { BuiltInAdapter } from './adapters/builtInAdapter';
import { HttpStatusError, RateLimiter, type RateLimitConfig } from './rateLimiter';
import { computePostingHash } from '../utils/jobFunnelTracker';

// Phase C scraper isolation and honest success (stubbed globalThis.fetch
// only, never live boards). One malformed card or one rate-limited detail
// page costs that card, never the batch; empty parses never count as
// success; badge markup never forks postingHash records; robots failures
// never disable enforcement; multi-agent robots files merge; the breaker
// recovers on a post-TTL trial success.

function zeroDelayLimiter(sourceName: string, overrides: Partial<RateLimitConfig> = {}): RateLimiter {
  return new RateLimiter({
    sourceName,
    minDelayMs: 0,
    maxDelayMs: 0,
    respectRobotsTxt: false,
    ...overrides,
  });
}

function samplePosting(sourceAggregator: string): RawPosting {
  return {
    sourceAggregator,
    companyName: 'SampleCorp',
    roleTitle: 'SeniorEngineer',
    location: 'Remote',
    jobUrl: 'https://sample.test/jobs/1',
    description: 'Build things with TypeScript.',
    hasFullDescription: true,
    postedAt: null,
  };
}

class EmptyAdapter implements SourceAdapter {
  readonly sourceName = 'emptySource';

  async search(): Promise<RawPosting[]> {
    return [];
  }
}

class HangingAdapter implements SourceAdapter {
  readonly sourceName = 'hangingSource';

  async search(): Promise<RawPosting[]> {
    return new Promise<RawPosting[]>(() => {});
  }
}

class OnePostingAdapter implements SourceAdapter {
  readonly sourceName = 'onePostingSource';

  attempts = 0;

  async search(): Promise<RawPosting[]> {
    this.attempts += 1;
    return [samplePosting('onePostingSource')];
  }
}

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

function linkedInCard(id: string, title: string, subtitleInner: string, location: string): string {
  return (
    `<li data-entity-urn="urn:li:jobPosting:${id}" class="base-card base-card--link">` +
    `<a class="base-card__full-link" href="https://www.linkedin.com/jobs/view/${id}?trk=x"></a>` +
    `<div class="base-search-card__info">` +
    `<h3 class="base-search-card__title">${title}</h3>` +
    `<h4 class="base-search-card__subtitle">${subtitleInner}</h4>` +
    `<div class="base-search-card__metadata"><span class="job-search-card__location">${location}</span>` +
    `<time class="job-search-card__listdate--new" datetime="2026-07-01">2 weeks ago</time></div></div></li>`
  );
}

function linkedInDetail(id: string, title: string, company: string, location: string): string {
  return (
    `<div class="top-card-layout__card"><h1 class="top-card-layout__title">${title}</h1>` +
    `<a class="topcard__org-name-link" href="https://www.linkedin.com/company/${company.toLowerCase()}">${company}</a>` +
    `<span class="topcard__flavor topcard__flavor--bullet">${location}</span>` +
    `<div class="show-more-less-html__markup"><p>Build things with TypeScript.</p></div>` +
    `<a class="topcard__link" href="https://www.linkedin.com/jobs/apply/${id}">Apply</a></div>`
  );
}

function wttjDetail(jobObject: Record<string, unknown>): string {
  const innerJson = JSON.stringify({ queries: [{ state: { data: jobObject } }] });
  const outerLiteral = JSON.stringify(innerJson).slice(1, -1);
  return `<!doctype html><html><body><script>window.__INITIAL_DATA__ = "${outerLiteral}"\nwindow.__TRAILER__ = 1;</script></body></html>`;
}

function wttjJob(id: string): Record<string, unknown> {
  return {
    name: 'Senior Engineer',
    slug: `senior-engineer-${id}`,
    description: 'Build things with TypeScript.',
    ['published_at']: '2026-07-01',
    organization: { name: 'SampleCorp', slug: 'samplecorp' },
  };
}

function builtInDetail(title: string, company: string, datePosted: string): string {
  return `<html><script type="application/ld+json">${JSON.stringify({
    '@type': 'JobPosting',
    title,
    description: 'Build things with TypeScript.',
    datePosted,
    hiringOrganization: { name: company },
    jobLocationType: 'TELECOMMUTE',
    identifier: { name: company, value: 'circle-1' },
  })}</script></html>`;
}

function builtInListing(urls: string[]): string {
  const anchors = urls.map((url) => `<a href="${url}">Role</a>`).join('');
  return `<html><body>${anchors}</body></html>`;
}

describe('per-item isolation (C1)', () => {
  it('keeps parsed LinkedIn postings when the last detail page 403s', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('seeMoreJobPostings')) {
        return new Response(
          `<ul>${linkedInCard('111001', 'Senior Engineer', '<a href="https://www.linkedin.com/company/acme">Acme</a>', 'Remote')}${linkedInCard('111002', 'Senior Engineer', '<a href="https://www.linkedin.com/company/acme">Acme</a>', 'Remote')}</ul>`,
          { status: 200 },
        );
      }
      if (url.endsWith('/111001')) {
        return new Response(linkedInDetail('111001', 'Senior Engineer', 'Acme', 'Remote'), { status: 200 });
      }
      return new Response('forbidden', { status: 403 });
    }) as typeof fetch;
    const adapter = new LinkedInAdapter(zeroDelayLimiter('linkedin'));
    const postings = await adapter.search('engineer', 'Remote');
    expect(postings).toHaveLength(1);
    expect(postings[0].jobUrl).toContain('111001');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('111002'));
  });

  it('keeps parsed BuiltIn postings when the last detail page 429s', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const goodUrl = 'https://builtin.com/job/senior-engineer/circle-1';
    const badUrl = 'https://builtin.com/job/senior-engineer/circle-2';
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url === 'https://builtin.com/jobs/remote' || url === 'https://builtin.com/jobs') {
        return new Response(builtInListing([goodUrl, badUrl]), { status: 200 });
      }
      if (url === goodUrl) {
        return new Response(builtInDetail('Senior Engineer', 'CircleGrid', '2026-07-01'), { status: 200 });
      }
      return new Response('rate limited', { status: 429 });
    }) as typeof fetch;
    const adapter = new BuiltInAdapter(zeroDelayLimiter('builtIn'));
    const postings = await adapter.search('engineer', 'Remote');
    expect(postings).toHaveLength(1);
    expect(postings[0].companyName).toBe('CircleGrid');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(badUrl));
  });

  it('skips a BuiltIn card with a malformed posted date and keeps the rest', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const badUrl = 'https://builtin.com/job/senior-engineer/circle-9';
    const goodUrl = 'https://builtin.com/job/senior-engineer/circle-1';
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url === 'https://builtin.com/jobs/remote' || url === 'https://builtin.com/jobs') {
        return new Response(builtInListing([badUrl, goodUrl]), { status: 200 });
      }
      if (url === goodUrl) {
        return new Response(builtInDetail('Senior Engineer', 'CircleGrid', '2026-07-01'), { status: 200 });
      }
      return new Response(builtInDetail('Senior Engineer', 'CircleGrid', 'not-a-real-date'), { status: 200 });
    }) as typeof fetch;
    const adapter = new BuiltInAdapter(zeroDelayLimiter('builtIn'));
    const postings = await adapter.search('engineer', 'Remote');
    expect(postings).toHaveLength(1);
    expect(postings[0].jobUrl).toBe(goodUrl);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('datePosted'));
  });

  it('keeps parsed WelcomeToTheJungle postings when the last detail page 403s', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const goodUrl = 'https://www.welcometothejungle.com/en/companies/samplecorp/jobs/senior-engineer-aa11';
    const badUrl = 'https://www.welcometothejungle.com/en/companies/samplecorp/jobs/senior-engineer-bb22';
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url === goodUrl) {
        return new Response(wttjDetail(wttjJob('aa11')), { status: 200 });
      }
      if (url === badUrl) {
        return new Response('forbidden', { status: 403 });
      }
      if (url.endsWith('/sitemaps/index.xml.gz')) {
        const index = `<sitemapindex><sitemap><loc>https://www.welcometothejungle.com/sitemaps/job-listings.1.xml.gz</loc></sitemap></sitemapindex>`;
        return new Response(index, { status: 200 });
      }
      if (url.endsWith('.xml.gz')) {
        const xml =
          `<urlset><url><loc>${goodUrl}</loc></url>` +
          `<url><loc>${badUrl}</loc></url></urlset>`;
        return new Response(xml, { status: 200 });
      }
      const index = `<sitemapindex><sitemap><loc>https://www.welcometothejungle.com/sitemaps/job-listings.1.xml.gz</loc></sitemap></sitemapindex>`;
      return new Response(index, { status: 200 });
    }) as typeof fetch;
    const adapter = new WelcomeToTheJungleAdapter(zeroDelayLimiter('welcomeToTheJungle'));
    const postings = await adapter.search('engineer', '');
    expect(postings).toHaveLength(1);
    expect(postings[0].jobUrl).toBe(goodUrl);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(badUrl));
  });
});

describe('honest success signal (C2)', () => {
  it('does not record success on an empty parse', async () => {
    const limiter = zeroDelayLimiter('emptySource');
    const registry = new JobSpyAdapterRegistry();
    registry.register(new EmptyAdapter(), undefined, limiter);
    const postings = await registry.search('emptySource', 'engineer', 'Remote');
    expect(postings).toEqual([]);
    // Counted as a permanent failure (toward the breaker, never backed off),
    // never reset as a healthy batch.
    expect(limiter.getConsecutiveFailures()).toBe(1);
    expect(limiter.getNextBackoffDelayMs()).toBe(0);
    expect(limiter.isStopped()).toBe(false);
  });

  it('records success when at least one posting parses', async () => {
    const limiter = zeroDelayLimiter('onePostingSource');
    const registry = new JobSpyAdapterRegistry();
    registry.register(new OnePostingAdapter(), undefined, limiter);
    limiter.recordFailure(null);
    const postings = await registry.search('onePostingSource', 'engineer', 'Remote');
    expect(postings).toHaveLength(1);
    expect(limiter.getConsecutiveFailures()).toBe(0);
  });
});

describe('overall search budget (C3)', () => {
  it('resolves a hung source as a per-source budget error without stalling the batch', async () => {
    const hangingLimiter = zeroDelayLimiter('hangingSource');
    const healthyLimiter = zeroDelayLimiter('onePostingSource');
    const registry = new JobSpyAdapterRegistry();
    registry.register(new HangingAdapter(), undefined, hangingLimiter);
    registry.register(new OnePostingAdapter(), undefined, healthyLimiter);
    const results = await registry.searchAll('engineer', 'Remote', { budgetMs: 20 });
    expect(results).toHaveLength(2);
    const hung = results.find((result) => result.sourceName === 'hangingSource');
    const healthy = results.find((result) => result.sourceName === 'onePostingSource');
    expect(hung?.postings).toEqual([]);
    expect(hung?.error?.message).toContain('budget');
    expect(healthy?.postings).toHaveLength(1);
    expect(healthy?.error).toBeNull();
  });

  it('exposes a default overall budget so LinkedIn detail chains cannot hang search', () => {
    expect(defaultOverallSearchBudgetMs).toBeGreaterThan(0);
  });
});

describe('LinkedIn company hygiene (C4)', () => {
  it('strips badge and screen-reader spans so company names stay hash-stable', () => {
    const badged = parseSearchCards(
      `<ul>${linkedInCard('222001', 'Senior Engineer', '<a href="https://www.linkedin.com/company/acme">Acme<span class="artdeco-entity-lockup__badge">3</span><span class="visually-hidden"> followers</span></a>', 'Remote')}</ul>`,
    );
    const clean = parseSearchCards(
      `<ul>${linkedInCard('222001', 'Senior Engineer', '<a href="https://www.linkedin.com/company/acme">Acme</a>', 'Remote')}</ul>`,
    );
    expect(badged).toHaveLength(1);
    expect(badged[0].company).toBe('Acme');
    expect(clean[0].company).toBe('Acme');
    expect(
      computePostingHash(badged[0].company ?? '', badged[0].title, badged[0].location ?? ''),
    ).toBe(computePostingHash(clean[0].company ?? '', clean[0].title, clean[0].location ?? ''));
  });
});

describe('rate limiter correctness (C5)', () => {
  it('fails closed on a robots 500 instead of caching open rules for the TTL', async () => {
    let fetches = 0;
    globalThis.fetch = (async () => {
      fetches += 1;
      return new Response('edge error', { status: 500 });
    }) as typeof fetch;
    const limiter = new RateLimiter({
      sourceName: 'robotsServerError',
      minDelayMs: 0,
      maxDelayMs: 0,
      respectRobotsTxt: true,
    });
    await expect(limiter.assertPathAllowed('https://example.com/jobs/1')).rejects.toThrow(HttpStatusError);
    // Not cached: the next request retries the fetch instead of serving a
    // poisoned open result for the TTL.
    await expect(limiter.assertPathAllowed('https://example.com/jobs/1')).rejects.toThrow(HttpStatusError);
    expect(fetches).toBe(2);
  });

  it('treats a robots 404 as open rules', async () => {
    globalThis.fetch = (async () => new Response('missing', { status: 404 })) as typeof fetch;
    const limiter = new RateLimiter({
      sourceName: 'robotsMissing',
      minDelayMs: 0,
      maxDelayMs: 0,
      respectRobotsTxt: true,
    });
    await expect(limiter.assertPathAllowed('https://example.com/jobs/1')).resolves.toBeUndefined();
  });

  it('merges all matching User-agent groups so later wildcard blocks bind', async () => {
    const limiter = new RateLimiter({
      sourceName: 'multiAgent',
      minDelayMs: 0,
      maxDelayMs: 0,
      respectRobotsTxt: true,
      robotsUserAgent: 'weJobSearch',
      robotsTxtFetcher: async () => 'User-agent: weJobSearch\nDisallow: /private\n\nUser-agent: *\nDisallow: /blocked\n',
    });
    await expect(limiter.assertPathAllowed('https://example.com/blocked/1')).rejects.toThrow(/disallows/);
    await expect(limiter.assertPathAllowed('https://example.com/private/1')).rejects.toThrow(/disallows/);
    await expect(limiter.assertPathAllowed('https://example.com/jobs/1')).resolves.toBeUndefined();
  });

  it('recovers the breaker on a post-TTL trial success without manual reset', async () => {
    const breakerTtlMs = 60000;
    let currentTime = Date.now();
    const dateNow = vi.spyOn(Date, 'now').mockImplementation(() => currentTime);
    try {
      const adapter = new OnePostingAdapter();
      const limiter = zeroDelayLimiter(adapter.sourceName, { breakerTtlMs });
      const registry = new JobSpyAdapterRegistry();
      registry.register(adapter, undefined, limiter);
      limiter.recordFailure(null);
      limiter.recordFailure(null);
      limiter.recordFailure(null);
      expect(limiter.isStopped()).toBe(true);
      currentTime += breakerTtlMs;
      // The getter is pure: expiry alone reports unstopped without clearing
      // the preserved failure count; the trial below decides recovery.
      expect(limiter.isStopped()).toBe(false);
      expect(limiter.getConsecutiveFailures()).toBe(3);
      const results = await registry.searchAll('engineer', 'Remote');
      expect(results[0].error).toBeNull();
      expect(results[0].postings).toHaveLength(1);
      expect(limiter.isStopped()).toBe(false);
      expect(limiter.getConsecutiveFailures()).toBe(0);
    } finally {
      dateNow.mockRestore();
    }
  });
});
