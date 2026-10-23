import { gunzipSync } from 'zlib';
import { HttpStatusError, type RateLimiter } from '../rateLimiter';
import { defaultRequestTimeoutMs as requestTimeoutMs } from '../requestTimeout';
import { scraperUserAgent } from '../userAgent';
import { fetchBoundedBytes, fetchBoundedText, maxSitemapResponseBytes } from '../httpFetcher';
import { cleanText, locationWorkMode, tokenize } from '../htmlUtils';
import type { RawPosting, SourceAdapter, SearchOptions } from '../jobSpyAdapter';

// Technique built fresh from direct site inspection (SDD Requirement 8, row 4)
// per the user's Step 3d decision, mirroring the hiring.cafe and Wellfound
// accepted-risk discipline. Welcome to the Jungle (WTTJ) offers no free public
// jobs API — the official Solutions API (developers.welcomekit.co) is
// employer-side and requires a token; third-party wrappers are paid. The job
// search frontend is a Next.js app whose Algolia index rejects non-site
// referers ("Method not allowed with this referer"), and defeating that guard
// by spoofing a referer would be a bot-detection bypass, which Section 1.4
// forbids. The honest, plain-HTTP data surface is instead:
//
//   - the robots-allowed `job-listings.{n}.xml.gz` sitemaps (declared in
//     robots.txt, gzip, ~10k URLs each), and
//   - server-rendered `/en/companies/{company}/jobs/{slug}` detail pages,
//     which embed the full structured job object (including salary amount AND
//     salary currency) in a double-serialized `window.__INITIAL_DATA__` blob
//     and as JSON-LD.
//
// Access posture (per the user's Step 3d decision):
//   - robots.txt allows the sitemaps, company pages, and job pages; only
//     `/me/*`, `/settings/*`, `/users/*`, `*/jobs?query=*`, and `/*?`
//     (query-string URLs) are disallowed, and this adapter builds no
//     query-string URLs, so `respectRobotsTxt` stays true.
//   - WTTJ's site CGUs (27 Apr 2026) explicitly prohibit scraping. Reading
//     public listings for a personal job search is treated as an accepted-risk
//     scrape per the user's Step 3d decision (hiring.cafe and Wellfound
//     discipline), using only public, unauthenticated pages over plain HTTP —
//     no login, no JS execution, no CAPTCHA/bot-detection bypass, and no
//     referer spoofing.
//   - Only a bounded prefix of sitemap entries and a bounded number of detail
//     pages are fetched per search; failures surface as HttpStatusError so the
//     shared rate limiter can back off / hard stop per source.
//
// This adapter captures salary alongside its currency: listings may be in EUR
// (WTTJ is a French-origin board), so the salary line with its currency is
// surfaced in `rawSalaryText`, unparsed and unconverted; compExtractor.ts
// (Step 4) normalizes currencies later — never converted here.
//
// Coverage note: WTTJ is EU/city-oriented. Job slugs carry a European city,
// not a US location or work mode, so `search` short-circuits before the
// sitemap scan when the requested location is a work mode or a place outside
// that coverage (see `wttjLocationIsReachable`). The sitemap index parse is
// cached for the process so repeated saved searches do not re-download it.
//
// Markup/JSON shape notes (observed 2026-08-08):
//   - Sitemap index lists `<sitemap><loc>...job-listings.{n}.xml.gz</loc></sitemap>`.
//   - Job sitemaps contain `<url><loc>https://www.welcometothejungle.com/en/companies/{company}/jobs/{slug}</loc><lastmod>...</lastmod></url>`.
//   - Detail pages ship `window.__INITIAL_DATA__ = "<json>"` where the literal
//     is a JS string serialized twice: parse the outer string literal once and
//     the resulting JSON string again to reach
//     `{ queries: [{ state: { data: { name, slug, office, offices, salary_*,
//     description, tools, organization, ... } } }] }`.
//   - Salary keys are `salary_currency`, `salary_min`/`salary_max` (detail) or
//     `salary_minimum`/`salary_maximum` (embedded related-job hits).
//   - Detail URLs rebuild as `/en/companies/{orgSlug}/jobs/{jobSlug}`.

export const welcomeToTheJungleBaseUrl = 'https://www.welcometothejungle.com';
export const sitemapIndexUrl = `${welcomeToTheJungleBaseUrl}/sitemaps/index.xml.gz`;

// Client-side filtering disclosure (Phase D): candidates come from the
// sitemap (substring pre-filter on the URL for location), and keywords plus
// the final location check run in memory after each detail fetch — the free
// surface offers no server-side query. The warning below is user-visible on
// every search. Table contracts unchanged.
export const welcomeToTheJungleClientSideFilterWarning =
  'welcomeToTheJungle: keyword and location filtering is client-side filtered (sitemap candidates plus substring location pre-filter, keywords matched in memory after each detail fetch).';

// Honest fallback for a posting with no office signal: 'unknown', never a
// blank string.
export const welcomeToTheJungleUnknownLocationLabel = 'unknown';

const maxSitemaps = 6;
const candidateCap = 60;
const maxPostings = 20;

// WTTJ job URLs are keyed by EU city slugs, so a work-mode request or a place
// outside its coverage cannot match any candidate. Short-circuiting before the
// sitemap scan keeps the slowest source from spending a minute and 25 MB to
// return nothing (audit finding 17). Unknown places still proceed: the
// adapter never guesses a non-match.
const wttjNonCoveredLocationTokens = new Set([
  'united', 'states', 'usa', 'us', 'america', 'canada', 'mexico', 'brazil',
  'india', 'singapore', 'australia', 'japan', 'china', 'israel', 'uae', 'dubai',
  'new', 'york', 'san', 'francisco', 'seattle', 'austin', 'boston', 'chicago',
  'angeles', 'toronto', 'vancouver', 'bengaluru', 'bangalore', 'hyderabad',
]);

// The sitemap index changes rarely, so parse it once per process instead of on
// every saved search. Only non-empty parses are cached, so a transient failure
// is retried rather than frozen as "no sitemaps" for the process lifetime.
const sitemapIndexCache = new Map<string, string[]>();

export function resetSitemapIndexCacheForTests(): void {
  sitemapIndexCache.clear();
}

export function wttjLocationIsReachable(location: string): boolean {
  const requested = location.trim();
  if (requested.length === 0) {
    return true;
  }
  if (locationWorkMode(requested) !== null) {
    return false;
  }
  return !tokenizeWttj(requested).some((token) => wttjNonCoveredLocationTokens.has(token));
}

export interface SitemapEntry {
  loc: string;
  lastmod: string | null;
}

export interface WttjOffice {
  address?: unknown;
  city?: unknown;
  countryCode?: unknown;
}

export interface WttjOrganization {
  name?: unknown;
  slug?: unknown;
  websiteOrgSlug?: unknown;
}

// Normalized (camelCase) view of a WTTJ job object. The site's raw detail
// payload uses snake_case keys; extractJobObject reads those external keys
// once and maps them here so the rest of the adapter stays dash-free per the
// naming rule. External payload keys are handled as bracket-string literals
// (wellfoundAdapter precedent).
export interface WttjJobData {
  name?: unknown;
  slug?: unknown;
  description?: unknown;
  publishedAt?: unknown;
  applyUrl?: unknown;
  contractType?: unknown;
  remote?: unknown;
  office?: WttjOffice;
  offices?: unknown;
  salaryCurrency?: unknown;
  salaryMin?: unknown;
  salaryMax?: unknown;
  salaryMinimum?: unknown;
  salaryMaximum?: unknown;
  salaryPeriod?: unknown;
  tools?: unknown;
  organization?: WttjOrganization;
}

function normalizeOffice(raw: unknown): WttjOffice | undefined {
  if (raw === null || typeof raw !== 'object') {
    return undefined;
  }
  const source = raw as Record<string, unknown>;
  const address = typeof source.address === 'string' ? source.address : undefined;
  const city = typeof source.city === 'string' ? source.city : undefined;
  const countryCode = typeof source['country_code'] === 'string' ? source['country_code'] : undefined;
  if (address === undefined && city === undefined && countryCode === undefined) {
    return undefined;
  }
  return { address, city, countryCode };
}

function normalizeOffices(raw: unknown): WttjOffice[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const offices: WttjOffice[] = [];
  for (const item of raw) {
    const office = normalizeOffice(item);
    if (office !== undefined) {
      offices.push(office);
    }
  }
  return offices;
}

function normalizeOrganization(raw: unknown): WttjOrganization | undefined {
  if (raw === null || typeof raw !== 'object') {
    return undefined;
  }
  const source = raw as Record<string, unknown>;
  const name = typeof source.name === 'string' ? source.name : undefined;
  const slug = typeof source.slug === 'string' ? source.slug : undefined;
  const websiteOrg = source['website_organization'];
  const websiteOrgSlug =
    websiteOrg !== null && typeof websiteOrg === 'object'
      ? (() => {
          const nested = websiteOrg as Record<string, unknown>;
          return typeof nested.slug === 'string' ? nested.slug : undefined;
        })()
      : undefined;
  if (name === undefined && slug === undefined && websiteOrgSlug === undefined) {
    return undefined;
  }
  return { name, slug, websiteOrgSlug };
}

export function parseSitemapIndexXml(xml: string): string[] {
  const sitemapUrls: string[] = [];
  const locRe = /<sitemap>[\s\S]*?<loc>([^<]+)<\/loc>[\s\S]*?<\/sitemap>/g;
  let match: RegExpExecArray | null;
  while ((match = locRe.exec(xml)) !== null) {
    const url = match[1].trim();
    if (url.includes('job-listings.') && url.endsWith('.xml.gz')) {
      sitemapUrls.push(url);
    }
  }
  return sitemapUrls;
}

export function parseJobSitemapXml(xml: string): SitemapEntry[] {
  const entries: SitemapEntry[] = [];
  const urlRe =
    /<url>[\s\S]*?<loc>([^<]+)<\/loc>[\s\S]*?(?:<lastmod>([^<]*)<\/lastmod>)?[\s\S]*?<\/url>/g;
  let match: RegExpExecArray | null;
  while ((match = urlRe.exec(xml)) !== null) {
    const lastmodRaw = match[2] === undefined ? '' : match[2];
    const lastmod = lastmodRaw.trim().length > 0 ? lastmodRaw.trim() : null;
    entries.push({ loc: match[1].trim(), lastmod });
  }
  return entries;
}

export function decodeGzipBuffer(buffer: Uint8Array): string {
  if (buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b) {
    return gunzipSync(buffer).toString('utf8');
  }
  return Buffer.from(buffer).toString('utf8');
}

// WTTJ text fields decode with the shared superset decoder (numeric character
// references included) in this source's historical strip-then-decode order.
function decodeText(value: unknown): string {
  return cleanText(value, { stripBeforeDecode: true });
}

function toNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

function tokenizeWttj(value: string): string[] {
  return tokenize(value, { dedupe: false });
}

function isEnglishDetailUrl(url: string): boolean {
  return url.includes('/jobs/') && url.includes(`${welcomeToTheJungleBaseUrl}/en/companies/`);
}

// Extract the first job object from a detail page's `window.__INITIAL_DATA__`
// blob and normalize its snake_case payload keys to the camelCase WttjJobData
// view. The literal is a JSON-encoded string whose value is itself a JSON
// document shaped `{ queries: [{ state: { data: <job> } }] }`. The JS string
// literal is delimited by a quote that follows `= ` (included in marker) and a
// quote that precedes the `\nwindow.__` trailer, which is why the raw slice is
// re-wrapped with an opening quote before parsing.
export function extractJobObject(html: string): WttjJobData | null {
  const marker = 'window.__INITIAL_DATA__ = "';
  const start = html.indexOf(marker);
  if (start === -1) {
    return null;
  }
  const tail = html.slice(start + marker.length);
  const terminator = '\nwindow.__';
  const end = tail.indexOf(terminator);
  const literal = end === -1 ? tail : tail.slice(0, end);
  let inner: string;
  try {
    inner = JSON.parse(`"${literal}`);
  } catch {
    return null;
  }
  let state: { queries?: Array<{ state?: { data?: unknown } }> };
  try {
    state = JSON.parse(inner);
  } catch {
    return null;
  }
  const queries = state.queries;
  if (!Array.isArray(queries)) {
    return null;
  }
  for (const query of queries) {
    const data = query.state?.data;
    if (data !== null && typeof data === 'object') {
      const raw = data as Record<string, unknown>;
      const organization = normalizeOrganization(raw.organization);
      if (
        typeof raw.name === 'string' &&
        typeof raw.slug === 'string' &&
        organization !== undefined
      ) {
        return {
          name: raw.name,
          slug: raw.slug,
          description: typeof raw.description === 'string' ? raw.description : undefined,
          publishedAt: typeof raw['published_at'] === 'string' ? raw['published_at'] : undefined,
          applyUrl: typeof raw['apply_url'] === 'string' ? raw['apply_url'] : undefined,
          contractType:
            typeof raw['contract_type'] === 'string' ? raw['contract_type'] : undefined,
          remote: typeof raw.remote === 'string' ? raw.remote : undefined,
          office: normalizeOffice(raw.office),
          offices: normalizeOffices(raw.offices),
          salaryCurrency:
            typeof raw['salary_currency'] === 'string' ? raw['salary_currency'] : undefined,
          salaryMin:
            typeof raw['salary_min'] === 'number' ? raw['salary_min'] : undefined,
          salaryMax:
            typeof raw['salary_max'] === 'number' ? raw['salary_max'] : undefined,
          salaryMinimum:
            typeof raw['salary_minimum'] === 'number' ? raw['salary_minimum'] : undefined,
          salaryMaximum:
            typeof raw['salary_maximum'] === 'number' ? raw['salary_maximum'] : undefined,
          salaryPeriod:
            typeof raw['salary_period'] === 'string' ? raw['salary_period'] : undefined,
          tools: raw.tools,
          organization,
        };
      }
    }
  }
  return null;
}

function formatSalaryLine(currency: unknown, min: unknown, max: unknown, period: unknown): string {
  const numericMin = toNumber(min);
  const numericMax = toNumber(max);
  if (numericMin === undefined && numericMax === undefined) {
    return '';
  }
  const currencyCode =
    typeof currency === 'string' && currency.trim().length > 0 ? currency.trim() : 'unknown';
  const range =
    numericMin !== undefined && numericMax !== undefined
      ? `${numericMin.toLocaleString()} - ${numericMax.toLocaleString()}`
      : `${(numericMin ?? numericMax)?.toLocaleString()}`;
  const periodLabel =
    period === 'monthly' ? 'per month' : period === 'weekly' ? 'per week' : period === 'hourly' ? 'per hour' : 'per year';
  return `Salary: ${currencyCode} ${range} (${periodLabel})`;
}

function formatLocation(office: WttjOffice | undefined, offices: unknown): string {
  if (office !== undefined) {
    const address = decodeText(office.address);
    if (address.length > 0) {
      return address;
    }
    const city = decodeText(office.city);
    const countryCode = decodeText(office.countryCode);
    if (city.length > 0 || countryCode.length > 0) {
      return [city, countryCode].filter((part) => part.length > 0).join(', ');
    }
  }
  if (Array.isArray(offices)) {
    const locationParts: string[] = [];
    for (const raw of offices) {
      const item = raw as WttjOffice | null | undefined;
      if (item === null || typeof item !== 'object') {
        continue;
      }
      const city = decodeText(item.city);
      const countryCode = decodeText(item.countryCode);
      const label = [city, countryCode].filter((part) => part.length > 0).join(', ');
      if (label.length > 0) {
        locationParts.push(label);
      }
    }
    if (locationParts.length > 0) {
      return locationParts.join('; ');
    }
  }
  return '';
}

export function jobToRawPosting(data: WttjJobData): RawPosting | null {
  const title = decodeText(data.name);
  const organization = data.organization ?? {};
  const companyName = decodeText(organization.name);
  const slug = decodeText(data.slug);
  const orgSlug = decodeText(organization.websiteOrgSlug) || decodeText(organization.slug);
  if (title.length === 0 || companyName.length === 0 || slug.length === 0 || orgSlug.length === 0) {
    return null;
  }

  const jobUrl = `${welcomeToTheJungleBaseUrl}/en/companies/${orgSlug}/jobs/${slug}`;
  const rawLocation = formatLocation(data.office, data.offices);
  const location = rawLocation.length > 0 ? rawLocation : welcomeToTheJungleUnknownLocationLabel;

  const descriptionParts: string[] = [];
  const description = decodeText(data.description);
  if (description.length > 0) {
    descriptionParts.push(description);
  }
  const salary = formatSalaryLine(
    data.salaryCurrency,
    data.salaryMin ?? data.salaryMinimum,
    data.salaryMax ?? data.salaryMaximum,
    data.salaryPeriod,
  );
  const remote = decodeText(data.remote);
  if (remote.length > 0 && remote !== 'unknown') {
    descriptionParts.push(`Remote: ${remote}`);
  }
  const contractType = decodeText(data.contractType);
  if (contractType.length > 0) {
    descriptionParts.push(`Contract: ${contractType}`);
  }
  const tools = Array.isArray(data.tools)
    ? data.tools
        .map((tool) => decodeText((tool as { name?: unknown }).name))
        .filter((tool) => tool.length > 0)
    : [];
  if (tools.length > 0) {
    descriptionParts.push(`Tools: ${tools.join(', ')}`);
  }
  const applyUrl = decodeText(data.applyUrl);
  if (applyUrl.length > 0) {
    descriptionParts.push(`Apply: ${applyUrl}`);
  }

  const publishedAt = decodeText(data.publishedAt);
  return {
    sourceAggregator: 'welcomeToTheJungle',
    companyName,
    roleTitle: title,
    location,
    jobUrl,
    description: descriptionParts.join('\n\n'),
    hasFullDescription: true,
    postedAt: publishedAt.length > 0 ? publishedAt : null,
    rawSalaryText: salary.length > 0 ? salary : undefined,
  };
}

export class WelcomeToTheJungleAdapter implements SourceAdapter {
  readonly sourceName = 'welcomeToTheJungle';

  private readonly limiter: RateLimiter;

  constructor(limiter: RateLimiter) {
    this.limiter = limiter;
  }

  async search(keywords: string, location: string, options?: SearchOptions): Promise<RawPosting[]> {
    console.warn(welcomeToTheJungleClientSideFilterWarning);
    if (!wttjLocationIsReachable(location)) {
      return [];
    }
    const keywordTokens = tokenizeWttj(keywords);
    const locationTokens = tokenizeWttj(location);
    const candidates = await this.collectCandidates(locationTokens);
    const postings: RawPosting[] = [];
    // Per-item isolation (C1): one 403/429 or malformed detail page costs that
    // URL, never the batch. Failures are skipped with a warning.
    for (const url of candidates) {
      if (postings.length >= maxPostings) {
        break;
      }
      let html: string;
      try {
        html = await this.fetchText(url);
      } catch (error) {
        console.warn(`welcomeToTheJungle: skipping detail ${url}: ${(error as Error).message}`);
        continue;
      }
      if (html.length === 0) {
        continue;
      }
      const job = extractJobObject(html);
      if (job === null) {
        continue;
      }
      const posting = jobToRawPosting(job);
      if (posting === null) {
        continue;
      }
      const searchableText = [posting.roleTitle, posting.companyName, posting.description]
        .join(' ')
        .toLowerCase();
      const matchesAllKeywords = keywordTokens.every((token) => searchableText.includes(token));
      if (!matchesAllKeywords) {
        continue;
      }
      const locationLabel = posting.location.toLowerCase();
      const matchesLocation = locationTokens.every((token) => locationLabel.includes(token));
      if (!matchesLocation) {
        continue;
      }
      postings.push(posting);
    }
    return postings;
  }

  // Registry detail-fetch for evaluate --jobUrl (SDD Section 4.1): claims only
  // welcometothejungle.com URLs, returns null otherwise so the registry keeps
  // routing. Uses the same server-rendered detail page and parser as search.
  canFetchPostingUrl(url: string): boolean {
    const hostname = new URL(url).hostname.toLowerCase();
    return (
      hostname === 'welcometothejungle.com' || hostname.endsWith('.welcometothejungle.com')
    );
  }

  async fetchPostingByUrl(url: string): Promise<RawPosting | null> {
    if (!this.canFetchPostingUrl(url)) {
      return null;
    }
    const html = await this.fetchText(url);
    if (html.length === 0) {
      return null;
    }
    const job = extractJobObject(html);
    if (job === null) {
      return null;
    }
    return jobToRawPosting(job);
  }

  private async collectCandidates(locationTokens: string[]): Promise<string[]> {
    let sitemapUrls = sitemapIndexCache.get(sitemapIndexUrl);
    if (sitemapUrls === undefined) {
      const sitemapXml = await this.fetchGzipText(sitemapIndexUrl);
      sitemapUrls = parseSitemapIndexXml(sitemapXml);
      if (sitemapUrls.length > 0) {
        sitemapIndexCache.set(sitemapIndexUrl, sitemapUrls);
      }
    }
    const candidates: string[] = [];
    for (const sitemapUrl of sitemapUrls.slice(0, maxSitemaps)) {
      if (candidates.length >= candidateCap) {
        break;
      }
      const xml = await this.fetchGzipText(sitemapUrl);
      const entries = parseJobSitemapXml(xml);
      for (const entry of entries) {
        if (candidates.length >= candidateCap) {
          break;
        }
        if (!isEnglishDetailUrl(entry.loc)) {
          continue;
        }
        const lower = entry.loc.toLowerCase();
        const locationMatchesUrl = locationTokens.every((token) => lower.includes(token));
        if (!locationMatchesUrl) {
          continue;
        }
        candidates.push(entry.loc);
      }
    }
    return candidates;
  }

  // Every request gates on the shared limiter: robots.txt policy check then a
  // jittered delay. A 404 yields '' so the caller treats it as "no data";
  // every other non-OK status throws HttpStatusError so the registry can
  // record the failure and back off (including any CloudFront edge rejection).
  private async fetchText(url: string): Promise<string> {
    await this.limiter.assertPathAllowed(url);
    await this.limiter.beforeRequest();
    return fetchBoundedText(url);
  }

  private async fetchGzipText(url: string): Promise<string> {
    await this.limiter.assertPathAllowed(url);
    await this.limiter.beforeRequest();
    const bytes = await fetchBoundedBytes(url, {
      maxBytes: maxSitemapResponseBytes,
      headers: { Accept: 'application/x-gzip,application/xml,text/xml,*/*' },
    });
    return bytes === null ? '' : decodeGzipBuffer(bytes);
  }
}