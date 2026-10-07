// Search orchestration (Phase 7a seam, extracted from jobSearchCore.ts with
// zero behavior change): the cache -> dedup -> evaluate -> persist pipeline
// shared by the search/evaluate/digest CLI commands and the MCP tools. The
// CLI command wrappers (runSearchCommand, runDigestCommand,
// runEvaluateCommand) stay in jobSearchCore.ts as a thin dispatcher; this
// module owns the pipeline. Nothing here chains into generate or drafting
// (SDD Section 1.5): evaluation persists tracking records only.

import { join, resolve } from 'node:path';
import { generateResume, loadMasterProfile, type GenerateResumeResult } from '../generators/resumeGenerator';
import {
  evaluateFit,
  loadJobPreferences,
  type CandidateCapabilities,
  type FitAssessment,
  type JobPreferences,
  type PostingFacts,
} from '../evaluators/fitEvaluator';
import { classifyLocationType, extractPostingFacts } from '../evaluators/postingFactsExtractor';
import { compensationFromPosting } from '../evaluators/compExtractor';
import { extractPostingRequirements } from '../evaluators/postingRequirementsExtractor';
import { candidateCapabilitiesFromProfile } from '../evaluators/profileCapabilitiesExtractor';
import { generateBrief } from '../generators/briefGenerator';
import { deduplicatePostings } from '../dedup/postingDeduplicator';
import {
  defaultSearchCacheTtlMinutes,
  getCachedSearch,
  putCachedSearch,
} from '../utils/searchCache';
import {
  masterProfileFileName,
  resolveDataRoot,
  savedSearchesFileName,
  searchCacheFileName,
  searchHistoryFileName,
  assertConfinedToRoot,
  type DirectoryOverrides,
} from '../utils/canonicalDataRoot';
import {
  createDefaultRegistry,
  type JobSpyAdapterRegistry,
  type RawPosting,
  type SourceSearchResult,
} from '../scrapers/jobSpyAdapter';
import {
  DuplicateApplicationError,
  computePostingHash,
  generateApplicationId,
  logApplication,
  markResumeGenerated,
  readApplicationHistory,
  resolveApplicationHistoryPath,
  type ApplicationRecord,
  type PostingFactsRecord,
} from '../utils/jobFunnelTracker';
import { readSavedSearches } from '../utils/savedSearches';
import { generateSearchHistoryId, recordSearch } from '../utils/searchHistory';
import {
  formatScrapeResults,
  type ActiveResultsTable,
  type EvaluatedPosting,
} from '../reporting/scrapeResultsFormatter';
import {
  formatExcludedResults,
  type ExcludedResultsTable,
} from '../reporting/excludedResultsFormatter';

export interface EvaluationDependencies {
  registry?: JobSpyAdapterRegistry;
  // Config-driven directories (v0.2.1 Lane A): explicit CLI-level data root
  // plus the directories block from jobPreferences.yaml.
  dataRoot?: string;
  directories?: DirectoryOverrides;
}

export interface ResolvedEvaluationContext {
  registry: JobSpyAdapterRegistry;
  candidate: CandidateCapabilities;
  preferences: JobPreferences;
  historyPath: string;
  dataRoot: string;
}

export async function resolveEvaluationContext(
  dependencies: EvaluationDependencies = {},
): Promise<ResolvedEvaluationContext> {
  const dataRoot = resolveDataRoot(dependencies.dataRoot, dependencies.directories);
  const profile = await loadMasterProfile(join(dataRoot, masterProfileFileName), dataRoot);
  const candidate = candidateCapabilitiesFromProfile(profile);
  const preferences = await loadJobPreferences(join(dataRoot, 'jobPreferences.yaml'));
  const historyPath = resolveApplicationHistoryPath(undefined, dataRoot);
  assertConfinedToRoot(dataRoot, historyPath, 'resolveEvaluationContext');
  return {
    registry: dependencies.registry ?? createDefaultRegistry(),
    candidate,
    preferences,
    historyPath,
    dataRoot,
  };
}

export interface PersistedEvaluation {
  entry: EvaluatedPosting;
  record: ApplicationRecord;
  alreadyRecorded: boolean;
}

function buildApplicationRecord(
  posting: RawPosting,
  sourceAggregators: string[],
  assessment: FitAssessment,
  postingFacts: PostingFacts,
): ApplicationRecord {
  return {
    applicationId: generateApplicationId(posting.companyName, posting.roleTitle),
    companyName: posting.companyName,
    roleTitle: posting.roleTitle,
    jobUrl: posting.jobUrl,
    postingHash: computePostingHash(posting.companyName, posting.roleTitle, posting.location),
    sourceAggregators: [...sourceAggregators],
    salaryRange: posting.rawSalaryText ?? null,
    fitScore: assessment.fitScore,
    fitStatus: assessment.fitStatus,
    referralContact: null,
    status: 'evaluated',
    statusHistory: [{ stage: 'evaluated', timestamp: new Date().toISOString() }],
    postingDescription: posting.description,
    postingFacts: {
      locationType: postingFacts.locationType,
      employerType: postingFacts.employerType ?? undefined,
      requiredClearanceLevel: postingFacts.requiredClearanceLevel ?? undefined,
    } as PostingFactsRecord,
  };
}

// Persistence is idempotent per SDD Requirement 4's evaluation-persistence
// sub-note and Requirement 7: dedup runs before evaluation, so a posting
// already logged (same postingHash) is never written twice. History matches
// decided by dedup (exact hash or fuzzy title) arrive with a non-null
// matchedApplicationId and skip the write entirely: the posting is
// re-evaluated for a fresh assessment, but no second record is created under
// a different hash. Identity is hash primary (A2): the postingHash read is
// the primary guard, and logApplication's duplicate error is the backstop
// against a concurrent same-hash write in a sequential batch.
// Returns true when the posting was already present (no duplicate written).
async function persistEvaluationIfNew(
  record: ApplicationRecord,
  historyPath: string,
  rootDir?: string | null,
): Promise<boolean> {
  const history = await readApplicationHistory(historyPath, rootDir);
  if (history.applications.some((existing) => existing.postingHash === record.postingHash)) {
    return true;
  }
  try {
    await logApplication(record, historyPath, rootDir);
    return false;
  } catch (error) {
    // Phase D: typed idempotency check. The pre-write hash guard above is the
    // primary signal; the duplicate error is the backstop against a
    // concurrent same-hash write. Matched by class, never by message
    // substring, so message rewording cannot silently break this path.
    if (error instanceof DuplicateApplicationError) {
      return true;
    }
    throw error;
  }
}

export async function evaluateAndPersistPosting(
  posting: RawPosting,
  sourceAggregators: string[],
  context: ResolvedEvaluationContext,
  matchedApplicationId: string | null,
): Promise<PersistedEvaluation> {
  const requirements = extractPostingRequirements(posting);
  const postingFacts = extractPostingFacts(posting);
  const assessment = evaluateFit({
    posting,
    requirements,
    candidate: context.candidate,
    preferences: context.preferences,
    postingFacts,
  });
  const brief = generateBrief(posting.description);
  const entry: EvaluatedPosting = { posting, brief, assessment };
  const record = buildApplicationRecord(posting, sourceAggregators, assessment, postingFacts);
  if (matchedApplicationId !== null) {
    return { entry, record, alreadyRecorded: true };
  }
  const alreadyRecorded = await persistEvaluationIfNew(record, context.historyPath, context.dataRoot);
  return { entry, record, alreadyRecorded };
}

export interface SingleEvaluationOutcome {
  posting: RawPosting;
  entry: EvaluatedPosting;
  record: ApplicationRecord;
  alreadyRecorded: boolean;
}

// fetchPostingByUrl + dedup + evaluate + persist for exactly one URL,
// shared by the evaluate CLI command and the evaluateJobPosting MCP tool
// (SDD Requirement 4 / Section 4.2). Throws on unsupported URLs and malformed
// input so the caller can surface a clear error; persistence is idempotent.
export async function evaluateJobPosting(
  jobUrl: string,
  dependencies: EvaluationDependencies = {},
): Promise<SingleEvaluationOutcome> {
  const context = await resolveEvaluationContext(dependencies);
  const posting = await context.registry.fetchPostingByUrl(jobUrl);
  const pending = await evaluateBatchToEvaluate([posting], context);
  if (pending.length === 0) {
    throw new Error(`No posting returned for the given URL; nothing evaluated.`);
  }
  const result = await evaluateAndPersistPosting(
    pending[0].posting,
    pending[0].sourceAggregators,
    context,
    pending[0].matchedApplicationId,
  );
  return {
    posting: pending[0].posting,
    entry: result.entry,
    record: result.record,
    alreadyRecorded: result.alreadyRecorded,
  };
}

export interface SearchBatchOutcome {
  results: SourceSearchResult[];
  entries: EvaluatedPosting[];
  newRecords: number;
  alreadyRecorded: number;
  evaluatedCount: number;
  // Phase 6b stale flag: true when results came from the search cache
  // (fully or partially), false after a live scrape. Optional because merged
  // multi-query outcomes (searchByProfile, digest) mix both paths.
  servedFromCache?: boolean;
}

// Search-time filters (SRA-04, goal G6): applied AFTER evaluation and
// persistence, BEFORE display, so the fixed result tables keep their exact
// column contracts and only reduce rows. Persistence is unaffected - every
// uniquely-evaluated posting is still logged (Requirement 4 sub-note).
export interface SearchFilters {
  remoteOnly?: boolean;
  minFit?: number;
  minSalary?: number;
  maxAgeDays?: number;
}

function applySearchFilters(entries: EvaluatedPosting[], filters: SearchFilters): EvaluatedPosting[] {
  if (
    filters.remoteOnly !== true &&
    filters.minFit === undefined &&
    filters.minSalary === undefined &&
    filters.maxAgeDays === undefined
  ) {
    return entries;
  }
  return entries.filter((entry) => {
    if (filters.remoteOnly === true && classifyLocationType(entry.posting.location) !== 'remote') {
      return false;
    }
    if (filters.minFit !== undefined && entry.assessment.fitScore < filters.minFit) {
      return false;
    }
    if (filters.minSalary !== undefined) {
      const compensation = compensationFromPosting(entry.posting);
      if (
        compensation !== null &&
        compensation.minAmount !== null &&
        compensation.minAmount < filters.minSalary
      ) {
        return false;
      }
    }
    if (filters.maxAgeDays !== undefined && entry.posting.postedAt !== null) {
      const postedAt = Date.parse(entry.posting.postedAt);
      if (Number.isFinite(postedAt)) {
        const ageDays = (Date.now() - postedAt) / 86_400_000;
        if (ageDays > filters.maxAgeDays) {
          return false;
        }
      }
    }
    return true;
  });
}

// Phase 6b: honest skip notice for a source recorded as failed in the cached
// partial batch being served. The source retries automatically once the cache
// entry expires; nothing about the skip is silent.
function partialCacheSkipMessage(sourceName: string): string {
  return (
    `Source '${sourceName}' skipped on this run: serving the last-good cached search, ` +
    `which was stored as a partial result because '${sourceName}' errored in that run. ` +
    `'${sourceName}' retries automatically once the cache entry expires.`
  );
}

export async function runSearchBatch(
  keywords: string,
  location: string,
  dependencies: EvaluationDependencies = {},
  filters: SearchFilters = {},
): Promise<SearchBatchOutcome> {
  const context = await resolveEvaluationContext(dependencies);

  // EUO-08 (G7): when the caller omits location, default to the first
  // preferredLocations entry. Pure default propagation (N2) - no chaining, no
  // other behavior change. Resolved BEFORE the cache lookup so the cache key
  // and the registry call both use the resolved location.
  const resolvedLocation =
    location.trim().length === 0 ? context.preferences.preferredLocations[0] ?? '' : location;

  // Search result caching (SRA-06): an identical keyword/location query within
  // the configured freshness window returns the cached raw scrape results
  // instead of re-scraping. Only the raw per-source postings are cached -
  // dedup, evaluation, and idempotent persistence still run, so the outcome
  // contract and the application-history guarantees are unchanged. Phase 6b
  // decided policy: a fully successful scrape is cached; a mixed batch caches
  // the successful subset with failedSources so an immediate retry serves the
  // last-good cache (skips surfaced loudly below) instead of hammering the
  // failed source; a total failure is not cached, so it retries.
  const cacheRoot = context.dataRoot;
  const cachePath = join(cacheRoot, searchCacheFileName);
  assertConfinedToRoot(cacheRoot, cachePath, 'searchCache');
  const ttlMinutes =
    context.preferences.searchCacheTtlMinutes ?? defaultSearchCacheTtlMinutes;
  const cachedHit = await getCachedSearch({
    filePath: cachePath,
    keywords,
    location: resolvedLocation,
    ttlMinutes,
    rootDir: context.dataRoot,
  });
  let results: SourceSearchResult[];
  let servedFromCache = false;
  if (cachedHit !== null) {
    servedFromCache = true;
    results = [
      ...cachedHit.results.map(
        (source): SourceSearchResult => ({
          sourceName: source.sourceName,
          postings: source.postings,
          error: null,
        }),
      ),
      // Skipped sources are reported as explicit errors, never silently
      // dropped: the CLI prints them under Per-source fetch results.
      ...cachedHit.failedSources.map(
        (sourceName): SourceSearchResult => ({
          sourceName,
          postings: [],
          error: new Error(partialCacheSkipMessage(sourceName)),
        }),
      ),
    ];
  } else {
    results = await context.registry.searchAll(keywords, resolvedLocation);
    const failed = results.filter((source) => source.error !== null);
    const succeeded = results.filter((source) => source.error === null);
    if (failed.length === 0) {
      await putCachedSearch({
        filePath: cachePath,
        keywords,
        location: resolvedLocation,
        results,
        rootDir: context.dataRoot,
      });
    } else if (succeeded.length > 0) {
      await putCachedSearch({
        filePath: cachePath,
        keywords,
        location: resolvedLocation,
        results: succeeded,
        failedSources: failed.map((source) => source.sourceName),
        rootDir: context.dataRoot,
      });
    }
  }
  const flat = results.flatMap((source) => source.postings);
  const pending = await evaluateBatchToEvaluate(flat, context);
  const entries: EvaluatedPosting[] = [];
  let newRecords = 0;
  let alreadyRecorded = 0;
  for (const candidateJob of pending) {
    const evaluated = await evaluateAndPersistPosting(
      candidateJob.posting,
      candidateJob.sourceAggregators,
      context,
      candidateJob.matchedApplicationId,
    );
    entries.push(evaluated.entry);
    if (evaluated.alreadyRecorded) {
      alreadyRecorded += 1;
    } else {
      newRecords += 1;
    }
  }
  const evaluatedCount = entries.length;

  // Search history persistence (EUO-13, G7): every completed search is
  // recorded with the resolved location and the unique result count, on BOTH
  // the cache-hit and fresh-scrape paths (the user ran a search either way).
  // Idempotent: an identical query (same searchId) updates its entry instead
  // of duplicating it. This is a tracking write, not a generation or outreach
  // action, so it does not violate Section 1.5's ask-don't-assume principle.
  const historyRoot = context.dataRoot;
  const searchHistoryPath = join(historyRoot, searchHistoryFileName);
  assertConfinedToRoot(historyRoot, searchHistoryPath, 'searchHistory');
  await recordSearch(
    {
      searchId: generateSearchHistoryId(keywords, resolvedLocation),
      keywords,
      location: resolvedLocation,
      timestamp: new Date().toISOString(),
      resultCount: evaluatedCount,
    },
    searchHistoryPath,
    historyRoot,
  );

  return {
    results,
    entries: applySearchFilters(entries, filters),
    newRecords,
    alreadyRecorded,
    evaluatedCount,
    servedFromCache,
  };
}

export interface SearchResultsOutcome extends SearchBatchOutcome {
  activeResults: ActiveResultsTable;
  excludedResults: ExcludedResultsTable;
}

export async function searchJobPostings(
  keywords: string,
  location: string,
  dependencies: EvaluationDependencies = {},
  filters: SearchFilters = {},
): Promise<SearchResultsOutcome> {
  const outcome = await runSearchBatch(keywords, location, dependencies, filters);
  return {
    ...outcome,
    activeResults: formatScrapeResults(outcome.entries),
    excludedResults: formatExcludedResults(outcome.entries),
  };
}

// Profile-driven search (EUO-05): builds one keyword query per targetRoles
// entry (role title plus the top profile skills), or a skills-derived fallback
// query when targetRoles is empty. Deterministic construction (N7): the role
// title is quoted as a phrase and the top skills are taken in profile order,
// so identical profiles always produce identical queries. A plain mapping of
// profile signals to query text - no scoring, no LLM.
export function buildProfileQueries(targetRoles: string[], skills: string[]): string[] {
  if (targetRoles.length > 0) {
    const topSkills = skills.slice(0, 3);
    return targetRoles.map((role) => `"${role}" ${topSkills.join(' ')}`.trim());
  }
  if (skills.length === 0) {
    return [];
  }
  return [skills.slice(0, 5).join(' ')];
}

export interface SearchByProfileOutcome extends SearchResultsOutcome {
  /** The exact keyword queries that were run, in order. */
  queries: string[];
  /** The location term used for every query (preferredLocations[0] or ''). */
  location: string;
}

// MCP tool handler (SDD Section 4.2) and core entry point for EUO-05: reads
// targetRoles + preferredLocations from jobPreferences.yaml and skills from
// masterProfile.md, runs one searchJobPostings call per derived query with the
// SAME dependencies (so history/cache/persistence behave identically), merges
// the per-query entries, deduplicates across queries by postingHash (the same
// hash the dedup path uses), and renders BOTH fixed result tables from the
// merged set via the shared formatters (N8). Explicitly user-invoked; it never
// auto-runs generation, drafting, or anything else (N2).
export async function searchByProfile(
  dependencies: EvaluationDependencies = {},
): Promise<SearchByProfileOutcome> {
  const dataRoot = resolveDataRoot(dependencies.dataRoot, dependencies.directories);
  const profile = await loadMasterProfile(join(dataRoot, masterProfileFileName), dataRoot);
  const capabilities = candidateCapabilitiesFromProfile(profile);
  const preferences = await loadJobPreferences(join(dataRoot, 'jobPreferences.yaml'));
  const targetRoles = preferences.targetRoles ?? [];
  const queries = buildProfileQueries(targetRoles, capabilities.skills);
  if (queries.length === 0) {
    throw new Error(
      'No target roles or skills found in the profile; nothing to search for. Add targetRoles to jobPreferences.yaml or skills to masterProfile.md.',
    );
  }
  const location = preferences.preferredLocations[0] ?? '';

  const allResults: SourceSearchResult[] = [];
  const seenHashes = new Set<string>();
  const entries: EvaluatedPosting[] = [];
  let newRecords = 0;
  let alreadyRecorded = 0;
  for (const query of queries) {
    const outcome = await searchJobPostings(query, location, dependencies);
    allResults.push(...outcome.results);
    newRecords += outcome.newRecords;
    alreadyRecorded += outcome.alreadyRecorded;
    for (const entry of outcome.entries) {
      const hash = computePostingHash(
        entry.posting.companyName,
        entry.posting.roleTitle,
        entry.posting.location,
      );
      if (!seenHashes.has(hash)) {
        seenHashes.add(hash);
        entries.push(entry);
      }
    }
  }
  return {
    results: allResults,
    entries,
    newRecords,
    alreadyRecorded,
    evaluatedCount: entries.length,
    activeResults: formatScrapeResults(entries),
    excludedResults: formatExcludedResults(entries),
    queries,
    location,
  };
}

export async function runSavedSearchesDigest(
  dependencies: EvaluationDependencies & { savedSearchesPath?: string } = {},
): Promise<SearchResultsOutcome> {
  const digestRoot = dependencies.dataRoot === undefined ? undefined : resolve(dependencies.dataRoot);
  const savedSearches = await readSavedSearches(
    dependencies.savedSearchesPath ?? join(digestRoot ?? resolveDataRoot(), savedSearchesFileName),
    digestRoot,
  );
  if (savedSearches.searches.length === 0) {
    return {
      results: [],
      entries: [],
      newRecords: 0,
      alreadyRecorded: 0,
      evaluatedCount: 0,
      activeResults: formatScrapeResults([]),
      excludedResults: formatExcludedResults([]),
    };
  }
  const allResults: SourceSearchResult[] = [];
  const seenHashes = new Set<string>();
  const entries: EvaluatedPosting[] = [];
  let newRecords = 0;
  let alreadyRecorded = 0;
  for (const savedSearch of savedSearches.searches) {
    const outcome = await searchJobPostings(
      savedSearch.keywords,
      savedSearch.location ?? '',
      dependencies,
    );
    allResults.push(...outcome.results);
    newRecords += outcome.newRecords;
    alreadyRecorded += outcome.alreadyRecorded;
    for (const entry of outcome.entries) {
      const hash = computePostingHash(
        entry.posting.companyName,
        entry.posting.roleTitle,
        entry.posting.location,
      );
      if (!seenHashes.has(hash)) {
        seenHashes.add(hash);
        entries.push(entry);
      }
    }
  }
  return {
    results: allResults,
    entries,
    newRecords,
    alreadyRecorded,
    evaluatedCount: entries.length,
    activeResults: formatScrapeResults(entries),
    excludedResults: formatExcludedResults(entries),
  };
}

export interface GenerateForRoleOptions {
  explicitVariant?: string;
  dataRoot?: string;
  /**
   * Explicit history file override (the MCP server injects one per test and
   * per deployment). Falls back to the dataRoot-derived default, which is
   * what the CLI uses.
   */
  historyPath?: string;
}

export interface GenerateForRoleOutcome {
  result: GenerateResumeResult;
  /** Ids of records advanced to generated (evaluated or already generated). */
  markedApplicationIds: string[];
  /**
   * Ids of records skipped because their status is past generation
   * (appliedConfirmed, interviewing, offer, staleNoResponse, rejected). They
   * are reported, never regressed (A3).
   */
  skippedApplicationIds: string[];
}

// A1: the single generate seam. The CLI runGenerate command and the MCP
// generateTailoredApplication tool both delegate here, so the history mutation
// is identical on both surfaces. Before this seam the CLI never marked history
// at all while the MCP marked it only when a record happened to exist, which
// left pattern analysis with null variant tags for CLI-generated resumes.
// The seam runs selectVariant + generateResume + markResumeGenerated with the
// same arguments on every call. It never reads jobPreferences (the generate
// path needs no preference data) and never chains into drafting, evaluation,
// or confirmation (SDD Section 1.5).
export async function generateForRole(
  companyName: string,
  roleTitle: string,
  options: GenerateForRoleOptions = {},
): Promise<GenerateForRoleOutcome> {
  const result = await generateResume({
    companyName,
    roleTitle,
    explicitVariant: options.explicitVariant,
    dataRoot: options.dataRoot,
  });
  const historyPath = options.historyPath ?? resolveApplicationHistoryPath(undefined, options.dataRoot);
  const history = await readApplicationHistory(historyPath, options.dataRoot);
  const applicationId = generateApplicationId(companyName, roleTitle);
  const markedApplicationIds: string[] = [];
  const skippedApplicationIds: string[] = [];
  for (const record of history.applications) {
    if (record.applicationId !== applicationId) {
      continue;
    }
    // A2: the same company and role can legitimately have one record per city
    // (same applicationId, distinct postingHash). The resume is company+role
    // scoped, so every forward-state record is marked through its unambiguous
    // (id, postingHash) target; records past generation are skipped, never
    // regressed (A3).
    if (record.status !== 'evaluated' && record.status !== 'generated') {
      skippedApplicationIds.push(record.applicationId);
      continue;
    }
    await markResumeGenerated(
      record.applicationId,
      result.variantName,
      historyPath,
      options.dataRoot,
      record.postingHash,
    );
    markedApplicationIds.push(record.applicationId);
  }
  return { result, markedApplicationIds, skippedApplicationIds };
}

async function evaluateBatchToEvaluate(
  postings: RawPosting[],
  context: ResolvedEvaluationContext,
): Promise<{ posting: RawPosting; sourceAggregators: string[]; matchedApplicationId: string | null }[]> {
  const dedup = await deduplicatePostings(postings, {
    historyPath: context.historyPath,
    rootDir: context.dataRoot,
  });
  const originalByHash = new Map<string, RawPosting>();
  for (const posting of postings) {
    const hash = computePostingHash(posting.companyName, posting.roleTitle, posting.location);
    if (!originalByHash.has(hash)) {
      originalByHash.set(hash, posting);
    }
  }
  const toEvaluate: { posting: RawPosting; sourceAggregators: string[]; matchedApplicationId: string | null }[] = [];
  for (const unique of dedup.uniquePostings) {
    const raw = originalByHash.get(unique.postingHash);
    if (raw !== undefined) {
      toEvaluate.push({ posting: raw, sourceAggregators: unique.sourceAggregators, matchedApplicationId: null });
    }
  }
  for (const merge of dedup.mergedPostings) {
    if (merge.matchedApplicationId === null) {
      continue;
    }
    const raw = originalByHash.get(merge.postingHash);
    if (raw !== undefined) {
      toEvaluate.push({
        posting: raw,
        sourceAggregators: merge.sourceAggregators,
        matchedApplicationId: merge.matchedApplicationId,
      });
    }
  }
  // A within-batch duplicate that ALSO matched the application history on a
  // rerun arrives as an extra merged entry with the same postingHash as its
  // batch twin. Collapse so every unique posting is evaluated exactly once
  // and the count remains deterministic across runs.
  const deduplicated: { posting: RawPosting; sourceAggregators: string[]; matchedApplicationId: string | null }[] = [];
  const evaluatedHashes = new Set<string>();
  for (const candidateJob of toEvaluate) {
    const hash = computePostingHash(
      candidateJob.posting.companyName,
      candidateJob.posting.roleTitle,
      candidateJob.posting.location,
    );
    if (evaluatedHashes.has(hash)) {
      continue;
    }
    evaluatedHashes.add(hash);
    deduplicated.push(candidateJob);
  }
  return deduplicated;
}
