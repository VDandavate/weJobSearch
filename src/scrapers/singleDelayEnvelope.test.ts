import { describe, expect, it } from 'vitest';
import {
  JobSpyAdapterRegistry,
  UnsupportedPostingUrlError,
  type RawPosting,
  type SourceAdapter,
} from './jobSpyAdapter';
import { RateLimiter } from './rateLimiter';

// B7a single delay envelope: the registry owns the one politeness delay per
// fetch. Adapters gate every request on the same shared limiter instance, so
// those nested gates must run inside the envelope without adding a second
// wait. These tests count issued delays via RateLimiter.getDelayCount with
// zero-delay limiters (no real sleeping, fully deterministic).

function zeroDelayLimiter(sourceName: string): RateLimiter {
  return new RateLimiter({ sourceName, minDelayMs: 0, maxDelayMs: 0, respectRobotsTxt: false });
}

function samplePosting(sourceAggregator: string): RawPosting {
  return {
    sourceAggregator,
    companyName: 'SampleCorp',
    roleTitle: 'SeniorEngineer',
    location: 'Remote',
    jobUrl: 'https://example.com/job/1',
    description: 'Build things with TypeScript.',
    hasFullDescription: true,
    postedAt: null,
  };
}

// Simulates a production adapter: its per-request gate calls beforeRequest on
// the shared limiter instance it was constructed with.
class GatedSearchAdapter implements SourceAdapter {
  readonly sourceName = 'gatedSource';

  constructor(private readonly limiter: RateLimiter) {}

  async search(): Promise<RawPosting[]> {
    await this.limiter.beforeRequest();
    return [];
  }
}

class DecliningDetailAdapter implements SourceAdapter {
  readonly sourceName = 'decliningSource';

  fetchCalls = 0;

  constructor(private readonly limiter: RateLimiter) {}

  canFetchPostingUrl(): boolean {
    return false;
  }

  async fetchPostingByUrl(): Promise<RawPosting | null> {
    this.fetchCalls += 1;
    await this.limiter.beforeRequest();
    return null;
  }

  async search(): Promise<RawPosting[]> {
    return [];
  }
}

// Simulates a failing adapter: gates on the shared limiter, then throws.
class ThrowingGatedAdapter implements SourceAdapter {
  readonly sourceName = 'throwingSource';

  constructor(private readonly limiter: RateLimiter) {}

  async search(): Promise<RawPosting[]> {
    await this.limiter.beforeRequest();
    throw new Error('boom gated');
  }
}

class ClaimingDetailAdapter implements SourceAdapter {
  readonly sourceName = 'claimingSource';

  constructor(
    private readonly limiter: RateLimiter,
    private readonly posting: RawPosting,
  ) {}

  canFetchPostingUrl(url: string): boolean {
    return url.includes('claiming.example.com');
  }

  async fetchPostingByUrl(): Promise<RawPosting | null> {
    await this.limiter.beforeRequest();
    return this.posting;
  }

  async search(): Promise<RawPosting[]> {
    return [];
  }
}

describe('single delay envelope (B7a)', () => {
  it('issues exactly one delay per search when the adapter gates on the shared limiter', async () => {
    const limiter = zeroDelayLimiter('gatedSource');
    const registry = new JobSpyAdapterRegistry();
    registry.register(new GatedSearchAdapter(limiter), undefined, limiter);

    await registry.search('gatedSource', 'senior engineer', 'Remote');

    expect(limiter.getDelayCount()).toBe(1);
  });

  it('issues exactly one delay per detail fetch across multiple detail-capable adapters', async () => {
    const decliningLimiter = zeroDelayLimiter('decliningSource');
    const claimingLimiter = zeroDelayLimiter('claimingSource');
    const posting = samplePosting('claimingSource');
    const declining = new DecliningDetailAdapter(decliningLimiter);
    const registry = new JobSpyAdapterRegistry();
    registry.register(declining, undefined, decliningLimiter);
    registry.register(new ClaimingDetailAdapter(claimingLimiter, posting), undefined, claimingLimiter);

    const result = await registry.fetchPostingByUrl('https://claiming.example.com/jobs/1');

    expect(result).toEqual(posting);
    // The declining adapter is skipped by claim routing before any limiter is
    // touched: no probe delay, and its fetch never runs.
    expect(declining.fetchCalls).toBe(0);
    expect(decliningLimiter.getDelayCount()).toBe(0);
    // The owning adapter's own per-request gate lands inside the registry
    // envelope, so the whole fetch costs exactly one delay.
    expect(claimingLimiter.getDelayCount()).toBe(1);
  });

  it('issues zero delays for a URL no registered adapter claims', async () => {
    const decliningLimiter = zeroDelayLimiter('decliningSource');
    const claimingLimiter = zeroDelayLimiter('claimingSource');
    const registry = new JobSpyAdapterRegistry();
    registry.register(new DecliningDetailAdapter(decliningLimiter), undefined, decliningLimiter);
    registry.register(
      new ClaimingDetailAdapter(claimingLimiter, samplePosting('claimingSource')),
      undefined,
      claimingLimiter,
    );

    await expect(registry.fetchPostingByUrl('https://example.com/job/1')).rejects.toThrow(
      UnsupportedPostingUrlError,
    );
    expect(decliningLimiter.getDelayCount()).toBe(0);
    expect(claimingLimiter.getDelayCount()).toBe(0);
  });

  it('still issues one delay and closes the envelope when the adapter throws', async () => {
    const limiter = zeroDelayLimiter('throwingSource');
    const registry = new JobSpyAdapterRegistry();
    registry.register(new ThrowingGatedAdapter(limiter), undefined, limiter);

    await expect(registry.search('throwingSource', 'staff engineer', 'Remote')).rejects.toThrow(
      'boom gated',
    );
    // Outer wait only; the nested gate added none even on the failure path.
    expect(limiter.getDelayCount()).toBe(1);
    // The envelope closed in the finally: a bare request past the fresh
    // timestamp issues its own delay instead of slipping through.
    await limiter.beforeRequest();
    expect(limiter.getDelayCount()).toBe(2);
  });
});
