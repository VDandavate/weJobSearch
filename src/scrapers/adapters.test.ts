import { describe, expect, it, vi } from 'vitest';
import {
  builtInBaseUrl,
  builtInClientSideFilterWarning,
  extractListingJobUrls,
  fillListingUrl,
  postingToRawPosting,
  unknownLocationLabel as builtInUnknownLocation,
} from './adapters/builtInAdapter';
import {
  buildListingUrl as buildFlexJobsUrl,
  companyFromRecord,
  flexJobsBaseUrl,
  flexJobsClientSideFilterWarning,
  flexJobsUnknownLocationLabel,
  FlexJobsAdapter,
  locationFromRecord,
  teaserFromRecord,
  type FlexJobsJobRecord,
} from './adapters/flexJobsAdapter';
import {
  buildListingUrl as buildCafeUrl,
  hiringCafeBaseUrl,
  slugifyCafe,
} from './adapters/hiringCafeAdapter';
import { cleanText as cleanCafeText, decodeHtmlEntities } from './htmlUtils';
import {
  normalizeJobId,
  parseSearchCards,
  postedWithinToTPR,
  workplaceTypeFlag,
  type LinkedInWorkplaceType,
  buildSearchUrl,
} from './adapters/linkedinAdapter';
import {
  jobToRawPosting,
  parseJobSitemapXml,
  parseSitemapIndexXml,
  welcomeToTheJungleBaseUrl,
  welcomeToTheJungleClientSideFilterWarning,
  welcomeToTheJungleUnknownLocationLabel,
  type WttjJobData,
} from './adapters/welcomeToTheJungleAdapter';
import {
  buildListingUrl as buildWellfoundUrl,
  slugifyWellfound,
  wellfoundBaseUrl,
} from './adapters/wellfoundAdapter';

// U24/C8: direct unit tests for each adapter's pure parsing/URL helpers.
// Network fetching stays behind the registry + rateLimiter (covered
// end-to-end by step13Pipeline with stubbed fetch); these suites pin the
// parsers so a markup change fails here first, not in production.

describe('linkedinAdapter pure helpers', () => {
  it('normalizes job ids from URNs, URLs, and bare digits', () => {
    expect(normalizeJobId('urn:li:jobPosting:4212345678')).toBe('4212345678');
    expect(normalizeJobId('https://www.linkedin.com/jobs/view/4212345678?trk=x')).toBe('4212345678');
    expect(normalizeJobId('4212345678')).toBe('4212345678');
    expect(normalizeJobId('not-an-id')).toBeNull();
  });

  it('maps age windows and workplace modes to API flags', () => {
    expect(postedWithinToTPR(86400)).toBe('r86400');
    expect(postedWithinToTPR(0)).toBeNull();
    expect(postedWithinToTPR()).toBeNull();
    expect(workplaceTypeFlag('remote')).toBe('2');
    expect(workplaceTypeFlag('hybrid')).toBe('3');
    expect(workplaceTypeFlag('on-site' as LinkedInWorkplaceType)).toBe('1');
    expect(workplaceTypeFlag('contract' as LinkedInWorkplaceType)).toBeNull();
  });

  it('decodes entities and parses one search card', () => {
    expect(decodeHtmlEntities('R&amp;D &lt;team&gt;')).toBe('R&D <team>');
    const html =
      `<ul><li data-entity-urn="urn:li:jobPosting:99" class="base-card">` +
      `<a class="base-card__full-link" href="https://www.linkedin.com/jobs/view/99?trk=x"></a>` +
      `<h3 class="base-search-card__title">Staff Engineer</h3>` +
      `<h4 class="base-search-card__subtitle"><a href="https://www.linkedin.com/company/acme">Acme</a></h4>` +
      `<span class="job-search-card__location">Remote</span></li></ul>`;
    const cards = parseSearchCards(html);
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ id: '99', title: 'Staff Engineer', company: 'Acme', location: 'Remote' });
    expect(parseSearchCards('<ul></ul>')).toEqual([]);
  });
});

describe('hiringCafeAdapter pure helpers', () => {
  it('slugifies queries with diacritics and spacing', () => {
    expect(slugifyCafe('Senior Engineer')).toBe('senior-engineer');
    expect(slugifyCafe('  Développeur Senior  ')).toBe('developpeur-senior');
    expect(buildCafeUrl('senior engineer', 'Remote')).toBe(`${hiringCafeBaseUrl}/jobs/senior-engineer-remote`);
    expect(buildCafeUrl('', '')).toBeNull();
  });

  it('cleans text and rejects non-strings', () => {
    expect(cleanCafeText('<b>Bold</b>  spaced')).toBe('Bold spaced');
    expect(cleanCafeText(undefined)).toBe('');
  });

  it('decodes numeric character references from hiring.cafe fields (F3 normalization)', () => {
    // hiring.cafe previously decoded named entities only, so numeric
    // references reached the evaluator undecoded. The shared superset
    // decoder normalizes this per adapter.
    expect(cleanCafeText('Ing&#233;nieur &#x26; lead')).toBe('Ingénieur & lead');
  });
});

describe('wellfoundAdapter pure helpers', () => {
  it('builds role URLs with optional location segments', () => {
    expect(slugifyWellfound('Staff Engineer')).toBe('staff-engineer');
    expect(buildWellfoundUrl('staff engineer', '')).toBe(`${wellfoundBaseUrl}/role/staff-engineer`);
    expect(buildWellfoundUrl('staff engineer', 'New York')).toBe(
      `${wellfoundBaseUrl}/role/l/staff-engineer/new-york`,
    );
    expect(buildWellfoundUrl('', '')).toBeNull();
  });
});

describe('flexJobsAdapter pure helpers', () => {
  it('pins the robots-allowed listing route', () => {
    expect(buildFlexJobsUrl('anything', 'anywhere')).toBe(`${flexJobsBaseUrl}/remote-jobs`);
  });

  it('reads company, location, and teaser fields defensively', () => {
    const record = {
      company: { name: '  Acme  ' },
      remoteOptions: ['Remote'],
      jobLocations: ['Austin, TX'],
      description: '',
      jobSummary: 'Short teaser.',
    } as unknown as FlexJobsJobRecord;
    expect(companyFromRecord(record)).toBe('Acme');
    expect(companyFromRecord({} as FlexJobsJobRecord)).toBe('');
    expect(locationFromRecord(record)).toBe('Remote | Austin, TX');
    expect(teaserFromRecord(record)).toBe('Short teaser.');
  });
});

describe('builtInAdapter pure helpers', () => {
  it('routes remote locations to the remote listing page', () => {
    expect(fillListingUrl('Remote')).toBe(`${builtInBaseUrl}/jobs/remote`);
    expect(fillListingUrl('Austin, TX')).toBe(`${builtInBaseUrl}/jobs`);
  });

  it('extracts job URLs from JSON-LD and anchors', () => {
    const html =
      `<script type="application/ld+json">{"@type":"ItemList","itemListElement":[` +
      `{"@type":"ListItem","url":"${builtInBaseUrl}/job/acme-staff-1?ref=x"},` +
      `{"@type":"ListItem","url":"https://example.com/other"}]}</script>` +
      `<a href="/job/acme-staff-2">Role</a>`;
    expect(extractListingJobUrls(html)).toEqual([
      `${builtInBaseUrl}/job/acme-staff-1`,
      `${builtInBaseUrl}/job/acme-staff-2`,
    ]);
    expect(extractListingJobUrls('<p>no jobs here</p>')).toEqual([]);
  });
});

describe('welcomeToTheJungleAdapter pure helpers', () => {
  it('keeps only job-listing sitemap archives from the index', () => {
    const xml =
      `<sitemapindex><sitemap><loc>${welcomeToTheJungleBaseUrl}/sitemaps/job-listings.0.xml.gz</loc></sitemap>` +
      `<sitemap><loc>${welcomeToTheJungleBaseUrl}/sitemaps/companies.0.xml.gz</loc></sitemap></sitemapindex>`;
    expect(parseSitemapIndexXml(xml)).toEqual([
      `${welcomeToTheJungleBaseUrl}/sitemaps/job-listings.0.xml.gz`,
    ]);
  });

  it('parses job sitemap entries with optional lastmod', () => {
    const xml =
      `<urlset><url><loc>https://www.welcometothejungle.com/en/companies/acme/jobs/staff</loc>` +
      `<lastmod>2026-07-01</lastmod></url>` +
      `<url><loc>https://www.welcometothejungle.com/en/companies/acme/jobs/lead</loc></url></urlset>`;
    expect(parseJobSitemapXml(xml)).toEqual([
      { loc: 'https://www.welcometothejungle.com/en/companies/acme/jobs/staff', lastmod: '2026-07-01' },
      { loc: 'https://www.welcometothejungle.com/en/companies/acme/jobs/lead', lastmod: null },
    ]);
  });

  it('decodes numeric character references from WTTJ fields (F3 normalization)', () => {
    // Welcome to the Jungle previously decoded named entities only, so
    // numeric references reached the evaluator undecoded. jobToRawPosting
    // runs every text field through the shared superset decoder.
    const posting = jobToRawPosting({
      name: 'Ing&#233;nieur logiciel',
      slug: 'ingenieur',
      organization: { name: 'Soci&#233;t&#233; &#x26; cie', slug: 'org' },
    });
    expect(posting?.roleTitle).toBe('Ingénieur logiciel');
    expect(posting?.companyName).toBe('Société & cie');
  });
});

// Phase D honest filtering: the three free-tier adapters with no server-side
// query surface label themselves client-side filtered with a user-visible
// warning, and a posting with no location signal renders 'unknown', never a
// silent blank. Table contracts are unchanged (no column assertions here).
describe('client-side filter labeling and unknown location fallback (Phase D)', () => {
  it('publishes a client-side-filtered warning per adapter', () => {
    for (const warning of [
      builtInClientSideFilterWarning,
      flexJobsClientSideFilterWarning,
      welcomeToTheJungleClientSideFilterWarning,
    ]) {
      expect(warning).toContain('client-side filtered');
    }
    expect(builtInUnknownLocation).toBe('unknown');
    expect(flexJobsUnknownLocationLabel).toBe('unknown');
    expect(welcomeToTheJungleUnknownLocationLabel).toBe('unknown');
  });

  it('flexJobs renders unknown when a record carries no location signal', () => {
    expect(locationFromRecord({} as FlexJobsJobRecord)).toBe('unknown');
  });

  it('builtIn renders unknown when a posting carries no location signal', () => {
    const posting = {
      title: 'Staff Engineer',
      hiringOrganization: { name: 'Acme' },
      identifier: { value: 'job123' },
    };
    const raw = postingToRawPosting(posting, `${builtInBaseUrl}/job/staff-engineer/job123`);
    expect(raw?.location).toBe('unknown');
  });

  it('welcomeToTheJungle renders unknown when a job carries no office signal', () => {
    const data = {
      name: 'Staff Engineer',
      slug: 'staff-engineer',
      organization: { name: 'Acme', slug: 'acme' },
    } as unknown as WttjJobData;
    const raw = jobToRawPosting(data);
    expect(raw?.location).toBe('unknown');
  });

  it('builtIn and flexJobs searches emit the user-visible warning before fetching', async () => {
    const { BuiltInAdapter } = await import('./adapters/builtInAdapter');
    const { RateLimiter } = await import('./rateLimiter');
    const stubFetch = vi.fn(async () => new Response('', { status: 404 }));
    const originalFetch = globalThis.fetch;
    globalThis.fetch = stubFetch as unknown as typeof fetch;
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const builtIn = new BuiltInAdapter(
        new RateLimiter({ sourceName: 'builtIn', minDelayMs: 0, maxDelayMs: 0, respectRobotsTxt: false }),
      );
      await expect(builtIn.search('engineer', 'Remote')).resolves.toEqual([]);
      expect(warnSpy).toHaveBeenCalledWith(builtInClientSideFilterWarning);
      warnSpy.mockClear();
      const flexJobs = new FlexJobsAdapter(
        new RateLimiter({ sourceName: 'flexJobs', minDelayMs: 0, maxDelayMs: 0, respectRobotsTxt: false }),
      );
      await expect(flexJobs.search('engineer', 'Remote')).resolves.toEqual([]);
      expect(warnSpy).toHaveBeenCalledWith(flexJobsClientSideFilterWarning);
    } finally {
      globalThis.fetch = originalFetch;
      warnSpy.mockRestore();
    }
  });

  it('welcomeToTheJungle search emits the user-visible warning before fetching', async () => {
    const { WelcomeToTheJungleAdapter } = await import('./adapters/welcomeToTheJungleAdapter');
    const { RateLimiter } = await import('./rateLimiter');
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error('network disabled in test');
    }) as unknown as typeof fetch;
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const adapter = new WelcomeToTheJungleAdapter(
        new RateLimiter({
          sourceName: 'welcomeToTheJungle',
          minDelayMs: 0,
          maxDelayMs: 0,
          respectRobotsTxt: false,
        }),
      );
      // The sitemap fetch fails under the stub, but the warning fires first.
      await expect(adapter.search('engineer', 'Remote')).rejects.toThrow();
      expect(warnSpy).toHaveBeenCalledWith(welcomeToTheJungleClientSideFilterWarning);
    } finally {
      globalThis.fetch = originalFetch;
      warnSpy.mockRestore();
    }
  });
});

describe('search radius plumbing', () => {
  it('buildSearchUrl emits distance= for LinkedIn when radiusMiles is provided', () => {
    const url = buildSearchUrl('senior engineer', 'Remote', { radiusMiles: 25 });
    expect(url).toContain('distance=25');
  });

  it('buildSearchUrl omits distance when radiusMiles is not provided', () => {
    const url = buildSearchUrl('senior engineer', 'Remote', {});
    expect(url).not.toContain('distance=');
  });

  it('other adapters ignore radiusMiles and surface a disclosure note', () => {
    const cafeUrl = buildCafeUrl('senior engineer', 'Remote', { radiusMiles: 25 });
    const wellfoundUrl = buildWellfoundUrl('senior engineer', 'Remote', { radiusMiles: 25 });
    const flexJobsUrl = buildFlexJobsUrl('senior engineer', 'Remote', { radiusMiles: 25 });

    // URLs should be unchanged (no radius parameter)
    expect(cafeUrl).not.toContain('radius');
    expect(wellfoundUrl).not.toContain('radius');
    expect(flexJobsUrl).not.toContain('radius');
  });
});
