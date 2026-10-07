import { HttpStatusError, type RateLimiter } from '../rateLimiter';
import { defaultRequestTimeoutMs as requestTimeoutMs } from '../requestTimeout';
import { scraperUserAgent } from '../userAgent';
import { extractNextDataJson, tokenize, trimText } from '../htmlUtils';
import type { RawPosting, SourceAdapter } from '../jobSpyAdapter';

// Technique built fresh from direct research (SDD Requirement 8, row 6)
// during Step 3f, using the same accepted-risk discipline as the other five
// adapters.
//
// Reality check (verified 2026-08-08):
//   - robots.txt allows the /remote-jobs and category listing paths; only
//     /admin*, */api/*, *?sub=*, *search.html?, /visitor/, and
//     clientevents/v1/* are disallowed. The listing URL we build stays on an
//     allowed path, so `respectRobotsTxt` stays true.
//   - FlexJobs is a subscription service (the paywall is the product):
//     employer names, full long-form descriptions, and applying all sit
//     behind the paid membership. Public unauthenticated pages expose only
//     teaser cards, and the /publicjobs/{slug} detail and /search surfaces
//     return HTTP 403 under an honest plain-HTTP guest fetch (Akamai edge
//     policy). This adapter NEVER fetches a detail page and never touches
//     the search surface; it stays entirely on the robots-allowed listing
//     page. No login, no session/cookie handling, no account credential use
//     of any kind — account-based automation was explicitly never approved
//     and is a different risk category than reading public listing pages.
//   - What IS public (robots-allowed, unauthenticated, HTTP 200): the
//     listing pages server-render a Next.js `__NEXT_DATA__` JSON island with
//     one entry per job, including the employer name, an ISO posted date, a
//     salaryRange string, remote/on-site flags, and a ~200-character
//     teaser/summary description (the `description` and `jobSummary`
//     fields are byte-identical on every observed record). The full posting
//     body is NOT in that payload; it is the paywalled product.
//
// Risk posture (per the user's Step 3f decision): FlexJobs' ToS (Jan 16,
// 2025) explicitly prohibits "automated software or devices such as spiders,
// robots or data mining techniques such as scraping" and separately forbids
// any "use, copy, ... scrape" of content "without FlexJobs' authorisation".
// This is an accepted-risk scrape exactly as documented in SDD Requirement
// 8, row 6: only public unauthenticated listing pages over plain HTTP — no
// login, no CAPTCHA/bot-detection bypass. Additional research confirmed
// nothing worse than the documented posture: the ToS contains no
// circumvention/anti-bypass clauses beyond the general automation ban, and
// the detail-page 403s are handled honestly (the adapter never fetches those
// paths, so no 403 bypass is even attempted).
//
// Only the first listing page per search is fetched (no pagination crawl).
// Failures surface as HttpStatusError so the shared rate limiter can
// back off / hard stop per source. Registered with the most conservative
// 4-5s delay range of the six per SDD Requirement 8.

export const flexJobsBaseUrl = 'https://www.flexjobs.com';
export const flexJobsListingPath = 'remote-jobs';

// Client-side filtering disclosure (Phase D): the listing builder stays on
// the single robots-allowed /remote-jobs page and ignores keywords/location
// (there is no server-side query surface on the free tier), so search()
// filters keywords and location in memory over teaser records. The warning
// below is user-visible on every search. Table contracts unchanged.
export const flexJobsClientSideFilterWarning =
  'flexJobs: keyword and location filtering is client-side filtered (the free listing page offers no server-side query); results are narrowed in memory over teaser records.';

// Honest fallback for a record with no location signal: 'unknown', never a
// blank string.
export const flexJobsUnknownLocationLabel = 'unknown';

const userAgent = scraperUserAgent;
const maxPostings = 20;

export interface FlexJobsCompany {
  companyId?: unknown;
  name?: unknown;
  slug?: unknown;
}

export interface FlexJobsJobRecord {
  id?: unknown;
  title?: unknown;
  description?: unknown;
  jobSummary?: unknown;
  postedDate?: unknown;
  jobLocations?: unknown;
  remoteOptions?: unknown;
  jobSchedules?: unknown;
  jobTypes?: unknown;
  salaryRange?: unknown;
  applyUrl?: unknown;
  slug?: unknown;
  company?: FlexJobsCompany | null;
}

function cleanList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => trimText(item))
    .filter((item) => item.length > 0);
}

export function parseListingHtml(html: string): unknown {
  // This source's lookup matched case-insensitively; preserved via options.
  return extractNextDataJson(html, { caseInsensitive: true });
}

export function collectJobRecords(parsed: unknown): FlexJobsJobRecord[] {
  if (parsed === null || typeof parsed !== 'object') {
    return [];
  }
  const props = (parsed as { props?: { pageProps?: unknown } }).props;
  if (props === undefined) {
    return [];
  }
  const pageProps = props.pageProps as Record<string, unknown> | undefined;
  if (pageProps === undefined) {
    return [];
  }
  const records: FlexJobsJobRecord[] = [];
  const seen = new Set<string>();
  const pushRecord = (value: unknown): void => {
    if (value === null || typeof value !== 'object') {
      return;
    }
    const raw = value as Record<string, unknown>;
    const title = trimText(raw.title);
    const slug = trimText(raw.slug);
    if (title.length === 0 || slug.length === 0) {
      return;
    }
    const record: FlexJobsJobRecord = {
      id: raw.id,
      title,
      description: typeof raw.description === 'string' ? raw.description : undefined,
      jobSummary: typeof raw.jobSummary === 'string' ? raw.jobSummary : undefined,
      postedDate: typeof raw.postedDate === 'string' ? raw.postedDate : undefined,
      jobLocations: raw.jobLocations,
      remoteOptions: raw.remoteOptions,
      jobSchedules: raw.jobSchedules,
      jobTypes: raw.jobTypes,
      salaryRange: typeof raw.salaryRange === 'string' ? raw.salaryRange : undefined,
      applyUrl: typeof raw.applyUrl === 'string' ? raw.applyUrl : undefined,
      slug,
      company:
        raw.company !== null && typeof raw.company === 'object'
          ? (raw.company as FlexJobsCompany)
          : null,
    };
    if (!seen.has(slug)) {
      seen.add(slug);
      records.push(record);
    }
  };
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) {
        visit(item);
      }
      return;
    }
    if (value === null || typeof value !== 'object') {
      return;
    }
    const raw = value as Record<string, unknown>;
    if (trimText(raw.slug).length > 0 && trimText(raw.title).length > 0) {
      pushRecord(raw);
      return;
    }
    for (const child of Object.values(raw)) {
      visit(child);
    }
  };
  visit(pageProps);
  return records;
}

export function buildListingUrl(keywords: string, location: string): string {
  return `${flexJobsBaseUrl}/${flexJobsListingPath}`;
}

export function companyFromRecord(record: FlexJobsJobRecord): string {
  const company = record.company;
  if (company === null || company === undefined) {
    return '';
  }
  return trimText(company.name);
}

export function locationFromRecord(record: FlexJobsJobRecord): string {
  const remoteOptions = cleanList(record.remoteOptions);
  const hasRemote = remoteOptions.some((option) => option.toLowerCase().includes('remote'));
  const hasHybrid = remoteOptions.some((option) => option.toLowerCase().includes('hybrid'));
  const remoteLabel = hasHybrid ? 'Hybrid Remote' : hasRemote ? 'Remote' : '';
  const locations = cleanList(record.jobLocations);
  const location = locations.join('; ');
  if (remoteLabel.length === 0) {
    return location.length > 0 ? location : flexJobsUnknownLocationLabel;
  }
  return location.length > 0 ? `${remoteLabel} | ${location}` : remoteLabel;
}

export function teaserFromRecord(record: FlexJobsJobRecord): string {
  const description = trimText(record.description);
  if (description.length > 0) {
    return description;
  }
  return trimText(record.jobSummary);
}

function normalizePostedDate(value: unknown): string | null {
  if (typeof value === 'string' && value.trim().length > 0) {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) {
      return date.toISOString();
    }
  }
  return null;
}

export function recordToRawPosting(record: FlexJobsJobRecord): RawPosting | null {
  const title = trimText(record.title);
  const slug = trimText(record.slug);
  if (title.length === 0 || slug.length === 0) {
    return null;
  }
  const teaser = teaserFromRecord(record);
  const descriptionParts: string[] = [];
  if (teaser.length > 0) {
    descriptionParts.push(teaser);
  }
  const jobTypes = cleanList(record.jobTypes);
  if (jobTypes.length > 0) {
    descriptionParts.push(`Job Type: ${jobTypes.join(', ')}`);
  }
  const schedules = cleanList(record.jobSchedules);
  if (schedules.length > 0) {
    descriptionParts.push(`Schedule: ${schedules.join(', ')}`);
  }
  const salary = trimText(record.salaryRange);
  return {
    sourceAggregator: 'flexJobs',
    companyName: companyFromRecord(record),
    roleTitle: title,
    location: locationFromRecord(record),
    jobUrl: `${flexJobsBaseUrl}/publicjobs/${slug}`,
    description: descriptionParts.join('\n'),
    hasFullDescription: false,
    postedAt: normalizePostedDate(record.postedDate),
    rawSalaryText: salary.length > 0 ? salary : undefined,
  };
}

export class FlexJobsAdapter implements SourceAdapter {
  readonly sourceName = 'flexJobs';

  private readonly limiter: RateLimiter;

  constructor(limiter: RateLimiter) {
    this.limiter = limiter;
  }

  async search(keywords: string, location: string): Promise<RawPosting[]> {
    console.warn(flexJobsClientSideFilterWarning);
    const listingUrl = buildListingUrl(keywords, location);
    const html = await this.fetchHtml(listingUrl);
    if (html.length === 0) {
      return [];
    }
    const parsed = parseListingHtml(html);
    if (parsed === null) {
      return [];
    }
    const records = collectJobRecords(parsed);
    const keywordTokens = tokenize(keywords);
    const locationTokens = tokenize(location);
    const postings: RawPosting[] = [];
    for (const record of records) {
      if (postings.length >= maxPostings) {
        break;
      }
      const posting = recordToRawPosting(record);
      if (posting === null) {
        continue;
      }
      const searchable = [posting.roleTitle, posting.companyName, posting.description]
        .join(' ')
        .toLowerCase();
      const keywordMatch = keywordTokens.every((token) => searchable.includes(token));
      if (!keywordMatch) {
        continue;
      }
      const locationLabel = posting.location.toLowerCase();
      const locationMatch =
        locationTokens.length === 0 ||
        locationTokens.every((token) => locationLabel.includes(token));
      if (!locationMatch) {
        continue;
      }
      postings.push(posting);
    }
    return postings;
  }

  // Every request gates on the shared limiter: robots.txt policy check then
  // a jittered delay (the most conservative 4-5s range of the six). A 404
  // yields '' so the caller treats it as "no data"; any other non-OK status
  // throws HttpStatusError so the registry can record the failure and back
  // off (including Akamai edge 403s).
  private async fetchHtml(url: string): Promise<string> {
    await this.limiter.assertPathAllowed(url);
    await this.limiter.beforeRequest();
    const response = await fetch(url, {
      headers: {
        'User-Agent': userAgent,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
    if (response.status === 404) {
      return '';
    }
    if (!response.ok) {
      throw new HttpStatusError(
        response.status,
        `FlexJobs listing request failed with status ${response.status}`,
      );
    }
    return response.text();
  }
}