import { HttpStatusError, type RateLimiter } from '../rateLimiter';
import { defaultRequestTimeoutMs as requestTimeoutMs } from '../requestTimeout';
import { scraperUserAgent } from '../userAgent';
import { fetchBoundedText } from '../httpFetcher';
import { extractNextDataJson, postingMatchesLocation, trimText } from '../htmlUtils';
import type { RawPosting, SourceAdapter, SearchOptions } from '../jobSpyAdapter';

// Technique built fresh from public site inspection (SDD Requirement 8, row 3)
// using the same discipline as the hiring.cafe adapter. Wellfound (formerly
// AngelList Talent) offers no public developer API — apitracker.io confirms
// every developer-docs field is empty — and its internal Apollo `/graphql`
// endpoint returns 401/403 without a session. The data is instead shipped
// server-rendered into a Next.js `__NEXT_DATA__` JSON island on every public
// SEO role-listing page, including the full Apollo cache.
//
// Access posture (per the user's Step 3c decision, mirroring hiring.cafe):
//   - robots.txt allows the /role/ listing paths (sitemap.xml.gz is published
//     for exactly these pages); the URLs we build stay on allowed paths, so
//     `respectRobotsTxt` stays true.
//   - Wellfound's Talent General Terms Article III explicitly prohibits
//     "automated or non-automated harvesting, collection or scraping" of
//     content. Reading public listings for a personal job search is treated as
//     an accepted-risk scrape per the user's Step 3c decision. This adapter uses
//     only public, unauthenticated pages over plain HTTP (no login, no cookie
//     warm-up, no JS execution, no CAPTCHA/bot-detection bypass) and never hits
//     a disallowed robots.txt path.
//   - Only the first role-listing page per search is fetched (page 1, 20
//     startups each with up to 3 highlighted jobs). Deeper pages and the
//     /jobs/ filter surface sit behind a sign-in wall for guest sessions, so
//     they are out of scope rather than bypassed.
//
// Markup/JSON shape notes (observed 2026-08-08):
//   - Listing pages ship `<script id="__NEXT_DATA__" type="application/json">`
//     holding { props: { pageProps: { apolloState: { data: ... } } } }.
//   - `data.ROOT_QUERY.talent["seoLandingPageJobSearchResults({...})"]` holds
//     `{ startups: [{ __ref: "StartupResult:<id>" }] }` plus totals.
//   - `data["StartupResult:<id>"]` carries `name`, `slug`, and
//     `highlightedJobListings` (job refs).
//   - `data["JobListingSearchResult:<id>"]` carries title, primaryRoleTitle,
//     description (markdown), compensation ("$310k – $345k"), locationNames,
//     remote flags, liveStartAt epoch seconds, and slug. Final detail URLs are
//     reconstructed as `/jobs/{id}-{slug}`, the same shape as the anchor hrefs
//     on the page.

export const wellfoundBaseUrl = 'https://wellfound.com';

const nextDataScriptId = '__NEXT_DATA__';

export interface WellfoundStartup {
  __typename?: unknown;
  id?: unknown;
  name?: unknown;
  slug?: unknown;
  companySize?: unknown;
  highlightedJobListings?: unknown;
}

export interface WellfoundJobListing {
  __typename?: unknown;
  autoPosted?: unknown;
  atsSource?: unknown;
  description?: unknown;
  jobType?: unknown;
  liveStartAt?: unknown;
  locationNames?: unknown;
  primaryRoleTitle?: unknown;
  remote?: unknown;
  acceptedRemoteLocationNames?: unknown;
  slug?: unknown;
  title?: unknown;
  compensation?: unknown;
  yearsExperienceMin?: unknown;
  yearsExperienceMax?: unknown;
  id?: unknown;
}

export interface WellfoundParsedListing {
  startupsById: Map<string, WellfoundStartup>;
  jobsById: Map<string, WellfoundJobListing>;
}

const emptyParsedListing = (): WellfoundParsedListing => ({
  startupsById: new Map(),
  jobsById: new Map(),
});

export function slugifyWellfound(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

export function buildListingUrl(keywords: string, location: string, options?: SearchOptions): string | null {
  const roleSlug = keywords.length > 0 ? slugifyWellfound(keywords) : '';
  if (roleSlug.length === 0) {
    return null;
  }
  const locationSlug = location.length > 0 ? slugifyWellfound(location) : '';
  return locationSlug.length === 0
    ? `${wellfoundBaseUrl}/role/${roleSlug}`
    : `${wellfoundBaseUrl}/role/l/${roleSlug}/${locationSlug}`;
}

export function parseListingHtml(html: string): WellfoundParsedListing {
  const empty = emptyParsedListing();
  // This source's script tag carries extra attributes; preserved via options.
  const parsed = extractNextDataJson(html, {
    scriptId: nextDataScriptId,
    allowExtraAttributes: true,
  });
  if (parsed === null) {
    return empty;
  }
  const data = (parsed as { props?: { pageProps?: { apolloState?: { data?: Record<string, unknown> } } } })
    ?.props?.pageProps?.apolloState?.data;
  if (data === undefined) {
    return empty;
  }
  const rootQuery = data['ROOT_QUERY'] as { talent?: Record<string, unknown> } | undefined;
  const talent = rootQuery?.talent;
  if (talent === undefined) {
    return empty;
  }

  const searchKey = Object.keys(talent).find((key) => key.startsWith('seoLandingPageJobSearchResults('));
  const searchResults = searchKey !== undefined ? (talent[searchKey] as { startups?: unknown } | undefined) : undefined;
  const startupsRef = Array.isArray(searchResults?.startups)
    ? (searchResults?.startups as Array<{ __ref?: unknown }>)
    : [];
  if (startupsRef.length === 0) {
    return empty;
  }

  const startupsById = new Map<string, WellfoundStartup>();
  const jobsById = new Map<string, WellfoundJobListing>();
  for (const entry of startupsRef) {
    const ref = entry.__ref;
    if (typeof ref !== 'string') {
      continue;
    }
    const startup = data[ref] as WellfoundStartup | undefined;
    if (startup !== undefined) {
      startupsById.set(ref, startup);
    }
  }

  for (const startup of startupsById.values()) {
    const highlighted = startup.highlightedJobListings;
    if (!Array.isArray(highlighted)) {
      continue;
    }
    for (const jobRef of highlighted as unknown[]) {
      const ref = (jobRef as { __ref?: unknown }).__ref;
      if (typeof ref !== 'string') {
        continue;
      }
      const job = data[ref] as WellfoundJobListing | undefined;
      if (job !== undefined) {
        jobsById.set(ref, job);
      }
    }
  }

  return { startupsById, jobsById };
}

export function jobToRawPosting(
  startup: WellfoundStartup,
  job: WellfoundJobListing,
): RawPosting | null {
  const title = trimText(job.title) || trimText(job.primaryRoleTitle);
  if (title.length === 0) {
    return null;
  }
  const companyName = trimText(startup.name);
  if (companyName.length === 0) {
    return null;
  }

  const id = trimText(job.id);
  const slug = trimText(job.slug);
  const jobUrlValue = id.length > 0 ? `${wellfoundBaseUrl}/jobs/${id}-${slug}` : '';
  if (jobUrlValue.length === 0) {
    return null;
  }

  const locationNames = Array.isArray(job.locationNames)
    ? job.locationNames.map((name) => trimText(name)).filter((name) => name.length > 0)
    : [];
  const remote = job.remote === true;
  const location = remote
    ? `Remote • ${locationNames.join(', ') || 'Anywhere'}`
    : locationNames.join(', ');
  const compensation = trimText(job.compensation);
  const jobType = trimText(job.jobType);
  const descriptionParts: string[] = [];
  const description = trimText(job.description);
  if (description.length > 0) {
    descriptionParts.push(description);
  }
  if (compensation.length > 0) {
    descriptionParts.push(compensation);
  }
  if (jobType.length > 0) {
    descriptionParts.push(jobType);
  }
  const liveStartAt = job.liveStartAt;
  const postedAt = typeof liveStartAt === 'number' ? new Date(liveStartAt * 1000).toISOString() : null;

  return {
    sourceAggregator: 'wellfound',
    companyName,
    roleTitle: title,
    location,
    jobUrl: jobUrlValue,
    description: descriptionParts.join('\n\n'),
    hasFullDescription: true,
    postedAt,
  };
}

export class WellfoundAdapter implements SourceAdapter {
  readonly sourceName = 'wellfound';

  private readonly limiter: RateLimiter;

  constructor(limiter: RateLimiter) {
    this.limiter = limiter;
  }

  async search(keywords: string, location: string, options?: SearchOptions): Promise<RawPosting[]> {
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
    for (const startup of parsed.startupsById.values()) {
      const highlightRefs = startup.highlightedJobListings;
      if (!Array.isArray(highlightRefs)) {
        continue;
      }
      for (const jobRef of highlightRefs as unknown[]) {
        const ref = (jobRef as { __ref?: unknown }).__ref;
        if (typeof ref !== 'string') {
          continue;
        }
        const job = parsed.jobsById.get(ref);
        if (job !== undefined) {
          const posting = jobToRawPosting(startup, job);
          if (posting !== null) {
            postings.push(posting);
          }
        }
      }
    }
    // Location request enforcement (audit finding 14): Wellfound redirects a
    // location path to the generic page, so the listing itself is not filtered.
    // Apply the same work-mode/city check the other adapters use.
    return postings.filter((posting) => postingMatchesLocation(posting.location, location));
  }

  // Every request gates on the shared limiter: robots.txt policy check then a
  // jittered delay. A 404 yields '' so the caller treats it as "no data";
  // every other non-OK status throws HttpStatusError so the registry can
  // record the failure and back off (including Wellfound's anti-bot layer).
  private async fetchHtml(url: string): Promise<string> {
    await this.limiter.assertPathAllowed(url);
    await this.limiter.beforeRequest();
    return fetchBoundedText(url);
  }
}