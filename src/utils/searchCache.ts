import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  assertConfinedToRoot,
  resolveDataRoot,
  searchCacheFileName,
} from './canonicalDataRoot';
import {
  readJsonStoreFile,
  resolveStoreFilePath,
  resolveStoreRoot,
  writeJsonStoreFile,
} from './jsonStore';

// Search result caching (SRA-06 work item, parent spec docs/weJobSearch-SDD.md):
// identical keyword/location queries within a configurable TTL window return
// the cached raw scrape results instead of re-scraping. Only the raw
// per-source scrape results are cached - dedup, evaluation, and idempotent
// persistence still run on every call, so the outcome contract and the
// application-history guarantees are unchanged. The store lives under the
// canonical data root and follows the same persistence contract as the other
// tracking modules: reads are read-only, writes are atomic (temp file +
// rename) and validate-before-write, and a malformed existing file is never
// silently overwritten.
//
// Responsibility matrix (Phase 5a) — one owner per concern:
// - savedSearches.ts: saved definitions. User intent to re-run a query
//   (keywords/location pair). No results, no run timestamps, no TTL.
// - searchHistory.ts: recent run log. One entry per completed search with a
//   timestamp and resultCount. Idempotent by searchId. No cached payloads.
// - searchCache.ts (this module): result cache. Raw per-source postings keyed
//   by a normalized query hash with a minutes-based TTL. No user intent, no
//   run history. Phase 6b partial-failure policy: a mixed batch (at least one
//   source succeeded, at least one errored) stores the successful subset plus
//   the failed source names, so an immediate retry serves the last-good cache
//   (with the skips surfaced loudly by the caller) instead of hammering the
//   failed source. A total failure (no source succeeded) is still not cached,
//   so it retries. This module round-trips whatever results and failedSources
//   it is given; the cache-vs-retry decision is caller policy in
//   runSearchBatch.
// Search identity: the cache key is deliberately NOT the human-readable
// `searchYEAR...` id. It is a case-insensitive sha256 over the normalized
// query so casing variants hit the same entry within the TTL window, and it
// is year-independent so a cached batch stays valid across New Year. The two
// shapes are documented here and not merged.

export const rawPostingSchema = z.object({
  sourceAggregator: z.string(),
  companyName: z.string(),
  roleTitle: z.string(),
  location: z.string(),
  jobUrl: z.string(),
  description: z.string(),
  hasFullDescription: z.boolean(),
  postedAt: z.string().nullable(),
  rawSalaryText: z.string().optional(),
});

export const cachedSourceResultsSchema = z.object({
  sourceName: z.string(),
  postings: z.array(rawPostingSchema),
});

export type CachedSourceResults = z.infer<typeof cachedSourceResultsSchema>;

export const cachedSearchEntrySchema = z.object({
  cacheKey: z.string(),
  keywords: z.string(),
  location: z.string(),
  createdAt: z.string(),
  results: z.array(cachedSourceResultsSchema),
  // Phase 6b: sources that errored in the run that produced this entry. An
  // empty array is a fully successful batch. Defaulted so entries written
  // before this field existed still parse.
  failedSources: z.array(z.string()).default([]),
});

export type CachedSearchEntry = z.infer<typeof cachedSearchEntrySchema>;

export const searchCacheSchema = z.object({
  entries: z.array(cachedSearchEntrySchema),
});

export type SearchCache = z.infer<typeof searchCacheSchema>;

// Default freshness window for a cached search when jobPreferences.yaml does
// not set searchCacheTtlMinutes (SRA-06 goal G8). The TTL is a performance
// knob, not a non-negotiable: the user-configurable value in jobPreferences
// always wins when present. TTL units are minutes everywhere (schema field,
// constant name, and getCachedSearch input); searchCacheMsPerMinute is the
// single minutes-to-milliseconds conversion so the unit cannot drift.
export const defaultSearchCacheTtlMinutes = 30;

export const searchCacheMsPerMinute = 60_000;

// Upper bound on stored entries so the cache file cannot grow without bound
// (Phase D): putCachedSearch prunes to this size after every upsert, keeping
// the most recently created entries. A capacity knob, not a non-negotiable.
export const defaultMaxSearchCacheEntries = 100;

// Pure pruning helper (unit-testable): drops entries with unparseable
// createdAt (they can never satisfy a TTL check), then keeps the newest
// maxEntries by creation time. Newest-first ordering keeps the survivors
// deterministic when several entries share a timestamp.
export function pruneSearchCacheEntries(
  entries: readonly CachedSearchEntry[],
  maxEntries: number = defaultMaxSearchCacheEntries,
): CachedSearchEntry[] {
  const parseable = entries.filter((entry) => Number.isFinite(Date.parse(entry.createdAt)));
  const newestFirst = [...parseable].sort((first, second) => {
    const timeDelta = Date.parse(second.createdAt) - Date.parse(first.createdAt);
    if (timeDelta !== 0) {
      return timeDelta;
    }
    return second.cacheKey < first.cacheKey ? -1 : second.cacheKey > first.cacheKey ? 1 : 0;
  });
  return newestFirst.slice(0, Math.max(0, maxEntries));
}

// Deterministic cache key for a keyword/location query: case- and
// whitespace-insensitive so equivalent invocations hit the same entry.
export function generateSearchCacheKey(keywords: string, location: string): string {
  const normalizedKeywords = keywords.trim().toLowerCase().replace(/\s+/g, ' ');
  const normalizedLocation = location.trim().toLowerCase().replace(/\s+/g, ' ');
  const normalized = `${normalizedKeywords}|${normalizedLocation}`;
  return createHash('sha256').update(normalized).digest('hex');
}

export async function readSearchCache(
  filePath?: string | null,
  rootDir?: string | null,
): Promise<SearchCache> {
  const root = resolveStoreRoot(rootDir);
  const resolved = resolveStoreFilePath(filePath, join(root, searchCacheFileName));
  return readJsonStoreFile({
    resolvedPath: resolved,
    root,
    label: 'readSearchCache',
    noun: 'search cache',
    schema: searchCacheSchema,
    missing: () => ({ entries: [] }),
  });
}

async function writeSearchCache(
  cache: SearchCache,
  filePath: string,
  rootDir?: string | null,
): Promise<void> {
  await writeJsonStoreFile({
    data: cache,
    resolvedPath: filePath,
    noun: 'search cache',
    schema: searchCacheSchema,
    // Refuse to overwrite a malformed existing file (same contract as the
    // application-history tracker and the saved-searches store).
    verifyExisting: () => readSearchCache(filePath, rootDir),
  });
}

export interface GetCachedSearchInput {
  filePath?: string;
  keywords: string;
  location: string;
  ttlMinutes: number;
  now?: Date;
  rootDir?: string | null;
}

// Returns the cached per-source results for a fresh entry, or null on a miss
// or when the stored entry is older than ttlMinutes. A hit carries the
// failedSources recorded with the entry (empty for a fully successful batch)
// so the caller can surface skipped sources instead of silently dropping
// coverage.
export interface CachedSearchHit {
  results: CachedSourceResults[];
  failedSources: string[];
}

export async function getCachedSearch(input: GetCachedSearchInput): Promise<CachedSearchHit | null> {
  const root =
    input.rootDir !== undefined && input.rootDir !== null && input.rootDir.trim().length > 0
      ? input.rootDir
      : resolveDataRoot();
  const filePath = input.filePath ?? join(root, searchCacheFileName);
  assertConfinedToRoot(root, filePath, 'getCachedSearch');
  const cache = await readSearchCache(filePath, root);
  const cacheKey = generateSearchCacheKey(input.keywords, input.location);
  const entry = cache.entries.find((candidate) => candidate.cacheKey === cacheKey);
  if (entry === undefined) {
    return null;
  }
  const createdAt = Date.parse(entry.createdAt);
  const now = (input.now ?? new Date()).getTime();
  if (!Number.isFinite(createdAt) || now - createdAt > input.ttlMinutes * searchCacheMsPerMinute) {
    return null;
  }
  return {
    results: entry.results.map((source) => ({ sourceName: source.sourceName, postings: source.postings })),
    failedSources: [...entry.failedSources],
  };
}

export interface PutCachedSearchInput {
  filePath?: string;
  keywords: string;
  location: string;
  results: CachedSourceResults[];
  // Sources that errored in this run. Omit (or pass []) for a fully
  // successful batch.
  failedSources?: string[];
  now?: Date;
  rootDir?: string | null;
}

// Upserts the per-source results for a query, replacing any previous entry
// with the same normalized key. Callers decide whether to cache: fully
// successful scrapes are always cached, mixed batches cache the successful
// subset with failedSources, and total failures are not cached so they retry.
export async function putCachedSearch(input: PutCachedSearchInput): Promise<void> {
  const root =
    input.rootDir !== undefined && input.rootDir !== null && input.rootDir.trim().length > 0
      ? input.rootDir
      : resolveDataRoot();
  const filePath = input.filePath ?? join(root, searchCacheFileName);
  assertConfinedToRoot(root, filePath, 'putCachedSearch');
  const cache = await readSearchCache(filePath, root);
  const cacheKey = generateSearchCacheKey(input.keywords, input.location);
  const entry: CachedSearchEntry = {
    cacheKey,
    keywords: input.keywords.trim(),
    location: input.location.trim(),
    createdAt: (input.now ?? new Date()).toISOString(),
    results: input.results.map((source) => ({
      sourceName: source.sourceName,
      postings: source.postings.map((posting) => ({ ...posting })),
    })),
    failedSources: input.failedSources ?? [],
  };
  const remaining = cache.entries.filter((candidate) => candidate.cacheKey !== cacheKey);
  // Bound the file (Phase D): prune to the newest capped entries on every
  // upsert so repeated searches cannot grow the store without bound.
  const pruned = pruneSearchCacheEntries([...remaining, entry]);
  await writeSearchCache({ entries: pruned }, filePath, root);
}
