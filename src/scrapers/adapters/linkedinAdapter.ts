import { HttpStatusError, type RateLimiter } from '../rateLimiter';
import { defaultRequestTimeoutMs as requestTimeoutMs } from '../requestTimeout';
import { scraperUserAgent } from '../userAgent';
import { cleanText, decodeHtmlEntities, stripTags } from '../htmlUtils';
import type { RawPosting, SourceAdapter } from '../jobSpyAdapter';

// Technique ported from .reference/aiJobSearch/.agents/skills/linkedin-search/
// per SDD Section 1.3: LinkedIn public "jobs-guest" endpoints, unauthenticated.
// Search returns an HTML list of job cards; detail returns a single job's HTML.
// Both are parsed with regex because the markup is shallow and stable. Retries
// and backoff are NOT handled here: a non-OK response throws HttpStatusError
// and the registry records the failure, driving backoff / hard-stop on the
// shared RateLimiter instance. Accepted-risk source per SDD Requirement 8.

export const searchUrl = 'https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search';
export const detailUrl = 'https://www.linkedin.com/jobs-guest/jobs/api/jobPosting';

const userAgent = scraperUserAgent;

export type LinkedInWorkplaceType = 'onsite' | 'remote' | 'hybrid';

export interface LinkedInSearchOptions {
  postedWithinSeconds?: number;
  workplaceType?: LinkedInWorkplaceType;
  start?: number;
  limit?: number;
}

export interface LinkedInJobCard {
  id: string;
  title: string;
  company: string | null;
  companyUrl: string | null;
  location: string | null;
  date: string | null;
  url: string;
}

export interface LinkedInJobDetail {
  id: string;
  title: string | null;
  company: string | null;
  companyUrl: string | null;
  location: string | null;
  date: string | null;
  url: string;
  description: string | null;
  seniority: string | null;
  employmentType: string | null;
  jobFunction: string | null;
  industries: string | null;
  applyUrl: string | null;
}

function cleanHtml(html: string): string {
  return cleanText(html, { stripBeforeDecode: true });
}

// Extract the inner HTML of a <div> identified by a CSS class name, correctly
// handling nested <div> elements by tracking tag depth.
export function extractDivContent(html: string, className: string): string | null {
  const escaped = className.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const openRe = new RegExp(`<div[^>]*class="[^"]*${escaped}[^"]*"[^>]*>`, 'i');
  const open = openRe.exec(html);
  if (open === null) {
    return null;
  }

  let index = open.index + open[0].length;
  let depth = 1;

  while (depth > 0 && index < html.length) {
    const nextOpen = html.indexOf('<div', index);
    const nextClose = html.indexOf('</div>', index);

    if (nextClose === -1) {
      return null;
    }

    if (nextOpen !== -1 && nextOpen < nextClose) {
      depth += 1;
      index = nextOpen + 4;
    } else {
      depth -= 1;
      index = nextClose + 6;
    }
  }

  return html.slice(open.index + open[0].length, index - 6);
}

// Parse the search response: a flat list of <li> job cards. Chunks are split on
// the job-posting URN and parsed independently so one malformed card cannot
// break the rest.
export function parseSearchCards(html: string): LinkedInJobCard[] {
  const results: LinkedInJobCard[] = [];
  const chunks = html.split(/data-entity-urn="urn:li:jobPosting:/).slice(1);

  for (const chunk of chunks) {
    const idMatch = chunk.match(/^(\d+)/);
    if (idMatch === null) {
      continue;
    }
    const id = idMatch[1];

    const linkMatch = chunk.match(/class="base-card__full-link[^"]*"[^>]*href="([^"]+)"/i);
    const url = linkMatch !== null ? decodeHtmlEntities(linkMatch[1]).split('?')[0] : '';

    let title: string | null = null;
    const h3 = chunk.match(/class="base-search-card__title"[^>]*>([\s\S]*?)<\/h3>/i);
    if (h3 !== null) {
      title = cleanHtml(h3[1]);
    }
    if (title === null) {
      const sr = chunk.match(/class="sr-only"[^>]*>([\s\S]*?)<\/span>/i);
      if (sr !== null) {
        title = cleanHtml(sr[1]);
      }
    }
    if (title === null) {
      continue;
    }

    let company: string | null = null;
    let companyUrl: string | null = null;
    const subtitle = chunk.match(/class="base-search-card__subtitle"[^>]*>([\s\S]*?)<\/h4>/i);
    if (subtitle !== null) {
      const anchor = subtitle[1].match(/href="([^"]+)"/i);
      if (anchor !== null) {
        companyUrl = decodeHtmlEntities(anchor[1]).split('?')[0];
      }
      // Company hygiene (C4): badge and screen-reader-only spans (follower
      // counts, "3" badges, hidden labels) leak into the text when cleaned
      // verbatim, forking postingHash records for the same employer. Strip
      // those spans before cleanHtml so only the visible name survives.
      const withoutBadges = subtitle[1].replace(
        /<span[^>]*class="[^"]*(?:badge|sr-only|screen-reader|visually-hidden)[^"]*"[^>]*>[\s\S]*?<\/span>/gi,
        '',
      );
      company = cleanHtml(withoutBadges) || null;
    }

    const locationMatch = chunk.match(/class="job-search-card__location"[^>]*>([\s\S]*?)<\/span>/i);
    const location = locationMatch !== null ? cleanHtml(locationMatch[1]) || null : null;

    const dateMatch = chunk.match(/class="job-search-card__listdate[^"]*"[^>]*datetime="([^"]+)"/i);
    const date = dateMatch !== null ? dateMatch[1] : null;

    results.push({
      id,
      title,
      company,
      companyUrl,
      location,
      date,
      url: url || `https://www.linkedin.com/jobs/view/${id}`,
    });
  }

  return results;
}

// Parse the single-job detail page. The title is returned as null (no fallback
// string) so the caller decides; toRawPosting falls back to the card title.
export function parseJobDetail(html: string, id: string): LinkedInJobDetail {
  const titleMatch = html.match(
    /class="(?:top-card-layout__title|topcard__title)[^"]*"[^>]*>([\s\S]*?)<\/h[12]>/i,
  );
  const title = titleMatch !== null ? cleanHtml(titleMatch[1]) || null : null;

  const orgMatch = html.match(
    /class="topcard__org-name-link[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i,
  );
  const company = orgMatch !== null ? cleanHtml(orgMatch[2]) || null : null;
  const companyUrl = orgMatch !== null ? decodeHtmlEntities(orgMatch[1]).split('?')[0] : null;

  const locationMatch = html.match(
    /class="topcard__flavor topcard__flavor--bullet"[^>]*>([\s\S]*?)<\/span>/i,
  );
  const location = locationMatch !== null ? cleanHtml(locationMatch[1]) || null : null;

  // Rich description block. Keep paragraph/line breaks as newlines.
  let description: string | null = null;
  const descriptionHtml =
    extractDivContent(html, 'show-more-less-html__markup') ??
    extractDivContent(html, 'description__text');
  if (descriptionHtml !== null) {
    const withBreaks = descriptionHtml
      .replace(/<\s*br\s*\/?>/gi, '\n')
      .replace(/<\/(p|li|ul|ol|div|h\d)>/gi, '\n');
    description =
      decodeHtmlEntities(stripTags(withBreaks)).replace(/\n{3,}/g, '\n\n').trim() || null;
  }

  // Job-criteria items: subheader label -> text value.
  const criteria: Record<string, string> = {};
  const itemRe =
    /class="description__job-criteria-subheader"[^>]*>([\s\S]*?)<\/h3>[\s\S]*?class="description__job-criteria-text[^"]*"[^>]*>([\s\S]*?)<\/span>/gi;
  let criteriaMatch: RegExpExecArray | null;
  while ((criteriaMatch = itemRe.exec(html)) !== null) {
    criteria[cleanHtml(criteriaMatch[1]).toLowerCase()] = cleanHtml(criteriaMatch[2]);
  }

  const applyMatch = html.match(/class="topcard__link[^"]*"[^>]*href="([^"]+)"/i);
  const applyUrl = applyMatch !== null ? decodeHtmlEntities(applyMatch[1]).split('?')[0] : null;

  return {
    id,
    title,
    company,
    companyUrl,
    location,
    date: null,
    url: `https://www.linkedin.com/jobs/view/${id}`,
    description,
    seniority: criteria['seniority level'] ?? null,
    employmentType: criteria['employment type'] ?? null,
    jobFunction: criteria['job function'] ?? null,
    industries: criteria['industries'] ?? null,
    applyUrl,
  };
}

// Accept a raw job ID, a job-view URL, or a job URN.
export function normalizeJobId(input: string): string | null {
  const urn = input.match(/urn:li:jobPosting:(\d+)/);
  if (urn !== null) {
    return urn[1];
  }
  const url = input.match(/-(\d{6,})(?:\?|$)/) ?? input.match(/\/(\d{6,})(?:\?|$)/);
  if (url !== null) {
    return url[1];
  }
  const bare = input.match(/^\d{6,}$/);
  if (bare !== null) {
    return input;
  }
  return null;
}

// Convert a job-age window in seconds to LinkedIn's f_TPR value.
export function postedWithinToTPR(seconds?: number): string | null {
  if (seconds === undefined || seconds === null || seconds <= 0) {
    return null;
  }
  return `r${seconds}`;
}

// Workplace-type flag: on-site=1, remote=2, hybrid=3.
export function workplaceTypeFlag(mode?: LinkedInWorkplaceType): string | null {
  switch ((mode ?? '').toLowerCase()) {
    case 'remote':
      return '2';
    case 'hybrid':
      return '3';
    case 'onsite':
    case 'on-site':
      return '1';
    default:
      return null;
  }
}

export function buildSearchUrl(
  keywords: string,
  location: string,
  options?: LinkedInSearchOptions,
): string {
  const params = new URLSearchParams();
  params.set('keywords', keywords);
  if (location.length > 0) {
    params.set('location', location);
  }
  const tpr = postedWithinToTPR(options?.postedWithinSeconds);
  if (tpr !== null) {
    params.set('f_TPR', tpr);
  }
  const workplaceType = workplaceTypeFlag(options?.workplaceType);
  if (workplaceType !== null) {
    params.set('f_WT', workplaceType);
  }
  const start = options?.start ?? 0;
  if (start > 0) {
    params.set('start', String(start));
  }
  return `${searchUrl}?${params.toString()}`;
}

export class LinkedInAdapter implements SourceAdapter {
  readonly sourceName = 'linkedin';

  private readonly limiter: RateLimiter;

  constructor(limiter: RateLimiter) {
    this.limiter = limiter;
  }

  async search(
    keywords: string,
    location: string,
    options?: LinkedInSearchOptions,
  ): Promise<RawPosting[]> {
    const url = buildSearchUrl(keywords, location, options);
    const html = await this.fetchHtml(url);
    let cards = parseSearchCards(html);
    if (options?.limit !== undefined && options.limit >= 0) {
      cards = cards.slice(0, options.limit);
    }
    const postings: RawPosting[] = [];
    // Per-item isolation (C1): one malformed card or one 403/429 on a detail
    // page costs that card, never the batch. A failing detail fetch (or a
    // parse throw) is skipped with a warning and the rest are kept.
    for (const card of cards) {
      let detail: LinkedInJobDetail | null;
      try {
        detail = await this.fetchDetailById(card.id);
      } catch (error) {
        console.warn(`linkedin: skipping detail for job ${card.id}: ${(error as Error).message}`);
        continue;
      }
      if (detail !== null) {
        postings.push(this.toRawPosting(card, detail));
      }
    }
    return postings;
  }

  // Public detail lookup for later evaluate --jobUrl flows. Returns null when
  // the posting no longer exists (HTTP 404), never throwing for that case.
  async fetchDetail(input: string): Promise<LinkedInJobDetail | null> {
    const id = normalizeJobId(input);
    if (id === null) {
      throw new Error(`Could not parse a LinkedIn job ID from '${input}'`);
    }
    return this.fetchDetailById(id);
  }

  // Registry detail-fetch for evaluate --jobUrl (SDD Section 4.1): claims only
  // linkedin.com URLs, returns null otherwise so the registry keeps routing.
  canFetchPostingUrl(url: string): boolean {
    const hostname = new URL(url).hostname.toLowerCase();
    return hostname === 'linkedin.com' || hostname.endsWith('.linkedin.com');
  }

  async fetchPostingByUrl(url: string): Promise<RawPosting | null> {
    if (!this.canFetchPostingUrl(url)) {
      return null;
    }
    const id = normalizeJobId(url);
    if (id === null) {
      return null;
    }
    const detail = await this.fetchDetailById(id);
    if (detail === null) {
      return null;
    }
    const card: LinkedInJobCard = {
      id: detail.id,
      title: detail.title ?? '',
      company: detail.company,
      companyUrl: detail.companyUrl,
      location: detail.location,
      date: detail.date,
      url: detail.url,
    };
    return this.toRawPosting(card, detail);
  }

  private async fetchDetailById(id: string): Promise<LinkedInJobDetail | null> {
    const html = await this.fetchHtml(`${detailUrl}/${id}`);
    if (html === '') {
      return null;
    }
    return parseJobDetail(html, id);
  }

  // Every request gates on the shared limiter: robots.txt policy check (no-op
  // for the accepted-risk sources) then a jittered delay. A 404 yields '' so
  // the caller treats it as "no data"; every other non-OK status throws
  // HttpStatusError so the registry can record the failure and back off.
  private async fetchHtml(url: string): Promise<string> {
    await this.limiter.assertPathAllowed(url);
    await this.limiter.beforeRequest();
    const response = await fetch(url, {
      headers: {
        'User-Agent': userAgent,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'X-Requested-With': 'XMLHttpRequest',
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
        `LinkedIn request failed with status ${response.status}`,
      );
    }
    return response.text();
  }

  private toRawPosting(card: LinkedInJobCard, detail: LinkedInJobDetail): RawPosting {
    return {
      sourceAggregator: 'linkedin',
      companyName: detail.company ?? card.company ?? '',
      roleTitle: detail.title ?? card.title,
      location: detail.location ?? card.location ?? '',
      jobUrl: detail.url,
      description: detail.description ?? '',
      hasFullDescription: true,
      postedAt: card.date,
    };
  }
}
