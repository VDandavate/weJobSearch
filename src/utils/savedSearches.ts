import { join } from 'node:path';
import { z } from 'zod';
import {
  savedSearchesFileName,
} from './canonicalDataRoot';
import {
  readJsonStoreFile,
  resolveStoreFilePath,
  resolveStoreRoot,
  writeJsonStoreFile,
} from './jsonStore';

// Saved search queries (SRA-01 work item, parent spec docs/weJobSearch-SDD.md). A
// saved search is a keyword/location pair the user wants to re-run; the
// `digest` command evaluates every saved search in one pass. The store lives
// under the canonical data root (real user data, never committed) and follows
// the same persistence contract as the other tracking modules: reads are
// read-only, writes are atomic (temp file + rename) and validate-before-write,
// and a malformed existing file is never silently overwritten.
//
// Responsibility matrix (Phase 5a) — one owner per concern:
// - savedSearches.ts (this module): saved definitions. User intent to re-run
//   a query (keywords/location pair). No results, no run timestamps, no TTL.
// - searchHistory.ts: recent run log. One entry per completed search with a
//   timestamp and resultCount. Idempotent by searchId. No cached payloads.
// - searchCache.ts: result cache. Raw per-source postings keyed by a
//   normalized query hash with a minutes-based TTL. No user intent, no run
//   history.
// Search identity: this module owns the single implementation of the
// human-readable year-scoped `searchYEAR...` id (generateSearchId), shared by
// saved definitions and history run entries so a run traces back to the saved
// search that produced it. The result cache deliberately uses a different,
// case-insensitive sha256 key (generateSearchCacheKey): it must hit across
// casing variants within its TTL window and is independent of calendar year,
// so the two shapes are not merged.

export const savedSearchSchema = z.object({
  searchId: z.string(),
  keywords: z.string(),
  location: z.string().optional(),
  createdAt: z.string(),
});

export type SavedSearch = z.infer<typeof savedSearchSchema>;

export const savedSearchesSchema = z.object({
  searches: z.array(savedSearchSchema),
});

export type SavedSearches = z.infer<typeof savedSearchesSchema>;

export function generateSearchId(keywords: string, location?: string, referenceDate?: Date): string {
  const year = (referenceDate ?? new Date()).getFullYear();
  const normalizedKeywords = keywords.replace(/[^A-Za-z0-9]/g, '');
  const normalizedLocation = (location ?? '').replace(/[^A-Za-z0-9]/g, '');
  return `search${year}${normalizedKeywords}${normalizedLocation}`;
}

export async function readSavedSearches(
  filePath?: string | null,
  rootDir?: string | null,
): Promise<SavedSearches> {
  // Default path derives from the effective root (U43): defaulting from
  // resolveDataRoot() first made relocated reads resolve the canonical path
  // and then fail confinement against the relocated root.
  const root = resolveStoreRoot(rootDir);
  const resolvedPath = resolveStoreFilePath(filePath, join(root, savedSearchesFileName));
  return readJsonStoreFile({
    resolvedPath,
    root,
    label: 'readSavedSearches',
    noun: 'saved searches',
    schema: savedSearchesSchema,
    missing: () => ({ searches: [] }),
  });
}

async function writeSavedSearches(
  searches: SavedSearches,
  filePath: string,
  rootDir?: string | null,
): Promise<void> {
  await writeJsonStoreFile({
    data: searches,
    resolvedPath: filePath,
    noun: 'saved searches',
    schema: savedSearchesSchema,
    // Refuse to overwrite a malformed existing file (same contract as the
    // application-history tracker).
    verifyExisting: () => readSavedSearches(filePath, rootDir),
  });
}

export async function addSavedSearch(
  input: { keywords: string; location?: string },
  filePath?: string | null,
  rootDir?: string | null,
): Promise<SavedSearch> {
  const keywords = input.keywords.trim();
  if (keywords.length === 0) {
    throw new Error('Saved search keywords must not be empty.');
  }
  const location = input.location?.trim() ?? '';
  const root = resolveStoreRoot(rootDir);
  const resolvedPath = resolveStoreFilePath(filePath, join(root, savedSearchesFileName));
  const existing = await readSavedSearches(resolvedPath, root);
  const duplicate = existing.searches.some(
    (search) => search.keywords.trim() === keywords && (search.location ?? '').trim() === location,
  );
  if (duplicate) {
    throw new Error(
      `A saved search for '${keywords}'${location.length > 0 ? ` in '${location}'` : ''} already exists.`,
    );
  }
  const search: SavedSearch = {
    searchId: generateSearchId(keywords, location),
    keywords,
    location: location.length > 0 ? location : undefined,
    createdAt: new Date().toISOString(),
  };
  await writeSavedSearches({ searches: [...existing.searches, search] }, resolvedPath, root);
  return search;
}