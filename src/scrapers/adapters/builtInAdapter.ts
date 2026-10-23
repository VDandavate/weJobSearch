import { type RateLimiter } from '../rateLimiter';
import { fetchBoundedText } from '../httpFetcher';
import { cleanText, decodeHtmlEntities, tokenize, trimText } from '../htmlUtils';
import type { RawPosting, SourceAdapter, SearchOptions } from '../jobSpyAdapter';

// Technique built fresh from direct site inspection (SDD Requirement 8, row 5)
// using the same discipline as the hiring.cafe, Wellfound and Welcome to the
// Jungle adapters. The SDD Step 0 acquisition confirmed no portable Built In
// logic exists in .reference/aiJobSearch (only generic "built-in guidance"
// phrasing in add-template.md), so this is built from scratch per SDD Section
// 1.3.
//
// Built In (builtin.com) offers no public jobs API — its "Standard JSON Feed"
// spec (knowledgebase.builtin.com) is an employer-side push channel, not a
// consumer endpoint. The listing and detail pages are Drupal server-rendered
// pages that embed structured JSON-LD, which is the honest plain-HTTP surface:
//
//   - Listing pages (`/jobs`, `/jobs/...`) ship a schema.org `ItemList`
//     JSON-LD (`itemListElement[].url`) plus literal `href="/job/{slug}/{id}"`
//     anchors; the canonical job URLs are reconstructed from those anchors.
//   - Detail pages `/job/{slug}/{id}` ship a full schema.org `JobPosting`
//     JSON-LD with title, HTML description, `datePosted`, `validThrough`,
//     `employmentType`, `directApply`, `identifier.value`, `jobLocationType`
//     (e.g. TELECOMMUTE/ONSITE/HYBRID), `applicantLocationRequirements`,
//     `hiringOrganization.name`, and — when advertised — `baseSalary`
//     (`currency` + `value.minValue/maxValue/unitText`).
//
// Access posture (per the user's Step 3e decision, mirroring steps 3b-3d):
//   - Built In's Community Terms of Use (May 23, 2025) Section 3(f) explicitly
//     prohibits accessing the Site through "bots, spiders, scrapers, web
//     crawlers, indexing agents or other automated devices". Reading public
//     listings for a personal job search is treated as an accepted-risk scrape
//     per the user's explicit sign-off. This adapter uses only public,
//     unauthenticated, server-rendered pages over plain HTTP (no login, no
//     session, no JS execution, no CAPTCHA/bot-detection bypass).
//   - robots.txt is respected: only `/jobs` and `/job/{slug}/{id}` paths that
//     are not disallowed are fetched. We never build the robots-blocked
//     `?search=` query URLs or the metro-hub listing directories robots
//     disallows (e.g. `/jobs* seattle`, `/jobs* chicago`); the shared rate
//     limiter's `assertPathAllowed` gate also enforces robots.txt before every
//     request.
//   - Listing candidates come from a bounded, robots-allowed listing page, not
//     from a crawl of sitemap.xml (sitemaps declare only listing pages, never
//     forward `/job/{slug}/{id}` detail URLs). We fetch only the one listing
//     URL we build and a bounded prefix of its job cards (up to `candidateCap`
//     anchors, then at most `maxPostings` detail fetches). Failures surface as
//     HttpStatusError so the shared limiter can back off / hard stop per
//     source.
//
// Markup/JSON shape notes (observed 2026-08-08 via bounded plain-HTTP GETs):
//   - The `application/ld+json` script marker is HTML-entity-encoded in the raw
//     DOM as `application/ld&#x2B;json`; decode entities before matching.
//   - Listing JSON-LD: `{ "@graph": [ { "@type":"ItemList", ...,
//     "itemListElement":[ { "@type":"ListItem", "position":1, "name":...,
//     "url":"https://builtin.com/job/{slug}/{id}", ... } ... ] } ] }`.
//   - Detail JSON-LD (JobPosting, inside `@graph` or top-level):
//       "identifier": { "name": "<company>", "value": "<jobId>" }
//       "jobLocation": { "address": { "addressLocality":"...",
//         "addressRegion":"...", "addressCountry":"USA" } }
//       "applicantLocationRequirements": { "name":"USA" }
//       "baseSalary": { "currency": "USD", "value": { "minValue":120000,
//         "maxValue":225000, "unitText":"YEAR" } }
//     Salary is optional: postings that don't advertise it omit baseSalary and
//     we leave rawSalaryText unset.

export const builtInBaseUrl = 'https://builtin.com';

// Client-side filtering disclosure (Phase D): the free listing surface offers
// no server-side keyword or location filtering (robots-allowed listing pages
// only, never the disallowed ?search= query URLs), so search() fetches the
// remote-only listing plus a bounded prefix of detail pages and filters
// keywords/location in memory. The warning below is user-visible on every
// search so a narrowed result set is never mistaken for a server-side query.
// The fixed scrape-result table contracts are unchanged.
export const builtInClientSideFilterWarning =
  'builtIn: keyword and location filtering is client-side filtered (the free listing surface offers no server-side query); results are narrowed in memory after fetching the remote-only listing.';

// Honest fallback for a posting with no location signal: 'unknown', never a
// blank string, so downstream display and evaluation never see a silent gap.
export const unknownLocationLabel = 'unknown';

const maxKeywordTokens = 5;
const candidateCap = 60;
const maxPostingsCount = 12;

export interface BuiltInJobPosting {
  title?: unknown;
  description?: unknown;
  datePosted?: unknown;
  validThrough?: unknown;
  employmentType?: unknown;
  jobLocation?: unknown;
  jobLocationType?: unknown;
  applicantLocationRequirements?: unknown;
  hiringOrganization?: unknown;
  baseSalary?: unknown;
  identifier?: unknown;
  jobUrl?: string;
}

export interface BuiltInSalaryData {
  currency: string;
  minValue: number | null;
  maxValue: number | null;
  unitText: string;
}

// BuiltIn's historical decoder flavor: lowercase-hex only. Invalid code points
// now degrade to U+FFFD in the shared decoder instead of throwing, so one bad
// byte costs one posting rather than the whole source.
const builtInDecodeOptions = {
  allowUppercaseHexPrefix: false,
} as const;

function builtInTokenize(value: string): string[] {
  return tokenize(value, { minTokenLength: 3, maxTokens: maxKeywordTokens });
}

function toNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return null;
}

function jsonLdNodes(parsed: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(parsed)) {
    return parsed.filter(
      (item): item is Record<string, unknown> => item !== null && typeof item === 'object',
    );
  }
  if (parsed !== null && typeof parsed === 'object') {
    const record = parsed as Record<string, unknown>;
    const graph = record['@graph'];
    if (Array.isArray(graph)) {
      return graph.filter(
        (item): item is Record<string, unknown> => item !== null && typeof item === 'object',
      );
    }
    if (typeof record['@type'] === 'string') {
      return [record];
    }
  }
  return [];
}

export function fillListingUrl(location: string): string {
  const locationTokens = builtInTokenize(location);
  if (locationTokens.includes('remote')) {
    return `${builtInBaseUrl}/jobs/remote`;
  }
  return `${builtInBaseUrl}/jobs`;
}

export function extractListingJobUrls(rawHtml: string): string[] {
  const html = decodeHtmlEntities(rawHtml, builtInDecodeOptions);
  const urls = new Set<string>();
  const scriptRe = /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi;
  let script: RegExpExecArray | null;
  while ((script = scriptRe.exec(html)) !== null) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(script[1]);
    } catch {
      continue;
    }
    for (const node of jsonLdNodes(parsed)) {
      if (node['@type'] !== 'ItemList') {
        continue;
      }
      const items = node.itemListElement;
      if (!Array.isArray(items)) {
        continue;
      }
      for (const item of items) {
        if (item === null || typeof item !== 'object') {
          continue;
        }
        const url = trimText((item as Record<string, unknown>).url);
        if (url.startsWith(`${builtInBaseUrl}/job/`)) {
          urls.add(url.split(/[?#]/)[0]);
        }
      }
    }
  }
  const anchorRe = /href="((?:https:\/\/builtin\.com)?\/job\/[^"?]+)"/gi;
  let match: RegExpExecArray | null;
  while ((match = anchorRe.exec(html)) !== null) {
    let href = match[1] ?? '';
    if (href.startsWith('/')) {
      href = `${builtInBaseUrl}${href}`;
    }
    const normalized = href.split(/[?#]/)[0];
    if (normalized.startsWith(`${builtInBaseUrl}/job/`)) {
      urls.add(normalized);
    }
  }
  return [...urls];
}

export function extractJobPosting(rawHtml: string): BuiltInJobPosting | null {
  const html = decodeHtmlEntities(rawHtml, builtInDecodeOptions);
  const scriptRe = /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi;
  let script: RegExpExecArray | null;
  while ((script = scriptRe.exec(html)) !== null) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(script[1]);
    } catch {
      continue;
    }
    for (const node of jsonLdNodes(parsed)) {
      if (node['@type'] === 'JobPosting') {
        return node as unknown as BuiltInJobPosting;
      }
    }
  }
  return null;
}

function companyNameFromPosting(posting: BuiltInJobPosting): string {
  const org = posting.hiringOrganization;
  if (org === null || typeof org !== 'object') {
    return '';
  }
  return trimText((org as Record<string, unknown>).name);
}

function salaryFromPosting(posting: BuiltInJobPosting): BuiltInSalaryData | null {
  const baseSalary = posting.baseSalary;
  if (baseSalary === null || typeof baseSalary !== 'object') {
    return null;
  }
  const rawSalary = baseSalary as Record<string, unknown>;
  const currency = trimText(rawSalary.currency) || 'USD';
  const value = rawSalary.value;
  if (value === null || typeof value !== 'object') {
    return null;
  }
  const numeric = value as Record<string, unknown>;
  const minValue = toNumber(numeric.minValue);
  const maxValue = toNumber(numeric.maxValue);
  const unitText = trimText(numeric.unitText) || 'YEAR';
  if (minValue === null && maxValue === null) {
    return null;
  }
  return { currency, minValue, maxValue, unitText };
}

function locationFromPosting(posting: BuiltInJobPosting): string {
  const segments: string[] = [];
  const jobLocationType = trimText(posting.jobLocationType).toUpperCase();
  if (jobLocationType === 'TELECOMMUTE') {
    segments.push('Remote');
  } else if (jobLocationType === 'HYBRID') {
    segments.push('Hybrid');
  }
  let place: unknown = posting.jobLocation;
  if (Array.isArray(place)) {
    place = place.length > 0 ? place[0] : undefined;
  }
  if (place !== null && place !== undefined && typeof place === 'object') {
    const locationNode = place as Record<string, unknown>;
    const address = locationNode.address ?? locationNode;
    if (address !== null && typeof address === 'object') {
      const addressNode = address as Record<string, unknown>;
      const locality = trimText(addressNode.addressLocality);
      const region = trimText(addressNode.addressRegion);
      const country = trimText(addressNode.addressCountry);
      if (locality.length > 0) {
        segments.push(locality);
      }
      if (region.length > 0) {
        segments.push(region);
      }
      if (country.length > 0) {
        segments.push(country);
      }
    }
  }
  if (segments.length === 0) {
    const applicant = posting.applicantLocationRequirements;
    if (applicant !== null && typeof applicant === 'object') {
      const name = trimText((applicant as Record<string, unknown>).name);
      if (name.length > 0) {
        segments.push(name);
      }
    }
  }
  return segments.join(', ');
}

function fallbackJobUrl(posting: BuiltInJobPosting): string {
  const identifier = posting.identifier;
  let jobId = '';
  if (identifier !== null && typeof identifier === 'object') {
    jobId = trimText((identifier as Record<string, unknown>).value);
  }
  const title = trimText(posting.title);
  if (jobId.length === 0 || title.length === 0) {
    return '';
  }
  const slug = title
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .join('-')
    .slice(0, 70);
  return `${builtInBaseUrl}/job/${slug}/${jobId}`;
}

export function postingToRawPosting(
  posting: BuiltInJobPosting,
  listingUrl?: string,
): RawPosting | null {
  const title = trimText(posting.title);
  if (title.length === 0) {
    return null;
  }
  const companyName = companyNameFromPosting(posting);
  if (companyName.length === 0) {
    return null;
  }
  let jobUrl = trimText(posting.jobUrl);
  if (jobUrl.length === 0 && listingUrl !== undefined) {
    jobUrl = listingUrl;
  }
  if (jobUrl.length === 0) {
    jobUrl = fallbackJobUrl(posting);
  }
  if (jobUrl.length === 0) {
    return null;
  }
  const rawLocation = locationFromPosting(posting);
  const location = rawLocation.length > 0 ? rawLocation : unknownLocationLabel;
  const description = cleanText(trimText(posting.description), builtInDecodeOptions);
  const salary = salaryFromPosting(posting);
  let rawSalaryText: string | undefined;
  if (salary !== null) {
    const period =
      salary.unitText === 'MONTH'
        ? 'per month'
        : salary.unitText === 'HOUR'
          ? 'per hour'
          : salary.unitText === 'WEEK'
            ? 'per week'
            : 'per year';
    const rangeParts: string[] = [];
    if (salary.minValue !== null) {
      rangeParts.push(salary.minValue.toLocaleString());
    }
    if (salary.maxValue !== null) {
      rangeParts.push(salary.maxValue.toLocaleString());
    }
    if (rangeParts.length > 0) {
      rawSalaryText = `${salary.currency} ${rangeParts.join(' - ')} ${period}`;
    }
  }
  const datePosted = trimText(posting.datePosted);
  // A malformed datePosted previously threw a RangeError out of toISOString
  // and aborted the whole search. Throw a descriptive error instead so the
  // per-item isolation in search() skips this card with a warning.
  let postedAt: string | null = null;
  if (datePosted.length > 0) {
    const parsed = new Date(datePosted);
    if (Number.isNaN(parsed.getTime())) {
      throw new Error(`BuiltIn posting at '${jobUrl}' has an unparseable datePosted '${datePosted}'`);
    }
    postedAt = parsed.toISOString();
  }
  return {
    sourceAggregator: 'builtIn',
    companyName,
    roleTitle: title,
    location,
    jobUrl,
    description,
    hasFullDescription: true,
    postedAt,
    rawSalaryText,
  };
}

export class BuiltInAdapter implements SourceAdapter {
  readonly sourceName = 'builtIn';

  private readonly limiter: RateLimiter;

  constructor(limiter: RateLimiter) {
    this.limiter = limiter;
  }

  async search(keywords: string, location: string, options?: SearchOptions): Promise<RawPosting[]> {
    console.warn(builtInClientSideFilterWarning);
    const listingUrl = fillListingUrl(location);
    const listingHtml = await this.fetchHtml(listingUrl);
    if (listingHtml.length === 0) {
      return [];
    }
    const rawUrls = extractListingJobUrls(listingHtml);
    if (rawUrls.length === 0) {
      return [];
    }
    const keywordTokens = builtInTokenize(keywords);
    const locationTokens = builtInTokenize(location);
    const postings: RawPosting[] = [];
    // Per-item isolation (C1): detail fetching AND parsing are both guarded,
    // so one 403/429 or one malformed card (bad date, bad JSON-LD) costs that
    // URL with a warning, never the already-parsed batch.
    for (const rawUrl of rawUrls.slice(0, candidateCap)) {
      if (postings.length >= maxPostingsCount) {
        break;
      }
      let detailHtml: string;
      try {
        detailHtml = await this.fetchHtml(rawUrl);
      } catch (error) {
        console.warn(`builtIn: skipping detail ${rawUrl}: ${(error as Error).message}`);
        continue;
      }
      if (detailHtml.length === 0) {
        continue;
      }
      const posting = extractJobPosting(detailHtml);
      if (posting === null) {
        continue;
      }
      let source: RawPosting | null;
      try {
        source = postingToRawPosting(posting, rawUrl);
      } catch (error) {
        console.warn(`builtIn: skipping malformed posting ${rawUrl}: ${(error as Error).message}`);
        continue;
      }
      if (source === null) {
        continue;
      }
      const searchable = [source.roleTitle, source.companyName, source.description]
        .join(' ')
        .toLowerCase();
      const keywordMatch = keywordTokens.every((token) => searchable.includes(token));
      if (!keywordMatch) {
        continue;
      }
      const locationMatch = locationTokens.every((token) =>
        source.location.toLowerCase().includes(token),
      );
      if (!locationMatch) {
        continue;
      }
      postings.push(source);
    }
    return postings;
  }

  // Registry detail-fetch for evaluate --jobUrl (SDD Section 4.1): claims only
  // builtin.com URLs, returns null otherwise so the registry keeps routing.
  canFetchPostingUrl(url: string): boolean {
    const hostname = new URL(url).hostname.toLowerCase();
    return hostname === 'builtin.com' || hostname.endsWith('.builtin.com');
  }

  async fetchPostingByUrl(url: string): Promise<RawPosting | null> {
    if (!this.canFetchPostingUrl(url)) {
      return null;
    }
    const html = await this.fetchHtml(url);
    if (html.length === 0) {
      return null;
    }
    const posting = extractJobPosting(html);
    if (posting === null) {
      return null;
    }
    return postingToRawPosting(posting, url);
  }

  private async fetchHtml(url: string): Promise<string> {
    await this.limiter.assertPathAllowed(url);
    await this.limiter.beforeRequest();
    return fetchBoundedText(url);
  }
}