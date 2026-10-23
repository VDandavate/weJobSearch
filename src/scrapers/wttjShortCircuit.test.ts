import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  resetSitemapIndexCacheForTests,
  WelcomeToTheJungleAdapter,
  wttjLocationIsReachable,
} from './adapters/welcomeToTheJungleAdapter';
import { RateLimiter } from './rateLimiter';

const indexUrl = 'https://www.welcometothejungle.com/sitemaps/index.xml.gz';
const jobSitemapUrl = 'https://www.welcometothejungle.com/sitemaps/job-listings.1.xml.gz';

function gzipXml(xml: string): Uint8Array {
  return gzipSync(Buffer.from(xml, 'utf8'));
}

function detailHtml(slug: string, title: string, company: string): string {
  const jobObject = {
    name: title,
    slug,
    description: 'We are building a platform in Paris.',
    ['published_at']: '2026-07-01T00:00:00Z',
    remote: 'No remote',
    ['contract_type']: 'CDI',
    office: { address: 'Paris' },
    ['salary_currency']: 'EUR',
    ['salary_min']: 55000,
    ['salary_max']: 65000,
    ['salary_period']: 'year',
    organization: { name: company, slug: company.toLowerCase(), ['website_organization']: { slug: company.toLowerCase() } },
  };
  const innerJson = JSON.stringify({ queries: [{ state: { data: jobObject } }] });
  const outerLiteral = JSON.stringify(innerJson).slice(1, -1);
  return `<!doctype html><html><body><script>window.__INITIAL_DATA__ = "${outerLiteral}"\nwindow.__TRAILER__ = 1;</script></body></html>`;
}

function zeroDelayLimiter(): RateLimiter {
  return new RateLimiter({
    sourceName: 'welcomeToTheJungle',
    minDelayMs: 0,
    maxDelayMs: 0,
    respectRobotsTxt: false,
  });
}

describe('welcomeToTheJungle location short-circuit', () => {
  beforeEach(() => {
    resetSitemapIndexCacheForTests();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('treats work modes and non-covered places as unreachable, covered places as reachable', () => {
    expect(wttjLocationIsReachable('')).toBe(true);
    expect(wttjLocationIsReachable('Paris')).toBe(true);
    expect(wttjLocationIsReachable('Berlin, Germany')).toBe(true);
    expect(wttjLocationIsReachable('London')).toBe(true);
    expect(wttjLocationIsReachable('Remote')).toBe(false);
    expect(wttjLocationIsReachable('Hybrid')).toBe(false);
    expect(wttjLocationIsReachable('New York')).toBe(false);
    expect(wttjLocationIsReachable('San Francisco')).toBe(false);
    expect(wttjLocationIsReachable('Singapore')).toBe(false);
  });

  it('returns zero results without fetching anything for an unreachable location', async () => {
    const fetchStub = vi.fn();
    vi.stubGlobal('fetch', fetchStub);
    const adapter = new WelcomeToTheJungleAdapter(zeroDelayLimiter());

    await expect(adapter.search('senior platform engineer', 'Remote')).resolves.toEqual([]);
    await expect(adapter.search('senior platform engineer', 'New York')).resolves.toEqual([]);
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it('fetches the sitemap index once and returns a covered-location posting', async () => {
    const requested: string[] = [];
    const fetchStub = vi.fn(async (url: string) => {
      requested.push(url);
      if (url === indexUrl) {
        return new Response(gzipXml(`<sitemapindex><sitemap><loc>${jobSitemapUrl}</loc></sitemap></sitemapindex>`));
      }
      if (url === jobSitemapUrl) {
        return new Response(
          gzipXml(
            `<urlset><url><loc>https://www.welcometothejungle.com/en/companies/paransi/jobs/paris-senior-platform-engineer</loc></url></urlset>`,
          ),
        );
      }
      if (url.includes('/en/companies/paransi/jobs/')) {
        return new Response(detailHtml('paris-senior-platform-engineer', 'Senior Platform Engineer', 'Paransi'));
      }
      return new Response('', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchStub);
    const adapter = new WelcomeToTheJungleAdapter(zeroDelayLimiter());

    const first = await adapter.search('senior platform engineer', 'Paris');
    const second = await adapter.search('senior platform engineer', 'Paris');

    expect(first).toHaveLength(1);
    expect(first[0].companyName).toBe('Paransi');
    expect(first[0].location).toBe('Paris');
    expect(second).toHaveLength(1);
    expect(requested.filter((url) => url === indexUrl)).toHaveLength(1);
  });
});
