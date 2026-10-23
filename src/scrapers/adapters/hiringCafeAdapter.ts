import { type RateLimiter } from '../rateLimiter';
import { fetchBoundedText } from '../httpFetcher';
import { cleanText, extractNextDataJson } from '../htmlUtils';
import type { RawPosting, SourceAdapter } from '../jobSpyAdapter';

// Technique ported fresh from public records of hiring.cafe — see SDD
// Requirement 8 (source 2, Low risk posture) and SDD Section 1.3's
// reverse-engineering approach. hiring.cafe offers no public API and its
// frontend is a Next.js app that server-renders a `__NEXT_DATA__` JSON island
// into every public HTML page. This adapter fetches the public listing page
// `/jobs/{querySlug}-{locationSlug}` over plain HTTP (no login, no auth
// bypass) and parses that JSON island rather than fragile CSS class names.
//
// Access posture (per Step 3b decision and SDD Requirement 8):
//   - robots.txt explicitly allows /jobs/ and /job/ paths; listing URLs we
//     build stay on those allowed paths, so `respectRobotsTxt` stays true.
//   - hiring.cafe's ToS Section 5 restricts re-publication/re-distribution of
//     its material. The intended use here (read listings for a personal job
//     search, prepare applications for manual human submission) is treated as
//     an accepted-risk scrape per the user's Step 3b instruction. It uses only
//     public, unauthenticated pages and never solves CAPTCHAs, never bypasses
//     bot detection, and never hits disallowed robots.txt paths.
//   - Only the first listing page per search is fetched (no pagination crawl),
//     and failures surface as HttpStatusError so the shared rate limiter can
//     back off / hard stop per source instead of hammering the site.
//
// Markup/JSON shape notes:
//   - Listing page ships `<script id="__NEXT_DATA__" type="application/json">`
//     holding { props: { pageProps: { ssrHits: [...] } } }.
//   - Each hit carries `jobInformation.title/description`,
//     `v6ProcessedJobData` (core title, company name, formatted workplace
//     location, requirements summary, technical tools, salary bands, etc.) and
//     `enrichedCompanyData.name`.
//   - Canonical detail URLs are reconstructed from visible `/job/...` anchors
//     on the listing page, keyed by requisition id, because the island does
//     not reliably embed the final URL.

export const hiringCafeBaseUrl = 'https://hiringcafe.com';

const nextDataScriptId = '__NEXT_DATA__';

export interface HiringCafeJobInformation {
  title?: unknown;
  description?: unknown;
}

export interface HiringCafeEnrichedCompany {
  name?: unknown;
}

export interface HiringCafeProcessedData {
  coreJobTitle?: unknown;
  companyName?: unknown;
  formattedWorkplaceLocation?: unknown;
  workplaceType?: unknown;
  commitment?: unknown;
  requirementsSummary?: unknown;
  technicalTools?: unknown;
  listedCompensationCurrency?: unknown;
  listedCompensationFrequency?: unknown;
  yearlyMinCompensation?: unknown;
  yearlyMaxCompensation?: unknown;
  monthlyMinCompensation?: unknown;
  monthlyMaxCompensation?: unknown;
  weeklyMinCompensation?: unknown;
  weeklyMaxCompensation?: unknown;
  hourlyMinCompensation?: unknown;
  hourlyMaxCompensation?: unknown;
}

export interface HiringCafeHit {
  requisitionId?: unknown;
  jobTitle?: unknown;
  hcTitle?: unknown;
  hcGroup?: unknown;
  hcPinnedSlug?: unknown;
  hcMetaDescription?: unknown;
  jobInformation?: HiringCafeJobInformation;
  v6ProcessedJobData?: HiringCafeProcessedData;
  enrichedCompanyData?: HiringCafeEnrichedCompany;
}

export interface HiringCafeParsedListing {
  hits: HiringCafeHit[];
  urlsByRequisitionId: Map<string, string>;
}

export function slugifyCafe(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

export function buildListingUrl(keywords: string, location: string): string | null {
  const querySlug = keywords.length > 0 ? slugifyCafe(keywords) : '';
  const locationSlug = location.length > 0 ? slugifyCafe(location) : '';
  if (querySlug.length === 0 && locationSlug.length === 0) {
    return null;
  }
  const joined = [querySlug, locationSlug].filter((part) => part.length > 0).join('-');
  return `${hiringCafeBaseUrl}/jobs/${joined}`;
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

function formatSalaryRange(processed: HiringCafeProcessedData | undefined): string {
  if (processed === undefined) {
    return '';
  }
  const pairs: Array<[string, number | undefined, number | undefined, string]> = [
    ['yearly', toNumber(processed.yearlyMinCompensation), toNumber(processed.yearlyMaxCompensation), '/yr'],
    ['monthly', toNumber(processed.monthlyMinCompensation), toNumber(processed.monthlyMaxCompensation), '/mo'],
    ['weekly', toNumber(processed.weeklyMinCompensation), toNumber(processed.weeklyMaxCompensation), '/wk'],
    ['hourly', toNumber(processed.hourlyMinCompensation), toNumber(processed.hourlyMaxCompensation), '/hr'],
  ];
  const frequency = String(processed.listedCompensationFrequency ?? '').toLowerCase();
  pairs.sort((left, right) => {
    const leftFirst = left[0] === frequency ? -1 : 0;
    const rightFirst = right[0] === frequency ? -1 : 0;
    return leftFirst - rightFirst;
  });
  for (const [, min, max, unit] of pairs) {
    if (min === undefined && max === undefined) {
      continue;
    }
    const currency = cleanText(processed.listedCompensationCurrency) || 'USD';
    if (min !== undefined && max !== undefined) {
      return `${currency} ${min.toLocaleString()}-${max.toLocaleString()}${unit}`;
    }
    const single = min !== undefined ? min : max;
    if (single !== undefined) {
      return `${currency} ${single.toLocaleString()}${unit}`;
    }
  }
  return '';
}

export function collectJobUrls(html: string): Map<string, string> {
  const urls = new Map<string, string>();
  const anchorRe = /href="\/job\/[^"?#]+"/g;
  let match: RegExpExecArray | null;
  while ((match = anchorRe.exec(html)) !== null) {
    const href = match[0].slice('href="'.length, -1);
    const slug = href.replace(/^\/job\//, '').split(/[?#]/)[0];
    const reqId = slug.split('-').pop();
    if (reqId !== undefined && reqId.length > 0) {
      urls.set(reqId, `${hiringCafeBaseUrl}${href}`);
    }
  }
  return urls;
}

export function parseListingHtml(html: string): HiringCafeParsedListing {
  const parsed = extractNextDataJson(html, { scriptId: nextDataScriptId });
  if (parsed === null) {
    return { hits: [], urlsByRequisitionId: collectJobUrls(html) };
  }
  const hits = (parsed as { props?: { pageProps?: { ssrHits?: unknown } } })?.props?.pageProps?.ssrHits;
  const urlMap = collectJobUrls(html);
  return {
    hits: Array.isArray(hits) ? (hits as HiringCafeHit[]) : [],
    urlsByRequisitionId: urlMap,
  };
}

export function hitToRawPosting(
  hit: HiringCafeHit,
  urlsByRequisitionId: Map<string, string>,
): RawPosting | null {
  const processed = hit.v6ProcessedJobData ?? {};
  const jobInfo = hit.jobInformation ?? {};
  const companyData = hit.enrichedCompanyData ?? {};

  const title =
    cleanText(jobInfo.title) ||
    cleanText(processed.coreJobTitle) ||
    cleanText(hit.jobTitle) ||
    cleanText(hit.hcTitle);
  if (title.length === 0) {
    return null;
  }

  const requisitionId = cleanText(hit.requisitionId);
  let url = requisitionId.length > 0 ? urlsByRequisitionId.get(requisitionId) : undefined;
  if (url === undefined) {
    const pinnedSlug = cleanText(hit.hcPinnedSlug);
    url = pinnedSlug.length > 0 ? `${hiringCafeBaseUrl}/job/${pinnedSlug.replace(/^\/+/, '')}` : '';
  }
  if (url.length === 0) {
    return null;
  }

  const descriptionParts: string[] = [];
  const rawDescription = cleanText(jobInfo.description);
  if (rawDescription.length > 0) {
    descriptionParts.push(rawDescription);
  }
  const requirements = cleanText(processed.requirementsSummary);
  if (requirements.length > 0) {
    descriptionParts.push(requirements);
  }
  const meta = cleanText(hit.hcMetaDescription);
  if (meta.length > 0) {
    descriptionParts.push(meta);
  }
  const tools = Array.isArray(processed.technicalTools)
    ? processed.technicalTools.map((tool) => cleanText(tool)).filter((tool) => tool.length > 0)
    : [];
  if (tools.length > 0) {
    descriptionParts.push(`Tools: ${tools.join(', ')}`);
  }
  const salary = formatSalaryRange(processed);

  return {
    sourceAggregator: 'hiringCafe',
    companyName: cleanText(processed.companyName) || cleanText(companyData.name) || cleanText(hit.hcGroup),
    roleTitle: title,
    location: cleanText(processed.formattedWorkplaceLocation),
    jobUrl: url,
    description: descriptionParts.join('\n\n'),
    hasFullDescription: true,
    postedAt: null,
    rawSalaryText: salary.length > 0 ? salary : undefined,
  };
}

export class HiringCafeAdapter implements SourceAdapter {
  readonly sourceName = 'hiringCafe';

  private readonly limiter: RateLimiter;

  constructor(limiter: RateLimiter) {
    this.limiter = limiter;
  }

  async search(keywords: string, location: string): Promise<RawPosting[]> {
    const url = buildListingUrl(keywords, location);
    if (url === null) {
      return [];
    }
    const html = await this.fetchHtml(url);
    if (html.length === 0) {
      return [];
    }
    const parsed = parseListingHtml(html);
    const postings: RawPosting[] = [];
    for (const hit of parsed.hits) {
      const posting = hitToRawPosting(hit, parsed.urlsByRequisitionId);
      if (posting !== null) {
        postings.push(posting);
      }
    }
    return postings;
  }

  private async fetchHtml(url: string): Promise<string> {
    await this.limiter.assertPathAllowed(url);
    await this.limiter.beforeRequest();
    return fetchBoundedText(url);
  }
}