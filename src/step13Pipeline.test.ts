import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import {
  runSearchCommand,
  runReviewQueueCommand,
  runReportCommand,
  dispatchCli,
  evaluateJobPosting,
  searchJobPostings,
  confirmApplicationSubmission,
  getFunnelReport,
  getReviewQueue,
  logNetworkingContact,
  type ParsedSearchArgs,
} from './cli/jobSearchCore';
import { deduplicatePostings } from './dedup/postingDeduplicator';
import { JobSpyAdapterRegistry } from './scrapers/jobSpyAdapter';
import { RateLimiter } from './scrapers/rateLimiter';
import { LinkedInAdapter } from './scrapers/adapters/linkedinAdapter';
import { HiringCafeAdapter } from './scrapers/adapters/hiringCafeAdapter';
import { WellfoundAdapter } from './scrapers/adapters/wellfoundAdapter';
import { WelcomeToTheJungleAdapter } from './scrapers/adapters/welcomeToTheJungleAdapter';
import { BuiltInAdapter } from './scrapers/adapters/builtInAdapter';
import { FlexJobsAdapter } from './scrapers/adapters/flexJobsAdapter';
import { readApplicationHistory } from './utils/jobFunnelTracker';

// Step 13 end-to-end pipeline verification (AGENTS.md Step 13, SDD Section
// 6.3): drive the full search -> dedup -> evaluate -> persist -> format ->
// CLI-report pipeline through the real JobSpyAdapterRegistry and all six
// registered adapters, with global fetch stubbed to synthetic responses so no
// network request is ever made and no real source is contacted. All candidate
// data comes from fixtures/ (synthetic only, never profile/). The assertions
// cover: six-source execution, cross-source dedup, idempotent persistence,
// the fixed 7/6-column result-table contracts rendered by the real pipeline,
// evaluate --jobUrl idempotency, and the review-queue / funnel / confirm
// reporting surfaces (SDD Requirements 2a, 4, 6, 9).
//
// Ownership (Phase 7c): @standalone end-to-end verification. No source module
// exists by design (there is deliberately no src/step13Pipeline.ts): this
// file drives the real JobSpyAdapterRegistry, all six adapters, and the CLI
// reporting surfaces directly with stubbed fetch. If a step13Pipeline source
// module is ever created, replace this note with the consumer name instead of
// leaving both.

const keywords = 'senior platform engineer';
const location = 'Remote';

const fixturesRoot = resolve(__dirname, '..', 'fixtures');
const profilePath = resolve(fixturesRoot, 'sampleProfile.md');
const preferencesPath = resolve(fixturesRoot, 'sampleJobPreferences.yaml');

// ---------------------------------------------------------------------------
// Fetch stub: a deterministic router keyed on URL shape. Any unregistered URL
// 404s, which the adapters treat as "no data" (never a network call).
// ---------------------------------------------------------------------------

type RouteBody = string | Uint8Array;

interface Route {
  matches: (url: string) => boolean;
  body: RouteBody;
}

const routes: Route[] = [];

function route(matches: (url: string) => boolean, body: RouteBody): void {
  routes.push({ matches, body });
}

async function stubFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
  const matched = routes.find((candidate) => candidate.matches(url));
  if (matched === undefined) {
    return new Response('<html>not found</html>', { status: 404 });
  }
  return new Response(matched.body, { status: 200 });
}

const originalFetch = globalThis.fetch;

function installFetchStub(): void {
  routes.length = 0;
  globalThis.fetch = stubFetch as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  routes.length = 0;
});

// ---------------------------------------------------------------------------
// Synthetic fixture builders, matched to each adapter's parser.
// ---------------------------------------------------------------------------

function gzipXml(xml: string): Uint8Array {
  return gzipSync(Buffer.from(xml, 'utf8'));
}

function linkedInSearchHtml(cards: Array<{ id: string; title: string; company: string; location: string }>): string {
  const cardHtml = cards
    .map(
      (card) =>
        `<li data-entity-urn="urn:li:jobPosting:${card.id}" class="base-card base-card--link">` +
        `<a class="base-card__full-link" href="https://www.linkedin.com/jobs/view/${card.id}?trk=public_jobs_jserp-result_search-card"></a>` +
        `<div class="base-search-card__info">` +
        `<h3 class="base-search-card__title">${card.title}</h3>` +
        `<h4 class="base-search-card__subtitle"><a href="https://www.linkedin.com/company/${card.company.toLowerCase()}">${card.company}</a></h4>` +
        `<div class="base-search-card__metadata"><span class="job-search-card__location">${card.location}</span>` +
        `<time class="job-search-card__listdate--new" datetime="2026-07-01">2 weeks ago</time></div></div></li>`,
    )
    .join('\n');
  return `<ul class="jobs-search__results-list">${cardHtml}</ul>`;
}

function linkedInDetailHtml(
  id: string,
  title: string,
  company: string,
  location: string,
  descriptionHtml: string,
): string {
  return (
    `<div class="top-card-layout__card"><h1 class="top-card-layout__title">${title}</h1>` +
    `<a class="topcard__org-name-link" href="https://www.linkedin.com/company/${company.toLowerCase()}">${company}</a>` +
    `<span class="topcard__flavor topcard__flavor--bullet">${location}</span>` +
    `<div class="show-more-less-html__markup">${descriptionHtml}</div>` +
    `<a class="topcard__link" href="https://www.linkedin.com/jobs/apply/${id}">Apply</a></div>`
  );
}

function hiringCafeListingHtml(hits: unknown[]): string {
  const anchors = (hits as Array<{ requisitionId: string }>)
    .map((hit) => `<a href="/job/senior-platform-engineer-${hit.requisitionId}">Senior Platform Engineer</a>`)
    .join('');
  return (
    `<html><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
      props: { pageProps: { ssrHits: hits } },
    })}</script>${anchors}</html>`
  );
}

function wellfoundListingHtml(data: Record<string, unknown>): string {
  return (
    `<html><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
      props: { pageProps: { apolloState: { data } } },
    })}</script></html>`
  );
}

function wttjDetailHtml(jobObject: Record<string, unknown>): string {
  const innerJson = JSON.stringify({ queries: [{ state: { data: jobObject } }] });
  const outerLiteral = JSON.stringify(innerJson).slice(1, -1);
  return `<!doctype html><html><body><script>window.__INITIAL_DATA__ = "${outerLiteral}"\nwindow.__TRAILER__ = 1;</script></body></html>`;
}

function builtInListingHtml(): string {
  const ldJson = JSON.stringify({
    '@graph': [
      {
        '@type': 'ItemList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, url: 'https://builtin.com/job/senior-platform-engineer/circle-123' },
          { '@type': 'ListItem', position: 2, url: 'https://builtin.com/job/platform-engineer/helix-456' },
        ],
      },
    ],
  });
  return (
    `<html><script type="application/ld+json">${ldJson}</script>` +
    `<a href="/job/senior-platform-engineer/circle-123">CircleGrid</a>` +
    `<a href="/job/platform-engineer/helix-456">Helix</a></html>`
  );
}

function builtInDetailHtml(jobPosting: Record<string, unknown>): string {
  return `<html><script type="application/ld+json">${JSON.stringify(jobPosting)}</script></html>`;
}

function flexJobsListingHtml(records: unknown[]): string {
  return (
    `<html><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
      props: { pageProps: { jobs: records } },
    })}</script></html>`
  );
}

// ---------------------------------------------------------------------------
// Six-adapter registry with zero-delay rate limiters (still exercising the
// shared RateLimiter beforeRequest/recordSuccess path, minus wall-clock wait).
// ---------------------------------------------------------------------------

function buildRegistry(): JobSpyAdapterRegistry {
  const registry = new JobSpyAdapterRegistry();
  const zeroDelay = (sourceName: string): RateLimiter =>
    new RateLimiter({ sourceName, minDelayMs: 0, maxDelayMs: 0, respectRobotsTxt: false });
  registry.register(new HiringCafeAdapter(zeroDelay('hiringCafe')));
  registry.register(new WellfoundAdapter(zeroDelay('wellfound')));
  registry.register(new WelcomeToTheJungleAdapter(zeroDelay('welcomeToTheJungle')));
  registry.register(new BuiltInAdapter(zeroDelay('builtIn')));
  registry.register(new FlexJobsAdapter(zeroDelay('flexJobs')));
  registry.register(new LinkedInAdapter(zeroDelay('linkedin')));
  return registry;
}

function installSearchRoutes(): void {
  // LinkedIn: search listing + one detail (duplicates hiring.cafe hit #2).
  route(
    (url) => url.startsWith('https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search'),
    linkedInSearchHtml([{ id: '222001', title: 'Senior Platform Engineer', company: 'LevelUpLabs', location: 'Remote' }]),
  );
  route(
    (url) => url.startsWith('https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/222001'),
    linkedInDetailHtml(
      '222001',
      'Senior Platform Engineer',
      'LevelUpLabs',
      'Remote',
      '<p>We build the platform that powers our customer base.</p><ul><li>TypeScript</li><li>Kubernetes</li><li>AWS</li></ul>',
    ),
  );

  // A standalone LinkedIn detail page (not part of any search listing) used by
  // the evaluate --jobUrl path and the reviewQueue/funnel tests.
  route(
    (url) => url.startsWith('https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/4789653'),
    linkedInDetailHtml(
      '4789653',
      'Senior Platform Engineer',
      'FoggyNow',
      'Remote',
      '<p>FoggyNow is building a green logistics platform.</p><ul><li>Python</li><li>Docker</li></ul>',
    ),
  );

  // hiring.cafe: two hits (AcmeVent strong fit; LevelUpLabs cross-source dup).
  route(
    (url) => url === 'https://hiring.cafe/jobs/senior-platform-engineer-remote',
    hiringCafeListingHtml([
      {
        requisitionId: 'abc123',
        jobInformation: {
          title: 'Senior Backend Engineer',
          description: '<p>We build a payments platform used by millions.</p>',
        },
        v6ProcessedJobData: {
          coreJobTitle: 'Senior Backend Engineer',
          companyName: 'AcmeVent',
          formattedWorkplaceLocation: 'Remote',
          listedCompensationCurrency: 'USD',
          listedCompensationFrequency: 'yearly',
          yearlyMinCompensation: 165000,
          yearlyMaxCompensation: 190000,
          requirementsSummary: '<p>TypeScript Python Kubernetes and AWS. 6+ years experience required.</p>',
          technicalTools: ['TypeScript', 'Python', 'Kubernetes', 'AWS'],
        },
        enrichedCompanyData: { name: 'AcmeVent' },
        hcMetaDescription: 'Senior Backend Engineer at AcmeVent (Remote).',
      },
      {
        requisitionId: 'def456',
        jobInformation: {
          title: 'Senior Platform Engineer',
          description: '<p>Core platform infrastructure team.</p>',
        },
        v6ProcessedJobData: {
          coreJobTitle: 'Senior Platform Engineer',
          companyName: 'LevelUpLabs',
          formattedWorkplaceLocation: 'Remote',
          listedCompensationCurrency: 'USD',
          listedCompensationFrequency: 'yearly',
          yearlyMinCompensation: 175000,
          yearlyMaxCompensation: 195000,
          requirementsSummary: '<p>TypeScript Kubernetes AWS React and Node.js.</p>',
          technicalTools: ['TypeScript', 'Kubernetes', 'AWS', 'React', 'Node.js'],
        },
        enrichedCompanyData: { name: 'LevelUpLabs' },
        hcMetaDescription: 'Senior Platform Engineer at LevelUpLabs (Remote).',
      },
    ]),
  );

  // Wellfound: one startup with one highlighted job (no rawSalaryText).
  route(
    (url) => url.startsWith('https://wellfound.com/role/l/senior-platform-engineer/remote'),
    wellfoundListingHtml({
      ['ROOT_QUERY']: {
        talent: {
          'seoLandingPageJobSearchResults({"page":1})': { startups: [{ __ref: 'StartupResult:START001' }] },
        },
      },
      'StartupResult:START001': {
        __typename: 'Startup',
        id: 'START001',
        name: 'ScaleForge',
        slug: 'scaleforge',
        highlightedJobListings: [{ __ref: 'JobListingSearchResult:JOB001' }],
      },
      'JobListingSearchResult:JOB001': {
        __typename: 'JobListingSearchResult',
        id: '1',
        slug: 'senior-platform-engineer',
        title: 'Senior Platform Engineer',
        description: 'Build the platform with TypeScript Kubernetes AWS and React.',
        compensation: '$200k – $230k',
        jobType: 'full-time',
        locationNames: ['Anywhere'],
        remote: true,
        liveStartAt: 1780000000,
      },
    }),
  );

  // Welcome to the Jungle: sitemap index -> one job sitemap -> one detail page
  // whose salary is EUR. The EUR salary is incomparable to the USD-configured
  // minimum (currency-mismatch manualReview) only when a compensation
  // nonNegotiable is configured; this pipeline runs neutral v0.2.1 defaults
  // with empty nonNegotiables, so the compensation rule is never evaluated and
  // the posting proves the EUR fixture parses end to end as strongFit.
  route(
    (url) => url === 'https://www.welcometothejungle.com/sitemaps/index.xml.gz',
    gzipXml(
      '<sitemapindex><sitemap><loc>https://www.welcometothejungle.com/sitemaps/job-listings.1.xml.gz</loc></sitemap></sitemapindex>',
    ),
  );
  route(
    (url) => url === 'https://www.welcometothejungle.com/sitemaps/job-listings.1.xml.gz',
    gzipXml(
      '<urlset><url><loc>https://www.welcometothejungle.com/en/companies/paransi/jobs/remote-senior-platform-engineer</loc><lastmod>2026-07-01</lastmod></url></urlset>',
    ),
  );
  route(
    (url) => url.includes('/en/companies/paransi/jobs/'),
    wttjDetailHtml({
      name: 'Senior Platform Engineer',
      slug: 'remote-senior-platform-engineer',
      description: 'We are looking for a Senior Platform Engineer to join the platform team.',
      ['published_at']: '2026-07-01T00:00:00Z',
      remote: 'Full remote',
      ['contract_type']: 'CDI',
      office: { address: 'Remote' },
      ['salary_currency']: 'EUR',
      ['salary_min']: 55000,
      ['salary_max']: 65000,
      ['salary_period']: 'year',
      organization: { name: 'Paransi', slug: 'paransi', ['website_organization']: { slug: 'paransi' } },
    }),
  );

  // Built In: one listing with two job anchors; one strong USD-paid detail,
  // one weak-fit detail (missing Swift + Healthcare domain, still USD-paid so
  // it stays excluded weakFit rather than rerouted to manualReview).
  route((url) => url === 'https://builtin.com/jobs/remote', builtInListingHtml());
  route(
    (url) => url === 'https://builtin.com/job/senior-platform-engineer/circle-123',
    builtInDetailHtml({
      '@context': 'https://schema.org/',
      '@type': 'JobPosting',
      title: 'Senior Platform Engineer',
      hiringOrganization: { name: 'CircleGrid' },
      jobLocationType: 'TELECOMMUTE',
      jobLocation: { address: { addressLocality: '', addressRegion: '', addressCountry: 'USA' } },
      description: '<p>Build and operate our cloud platform using TypeScript Kubernetes and AWS.</p>',
      baseSalary: { currency: 'USD', value: { minValue: 170000, maxValue: 200000, unitText: 'YEAR' } },
      datePosted: '2026-07-01',
      identifier: { name: 'CircleGrid', value: 'circle-123' },
    }),
  );
  route(
    (url) => url === 'https://builtin.com/job/platform-engineer/helix-456',
    builtInDetailHtml({
      '@context': 'https://schema.org/',
      '@type': 'JobPosting',
      title: 'Senior Platform Engineer',
      hiringOrganization: { name: 'Helix' },
      jobLocationType: 'TELECOMMUTE',
      jobLocation: { address: { addressLocality: '', addressRegion: '', addressCountry: 'USA' } },
      description: '<p>Healthcare platform. Build with Swift for our client teams.</p>',
      baseSalary: { currency: 'USD', value: { minValue: 150000, maxValue: 160000, unitText: 'YEAR' } },
      datePosted: '2026-07-01',
      identifier: { name: 'Helix', value: 'helix-456' },
    }),
  );

  // FlexJobs: teaser-only listing page with one strong fit and one
  // staffing-agency posting (hard-rejected by the employerType rule).
  route(
    (url) => url === 'https://www.flexjobs.com/remote-jobs',
    flexJobsListingHtml([
      {
        title: 'Senior Platform Engineer',
        slug: 'nimbus-senior-platform-engineer',
        description: 'NimbusCore is hiring a Senior Platform Engineer to build and operate our cloud platform using TypeScript, Kubernetes, AWS, and React.',
        jobSummary: 'NimbusCore is hiring a Senior Platform Engineer to build and operate our cloud platform using TypeScript, Kubernetes, AWS, and React.',
        postedDate: '2026-07-01',
        remoteOptions: ['Remote'],
        jobSchedules: ['Full-time'],
        jobTypes: ['Full-time'],
        salaryRange: 'USD 155,000 - 185,000 Annually',
        company: { name: 'NimbusCore', companyId: 'NB1', slug: 'nimbuscore' },
      },
      {
        title: 'Senior Platform Engineer',
        slug: 'brightstaffing-senior-platform-engineer',
        description: 'BrightStaffing is a staffing agency hiring Senior Platform Engineers for client engagements.',
        jobSummary: 'BrightStaffing is a staffing agency hiring Senior Platform Engineers for client engagements.',
        postedDate: '2026-07-02',
        remoteOptions: ['Remote'],
        jobSchedules: ['Full-time'],
        jobTypes: ['Contract'],
        company: { name: 'BrightStaffing', companyId: 'BS1', slug: 'brightstaffing' },
      },
    ]),
  );
}

async function makeRunDirectory(): Promise<{
  historyPath: string;
  contactsPath: string;
  searchHistoryPath: string;
}> {
  const dir = await mkdtemp(join(tmpdir(), 'wejobsearch-step13-'));
  process.env.WEJOBSEARCHDATAROOT = dir;
  await writeFile(join(dir, 'masterProfile.md'), await readFile(profilePath, 'utf8'), 'utf8');
  await writeFile(join(dir, 'jobPreferences.yaml'), await readFile(preferencesPath, 'utf8'), 'utf8');
  return {
    historyPath: join(dir, 'applications', 'applicationHistory.json'),
    contactsPath: join(dir, 'networkingContacts.json'),
    searchHistoryPath: join(dir, 'searchHistory.json'),
  };
}

async function installContacts(contactsPath: string): Promise<void> {
  await writeFile(
    contactsPath,
    `${JSON.stringify({ contacts: [] }, null, 2)}\n`,
    'utf8',
  );
}

describe('step 13: six-adapter end-to-end pipeline against fixtures (no network)', () => {
  it('runs every registered adapter through registry.searchAll and evaluates unique postings', async () => {
    installFetchStub();
    installSearchRoutes();
    const { historyPath, searchHistoryPath } = await makeRunDirectory();
    const registry = buildRegistry();

    const outcome = await searchJobPostings(keywords, location, {
      registry,
    });

    // Every one of the six registered sources produced postings.
    expect(outcome.results).toHaveLength(6);
    expect(outcome.results.map((source) => source.sourceName).sort()).toEqual(
      ['builtIn', 'flexJobs', 'hiringCafe', 'linkedin', 'welcomeToTheJungle', 'wellfound'],
    );
    for (const source of outcome.results) {
      expect(source.error).toBeNull();
      expect(source.postings.length).toBeGreaterThan(0);
    }

    // The six sources returned 9 raw postings; dedup collapses the LevelUpLabs
    // duplicate (hiring.cafe + linkedin) into one unique posting.
    const rawCount = outcome.results.reduce((total, source) => total + source.postings.length, 0);
    expect(rawCount).toBe(9);
    expect(outcome.entries).toHaveLength(8);

    const leveledUp = outcome.entries.find((entry) => entry.posting.companyName === 'LevelUpLabs');
    expect(leveledUp).toBeDefined();

    // Dedup evidence against an empty history: the 9 raw postings collapse to
    // 8 unique + 1 within-batch merge across hiringCafe and linkedin. A fresh
    // empty history file in the SAME run directory (the history used by
    // searchJobPostings already contains those records, and the directory is
    // the confined data root for this test).
    const runDir = process.env.WEJOBSEARCHDATAROOT as string;
    const dedupHistoryPath = join(runDir, 'emptyHistory.json');
    await writeFile(dedupHistoryPath, JSON.stringify({ applications: [] }), 'utf8');
    const rawPostings = outcome.results.flatMap((source) => source.postings);
    const { uniquePostings, mergedPostings } = await deduplicatePostings(rawPostings, { historyPath: dedupHistoryPath });
    expect(uniquePostings).toHaveLength(8);
    expect(mergedPostings).toHaveLength(1);
    const levelUpMerge = mergedPostings.find((merge) => merge.companyName === 'LevelUpLabs');
    expect(levelUpMerge?.sourceAggregators).toEqual(expect.arrayContaining(['linkedin', 'hiringCafe']))

    // Fixed table contracts rendered from the real pipeline output: exact
    // 7-column active and 6-column excluded cores with no trailing extras
    // (SDD Requirement 2a).
    expect([...outcome.activeResults.columns]).toEqual([
      'Sr. No.',
      'Job Title',
      'Organization',
      'Brief',
      'Fit Score',
      'Justification',
      'Link',
    ]);
    expect([...outcome.excludedResults.columns]).toEqual([
      'Sr. No.',
      'Job Title',
      'Organization',
      'Fit Score',
      'Justification',
      'Link',
    ]);

    // Expected spread across the score bands (SDD Requirement 2 table) under
    // neutral v0.2.1 defaults: fixtures/sampleJobPreferences.yaml ships empty
    // nonNegotiables + empty preferredLocations, and an 'unknown' location
    // never rejects — so the hard-rejection gate, the salary routing, and the
    // staffing-agency rule all stay silent. Only Helix (posting-only Swift +
    // Healthcare domain) drops out on deductions.
    const byCompany = new Map(outcome.entries.map((entry) => [entry.posting.companyName, entry.assessment.fitStatus]));
    expect(byCompany.get('AcmeVent')).toBe('strongFit');
    expect(byCompany.get('LevelUpLabs')).toBe('strongFit');
    expect(byCompany.get('CircleGrid')).toBe('strongFit');
    expect(byCompany.get('NimbusCore')).toBe('strongFit');
    expect(byCompany.get('Paransi')).toBe('strongFit');
    expect(byCompany.get('ScaleForge')).toBe('strongFit');
    expect(byCompany.get('BrightStaffing')).toBe('strongFit');
    expect(byCompany.get('Helix')).toBe('weakFit');

    expect(outcome.activeResults.rows).toHaveLength(7);
    expect(outcome.excludedResults.rows).toHaveLength(1);

    // Persistence: every unique posting logged with status evaluated.
    const history = await readApplicationHistory();
    expect(history.applications).toHaveLength(8);
    for (const record of history.applications) {
      expect(record.status).toBe('evaluated');
      expect(record.fitScore).toBeGreaterThanOrEqual(0);
    }

    // Cross-source aggregation survived into history for the merged posting.
    const levelUpRecord = history.applications.find((record) => record.companyName === 'LevelUpLabs');
    expect(levelUpRecord?.sourceAggregators).toEqual(expect.arrayContaining(['hiringCafe', 'linkedin']));
  });

  it('reruns the same search idempotently: no duplicate records, counts stable', async () => {
    installFetchStub();
    installSearchRoutes();
    const { historyPath, searchHistoryPath } = await makeRunDirectory();
    const registry = buildRegistry();

    const deps = { registry, profilePath, preferencesPath, historyPath, searchHistoryPath };

    const first = await searchJobPostings(keywords, location, deps);
    expect(first.newRecords).toBe(8);
    expect(first.alreadyRecorded).toBe(0);

    const second = await searchJobPostings(keywords, location, deps);
    expect(second.newRecords).toBe(0);
    expect(second.alreadyRecorded).toBe(8);
    expect(second.entries).toHaveLength(8);

    const history = await readApplicationHistory();
    expect(history.applications).toHaveLength(8);
    expect(second.activeResults.rows).toEqual(first.activeResults.rows);
    expect(second.excludedResults.rows).toEqual(first.excludedResults.rows);
  });

  it('evaluates a single posting by URL through the registry and stays idempotent', async () => {
    installFetchStub();
    installSearchRoutes();
    const { historyPath } = await makeRunDirectory();
    const registry = buildRegistry();

    const first = await evaluateJobPosting('https://www.linkedin.com/jobs/view/4789653', {
      registry,
    });
    expect(first.posting.companyName).toBe('FoggyNow');
    expect(first.alreadyRecorded).toBe(false);
    expect(first.record.status).toBe('evaluated');

    const historyAfterFirst = await readApplicationHistory();
    expect(historyAfterFirst.applications).toHaveLength(1);

    const second = await evaluateJobPosting('https://www.linkedin.com/jobs/view/4789653', {
      registry,
    });
    expect(second.alreadyRecorded).toBe(true);
    expect(second.record.companyName).toBe('FoggyNow');

    const historyAfterSecond = await readApplicationHistory();
    expect(historyAfterSecond.applications).toHaveLength(1);
  }, 15000);

  it('runSearchCommand renders both fixed tables plus the per-source summary', async () => {
    installFetchStub();
    installSearchRoutes();
    const { historyPath, searchHistoryPath } = await makeRunDirectory();
    const registry = buildRegistry();

    const args: ParsedSearchArgs = {
      keywords,
      location,
registry,
       help: false,
    };
    const result = await runSearchCommand(args);
    expect(result.exitCode).toBe(0);

    const joined = result.printedLines.join('\n');
    expect(joined).toContain('Sources: hiringCafe, wellfound, welcomeToTheJungle, builtIn, flexJobs, linkedin.');
    expect(joined).toContain('Active results:');
    expect(joined).toContain('Excluded results:');
    expect(joined).toContain('| Sr. No. | Job Title | Organization | Brief | Fit Score | Justification | Link |');
    expect(joined).toContain('| Sr. No. | Job Title | Organization | Fit Score | Justification | Link |');
    expect(joined).toContain('AcmeVent');
    expect(joined).toContain('Paransi');
  });

  it('reviewQueue, report, and confirmApp surface the persisted pipeline output', async () => {
    installFetchStub();
    installSearchRoutes();
    const { historyPath, contactsPath, searchHistoryPath } = await makeRunDirectory();
    await installContacts(contactsPath);
    const registry = buildRegistry();

    const deps = { registry, profilePath, preferencesPath, historyPath, searchHistoryPath };
    await searchJobPostings(keywords, location, deps);
    await evaluateJobPosting('https://www.linkedin.com/jobs/view/4789653', {
      registry,
    });

    // reviewQueue lists every manualReview application. Under neutral v0.2.1
    // defaults (empty nonNegotiables, 'unknown' location never rejects) no
    // stubbed posting routes to manualReview — FoggyNow included (its Python
    // + Docker requirements are both in the fixture profile) — so the queue
    // is correctly empty rather than listing Paransi/ScaleForge/FoggyNow.
    const queue = await getReviewQueue();
    expect(queue).toEqual([]);
    const queueCommand = await runReviewQueueCommand({ help: false });
    expect(queueCommand.exitCode).toBe(0);
    expect(queueCommand.printedLines.join('\n')).toContain('manualReview');

    // A referral contact linked to the AcmeVent application.
    await logNetworkingContact('Jane Sample', 'AcmeVent', 'formerColleague', {
      linkedApplicationIds: ['app2026AcmeVentSeniorBackendEngineer'],
    });

    // confirmApplicationSubmission moves one evaluated record forward.
    const confirmed = await confirmApplicationSubmission('AcmeVent', 'Senior Backend Engineer', 'Submitted via Greenhouse portal');
    expect(confirmed.record.status).toBe('appliedConfirmed');
    const confirmedAgain = await confirmApplicationSubmission('AcmeVent', 'Senior Backend Engineer', 'again', {
    });
    expect(confirmedAgain.alreadyConfirmed).toBe(true);

    // The funnel report reflects all of it (SDD Requirement 9): 8 searched
    // postings + FoggyNow, all strongFit except Helix (weakFit on deductions).
    const report = await getFunnelReport({ historyPath, contactsPath, searchHistoryPath });
    expect(report.totalApplications).toBe(9);
    expect(report.statusCounts.appliedConfirmed).toBe(1);
    expect(report.fitStatusCounts.strongFit).toBe(8);
    expect(report.fitStatusCounts.manualReview).toBe(0);
    expect(report.fitStatusCounts.hardRejected).toBe(0);
    expect(report.fitStatusCounts.weakFit).toBe(1);
    expect(report.awaitingManualReview).toEqual([]);
    expect(report.referralConversion.referralLinked.evaluated).toBe(1);

    const reportCommand = await runReportCommand({
      format: 'table',
      help: false,
    });
    expect(reportCommand.exitCode).toBe(0);
    expect(reportCommand.printedLines.join('\n')).toContain('appliedConfirmed');

    // Fresh history file still validates after all writes.
    await readApplicationHistory();
    const contacts = await readFile(contactsPath, 'utf8');
    expect(JSON.parse(contacts).contacts).toHaveLength(1);
  });

  it('the CLI with no subcommand only presents a menu and chains nothing', async () => {
    const result = await dispatchCli([]);
    expect(result.exitCode).toBe(0);
    const joined = result.printedLines.join('\n');
    expect(joined).toContain('search');
    expect(joined).toContain('evaluate');
    expect(joined).toContain('report');
    expect(joined).toContain('reviewQueue');
  });
});
