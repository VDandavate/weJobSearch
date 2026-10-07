import { join } from 'node:path';
import { z } from 'zod';
import {
  searchHistoryFileName,
} from './canonicalDataRoot';
import { generateSearchId } from './savedSearches';
import {
  readJsonStoreFile,
  resolveStoreFilePath,
  resolveStoreRoot,
  writeJsonStoreFile,
} from './jsonStore';

// Search history persistence (EUO-13, goal G7). Every completed search is
// recorded with its query, the resolved location (per EUO-08), an ISO
// timestamp, and the number of unique postings it returned, so past searches
// are reviewable and repeatable. The store lives under the canonical data
// root (real user data, never committed) and follows the same persistence
// contract as applicationHistory.json (SDD Requirement 4): reads are
// read-only, writes are atomic (temp file + rename) and validate-before-write,
// and a malformed existing file is never silently overwritten.
//
// Responsibility matrix (Phase 5a) — one owner per concern:
// - savedSearches.ts: saved definitions. User intent to re-run a query
//   (keywords/location pair). No results, no run timestamps, no TTL.
// - searchHistory.ts (this module): recent run log. One entry per completed
//   search with a timestamp and resultCount. Idempotent by searchId. No cached
//   payloads.
// - searchCache.ts: result cache. Raw per-source postings keyed by a
//   normalized query hash with a minutes-based TTL. No user intent, no run
//   history.
// Search identity: history run ids reuse the saved-search definition id
// (generateSearchId, the single implementation of the human-readable
// year-scoped `searchYEAR...` shape) so a run traces back to the saved search
// that produced it. The result cache deliberately uses a different,
// case-insensitive sha256 key, so the two shapes are not merged.

export const searchHistoryEntrySchema = z.object({
  searchId: z.string(),
  keywords: z.string().min(1),
  location: z.string(),
  timestamp: z.string(),
  resultCount: z.number(),
});
export type SearchHistoryEntry = z.infer<typeof searchHistoryEntrySchema>;

export const searchHistorySchema = z.object({
  searches: z.array(searchHistoryEntrySchema),
});
export type SearchHistory = z.infer<typeof searchHistorySchema>;

// Deterministic id for a query run in a given year: the same keywords +
// location within the same year always produce the same id, which is what
// makes recordSearch idempotent (an identical query updates its entry rather
// than duplicating it), while a query re-run in a later year starts a new
// entry so year-over-year history stays visible. Delegates to the saved-search
// id (Phase 5a unification): the two were byte-identical implementations, so
// one owner remains and the shapes cannot drift apart.
export function generateSearchHistoryId(
  keywords: string,
  location: string,
  referenceDate?: Date,
): string {
  return generateSearchId(keywords, location, referenceDate);
}

export async function readSearchHistory(
  filePath?: string | null,
  rootDir?: string | null,
): Promise<SearchHistory> {
  // Default path derives from the effective root (U43): defaulting from
  // resolveDataRoot() first made relocated reads resolve the canonical path
  // and then fail confinement against the relocated root.
  const root = resolveStoreRoot(rootDir);
  const resolvedPath = resolveStoreFilePath(filePath, join(root, searchHistoryFileName));
  return readJsonStoreFile({
    resolvedPath,
    root,
    label: 'readSearchHistory',
    noun: 'search history',
    schema: searchHistorySchema,
    missing: () => ({ searches: [] }),
  });
}

async function writeSearchHistory(
  history: SearchHistory,
  filePath: string,
  rootDir?: string | null,
): Promise<void> {
  await writeJsonStoreFile({
    data: history,
    resolvedPath: filePath,
    noun: 'search history',
    schema: searchHistorySchema,
    // Refuse to overwrite a malformed existing file (same contract as the
    // application-history tracker).
    verifyExisting: () => readSearchHistory(filePath, rootDir),
  });
}

// Records one completed search. Idempotent re-runs (EUO-13): an entry whose
// searchId already exists is replaced in place - timestamp and resultCount
// refresh, the entry moves to the end (most recent), and no duplicate is
// appended. Distinct queries append as new entries in run order.
export async function recordSearch(
  entry: SearchHistoryEntry,
  filePath?: string | null,
  rootDir?: string | null,
): Promise<SearchHistoryEntry> {
  const root = resolveStoreRoot(rootDir);
  const resolvedPath = resolveStoreFilePath(filePath, join(root, searchHistoryFileName));
  const history = await readSearchHistory(resolvedPath, root);
  const existingIndex = history.searches.findIndex(
    (existing) => existing.searchId === entry.searchId,
  );
  if (existingIndex !== -1) {
    history.searches.splice(existingIndex, 1);
  }
  history.searches.push(entry);
  await writeSearchHistory(history, resolvedPath, root);
  return entry;
}
