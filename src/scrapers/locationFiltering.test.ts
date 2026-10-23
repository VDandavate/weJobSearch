import { afterEach, describe, expect, it, vi } from 'vitest';
import { LinkedInAdapter } from './adapters/linkedinAdapter';
import { WellfoundAdapter } from './adapters/wellfoundAdapter';
import { RateLimiter } from './rateLimiter';

// Audit finding 14: two sources sent the requested location to the board but
// never enforced it, so `--location Remote` returned Singapore and on-site
// roles. These cases drive each adapter's public search seam with a mixed
// fixture and assert the post-filter keeps only matching postings.

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

function zeroDelayLimiter(sourceName: string): RateLimiter {
  return new RateLimiter({
    sourceName,
    minDelayMs: 0,
    maxDelayMs: 0,
    respectRobotsTxt: false,
  });
}

function linkedInCard(id: string, location: string): string {
  return (
    `<li data-entity-urn="urn:li:jobPosting:${id}" class="base-card base-card--link">` +
    `<a class="base-card__full-link" href="https://www.linkedin.com/jobs/view/${id}?trk=x"></a>` +
    `<div class="base-search-card__info">` +
    `<h3 class="base-search-card__title">Senior Engineer</h3>` +
    `<h4 class="base-search-card__subtitle"><a href="https://www.linkedin.com/company/acme">Acme</a></h4>` +
    `<div class="base-search-card__metadata"><span class="job-search-card__location">${location}</span>` +
    `<time class="job-search-card__listdate--new" datetime="2026-07-01">2 weeks ago</time></div></div></li>`
  );
}

function linkedInDetail(id: string, location: string): string {
  return (
    `<div class="top-card-layout__card"><h1 class="top-card-layout__title">Senior Engineer</h1>` +
    `<a class="topcard__org-name-link" href="https://www.linkedin.com/company/acme">Acme</a>` +
    `<span class="topcard__flavor topcard__flavor--bullet">${location}</span>` +
    `<div class="show-more-less-html__markup"><p>Build things with TypeScript.</p></div>` +
    `<a class="topcard__link" href="https://www.linkedin.com/jobs/apply/${id}">Apply</a></div>`
  );
}

function stubLinkedIn(): void {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('seeMoreJobPostings')) {
      return new Response(
        `<ul>${linkedInCard('111001', 'Remote')}${linkedInCard('111002', 'Singapore')}</ul>`,
        { status: 200 },
      );
    }
    if (url.endsWith('/111001')) {
      return new Response(linkedInDetail('111001', 'Remote'), { status: 200 });
    }
    if (url.endsWith('/111002')) {
      return new Response(linkedInDetail('111002', 'Singapore'), { status: 200 });
    }
    return new Response('missing', { status: 404 });
  }) as typeof fetch;
}

function wellfoundListingHtml(): string {
  return `<html><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
    props: {
      pageProps: {
        apolloState: {
          data: {
            ['ROOT_QUERY']: {
              talent: {
                'seoLandingPageJobSearchResults({"page":1})': {
                  startups: [{ __ref: 'StartupResult:START001' }],
                },
              },
            },
            'StartupResult:START001': {
              __typename: 'Startup',
              id: 'START001',
              name: 'ScaleForge',
              slug: 'scaleforge',
              highlightedJobListings: [
                { __ref: 'JobListingSearchResult:REMOTE' },
                { __ref: 'JobListingSearchResult:NY' },
              ],
            },
            'JobListingSearchResult:REMOTE': {
              __typename: 'JobListingSearchResult',
              id: '1',
              slug: 'senior-platform-engineer',
              title: 'Senior Platform Engineer',
              description: 'Build the platform with TypeScript.',
              locationNames: ['Anywhere'],
              remote: true,
              liveStartAt: 1780000000,
            },
            'JobListingSearchResult:NY': {
              __typename: 'JobListingSearchResult',
              id: '2',
              slug: 'platform-engineer',
              title: 'Senior Platform Engineer',
              description: 'Build the platform with TypeScript.',
              locationNames: ['New York'],
              remote: false,
              liveStartAt: 1780000000,
            },
          },
        },
      },
    },
  })}</script></html>`;
}

describe('location request enforcement (audit finding 14)', () => {
  it('LinkedIn keeps only remote postings for a Remote request', async () => {
    stubLinkedIn();
    const postings = await new LinkedInAdapter(zeroDelayLimiter('linkedin')).search(
      'engineer',
      'Remote',
    );
    expect(postings.map((posting) => posting.jobUrl)).toEqual([
      expect.stringContaining('111001'),
    ]);
  });

  it('LinkedIn keeps every posting when no location is requested', async () => {
    stubLinkedIn();
    const postings = await new LinkedInAdapter(zeroDelayLimiter('linkedin')).search('engineer', '');
    expect(postings).toHaveLength(2);
  });

  it('Wellfound keeps only remote postings for a Remote request', async () => {
    globalThis.fetch = (async () => new Response(wellfoundListingHtml(), { status: 200 })) as typeof fetch;
    const postings = await new WellfoundAdapter(zeroDelayLimiter('wellfound')).search(
      'engineer',
      'Remote',
    );
    expect(postings).toHaveLength(1);
    expect(postings[0].location).toContain('Remote');
  });

  it('Wellfound keeps only the city posting for a city request', async () => {
    globalThis.fetch = (async () => new Response(wellfoundListingHtml(), { status: 200 })) as typeof fetch;
    const postings = await new WellfoundAdapter(zeroDelayLimiter('wellfound')).search(
      'engineer',
      'New York',
    );
    expect(postings).toHaveLength(1);
    expect(postings[0].location).toBe('New York');
  });
});
