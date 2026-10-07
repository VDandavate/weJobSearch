import { describe, expect, it } from 'vitest';
import {
  JobSpyAdapterRegistry,
  PostingDetailUnavailableError,
  UnsupportedPostingUrlError,
  type RawPosting,
  type SourceAdapter,
} from './jobSpyAdapter';
import { RateLimiter, type RateLimitConfig } from './rateLimiter';

// U33 scraper-error-class: registry-level accounting for error classification
// (permanent vs timeout-like failures) and posting-detail availability
// (claimed-but-empty vs unsupported URLs). Zero-delay limiters keep every
// case deterministic with no real sleeping.

function zeroDelayLimiter(sourceName: string, overrides: Partial<RateLimitConfig> = {}): RateLimiter {
  return new RateLimiter({
    sourceName,
    minDelayMs: 0,
    maxDelayMs: 0,
    respectRobotsTxt: false,
    ...overrides,
  });
}

function samplePosting(): RawPosting {
  return {
    sourceAggregator: 'nullDetail',
    companyName: 'SampleCorp',
    roleTitle: 'SeniorEngineer',
    location: 'Remote',
    jobUrl: 'https://null.test/jobs/1',
    description: 'Build things with TypeScript.',
    hasFullDescription: true,
    postedAt: null,
  };
}

// Claims every URL but never produces detail (deleted posting, paywall shell).
class NullDetailAdapter implements SourceAdapter {
  readonly sourceName = 'nullDetail';

  async search(): Promise<RawPosting[]> {
    return [];
  }

  async fetchPostingByUrl(): Promise<RawPosting | null> {
    return null;
  }
}

// Search-only adapter: no fetchPostingByUrl, so it can never claim a URL.
class SearchOnlyAdapter implements SourceAdapter {
  readonly sourceName = 'searchOnly';

  async search(): Promise<RawPosting[]> {
    return [samplePosting()];
  }
}

class FailingSearchAdapter implements SourceAdapter {
  readonly sourceName = 'failingSearch';

  constructor(private readonly error: Error) {}

  async search(): Promise<RawPosting[]> {
    throw this.error;
  }
}

describe('posting detail availability accounting (U33)', () => {
  it('throws detail-unavailable (not unsupported) when a claiming adapter returns no detail', async () => {
    const limiter = zeroDelayLimiter('nullDetail');
    const registry = new JobSpyAdapterRegistry();
    registry.register(new NullDetailAdapter(), undefined, limiter);

    let caught: unknown;
    try {
      await registry.fetchPostingByUrl('https://null.test/jobs/1');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(PostingDetailUnavailableError);
    expect((caught as PostingDetailUnavailableError).attemptedSources).toEqual(['nullDetail']);
    expect((caught as Error).message).toContain('currently unavailable');
    expect((caught as Error).message).not.toContain('No registered adapter can fetch');
  });

  it('keeps the unsupported error when no adapter can fetch the URL', async () => {
    const limiter = zeroDelayLimiter('searchOnly');
    const registry = new JobSpyAdapterRegistry();
    registry.register(new SearchOnlyAdapter(), undefined, limiter);

    await expect(registry.fetchPostingByUrl('https://unknown.example/jobs/7')).rejects.toThrow(
      UnsupportedPostingUrlError,
    );
    await expect(registry.fetchPostingByUrl('https://unknown.example/jobs/7')).rejects.toThrow(
      'No registered adapter can fetch a single posting',
    );
  });

  it('accounts empty detail as a permanent failure without scheduling backoff', async () => {
    const limiter = zeroDelayLimiter('nullDetail');
    const registry = new JobSpyAdapterRegistry();
    registry.register(new NullDetailAdapter(), undefined, limiter);

    await expect(registry.fetchPostingByUrl('https://null.test/jobs/1')).rejects.toThrow(
      PostingDetailUnavailableError,
    );
    expect(limiter.getConsecutiveFailures()).toBe(1);
    expect(limiter.getNextBackoffDelayMs()).toBe(0);
    expect(limiter.isStopped()).toBe(false);
  });

  it('backs off timeout-like search errors but not permanent ones', async () => {
    const permanentLimiter = zeroDelayLimiter('permanentSearch', {
      backoffBaseMs: 1000,
      backoffMaxMs: 10000,
    });
    const permanentRegistry = new JobSpyAdapterRegistry();
    permanentRegistry.register(
      new FailingSearchAdapter(new TypeError('getaddrinfo ENOTFOUND')),
      undefined,
      permanentLimiter,
    );
    await expect(
      permanentRegistry.search('failingSearch', 'staff engineer', 'Remote'),
    ).rejects.toThrow('ENOTFOUND');
    expect(permanentLimiter.getConsecutiveFailures()).toBe(1);
    expect(permanentLimiter.getNextBackoffDelayMs()).toBe(0);

    const timeoutError = new Error('The operation timed out');
    timeoutError.name = 'TimeoutError';
    const timeoutLimiter = zeroDelayLimiter('timeoutSearch', {
      backoffBaseMs: 1000,
      backoffMaxMs: 10000,
    });
    const timeoutRegistry = new JobSpyAdapterRegistry();
    timeoutRegistry.register(new FailingSearchAdapter(timeoutError), undefined, timeoutLimiter);
    await expect(timeoutRegistry.search('failingSearch', 'staff engineer', 'Remote')).rejects.toThrow(
      'timed out',
    );
    expect(timeoutLimiter.getConsecutiveFailures()).toBe(1);
    expect(timeoutLimiter.getNextBackoffDelayMs()).toBe(1000);
  });
});

describe('registry dispatch (U24)', () => {
  function sampleRawPosting(): RawPosting {
    return {
      sourceAggregator: 'listingSource',
      companyName: 'SampleCorp',
      roleTitle: 'SeniorEngineer',
      location: 'Remote',
      jobUrl: 'https://example.com/job/1',
      description: 'Build things with TypeScript.',
      hasFullDescription: true,
      postedAt: null,
    };
  }

  class ListingAdapter implements SourceAdapter {
    readonly sourceName = 'listingSource';

    async search(): Promise<RawPosting[]> {
      return [sampleRawPosting()];
    }
  }

  it('dispatches search to the registered adapter and returns its postings', async () => {
    const limiter = zeroDelayLimiter('listingSource');
    const registry = new JobSpyAdapterRegistry();
    registry.register(new ListingAdapter(), undefined, limiter);
    const postings = await registry.search('listingSource', 'engineer', 'Remote');
    expect(postings).toHaveLength(1);
    expect(postings[0].companyName).toBe('SampleCorp');
  });

  it('throws for an unregistered source instead of fetching', async () => {
    const registry = new JobSpyAdapterRegistry();
    await expect(registry.search('nope', 'engineer', 'Remote')).rejects.toThrow(
      "No adapter registered for source 'nope'",
    );
  });

  it('searchAll aggregates successes and surfaces per-source errors', async () => {
    const goodLimiter = zeroDelayLimiter('listingSource');
    const badLimiter = zeroDelayLimiter('failingSearch');
    const registry = new JobSpyAdapterRegistry();
    registry.register(new ListingAdapter(), undefined, goodLimiter);
    registry.register(new FailingSearchAdapter(new Error('source down')), undefined, badLimiter);
    const results = await registry.searchAll('engineer', 'Remote');
    expect(results).toHaveLength(2);
    const good = results.find((result) => result.sourceName === 'listingSource');
    const bad = results.find((result) => result.sourceName === 'failingSearch');
    expect(good?.postings).toHaveLength(1);
    expect(good?.error).toBeNull();
    expect(bad?.postings).toEqual([]);
    expect(bad?.error?.message).toBe('source down');
  });
});
