import { afterEach, expect, it, vi } from 'vitest';
import {
  HiringCafeAdapter,
  HiringCafeUnavailableError,
} from './adapters/hiringCafeAdapter';
import { RateLimiter } from './rateLimiter';

function zeroDelayLimiter(): RateLimiter {
  return new RateLimiter({
    sourceName: 'hiringCafe',
    minDelayMs: 0,
    maxDelayMs: 0,
    respectRobotsTxt: false,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

it('reports hiring.cafe as unavailable instead of returning a silent zero on a Cloudflare 403', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('blocked', { status: 403 })),
  );
  const adapter = new HiringCafeAdapter(zeroDelayLimiter());

  const failure = adapter.search('senior platform engineer', 'Remote');
  await expect(failure).rejects.toBeInstanceOf(HiringCafeUnavailableError);
  await expect(failure).rejects.toThrow(/hiring\.cafe is unavailable.*403/);
});
