import {
  computePostingHash,
  readApplicationHistory,
  writeApplicationHistory,
} from '../utils/jobFunnelTracker';
import {
  locationsMatch,
  normalizeCompanyName,
  normalizeRoleTitle,
} from '../utils/postingIdentity';
import type { RawPosting } from '../scrapers/jobSpyAdapter';

// Compatibility re-exports: the normal forms live in utils/postingIdentity
// (shared with computePostingHash) while existing importers keep working.
export { normalizeCompanyName, normalizeLocation, normalizeRoleTitle } from '../utils/postingIdentity';

export const defaultFuzzyThreshold = 2;

export type DuplicateMatchKind = 'exactHash' | 'fuzzyRoleTitle' | 'withinBatch';

export interface DeduplicatedPosting {
  sourceAggregators: string[];
  companyName: string;
  roleTitle: string;
  location: string;
  jobUrl: string;
  postingHash: string;
  description: string;
  postedAt: string | null;
}

export interface MergedPosting {
  postingHash: string;
  companyName: string;
  roleTitle: string;
  location: string;
  jobUrl: string;
  matchKind: DuplicateMatchKind;
  matchedApplicationId: string | null;
  matchedPostingHash: string;
  sourceAggregators: string[];
}

export interface DeduplicationResult {
  uniquePostings: DeduplicatedPosting[];
  mergedPostings: MergedPosting[];
}

export interface DeduplicateOptions {
  historyPath?: string;
  fuzzyThreshold?: number;
  rootDir?: string | null;
}

export function levenshteinDistance(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  if (left.length === 0) {
    return right.length;
  }
  if (right.length === 0) {
    return left.length;
  }
  let previous = Array.from({ length: right.length + 1 }, (entry, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= right.length; j += 1) {
      const substitutionCost = left[i - 1] === right[j - 1] ? 0 : 1;
      current[j] = Math.min(
        current[j - 1] + 1,
        previous[j] + 1,
        previous[j - 1] + substitutionCost,
      );
    }
    previous = current;
  }
  return previous[right.length];
}

export interface FuzzyMatchCandidate {
  companyName: string;
  roleTitle: string;
  location?: string;
}

// Threshold policy (B3c, documented here as the normative statement): role
// titles compare in normalized form and merge when EITHER rule holds.
//  1. Scaled character distance: levenshtein <= max(base, floor(longer/10)).
//     Typical titles (<=29 chars) keep the historical threshold of 2; longer
//     titles relax gradually so a typo cluster in a 40-char title still
//     merges instead of silently forking a duplicate record.
//  2. Token-subset containment: every word of the shorter title appears in
//     the longer one with at most two extra words. Covers cross-board
//     qualifier additions ("... Engineer" vs "... Engineer, Infrastructure")
//     regardless of length. One-word substitutions ("Platform" vs "Data")
//     are NOT subsets and correctly refuse to merge.
const maxTokenSubsetExtraWords = 2;

function scaledTitleThreshold(baseThreshold: number, longerLength: number): number {
  return Math.max(baseThreshold, Math.floor(longerLength / 10));
}

// Word gap when every word of the shorter title appears in the longer one,
// or null when the shorter title has a word the longer one lacks (a
// substitution, not a qualification — never a merge on its own).
function titleTokenSubsetWordGap(shorterTitle: string, longerTitle: string): number | null {
  const longerWords = longerTitle.split(' ').filter((token) => token.length > 0);
  const longerTokens = new Set(longerWords);
  const shorterTokens = shorterTitle.split(' ').filter((token) => token.length > 0);
  for (const token of shorterTokens) {
    if (!longerTokens.has(token)) {
      return null;
    }
  }
  return longerWords.length - shorterTokens.length;
}

export function isFuzzyDuplicate(
  candidate: FuzzyMatchCandidate,
  existing: FuzzyMatchCandidate,
  fuzzyThreshold: number = defaultFuzzyThreshold,
): boolean {
  if (normalizeCompanyName(candidate.companyName) !== normalizeCompanyName(existing.companyName)) {
    return false;
  }
  const candidateTitle = normalizeRoleTitle(candidate.roleTitle);
  const existingTitle = normalizeRoleTitle(existing.roleTitle);
  const titleDistance = levenshteinDistance(candidateTitle, existingTitle);
  const longerLength = Math.max(candidateTitle.length, existingTitle.length);
  if (titleDistance <= scaledTitleThreshold(fuzzyThreshold, longerLength)) {
    return locationsMatch(candidate.location, existing.location);
  }
  const [shorterTitle, longerTitle] =
    candidateTitle.length <= existingTitle.length
      ? [candidateTitle, existingTitle]
      : [existingTitle, candidateTitle];
  const wordGap = titleTokenSubsetWordGap(shorterTitle, longerTitle);
  if (wordGap !== null && wordGap <= maxTokenSubsetExtraWords) {
    return locationsMatch(candidate.location, existing.location);
  }
  return false;
}

function addSource(sourceAggregators: string[], source: string): string[] {
  if (!sourceAggregators.includes(source)) {
    sourceAggregators.push(source);
  }
  return sourceAggregators;
}

function toMergedPosting(
  posting: RawPosting,
  postingHash: string,
  matchKind: DuplicateMatchKind,
  matchedApplicationId: string | null,
  matchedPostingHash: string,
  sourceAggregators: string[],
): MergedPosting {
  return {
    postingHash,
    companyName: posting.companyName,
    roleTitle: posting.roleTitle,
    location: posting.location,
    jobUrl: posting.jobUrl,
    matchKind,
    matchedApplicationId,
    matchedPostingHash,
    sourceAggregators: [...sourceAggregators],
  };
}

export async function deduplicatePostings(
  postings: RawPosting[],
  options: DeduplicateOptions = {},
): Promise<DeduplicationResult> {
  const history = await readApplicationHistory(options.historyPath, options.rootDir);
  const fuzzyThreshold = options.fuzzyThreshold ?? defaultFuzzyThreshold;

  const uniquePostings: DeduplicatedPosting[] = [];
  const mergedPostings: MergedPosting[] = [];
  const changedHistoryIds = new Set<string>();

  for (const posting of postings) {
    const postingHash = computePostingHash(posting.companyName, posting.roleTitle, posting.location);

    const batchExact = uniquePostings.find((candidate) => candidate.postingHash === postingHash);
    if (batchExact !== undefined) {
      addSource(batchExact.sourceAggregators, posting.sourceAggregator);
      mergedPostings.push(
        toMergedPosting(
          posting,
          postingHash,
          'withinBatch',
          null,
          postingHash,
          batchExact.sourceAggregators,
        ),
      );
      continue;
    }

    const batchFuzzy = uniquePostings.find((candidate) =>
      isFuzzyDuplicate(posting, candidate, fuzzyThreshold),
    );
    if (batchFuzzy !== undefined) {
      addSource(batchFuzzy.sourceAggregators, posting.sourceAggregator);
      mergedPostings.push(
        toMergedPosting(
          posting,
          postingHash,
          'fuzzyRoleTitle',
          null,
          batchFuzzy.postingHash,
          batchFuzzy.sourceAggregators,
        ),
      );
      continue;
    }

    const historyExact = history.applications.find((record) => record.postingHash === postingHash);
    if (historyExact !== undefined) {
      addSource(historyExact.sourceAggregators, posting.sourceAggregator);
      changedHistoryIds.add(historyExact.applicationId);
      mergedPostings.push(
        toMergedPosting(
          posting,
          postingHash,
          'exactHash',
          historyExact.applicationId,
          postingHash,
          historyExact.sourceAggregators,
        ),
      );
      continue;
    }

    const historyFuzzy = history.applications.find((record) =>
      isFuzzyDuplicate(posting, record, fuzzyThreshold),
    );
    if (historyFuzzy !== undefined) {
      addSource(historyFuzzy.sourceAggregators, posting.sourceAggregator);
      changedHistoryIds.add(historyFuzzy.applicationId);
      mergedPostings.push(
        toMergedPosting(
          posting,
          postingHash,
          'fuzzyRoleTitle',
          historyFuzzy.applicationId,
          historyFuzzy.postingHash,
          historyFuzzy.sourceAggregators,
        ),
      );
      continue;
    }

    uniquePostings.push({
      sourceAggregators: [posting.sourceAggregator],
      companyName: posting.companyName,
      roleTitle: posting.roleTitle,
      location: posting.location,
      jobUrl: posting.jobUrl,
      postingHash,
      description: posting.description,
      postedAt: posting.postedAt,
    });
  }

  if (changedHistoryIds.size > 0) {
    await writeApplicationHistory(history, options.historyPath, options.rootDir);
  }

  return { uniquePostings, mergedPostings };
}
