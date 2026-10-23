import { describe, expect, it, vi } from 'vitest';
import {
  JobSpyAdapterRegistry,
  type RawPosting,
  type SourceAdapter,
} from './jobSpyAdapter';
import {
  computeEffectiveWaitMs,
  HttpStatusError,
  isDisallowedByGroup,
  RateLimitHardStopError,
  RateLimiter,
  robotsRuleMatchesPath,
  type RateLimitConfig,
  type RobotsGroup,
} from './rateLimiter';

// B7b: the tripped breaker is latched across searchAll runs until breakerTtlMs
// elapses. The next search after the TTL supplies one trial request: success
// recovers the source, while another failure re-trips the breaker. Backoff now
// covers 5xx responses and timeouts in addition to 429 and 403 responses.
//
// U35 scraper-test-fold: canonical suite for the breaker/backoff scenarios
// previously duplicated in breakerBackoff.test.ts (deleted). The explicit
// 403/429 rows plus the single-attempt latch assertion below preserve the
// non-5xx backoff coverage the deleted file owned.

function zeroDelayLimiter(sourceName: string, overrides: Partial<RateLimitConfig> = {}): RateLimiter {
  return new RateLimiter({
    sourceName,
    minDelayMs: 0,
    maxDelayMs: 0,
    respectRobotsTxt: false,
    ...overrides,
  });
}

class FlakyAdapter implements SourceAdapter {
  readonly sourceName = 'flakySource';

  attempts = 0;

  async search(): Promise<RawPosting[]> {
    this.attempts += 1;
    throw new Error(`boom attempt ${this.attempts}`);
  }
}

class HealthyAdapter implements SourceAdapter {
  readonly sourceName = 'healthySource';

  attempts = 0;

  async search(): Promise<RawPosting[]> {
    this.attempts += 1;
    // Returns one posting: under honest-success accounting (Phase C) an
    // empty parse no longer counts as success, so recovery requires a real
    // parsed posting.
    return [
      {
        sourceAggregator: 'healthySource',
        companyName: 'SampleCorp',
        roleTitle: 'SeniorEngineer',
        location: 'Remote',
        jobUrl: 'https://healthy.test/jobs/1',
        description: 'Build things with TypeScript.',
        hasFullDescription: true,
        postedAt: null,
      },
    ];
  }
}

class StatusAdapter implements SourceAdapter {
  readonly sourceName = 'statusSource';

  attempts = 0;

  private readonly statusCode: number;

  constructor(statusCode: number) {
    this.statusCode = statusCode;
  }

  async search(): Promise<RawPosting[]> {
    this.attempts += 1;
    throw new HttpStatusError(this.statusCode, `received status ${this.statusCode}`);
  }
}

class TimeoutAdapter implements SourceAdapter {
  readonly sourceName = 'timeoutSource';

  attempts = 0;

  async search(): Promise<RawPosting[]> {
    this.attempts += 1;
    const timeout = new Error('request timed out');
    timeout.name = 'TimeoutError';
    throw timeout;
  }
}

function registryWith(adapter: SourceAdapter, limiter?: RateLimiter): JobSpyAdapterRegistry {
  const registry = new JobSpyAdapterRegistry();
  registry.register(adapter, undefined, limiter ?? zeroDelayLimiter(adapter.sourceName));
  return registry;
}

async function failTimes(registry: JobSpyAdapterRegistry, sourceName: string, times: number): Promise<void> {
  for (let index = 0; index < times; index += 1) {
    await expect(registry.search(sourceName, 'staff engineer', 'Remote')).rejects.toThrow();
  }
}

describe('RateLimiter hard-stop latch', () => {
  it('latches stopped after three consecutive failures and names the source', () => {
    const limiter = zeroDelayLimiter('poisonedSource');
    limiter.recordFailure();
    limiter.recordFailure();
    expect(limiter.isStopped()).toBe(false);
    limiter.recordFailure();
    expect(limiter.isStopped()).toBe(true);
    expect(limiter.getConsecutiveFailures()).toBe(3);
    expect(() => limiter.assertNotStopped()).toThrow(RateLimitHardStopError);
    expect(() => limiter.assertNotStopped()).toThrow(/poisonedSource/);
  });

  it('clears the consecutive count on success so transient errors do not latch', () => {
    const limiter = zeroDelayLimiter('flakyOk');
    limiter.recordFailure();
    limiter.recordFailure();
    limiter.recordSuccess();
    expect(limiter.getConsecutiveFailures()).toBe(0);
    expect(limiter.isStopped()).toBe(false);
  });

  it('reset clears a latched stop so the source can be retried', () => {
    const limiter = zeroDelayLimiter('resetMe');
    limiter.recordFailure();
    limiter.recordFailure();
    limiter.recordFailure();
    expect(limiter.isStopped()).toBe(true);
    limiter.reset();
    expect(limiter.isStopped()).toBe(false);
    expect(limiter.getConsecutiveFailures()).toBe(0);
    expect(() => limiter.assertNotStopped()).not.toThrow();
  });
});

describe('registry stopped-source policy (B7b)', () => {
  it('keeps a latched source loudly stopped on single search instead of dropping it silently', async () => {
    const adapter = new FlakyAdapter();
    const limiter = zeroDelayLimiter(adapter.sourceName, { backoffBaseMs: 1, backoffMaxMs: 1 });
    const registry = registryWith(adapter, limiter);
    await failTimes(registry, adapter.sourceName, 3);
    expect(registry.getRateLimiter(adapter.sourceName).isStopped()).toBe(true);
    await expect(registry.search(adapter.sourceName, 'staff engineer', 'Remote')).rejects.toThrow(
      RateLimitHardStopError,
    );
    // The stopped attempt never reached the adapter: still 3 attempts, not 4.
    expect(adapter.attempts).toBe(3);
  });

  it('keeps a tripped breaker latched across searchAll runs before its TTL elapses', async () => {
    const adapter = new FlakyAdapter();
    const limiter = zeroDelayLimiter(adapter.sourceName, {
      backoffBaseMs: 1,
      backoffMaxMs: 1,
      breakerTtlMs: 60000,
    });
    const registry = registryWith(adapter, limiter);
    await failTimes(registry, adapter.sourceName, 3);
    expect(limiter.isStopped()).toBe(true);

    const first = await registry.searchAll('staff engineer', 'Remote');
    const second = await registry.searchAll('staff engineer', 'Remote');

    expect(adapter.attempts).toBe(3);
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(first[0].error).toBeInstanceOf(RateLimitHardStopError);
    expect(second[0].error).toBeInstanceOf(RateLimitHardStopError);
    expect(limiter.isStopped()).toBe(true);
  });

  it('permits one trial after the TTL elapses and re-trips when the trial fails', async () => {
    const breakerTtlMs = 60000;
    let currentTime = Date.now();
    const dateNow = vi.spyOn(Date, 'now').mockImplementation(() => currentTime);
    try {
      const adapter = new FlakyAdapter();
      const limiter = zeroDelayLimiter(adapter.sourceName, {
        backoffBaseMs: 1,
        backoffMaxMs: 1,
        breakerTtlMs,
      });
      const registry = registryWith(adapter, limiter);
      await failTimes(registry, adapter.sourceName, 3);
      expect(limiter.isStopped()).toBe(true);

      currentTime += breakerTtlMs;
      const results = await registry.searchAll('staff engineer', 'Remote');

      expect(adapter.attempts).toBe(4);
      expect(results).toHaveLength(1);
      expect(results[0].error?.message).toContain('boom attempt 4');
      expect(limiter.isStopped()).toBe(true);
    } finally {
      dateNow.mockRestore();
    }
  });

  it('recovers a source that succeeds on its post-TTL trial without manual intervention', async () => {
    const breakerTtlMs = 60000;
    let currentTime = Date.now();
    const dateNow = vi.spyOn(Date, 'now').mockImplementation(() => currentTime);
    try {
      const healthy = new HealthyAdapter();
      const limiter = zeroDelayLimiter(healthy.sourceName, { breakerTtlMs });
      const registry = registryWith(healthy, limiter);
      limiter.recordFailure(404);
      limiter.recordFailure(404);
      limiter.recordFailure(404);
      expect(limiter.isStopped()).toBe(true);

      currentTime += breakerTtlMs;
      const results = await registry.searchAll('staff engineer', 'Remote');

      expect(healthy.attempts).toBe(1);
      expect(results[0].error).toBeNull();
      expect(limiter.isStopped()).toBe(false);
      expect(limiter.getConsecutiveFailures()).toBe(0);
    } finally {
      dateNow.mockRestore();
    }
  });

  it('surfaces a still-failing source in searchAll results so coverage loss is loud', async () => {
    const adapter = new FlakyAdapter();
    const registry = registryWith(adapter);
    const results = await registry.searchAll('staff engineer', 'Remote');
    expect(results).toHaveLength(1);
    expect(results[0].sourceName).toBe(adapter.sourceName);
    expect(results[0].error).not.toBeNull();
    expect(results[0].postings).toEqual([]);
  });
});

describe('extended failure backoff (B7b)', () => {
  it.each([403, 429, 500, 502, 503, 504])(
    'schedules backoff after HTTP %i without tripping the breaker',
    async (statusCode: number) => {
      const adapter = new StatusAdapter(statusCode);
      const limiter = zeroDelayLimiter(adapter.sourceName, {
        backoffBaseMs: 1000,
        backoffMaxMs: 10000,
      });
      const registry = registryWith(adapter, limiter);

      await expect(registry.search(adapter.sourceName, 'staff engineer', 'Remote')).rejects.toThrow(
        HttpStatusError,
      );

      expect(limiter.getConsecutiveFailures()).toBe(1);
      expect(limiter.getNextBackoffDelayMs()).toBe(1000);
      expect(limiter.isStopped()).toBe(false);
      // Folded from breakerBackoff.test.ts: the registry-level failure counts
      // toward the latch on a single adapter attempt, no silent retry.
      expect(adapter.attempts).toBe(1);
    },
  );

  it('schedules backoff after a timeout without an HTTP status', async () => {
    const adapter = new TimeoutAdapter();
    const limiter = zeroDelayLimiter(adapter.sourceName, {
      backoffBaseMs: 1000,
      backoffMaxMs: 10000,
    });
    const registry = registryWith(adapter, limiter);

    await expect(registry.search(adapter.sourceName, 'staff engineer', 'Remote')).rejects.toThrow(
      /request timed out/,
    );

    expect(adapter.attempts).toBe(1);
    expect(limiter.getConsecutiveFailures()).toBe(1);
    expect(limiter.getNextBackoffDelayMs()).toBe(1000);
    expect(limiter.isStopped()).toBe(false);
  });

  it('applies exponential backoff to repeated retryable failures', () => {
    const limiter = zeroDelayLimiter('exponentialBackoff', {
      backoffBaseMs: 1000,
      backoffMaxMs: 10000,
    });

    limiter.recordFailure(503);
    expect(limiter.getNextBackoffDelayMs()).toBe(1000);
    limiter.recordFailure();
    expect(limiter.getNextBackoffDelayMs()).toBe(2000);
    expect(limiter.getConsecutiveFailures()).toBe(2);
    expect(limiter.isStopped()).toBe(false);
  });

  it('does not schedule backoff for a non-retryable client error', () => {
    const limiter = zeroDelayLimiter('clientError');

    limiter.recordFailure(404);

    expect(limiter.getConsecutiveFailures()).toBe(1);
    expect(limiter.getNextBackoffDelayMs()).toBe(0);
    expect(limiter.isStopped()).toBe(false);
  });

  it('counts permanent failures toward the breaker without scheduling backoff', () => {
    const limiter = zeroDelayLimiter('permanentFailure');

    limiter.recordFailure(null);
    limiter.recordFailure(null);

    expect(limiter.getConsecutiveFailures()).toBe(2);
    expect(limiter.getNextBackoffDelayMs()).toBe(0);
    expect(limiter.isStopped()).toBe(false);

    limiter.recordFailure(null);

    expect(limiter.getConsecutiveFailures()).toBe(3);
    expect(limiter.getNextBackoffDelayMs()).toBe(0);
    expect(limiter.isStopped()).toBe(true);
  });
});

describe('robots cache TTL (U42/B9)', () => {
  function robotsLimiter(
    sourceName: string,
    overrides: Partial<RateLimitConfig> & {
      robotsTxtFetcher: (url: string) => Promise<string>;
    },
  ): RateLimiter {
    return new RateLimiter({
      sourceName,
      minDelayMs: 0,
      maxDelayMs: 0,
      respectRobotsTxt: true,
      ...overrides,
    });
  }

  it('refetches robots rules after the cache TTL instead of failing open forever', async () => {
    let fetches = 0;
    const limiter = robotsLimiter('robotsTtl', {
      robotsCacheTtlMs: 0,
      robotsTxtFetcher: async () => {
        fetches += 1;
        if (fetches === 1) {
          throw new Error('transient robots timeout');
        }
        return 'User-agent: *\nDisallow: /blocked\n';
      },
    });
    await limiter.assertPathAllowed('https://example.com/jobs/1');
    expect(fetches).toBe(1);
    await limiter.assertPathAllowed('https://example.com/jobs/2');
    expect(fetches).toBe(2);
  });

  it('keeps serving cached robots rules within the TTL', async () => {
    let fetches = 0;
    const limiter = robotsLimiter('robotsFresh', {
      robotsCacheTtlMs: 10 * 60 * 1000,
      robotsTxtFetcher: async () => {
        fetches += 1;
        throw new Error('transient robots timeout');
      },
    });
    await limiter.assertPathAllowed('https://example.com/jobs/1');
    await limiter.assertPathAllowed('https://example.com/jobs/2');
    expect(fetches).toBe(1);
  });
});

describe('robots rule matching (finding 11)', () => {
  function group(allows: string[], disallows: string[]): RobotsGroup {
    return { userAgents: ['*'], allows, disallows, crawlDelayMs: null };
  }

  it.each([
    ['/*?searchState=*', '/jobs?searchState=abc', true],
    ['/*?searchState=*', '/jobs?location=Remote', false],
    ['*/api/*', '/v1/api/jobs', true],
    ['*/api/*', '/api/', true],
    ['*/api/*', '/v1/apix/jobs', false],
    ['/*.asmx', '/Services/Jobs.asmx', true],
    ['/*.asmx', '/Services/Jobs.aspx', false],
    ['/me/*', '/me/profile', true],
    ['/me/*', '/me/', true],
    ['/me/*', '/member', false],
  ])('matches the wildcard rule %s against %s', (rule, path, expected) => {
    expect(robotsRuleMatchesPath(rule, path)).toBe(expected);
  });

  it('anchors a trailing $ and otherwise matches as a prefix', () => {
    expect(robotsRuleMatchesPath('/job$', '/job')).toBe(true);
    expect(robotsRuleMatchesPath('/job$', '/jobs')).toBe(false);
    expect(robotsRuleMatchesPath('/job', '/jobs')).toBe(true);
  });

  it('treats the empty rule and / as matching every path', () => {
    expect(robotsRuleMatchesPath('', '/anything?x=1')).toBe(true);
    expect(robotsRuleMatchesPath('/', '/anything?x=1')).toBe(true);
  });

  it('lets the longest matching rule win', () => {
    const rules = group(['/jobs/remote'], ['/jobs']);
    expect(isDisallowedByGroup(rules, '/jobs/remote/1')).toBe(false);
    expect(isDisallowedByGroup(rules, '/jobs/other')).toBe(true);
  });

  it('compares wildcard rules by their literal prefix', () => {
    const rules = group(['/public/*'], ['/*']);
    expect(isDisallowedByGroup(rules, '/public/jobs')).toBe(false);
    expect(isDisallowedByGroup(rules, '/private/jobs')).toBe(true);
  });

  it('lets Allow beat Disallow when specificity ties', () => {
    expect(isDisallowedByGroup(group(['/jobs'], ['/jobs']), '/jobs/1')).toBe(false);
    expect(isDisallowedByGroup(group([], ['/jobs']), '/jobs/1')).toBe(true);
  });

  it('matches the path plus query at the enforcement seam', async () => {
    const limiter = new RateLimiter({
      sourceName: 'robotsQuery',
      minDelayMs: 0,
      maxDelayMs: 0,
      respectRobotsTxt: true,
      robotsTxtFetcher: async () => 'User-agent: *\nDisallow: /*?searchState=*\n',
    });
    await expect(
      limiter.assertPathAllowed('https://example.com/jobs?searchState=abc'),
    ).rejects.toThrow(/disallows/);
    await expect(limiter.assertPathAllowed('https://example.com/jobs?location=Remote')).resolves.toBeUndefined();
  });
});

describe('effective wait (finding 12)', () => {
  it('adds the scheduled backoff to the politeness delay instead of taking the maximum', () => {
    expect(computeEffectiveWaitMs(2000, 1000)).toBe(3000);
    expect(computeEffectiveWaitMs(5000, 1000)).toBe(6000);
    expect(computeEffectiveWaitMs(2000, 0)).toBe(2000);
  });

  it('grows the scheduled backoff exponentially until the configured cap', () => {
    const limiter = zeroDelayLimiter('additiveBackoff', {
      backoffBaseMs: 1000,
      backoffMaxMs: 5000,
      maxConsecutiveFailures: 10,
    });
    limiter.recordFailure(429);
    expect(limiter.getNextBackoffDelayMs()).toBe(1000);
    limiter.recordFailure(429);
    expect(limiter.getNextBackoffDelayMs()).toBe(2000);
    limiter.recordFailure(429);
    expect(limiter.getNextBackoffDelayMs()).toBe(4000);
    limiter.recordFailure(429);
    expect(limiter.getNextBackoffDelayMs()).toBe(5000);
    limiter.recordFailure(429);
    expect(limiter.getNextBackoffDelayMs()).toBe(5000);
  });

  it('resets the scheduled backoff after a success', () => {
    const limiter = zeroDelayLimiter('resetBackoff', { backoffBaseMs: 1000, backoffMaxMs: 10000 });
    limiter.recordFailure(503);
    expect(limiter.getNextBackoffDelayMs()).toBe(1000);
    limiter.recordSuccess();
    expect(limiter.getNextBackoffDelayMs()).toBe(0);
  });
});
