import { join, resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import {
  generateResumePreview,
  loadMasterProfile,
  parseResumeVariants,
  ResumeGenerationError,
} from '../generators/resumeGenerator';
import {
  CoverLetterGenerationError,
  draftCoverLetter,
} from '../generators/coverLetterGenerator';
import {
  draftOutreachMessage as draftOutreachPackageMessage,
  OutreachGenerationError,
} from '../generators/outreachMessageGenerator';
import { exportDataRoot, importDataRoot, type ImportResult } from '../utils/dataPortability';
import { ProfileConfirmationRequiredError } from '../utils/profileService';
import {
  inventoryDataRoot,
  wipeDataRoot,
  type WipeDataRootResult,
} from '../utils/profileWiper';
import { parsePdfDocument } from '../utils/pdfParser';
import {
  generateApplicationId,
  readApplicationHistory,
  resolveApplicationHistoryPath,
  updateApplicationStatus,
  type ApplicationRecord,
  type ApplicationStatus,
} from '../utils/jobFunnelTracker';
import { addSavedSearch, readSavedSearches } from '../utils/savedSearches';
import { savedSearchesFileName } from '../utils/canonicalDataRoot';
import {
  activeResultsToMarkdown,
  formatScrapeResults,
  isActiveFitStatus,
  renderMarkdown,
  type EvaluatedPosting,
} from '../reporting/scrapeResultsFormatter';
import {
  excludedResultsToMarkdown,
  formatExcludedResults,
} from '../reporting/excludedResultsFormatter';
import {
  addNetworkingContact,
  type NetworkingContact,
  type NewContactInput,
} from '../utils/networkingContacts';
import { networkingContactsFileName, redactHomePrefix, resolveDataRoot, resumeVariantsFileName } from '../utils/canonicalDataRoot';
import {
  loadFunnelReport,
  formatFunnelReportTable,
  writeFunnelReportToFile,
  redactFunnelReport,
  identitiesShownNote,
  type FunnelReport,
} from '../reporting/funnelReporter';
import {
  formatReviewQueue,
  reviewQueueToMarkdown,
} from '../reporting/reviewQueueFormatter';
import { loadJobPreferences, parseJobPreferences } from '../evaluators/fitEvaluator';
import { extractPostingRequirements } from '../evaluators/postingRequirementsExtractor';
import type { RawPosting } from '../scrapers/jobSpyAdapter';
import { candidateCapabilitiesFromProfile } from '../evaluators/profileCapabilitiesExtractor';
import { suggestRoles } from '../evaluators/roleSuggester';
import { analyzeApplicationPatterns, type PatternSuggestion } from '../reporting/patternAnalyzer';
import {
  createCliPromptContext,
  InitCancelledError,
  runInitWizard,
  SetupValidationError,
  type PromptContext,
} from './initWizard';
import {
  evaluateJobPosting,
  generateForRole,
  runSavedSearchesDigest,
  searchByProfile,
  searchJobPostings,
} from '../core/searchOrchestrator';
import type {
  ParsedAddContactArgs,
  ParsedConfirmAppArgs,
  ParsedCoverLetterArgs,
  ParsedDigestArgs,
  ParsedEvaluateArgs,
  ParsedExportDataArgs,
  ParsedGenerateArgs,
  ParsedImportDataArgs,
  ParsedInitArgs,
  ParsedOutreachArgs,
  ParsedPdfArgs,
  ParsedPreviewResumeArgs,
  ParsedReportArgs,
  ParsedReviewArgs,
  ParsedReviewQueueArgs,
  ParsedSearchArgs,
  ParsedShowArgs,
  ParsedUpdateStatusArgs,
  ParsedValidateArgs,
  ParsedWipeProfileArgs,
} from './argsParser';

// Compatibility re-exports (Phase 7a): argument parsing lives in
// ./argsParser and search orchestration in ../core/searchOrchestrator. The
// MCP server and existing tests resolve these names through this dispatcher,
// so every pre-extraction export keeps working from this path.
export {
  parseAddContactArgs,
  parseConfirmAppArgs,
  parseCoverLetterArgs,
  parseDigestArgs,
  parseEvaluateArgs,
  parseExportDataArgs,
  parseGenerateArgs,
  parseImportDataArgs,
  parseInitArgs,
  parseOutreachArgs,
  parsePdfArgs,
  parsePreviewResumeArgs,
  parseReportArgs,
  parseReviewArgs,
  parseReviewQueueArgs,
  parseSearchArgs,
  parseShowArgs,
  parseUpdateStatusArgs,
  parseValidateArgs,
  parseWipeProfileArgs,
} from './argsParser';
export type {
  ParsedAddContactArgs,
  ParsedConfirmAppArgs,
  ParsedCoverLetterArgs,
  ParsedDigestArgs,
  ParsedEvaluateArgs,
  ParsedExportDataArgs,
  ParsedGenerateArgs,
  ParsedImportDataArgs,
  ParsedInitArgs,
  ParsedOutreachArgs,
  ParsedPdfArgs,
  ParsedPreviewResumeArgs,
  ParsedReportArgs,
  ParsedReviewArgs,
  ParsedReviewQueueArgs,
  ParsedSearchArgs,
  ParsedShowArgs,
  ParsedUpdateStatusArgs,
  ParsedValidateArgs,
  ParsedWipeProfileArgs,
} from './argsParser';
export {
  buildProfileQueries,
  evaluateAndPersistPosting,
  evaluateJobPosting,
  generateForRole,
  resolveEvaluationContext,
  runSavedSearchesDigest,
  runSearchBatch,
  searchByProfile,
  searchJobPostings,
} from '../core/searchOrchestrator';
// Phase E thin-dispatcher split: dispatchCli plus the per-command help texts
// live in ./cliDispatcher (which imports the run* handlers above from here).
// The re-export below keeps every pre-split import path working.
export { dispatchCli } from './cliDispatcher';
// Phase G thin-bridge re-exports: the MCP server may not import the engine
// layers directly (enforced by the mcp import graph guard in
// src/utils/importGraph.test.ts), so the seams its tools delegate to are
// re-exported here from the same CLI core module every CLI command uses.
export { parsePdfDocument } from '../utils/pdfParser';
export { ingestDocuments } from '../utils/documentIngestor';
export { jobPreferencesSchema } from '../evaluators/fitEvaluator';
export {
  initializeUserProfile,
  masterProfileInputSchema,
  readUserProfile,
  updateUserProfile,
} from '../utils/profileService';
export type { ProfileWriteResult } from '../utils/profileService';
import { dispatchCli } from './cliDispatcher';
import {
  addContactHelpText,
  confirmAppHelpText,
  digestHelpText,
  exportDataHelpText,
  importDataHelpText,
  initHelpText,
  parsePdfHelpText,
  reportHelpText,
  reviewQueueHelpText,
  showHelpText,
  updateStatusHelpText,
  validateHelpText,
  wipeProfileHelpText,
} from './cliDispatcher';
export type {
  EvaluationDependencies,
  PersistedEvaluation,
  ResolvedEvaluationContext,
  SearchBatchOutcome,
  SearchByProfileOutcome,
  SearchFilters,
  SearchResultsOutcome,
  SingleEvaluationOutcome,
} from '../core/searchOrchestrator';

// Pure CLI engine entry point (SDD Section 4.1). Every entry in
// commandNames below is wired to real logic in dispatchCli in
// ./cliDispatcher (the CLI dead link contract test enforces this: menu,
// dispatch, and the unknown-command error all read from the single
// commandNames constant). Running the CLI with no subcommand shows the
// subcommand shows the available menu and does nothing else (SDD Section 1.5:
// no capability chains into another). Every capability is invoked explicitly
// by the user. Generating a resume never triggers cover letter drafting, and
// drafting a cover letter never triggers resume generation.

export interface CliDispatchResult {
  exitCode: number;
  printedLines: string[];
}

// B5 catch-all mapping: runners convert unexpected failures to exit 1 with
// the error message only — never a stack trace — and main() applies the same
// mapping to anything escaping dispatch. PII hygiene at the CLI boundary
// (residuals pass): every fatal message is redacted here, so throw sites that
// echo absolute paths are covered mechanically (redactHomePrefix is
// idempotent, so already-redacted messages pass through unchanged).
export function formatFatalError(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) {
    return redactHomePrefix(error.message);
  }
  return redactHomePrefix(String(error));
}

function exitOneWithMessage(error: unknown): CliDispatchResult {
  return { exitCode: 1, printedLines: [formatFatalError(error)] };
}

export const commandNames: readonly string[] = [
  'generate',
  'previewResume',
  'parsePdf',
  'evaluate',
  'search',
  'digest',
  'show',
  'review',
  'updateStatus',
  'confirmApp',
  'reviewQueue',
  'report',
  'addContact',
  'draftOutreach',
  'draftCoverLetter',
  'exportData',
  'importData',
  'init',
  'validate',
  'wipeProfile',
];

const oneLineSummaries: Record<string, string> = {
  generate: 'Generate a tailored 1-page resume (auto-selects variant)',
  previewResume: 'Render a 1-page resume preview from the profile (no target role)',
  parsePdf: 'Parse a local PDF resume or job description',
  evaluate: 'Evaluate a single posting and log it (dedup check first)',
  search: 'Search all sources (defaults to profile targetRoles when --keywords is omitted)',
  digest: 'Run every saved search, evaluate, and render both tables',
  show: 'Show stored detail for one evaluated posting',
  review: 'Review one posting with an explicit next-action menu',
  updateStatus: 'Record a status transition (interviewing|offer|rejected)',
  confirmApp: 'Confirm a submission and update history',
  reviewQueue: 'Review roles flagged for manual decision',
  report: 'Print funnel summary',
  addContact: 'Log a networking contact',
  draftOutreach: 'Draft an outreach message (never sent)',
  draftCoverLetter: 'Draft a cover letter (never auto-triggered)',
  exportData: 'Back up the canonical data root to a gzip tarball',
  importData: 'Restore a backup into a fresh canonical root (never overwrites)',
  init: 'Run the setup wizard',
  validate: 'Validate jobPreferences.yaml and resumeVariants.yaml configs',
  wipeProfile: 'Delete the whole canonical data root (typed confirmation + tar backup)',
};

const usageText = ['Usage: node dist/cli/jobSearchCore.js <command> [options]', "Try 'node dist/cli/jobSearchCore.js --help'."];

export function menuLines(): string[] {
  return [
    'weJobSearch CLI - deterministic job search engine (SDD docs/weJobSearch-SDD.md)',
    '',
    'Commands:',
    ...commandNames.map((name) => `  ${name.padEnd(16)} ${oneLineSummaries[name] ?? ''}`),
    '',
    ...usageText,
  ];
}

export async function runGenerate(args: ParsedGenerateArgs): Promise<CliDispatchResult> {
  const company = args.company ?? '';
  const role = args.role ?? '';
  try {
    // A1: single generate seam - the MCP generateTailoredApplication tool
    // delegates to the same core function, so both surfaces produce the same
    // history mutation (status plus variant tag).
    const outcome = await generateForRole(company, role, {
      explicitVariant: args.variant,
      dataRoot: args.dataRoot,
    });
    const lines = [
      `Resume generated for ${company} / ${role}.`,
      `Variant: ${outcome.result.variantName}`,
      `Pages: ${outcome.result.pageCount}`,
      `PDF: ${outcome.result.pdfPath}`,
      `Typst source: ${outcome.result.typPath}`,
    ];
    if (outcome.skippedApplicationIds.length > 0) {
      lines.push(
        `Skipped history update for ${outcome.skippedApplicationIds.join(', ')}: status is past generation; the record was left unchanged.`,
      );
    }
    return { exitCode: 0, printedLines: lines };
  } catch (error: unknown) {
    if (error instanceof ResumeGenerationError) {
      return { exitCode: 1, printedLines: [error.message] };
    }
    return exitOneWithMessage(error);
  }
}

export async function runPreviewResumeCommand(args: ParsedPreviewResumeArgs): Promise<CliDispatchResult> {
  try {
    const result = await generateResumePreview({
      explicitVariant: args.variant,
      dataRoot: args.dataRoot,
    });
    return {
      exitCode: 0,
      printedLines: [
        'Resume preview generated.',
        `Variant: ${result.variantName}`,
        `Pages: ${result.pageCount}`,
        `PDF: ${result.pdfPath}`,
        `Typst source: ${result.typPath}`,
      ],
    };
  } catch (error: unknown) {
    if (error instanceof ResumeGenerationError) {
      return { exitCode: 1, printedLines: [error.message] };
    }
    return exitOneWithMessage(error);
  }
}

interface ResolvedCoverLetterRequirements {
  requirements?: string[];
  source: 'explicit' | 'stored' | 'profileOnly';
}

function storedPostingRequirements(record: ApplicationRecord): string[] | undefined {
  const description = record.postingDescription?.trim() ?? '';
  if (description.length === 0) {
    return undefined;
  }
  const storedPosting: RawPosting = {
    sourceAggregator: record.sourceAggregators[0] ?? 'stored',
    companyName: record.companyName,
    roleTitle: record.roleTitle,
    location: '',
    jobUrl: record.jobUrl,
    description,
    hasFullDescription: true,
    postedAt: null,
  };
  const extracted = extractPostingRequirements(storedPosting);
  const requirements = [
    ...extracted.requiredSkills,
    ...extracted.requiredDomains,
    ...(extracted.requiredYearsOfExperience === null
      ? []
      : [`${extracted.requiredYearsOfExperience} years of experience`]),
  ];
  return [...new Set(requirements)];
}

// Findings 23/24: with no explicit requirements, read the stored posting for
// the matching record and run the deterministic extractor on it. Several
// matching records without a hash is an error, never a guess.
async function resolveCoverLetterRequirements(
  companyName: string,
  roleTitle: string,
  explicitRequirements: readonly string[] | undefined,
  postingHash: string | undefined,
  dataRoot: string | undefined,
): Promise<ResolvedCoverLetterRequirements> {
  if (explicitRequirements !== undefined && explicitRequirements.length > 0) {
    return { requirements: [...explicitRequirements], source: 'explicit' };
  }
  const historyPath = resolveApplicationHistoryPath(undefined, dataRoot);
  const history = await readApplicationHistory(historyPath, dataRoot);
  const applicationId = generateApplicationId(companyName, roleTitle);
  const matches = history.applications.filter(
    (application) => application.applicationId === applicationId,
  );
  if (postingHash !== undefined) {
    const exact = matches.find((application) => application.postingHash === postingHash);
    if (exact === undefined) {
      throw new Error(
        `No application record found with id ${applicationId} and postingHash ${postingHash}.`,
      );
    }
    return { requirements: storedPostingRequirements(exact), source: 'stored' };
  }
  if (matches.length > 1) {
    throw new Error(
      [
        ...describeApplicationMatches(applicationId, matches),
        'No cover letter was written because the posting cannot be chosen without a hash.',
      ].join('\n'),
    );
  }
  if (matches.length === 0) {
    return { source: 'profileOnly' };
  }
  const requirements = storedPostingRequirements(matches[0]);
  return requirements === undefined
    ? { source: 'profileOnly' }
    : { requirements, source: 'stored' };
}

export async function runDraftCoverLetter(args: ParsedCoverLetterArgs): Promise<CliDispatchResult> {
  const company = args.company ?? '';
  const role = args.role ?? '';
  try {
    const resolved = await resolveCoverLetterRequirements(
      company,
      role,
      args.postingRequirements,
      args.postingHash,
      args.dataRoot,
    );
    const result = await draftCoverLetter({
      companyName: company,
      roleTitle: role,
      postingRequirements: resolved.requirements,
      dataRoot: args.dataRoot,
    });
    const excluded = result.excludedTokens.length > 0 ? result.excludedTokens : ['none'];
    const referenced =
      resolved.source === 'profileOnly'
        ? '(none - profile grounded only)'
        : result.claimableTokens.length > 0
          ? result.claimableTokens.join(', ')
          : '(none claimable from the stored posting)';
    return {
      exitCode: 0,
      printedLines: [
        `Cover letter drafted for ${company} / ${role}.`,
        `Markdown: ${result.markdownPath}`,
        `Posting requirements referenced: ${referenced}`,
        `Posting requirements held back (not in masterProfile.md): ${excluded.join(', ')}`,
      ],
    };
  } catch (error: unknown) {
    if (error instanceof CoverLetterGenerationError) {
      return { exitCode: 1, printedLines: [error.message] };
    }
    return exitOneWithMessage(error);
  }
}

export async function runDraftOutreachCommand(args: ParsedOutreachArgs): Promise<CliDispatchResult> {
  const contactId = args.contactId ?? '';
  const company = args.company ?? '';
  const role = args.role ?? '';
  try {
    const result = await draftOutreachPackageMessage({
      contactId,
      companyName: company,
      roleTitle: role,
      platform: args.platform,
      dataRoot: args.dataRoot,
    });
    const hallmarks = result.excludedTokens.length > 0 ? result.excludedTokens : ['none'];
    return {
      exitCode: 0,
      printedLines: [
        `Outreach message drafted for ${result.contact.name} (contactId ${result.contact.contactId}) - ` +
          `${company} / ${role}.`,
        `Platform: ${result.platform}`,
        `Markdown: ${result.markdownPath}`,
        `Posting requirements held back (not in masterProfile.md): ${hallmarks.join(', ')}`,
      ],
    };
  } catch (error: unknown) {
    if (error instanceof OutreachGenerationError) {
      return { exitCode: 1, printedLines: [error.message] };
    }
    return exitOneWithMessage(error);
  }
}

function renderSingleEvaluation(entry: EvaluatedPosting): string[] {
  const batch = [entry];
  if (isActiveFitStatus(entry.assessment.fitStatus)) {
    return [renderMarkdown(activeResultsToMarkdown(formatScrapeResults(batch)))];
  }
  return [renderMarkdown(excludedResultsToMarkdown(formatExcludedResults(batch)))];
}

// Always renders both fixed tables (SDD Requirement 2a): Active Results and
// Excluded Results, headers included, even when one side is empty. No command
// builds its own ad hoc table.
function renderActiveAndExcludedTables(entries: EvaluatedPosting[]): string[] {
  return [
    'Active results:',
    renderMarkdown(activeResultsToMarkdown(formatScrapeResults(entries))),
    '',
    'Excluded results:',
    renderMarkdown(excludedResultsToMarkdown(formatExcludedResults(entries))),
  ];
}

export async function runEvaluateCommand(args: ParsedEvaluateArgs): Promise<CliDispatchResult> {
  const jobUrl = args.jobUrl ?? '';
  if (jobUrl.length === 0) {
    return {
      exitCode: 1,
      printedLines: [
        'evaluate requires --jobUrl.',
        '',
        'Usage:',
        '  node dist/cli/jobSearchCore.js evaluate --jobUrl "https://www.linkedin.com/jobs/view/123456"',
      ],
    };
  }
  try {
    const result = await evaluateJobPosting(jobUrl, {
      registry: args.registry,
      dataRoot: args.dataRoot,
    });
    const lines = renderSingleEvaluation(result.entry);
    const summary = [
      `Evaluated ${result.entry.posting.companyName} / ${result.entry.posting.roleTitle} — ${result.entry.assessment.fitStatus} (${result.entry.assessment.fitScore.toFixed(1)}).`,
      result.alreadyRecorded
        ? 'Already present in application history; sources merged, no duplicate record written.'
        : 'Logged to applicationHistory.json with status evaluated.',
    ];
    return { exitCode: 0, printedLines: [...summary, '', ...lines] };
  } catch (error) {
    return { exitCode: 1, printedLines: [(error as Error).message] };
  }
}

// Profile-driven search (EUO-05): builds one keyword query per targetRoles
// entry (role title plus the top profile skills - see buildProfileQueries in
// ../core/searchOrchestrator, which owns the query construction).

// Keyword-less search fallback: runs every targetRoles-derived query through
// searchByProfile (one query per role, merged and deduplicated across queries
// - never sliced to the first), then renders the same fixed tables as the
// keyword path. Throws only via searchByProfile's own empty-profile error,
// which the caller surfaces with usage guidance.
async function runProfileFallbackSearch(args: ParsedSearchArgs): Promise<CliDispatchResult> {
  if (args.save === true) {
    return {
      exitCode: 1,
      printedLines: [
        'search --save requires --keywords: a profile search has no single keyword phrase to save.',
        '',
        'Usage:',
        '  node dist/cli/jobSearchCore.js search --keywords "senior software engineer" --location "Remote" --save',
      ],
    };
  }
  let outcome: Awaited<ReturnType<typeof searchByProfile>>;
  try {
    outcome = await searchByProfile({
      registry: args.registry,
      dataRoot: args.dataRoot,
    });
  } catch (error) {
    return {
      exitCode: 1,
      printedLines: [
        (error as Error).message,
        '',
        'Usage:',
        '  node dist/cli/jobSearchCore.js search --keywords "senior software engineer" --location "Remote"',
        '  node dist/cli/jobSearchCore.js search   (uses targetRoles from jobPreferences.yaml)',
      ],
    };
  }
  const { results, entries, newRecords, alreadyRecorded, evaluatedCount, queries, location } = outcome;
  const failedSources = results.filter((sourceResult) => sourceResult.error !== null);
  const sourceSummary = results
    .map((sourceResult) => {
      const failure = sourceResult.error !== null ? ` (failed: ${sourceResult.error.message})` : '';
      const disclosure = sourceResult.disclosureNote ? ` [${sourceResult.disclosureNote}]` : '';
      return `  ${sourceResult.sourceName}: ${sourceResult.postings.length} posting(s)${failure}${disclosure}`;
    })
    .join('\n');
  const lines: string[] = [
    `Searched by profile: ${queries.length} querie(s) ${queries.map((query) => `'${query}'`).join(', ')}${location.length > 0 ? ` in '${location}'` : ''}.`,
    `Sources: ${results.map((sourceResult) => sourceResult.sourceName).join(', ')}.`,
    `Evaluated ${evaluatedCount} unique posting(s); ${newRecords} new record(s) logged, ${alreadyRecorded} already present.`,
    '',
    ...renderActiveAndExcludedTables(entries),
  ];
  if (failedSources.length > 0) {
    lines.push('', 'Per-source fetch results:', sourceSummary);
  }
  return { exitCode: 0, printedLines: lines };
}

export async function runSearchCommand(args: ParsedSearchArgs): Promise<CliDispatchResult> {
  const keywords = (args.keywords ?? '').trim();
  // Multi-title default: no --keywords means "search for everything in my
  // profile" - one query per targetRoles entry via searchByProfile. An
  // explicit --keywords stays a single-query searchJobPostings call.
  if (keywords.length === 0) {
    return runProfileFallbackSearch(args);
  }
  if (args.save === true) {
    try {
      const saveRoot = args.dataRoot === undefined ? undefined : resolve(args.dataRoot);
      await addSavedSearch(
        { keywords, location: args.location },
        join(saveRoot ?? resolveDataRoot(), savedSearchesFileName),
        saveRoot,
      );
    } catch (error) {
      return { exitCode: 1, printedLines: [(error as Error).message] };
    }
  }
  // Overall-budget and dependency failures (C3): a throw out of
  // searchJobPostings renders the same shape as the sibling digest/profile
  // commands (message plus usage) instead of a bare top-level throw.
  let outcome: Awaited<ReturnType<typeof searchJobPostings>>;
  try {
    outcome = await searchJobPostings(
      keywords,
      args.location ?? '',
      {
        registry: args.registry,
        dataRoot: args.dataRoot,
      },
      {
        remoteOnly: args.remoteOnly,
        minFit: args.minFit,
        minSalary: args.minSalary,
        maxAgeDays: args.maxAgeDays,
        radiusMiles: args.radiusMiles,
      },
    );
  } catch (error) {
    return {
      exitCode: 1,
      printedLines: [
        (error as Error).message,
        '',
        'Usage:',
        '  node dist/cli/jobSearchCore.js search --keywords "senior software engineer" --location "Remote"',
      ],
    };
  }
  const { results, entries, newRecords, alreadyRecorded, evaluatedCount } = outcome;
  const failedSources = results.filter((sourceResult) => sourceResult.error !== null);
  const sourceSummary = results
    .map((sourceResult) => {
      const failure = sourceResult.error !== null ? ` (failed: ${sourceResult.error.message})` : '';
      const disclosure = sourceResult.disclosureNote ? ` [${sourceResult.disclosureNote}]` : '';
      return `  ${sourceResult.sourceName}: ${sourceResult.postings.length} posting(s)${failure}${disclosure}`;
    })
    .join('\n');
  const activeFilters: string[] = [];
  if (args.remoteOnly === true) {
    activeFilters.push('remoteOnly');
  }
  if (args.minFit !== undefined) {
    activeFilters.push(`minFit ${args.minFit}`);
  }
  if (args.minSalary !== undefined) {
    activeFilters.push(`minSalary ${args.minSalary}`);
  }
  if (args.maxAgeDays !== undefined) {
    activeFilters.push(`maxAgeDays ${args.maxAgeDays}`);
  }
  const lines: string[] = [
    `Searched keywords: '${keywords}'${args.location !== undefined && args.location.length > 0 ? ` in '${args.location}'` : ''}.`,
    `Sources: ${results.map((sourceResult) => sourceResult.sourceName).join(', ')}.`,
    `Evaluated ${evaluatedCount} unique posting(s); ${newRecords} new record(s) logged, ${alreadyRecorded} already present.`,
    ...(activeFilters.length > 0
      ? [`Filters: ${activeFilters.join(', ')}. Shown ${entries.length} of ${evaluatedCount} evaluated posting(s).`]
      : []),
    '',
    ...renderActiveAndExcludedTables(entries),
  ];
  if (args.save === true) {
    lines.push(
      '',
      `Saved search '${keywords}'${args.location !== undefined && args.location.length > 0 ? ` in '${args.location}'` : ''}. Re-run all saved searches with 'digest'.`,
    );
  }
  if (failedSources.length > 0) {
    lines.push('', 'Per-source fetch results:', sourceSummary);
  }
  return { exitCode: 0, printedLines: lines };
}

export async function runDigestCommand(args: ParsedDigestArgs): Promise<CliDispatchResult> {
  if (args.help === true) {
    return { exitCode: 0, printedLines: digestHelpText() };
  }
  let savedSearches;
  try {
    savedSearches = await readSavedSearches(undefined, args.dataRoot);
  } catch (error) {
    return exitOneWithMessage(error);
  }
  if (savedSearches.searches.length === 0) {
    return {
      exitCode: 0,
      printedLines: [
        'No saved searches yet.',
        '',
        'Save a search first:',
        '  node dist/cli/jobSearchCore.js search --keywords "senior software engineer" --location "Remote" --save',
        'Then re-run all saved searches with:',
        '  node dist/cli/jobSearchCore.js digest',
      ],
    };
  }
  let outcome;
  try {
    outcome = await runSavedSearchesDigest({
      registry: args.registry,
      dataRoot: args.dataRoot,
    });
  } catch (error) {
    return exitOneWithMessage(error);
  }
  const { results, entries, newRecords, alreadyRecorded } = outcome;
  const failedSources = results.filter((sourceResult) => sourceResult.error !== null);
  const sourceSummary = results
    .map((sourceResult) => {
      const failure = sourceResult.error !== null ? ` (failed: ${sourceResult.error.message})` : '';
      const disclosure = sourceResult.disclosureNote ? ` [${sourceResult.disclosureNote}]` : '';
      return `  ${sourceResult.sourceName}: ${sourceResult.postings.length} posting(s)${failure}${disclosure}`;
    })
    .join('\n');
  const lines: string[] = [
    `Digest of ${savedSearches.searches.length} saved search(es): ${savedSearches.searches
      .map(
        (search) =>
          `'${search.keywords}'${search.location !== undefined && search.location.length > 0 ? ` in '${search.location}'` : ''}`,
      )
      .join(', ')}.`,
    `Sources: ${results.map((sourceResult) => sourceResult.sourceName).join(', ')}.`,
    `Evaluated ${entries.length} unique posting(s); ${newRecords} new record(s) logged, ${alreadyRecorded} already present.`,
    '',
    ...renderActiveAndExcludedTables(entries),
  ];
  if (failedSources.length > 0) {
    lines.push('', 'Per-source fetch results:', sourceSummary);
  }
  return { exitCode: 0, printedLines: lines };
}

// Identity targeting (findings 20-22): applicationId stays the human-readable
// id and one id can map to several records (the same role in different cities).
// Every command that targets one record resolves it through this helper, so an
// id shared by several records is listed, never silently reduced to the first.
function describeApplicationMatches(
  applicationId: string,
  matches: readonly ApplicationRecord[],
): string[] {
  return [
    `Application id ${applicationId} matches ${matches.length} records (the same company and role in different locations).`,
    'Retry with the postingHash of the target record (CLI: --postingHash):',
    ...matches.map(
      (record) =>
        `  postingHash ${record.postingHash} | location ${record.postingFacts?.locationType ?? 'unknown'} | status ${record.status} | fit ${record.fitScore}`,
    ),
  ];
}

function selectApplicationRecord(
  applications: readonly ApplicationRecord[],
  applicationId: string,
  postingHash: string | undefined,
): ApplicationRecord {
  const matches = applications.filter(
    (application) => application.applicationId === applicationId,
  );
  if (postingHash !== undefined) {
    const exact = matches.find((application) => application.postingHash === postingHash);
    if (exact === undefined) {
      throw new Error(
        `No application record found with id ${applicationId} and postingHash ${postingHash}.`,
      );
    }
    return exact;
  }
  if (matches.length > 1) {
    throw new Error(describeApplicationMatches(applicationId, matches).join('\n'));
  }
  if (matches.length === 0) {
    throw new Error(`No application record found for id ${applicationId}.`);
  }
  return matches[0];
}

// Shared by the show CLI command and the getPostingDetail MCP tool (SRA-02):
// returns the stored application record for one company/role, or throws with a
// readable message when the posting was never evaluated. Read-only.
export async function getPostingDetail(
  companyName: string,
  roleTitle: string,
  options: { historyPath?: string; dataRoot?: string; postingHash?: string } = {},
): Promise<ApplicationRecord> {
  const historyPath = options.historyPath ?? resolveApplicationHistoryPath(undefined, options.dataRoot);
  const history = await readApplicationHistory(historyPath, options.dataRoot);
  const applicationId = generateApplicationId(companyName, roleTitle);
  const matches = history.applications.filter(
    (application) => application.applicationId === applicationId,
  );
  if (matches.length === 0) {
    throw new Error(
      `No application record found for '${companyName}' / '${roleTitle}' (id ${applicationId}) in the canonical data root. ` +
        'Run evaluate or search first so the posting is logged before reviewing.',
    );
  }
  return selectApplicationRecord(matches, applicationId, options.postingHash);
}

function renderPostingDetail(record: ApplicationRecord): string[] {
  const lines: string[] = [
    `Details for ${record.companyName} / ${record.roleTitle}`,
    `  Fit score: ${record.fitScore} (${record.fitStatus})`,
    `  Salary range: ${record.salaryRange ?? '(not stated)'}`,
    `  Sources: ${record.sourceAggregators.join(', ')}`,
    `  Link: ${record.jobUrl}`,
  ];
  const facts = record.postingFacts;
  if (facts !== undefined) {
    lines.push(
      '  Posting facts:',
      `    Location type: ${facts.locationType ?? 'unknown'}`,
      `    Employer type: ${facts.employerType ?? 'unknown'}`,
      `    Required clearance: ${facts.requiredClearanceLevel ?? 'unknown'}`,
    );
  } else {
    lines.push('  Posting facts: (not stored)');
  }
  lines.push('  Description:');
  if (record.postingDescription !== undefined && record.postingDescription.length > 0) {
    lines.push(record.postingDescription);
  } else {
    lines.push('    (not stored)');
  }
  lines.push('  Status history:');
  for (const entry of record.statusHistory) {
    const note = entry.notes !== undefined && entry.notes.length > 0 ? ` (${entry.notes})` : '';
    lines.push(`    ${entry.stage} @ ${entry.timestamp}${note}`);
  }
  return lines;
}

export async function runShowCommand(args: ParsedShowArgs): Promise<CliDispatchResult> {
  if (args.help === true) {
    return { exitCode: 0, printedLines: showHelpText() };
  }
  const company = args.companyName ?? '';
  const role = args.roleTitle ?? '';
  if (company.length === 0 || role.length === 0) {
    return {
      exitCode: 1,
      printedLines: [
        'show requires --company and --role.',
        '',
        'Usage:',
        '  node dist/cli/jobSearchCore.js show --company "AcmeCorp" --role "SeniorEngineer"',
      ],
    };
  }
  try {
    const record = await getPostingDetail(company, role, {
      dataRoot: args.dataRoot,
      postingHash: args.postingHash,
    });
    return { exitCode: 0, printedLines: renderPostingDetail(record) };
  } catch (error) {
    return { exitCode: 1, printedLines: [(error as Error).message] };
  }
}

// Review flow (SRA-02, goals G2/G3): prints the same stored detail as show,
// then offers an explicit next-action menu. Exactly one action per choice and
// nothing auto-chains (SDD Section 1.5): each menu option invokes exactly one
// existing command. The PromptContext is injectable for testability (same
// pattern as the init wizard); the CLI wrapper supplies the real readline one.
export async function runReviewCommand(
  args: ParsedReviewArgs,
  options: { prompt?: PromptContext; historyPath?: string; dataRoot?: string } = {},
): Promise<CliDispatchResult> {
  const company = args.companyName ?? '';
  const role = args.roleTitle ?? '';
  const dataRoot = options.dataRoot ?? args.dataRoot;
  const historyPath = options.historyPath ?? resolveApplicationHistoryPath(undefined, dataRoot);
  let history;
  try {
    history = await readApplicationHistory(historyPath, dataRoot);
  } catch (error) {
    return exitOneWithMessage(error);
  }
  const applicationId = generateApplicationId(company, role);
  const matches = history.applications.filter(
    (application) => application.applicationId === applicationId,
  );
  if (matches.length === 0) {
    return {
      exitCode: 1,
      printedLines: [
        `No application record found for '${company}' / '${role}' (id ${applicationId}) in the canonical data root.`,
        'Run evaluate or search first so the posting is logged before reviewing.',
      ],
    };
  }
  let record: ApplicationRecord;
  try {
    record = selectApplicationRecord(matches, applicationId, args.postingHash);
  } catch (error) {
    return { exitCode: 1, printedLines: (error as Error).message.split('\n') };
  }
  const prompt = options.prompt ?? createCliPromptContext();
  const detailLines = renderPostingDetail(record);
  prompt.print(detailLines);
  prompt.print([
    '',
    'Next actions (exactly one per choice; nothing runs automatically):',
    '  [g]enerate resume',
    '  [c]over letter',
    '  [o]utreach message',
    '  [a]pply (confirm submission)',
    '  [s]kip',
  ]);
  const answer = (await prompt.ask('Choose an action (g/c/o/a/s): ')).trim().toLowerCase();
  const choice = answer.length > 0 ? answer[0] : 's';
  switch (choice) {
    case 'g': {
      const result = await runGenerate({
      company,
      role,
      dataRoot,
    });
      return { exitCode: result.exitCode, printedLines: [...detailLines, '', ...result.printedLines] };
    }
    case 'c': {
      const result = await runDraftCoverLetter({
      company,
      role,
      postingHash: args.postingHash,
      dataRoot,
    });
      return { exitCode: result.exitCode, printedLines: [...detailLines, '', ...result.printedLines] };
    }
    case 'o': {
      const contactId = (await prompt.ask('Contact id (from networkingContacts.json): ')).trim();
      if (contactId.length === 0) {
        return {
          exitCode: 1,
          printedLines: [...detailLines, '', 'Outreach requires a contact id; nothing was drafted.'],
        };
      }
      const result = await runDraftOutreachCommand({
      contactId,
      company,
      role,
      dataRoot,
    });
      return { exitCode: result.exitCode, printedLines: [...detailLines, '', ...result.printedLines] };
    }
    case 'a': {
      const notes = (await prompt.ask('Confirmation note (optional): ')).trim();
      try {
        const outcome = await confirmApplicationSubmission(company, role, notes, {
          historyPath,
          dataRoot,
          postingHash: args.postingHash,
        });
        const note = outcome.alreadyConfirmed ? 'was already confirmed' : 'confirmed';
        return {
          exitCode: 0,
          printedLines: [...detailLines, '', `Application ${applicationId} ${note}.`],
        };
      } catch (error) {
        return { exitCode: 1, printedLines: [...detailLines, '', (error as Error).message] };
      }
    }
    default:
      return { exitCode: 0, printedLines: [...detailLines, '', 'Skipped. No action taken.'] };
  }
}

// Status transitions (SRA-03, goal G4): wraps the existing
// updateApplicationStatus so the funnel reflects reality. appliedConfirmed is
// deliberately NOT settable here - confirmApplicationSubmission remains its
// exclusive manual path (SDD Requirement 4 / Section 1.5); staleNoResponse is
// a derived visibility flag, never written directly.
const updateStatusAllowedValues: readonly string[] = ['interviewing', 'offer', 'rejected'];

export async function runUpdateStatusCommand(args: ParsedUpdateStatusArgs): Promise<CliDispatchResult> {
  if (args.help === true) {
    return { exitCode: 0, printedLines: updateStatusHelpText() };
  }
  const company = args.companyName ?? '';
  const role = args.roleTitle ?? '';
  const status = args.status ?? '';
  if (company.length === 0 || role.length === 0 || status.length === 0) {
    return {
      exitCode: 1,
      printedLines: [
        'updateStatus requires --company, --role, and --status.',
        '',
        'Usage:',
        '  node dist/cli/jobSearchCore.js updateStatus --company "AcmeCorp" --role "SeniorEngineer" --status interviewing',
      ],
    };
  }
  if (status === 'appliedConfirmed') {
    return {
      exitCode: 1,
      printedLines: [
        `'appliedConfirmed' cannot be set via updateStatus; it is only reachable through confirmApplicationSubmission after the human submits on the portal.`,
      ],
    };
  }
  if (!updateStatusAllowedValues.includes(status)) {
    return {
      exitCode: 1,
      printedLines: [
        `Unknown status '${status}'. Allowed values: ${updateStatusAllowedValues.join(', ')}.`,
      ],
    };
  }
  const historyPath = resolveApplicationHistoryPath(undefined, args.dataRoot);
  let history;
  try {
    history = await readApplicationHistory(historyPath, args.dataRoot);
  } catch (error) {
    return exitOneWithMessage(error);
  }
  const applicationId = generateApplicationId(company, role);
  let record: ApplicationRecord;
  try {
    record = selectApplicationRecord(history.applications, applicationId, args.postingHash);
  } catch (error) {
    const message = (error as Error).message;
    if (message.startsWith('Application id ')) {
      return { exitCode: 1, printedLines: message.split('\n') };
    }
    return {
      exitCode: 1,
      printedLines: [
        `No application record found for '${company}' / '${role}' (id ${applicationId}) in the canonical data root.`,
        'Run evaluate or search first so the posting is logged before updating status.',
      ],
    };
  }
  let updated;
  try {
    updated = await updateApplicationStatus(
      applicationId,
      status as ApplicationStatus,
      args.notes,
      historyPath,
      args.dataRoot,
      record.postingHash,
    );
  } catch (error) {
    return exitOneWithMessage(error);
  }
  return {
    exitCode: 0,
    printedLines: [
      `Application ${applicationId} status updated: ${record.status} -> ${status}.`,
      `History: ${updated.statusHistory
        .map((entry) => `${entry.stage} @ ${entry.timestamp}`)
        .join(', ')}`,
    ],
  };
}

export async function runAddContactCommand(args: ParsedAddContactArgs): Promise<CliDispatchResult> {
  if (args.help === true) {
    return { exitCode: 0, printedLines: addContactHelpText() };
  }
  if (args.name === undefined || args.name.trim().length === 0 || args.company === undefined || args.company.trim().length === 0) {
    return {
      exitCode: 1,
      printedLines: [
        'addContact requires --name and --company.',
        '',
        'Usage:',
        '  node dist/cli/jobSearchCore.js addContact --name "Jane Smith" --company "AcmeCorp"',
      ],
    };
  }
  const input: NewContactInput = {
    name: args.name,
    company: args.company,
    relationship: args.relationship,
    followUpDue: args.followUpDue ?? undefined,
  };
  if (args.linkedApplicationIds !== undefined) {
    input.linkedApplicationIds = args.linkedApplicationIds
      .split(',')
      .map((value) => value.trim())
      .filter((value) => value.length > 0);
  }
  try {
    const dataRoot = args.dataRoot === undefined ? undefined : resolve(args.dataRoot);
    const contactsPath = join(dataRoot ?? resolveDataRoot(), networkingContactsFileName);
    const contact = await addNetworkingContact(input, contactsPath, { rootDir: dataRoot });
    return {
      exitCode: 0,
      printedLines: [
        `Contact logged: ${contact.name} (${contact.company})`,
        `Contact ID: ${contact.contactId}`,
        `Relationship: ${contact.relationship}`,
        `Saved to: ${contactsPath}`,
      ],
    };
  } catch (error) {
    return { exitCode: 1, printedLines: [(error as Error).message] };
  }
}

export async function runReportCommand(args: ParsedReportArgs): Promise<CliDispatchResult> {
  if (args.help === true) {
    return { exitCode: 0, printedLines: reportHelpText() };
  }
  const format = args.format ?? 'table';
  if (format !== 'table' && format !== 'json') {
    return { exitCode: 1, printedLines: [`report --format must be 'table' or 'json'; got '${format}'.`] };
  }
  try {
    const report = await loadFunnelReport({ dataRoot: args.dataRoot });
    const shouldRedact = !args.noRedact;
    if (args.output) {
      // H4: file output is redacted by default; --noRedact opts out.
      // O2/U45: --format selects the file bytes (previously both branches
      // returned the same table file). The file writer warns itself when
      // identities are actually shown, so no CLI-level warn here (B3/U45:
      // warning twice, or warning for a redacted file, is the old bug).
      const outputPath = await writeFunnelReportToFile(report, args.output, {
        redact: shouldRedact,
        dataRoot: args.dataRoot,
        format,
      });
      return { exitCode: 0, printedLines: [`Report written to ${outputPath}`] };
    }
    if (format === 'json') {
      const displayReport = shouldRedact ? redactFunnelReport(report) : report;
      // The table formatter warns on its own path; the JSON path needs its
      // own warn, fired exactly when identities are shown (B3/U45).
      if (!shouldRedact) {
        console.warn(identitiesShownNote);
      }
      return { exitCode: 0, printedLines: [JSON.stringify(displayReport, null, 2)] };
    }
    // Table path: the formatter warns itself iff redact is false.
    return { exitCode: 0, printedLines: formatFunnelReportTable(report, shouldRedact) };
  } catch (error) {
    return { exitCode: 1, printedLines: [(error as Error).message] };
  }
}

export async function runReviewQueueCommand(args: ParsedReviewQueueArgs): Promise<CliDispatchResult> {
  if (args.help === true) {
    return { exitCode: 0, printedLines: reviewQueueHelpText() };
  }
  try {
    const historyPath = resolveApplicationHistoryPath(undefined, args.dataRoot);
    const history = await readApplicationHistory(historyPath, args.dataRoot);
    const table = formatReviewQueue(history.applications);
    const lines = [
      table.rows.length > 0
        ? `${table.rows.length} application(s) awaiting a human decision (fitStatus manualReview):`
        : 'No applications are awaiting a human decision (fitStatus manualReview).',
    ];
    if (table.rows.length > 0) {
      lines.push(renderMarkdown(reviewQueueToMarkdown(table)));
    }
    return { exitCode: 0, printedLines: lines };
  } catch (error) {
    return { exitCode: 1, printedLines: [(error as Error).message] };
  }
}

export async function runInitCommand(
  args: ParsedInitArgs,
  prompt?: PromptContext,
): Promise<CliDispatchResult> {
  if (args.help === true) {
    return { exitCode: 0, printedLines: initHelpText() };
  }
  // The wizard is a readline interview. Inside an agent shell stdin is not a
  // TTY, so the first question dies with a bare "readline was closed" and the
  // user is left with no setup at all. Say what to do instead.
  if (prompt === undefined && process.stdin.isTTY !== true) {
    return {
      exitCode: 1,
      printedLines: [
        'init needs an interactive terminal, and stdin here is not one. Nothing was written.',
        'Run it in your own terminal: node dist/cli/jobSearchCore.js init',
        'In an agent session, use the setup flow instead: the profile MCP tools (getUserProfile, ingestDocuments, initializeUserProfile).',
      ],
    };
  }
  const ctx = prompt ?? createCliPromptContext();
  try {
    const result = await runInitWizard({
      prompt: ctx,
      repoRoot: args.repoRoot,
      profileDirectory: args.dataRoot === undefined ? undefined : resolve(args.dataRoot),
      // B1: the init command always targets a data root — the canonical root
      // for a plain run, the relocated root with --dataRoot — so it always
      // seeds the working resumeVariants.yaml. (Previously tied to dataRoot
      // presence, so a plain canonical-root init never seeded and generate,
      // previewResume, and validate failed after a fresh init.)
      seedVariants: true,
    });
    return { exitCode: result.exitCode, printedLines: result.printedLines };
  } catch (error) {
    if (error instanceof InitCancelledError || error instanceof SetupValidationError) {
      return { exitCode: 1, printedLines: [error.message] };
    }
    throw error;
  } finally {
    ctx.close();
  }
}

export async function runValidateCommand(args: ParsedValidateArgs): Promise<CliDispatchResult> {
  if (args.help === true) {
    return { exitCode: 0, printedLines: validateHelpText() };
  }
  const dataRoot = args.dataRoot === undefined ? resolveDataRoot() : resolve(args.dataRoot);
  const lines: string[] = ['weJobSearch configuration validation', ''];
  let failed = false;
  const checkFile = async (
    label: string,
    filePath: string,
    parse: (content: string) => void,
  ): Promise<void> => {
    let content: string;
    try {
      content = await readFile(filePath, 'utf8');
    } catch (error) {
      failed = true;
      lines.push(`${label}: FAIL — not found at ${filePath}. Run init to create it.`);
      return;
    }
    try {
      parse(content);
      lines.push(`${label}: OK (${filePath})`);
    } catch (error) {
      failed = true;
      lines.push(`${label}: FAIL — ${formatFatalError(error)}`);
    }
  };
  await checkFile('jobPreferences.yaml', join(dataRoot, 'jobPreferences.yaml'), (content) => {
    parseJobPreferences(content);
  });
  await checkFile('resumeVariants.yaml', join(dataRoot, resumeVariantsFileName), (content) => {
    parseResumeVariants(content);
  });
  if (failed) {
    lines.push('', 'Fix the files above (or run init to regenerate them), then re-run validate.');
  }
  return { exitCode: failed ? 1 : 0, printedLines: lines };
}

export async function runExportDataCommand(args: ParsedExportDataArgs): Promise<CliDispatchResult> {
  if (args.help === true) {
    return { exitCode: 0, printedLines: exportDataHelpText() };
  }
  if (args.archivePath === undefined || args.archivePath.trim().length === 0) {
    return {
      exitCode: 1,
      printedLines: [
        'exportData requires --archivePath PATH.',
        '',
        'Usage:',
        '  node dist/cli/jobSearchCore.js exportData --archivePath /path/to/weJobSearch-backup.tar.gz',
      ],
    };
  }
  try {
    const result = await exportDataRoot({ archivePath: args.archivePath, rootPath: args.rootPath });
    return {
      exitCode: 0,
      printedLines: [
        `Exported data root '${result.sourceRoot}' to '${result.archivePath}'`,
        `Entries: ${result.entryCount}; bytes: ${result.byteCount}`,
        `Sanctioned outside-root write: archive '${result.archivePath}' holds ${result.entryCount} entries from outside the git work tree.`,
      ],
    };
  } catch (error) {
    return { exitCode: 1, printedLines: [(error as Error).message] };
  }
}

// Pure success-line formatter for importData (R-H2-1): the user-supplied
// absolute rootPath/archivePath are redacted to data-root-relative form
// before echo, matching the D2 error-path redaction posture. Counts and
// wording are unchanged; only identity-bearing path segments are redacted.
export function formatImportDataSuccessLines(result: ImportResult): string[] {
  return [
    `Imported ${result.entryCount} archive entries into '${redactHomePrefix(result.rootPath)}'`,
    `Restored files: ${result.restoredFiles.length}`,
    `Sanctioned outside-root read: archive '${redactHomePrefix(result.archivePath)}' supplied ${result.entryCount} entries from outside the git work tree.`,
  ];
}

export async function runImportDataCommand(args: ParsedImportDataArgs): Promise<CliDispatchResult> {
  if (args.help === true) {
    return { exitCode: 0, printedLines: importDataHelpText() };
  }
  if (args.archivePath === undefined || args.archivePath.trim().length === 0) {
    return {
      exitCode: 1,
      printedLines: [
        'importData requires --archivePath PATH.',
        '',
        'Usage:',
        '  node dist/cli/jobSearchCore.js importData --archivePath /path/to/weJobSearch-backup.tar.gz',
      ],
    };
  }
  try {
    const result = await importDataRoot({ archivePath: args.archivePath, rootPath: args.rootPath });
    return { exitCode: 0, printedLines: formatImportDataSuccessLines(result) };
  } catch (error) {
    return { exitCode: 1, printedLines: [(error as Error).message] };
  }
}

// MCP tool handlers (SDD Section 4.2). These are the standalone functions the
// Step 7 jobSearchServer.ts server registers as native tools. They share the
// same core paths as the CLI commands and never chain into generate,
// draftCoverLetter, or draftOutreach (Section 1.5).

// CLI wipeProfile: same resolve guard, inventory, and backup mechanics as the
// MCP tool below; the typed 'wipe' prompt is the CLI's confirmation gate, so
// --force is the only way past it (scripted use still backs up).
export async function runWipeProfileCommand(
  args: ParsedWipeProfileArgs,
  options: { prompt?: PromptContext } = {},
): Promise<CliDispatchResult> {
  if (args.help === true) {
    return { exitCode: 0, printedLines: wipeProfileHelpText() };
  }
  let rootPath: string;
  try {
    rootPath = resolveDataRoot(args.dataRoot);
  } catch (error) {
    return exitOneWithMessage(error);
  }
  const inventory = await inventoryDataRoot(rootPath);
  if (inventory === null) {
    return { exitCode: 0, printedLines: [`Nothing to wipe: '${rootPath}' does not exist.`] };
  }
  const inventoryLines = [
    `Wipe target: '${rootPath}'`,
    `Contents: ${inventory.fileCount} file(s), ${inventory.dirCount} director(ies), ${inventory.totalBytes} bytes`,
  ];
  if (args.force !== true) {
    // Created lazily, right before the ask: a readline interface opened before
    // the inventory walk closes on stdin EOF when input is piped, which would
    // reject the question instead of reading the confirmation line.
    const prompt = options.prompt ?? createCliPromptContext();
    prompt.print(inventoryLines);
    let answer: string;
    try {
      answer = (
        await prompt.ask(`Type 'wipe' to delete ${rootPath} and everything under it: `)
      )
        .trim()
        .toLowerCase();
    } finally {
      if (options.prompt === undefined) {
        prompt.close();
      }
    }
    if (answer !== 'wipe') {
      return { exitCode: 0, printedLines: [...inventoryLines, 'Aborted: nothing was deleted.'] };
    }
  }
  try {
    const result = await wipeDataRoot({ rootPath, noBackup: args.noBackup });
    return {
      exitCode: 0,
      printedLines: [
        ...inventoryLines,
        `Deleted '${result.rootPath}' (${result.inventory.fileCount} file(s), ${result.inventory.dirCount} director(ies)).`,
        result.backupPath === null
          ? 'No backup written (--noBackup).'
          : `Backup: '${result.backupPath}'`,
      ],
    };
  } catch (error) {
    return exitOneWithMessage(error);
  }
}

// MCP wipeUserProfile: no interactive prompt (the host asks first), but the
// same confirmation gate as initializeUserProfile, and the backup still runs
// unless noBackup is true.
export async function wipeUserProfile(
  options: { confirmed?: boolean; noBackup?: boolean; dataRoot?: string } = {},
): Promise<WipeDataRootResult> {
  if (options.confirmed !== true) {
    throw new ProfileConfirmationRequiredError();
  }
  return wipeDataRoot({
    rootPath: resolveDataRoot(options.dataRoot),
    noBackup: options.noBackup,
  });
}

export interface LogNetworkingContactOptions {
  contactsPath?: string;
  linkedApplicationIds?: readonly string[];
  followUpDue?: string;
  // Whole data-root relocation (U44): when set, the contacts file is
  // resolved under this root (mirrors runAddContactCommand's derivation).
  dataRoot?: string;
}

export async function logNetworkingContact(
  name: string,
  company: string,
  relationship?: string,
  options: LogNetworkingContactOptions = {},
): Promise<NetworkingContact> {
  const input: NewContactInput = {
    name,
    company,
    relationship,
    linkedApplicationIds: options.linkedApplicationIds,
    followUpDue: options.followUpDue ?? undefined,
  };
  const dataRoot = options.dataRoot === undefined ? undefined : resolve(options.dataRoot);
  const contactsPath =
    options.contactsPath ?? join(dataRoot ?? resolveDataRoot(), networkingContactsFileName);
  return addNetworkingContact(input, contactsPath, { rootDir: dataRoot });
}

export async function getFunnelReport(
  options: {
    historyPath?: string;
    contactsPath?: string;
    searchHistoryPath?: string;
    dataRoot?: string;
    redact?: boolean;
  } = {},
): Promise<FunnelReport> {
  const report = await loadFunnelReport({
    historyPath: options.historyPath,
    contactsPath: options.contactsPath,
    searchHistoryPath: options.searchHistoryPath,
    dataRoot: options.dataRoot,
  });
  // H4: if redact is requested, return the redacted version
  return options.redact ? redactFunnelReport(report) : report;
}

export interface ReviewQueueEntry {
  applicationId: string;
  companyName: string;
  roleTitle: string;
  jobUrl: string;
  fitScore: number;
  currentStatus: string;
}

export async function getReviewQueue(historyPath?: string, dataRoot?: string): Promise<ReviewQueueEntry[]> {
  const history = await readApplicationHistory(historyPath, dataRoot);
  const table = formatReviewQueue(history.applications);
  return table.rows.map((row) => ({
    applicationId: row.applicationId,
    companyName: row.organization,
    roleTitle: row.jobTitle,
    jobUrl: row.link,
    fitScore: row.fitScore,
    currentStatus: row.currentStatus,
  }));
}

// Phase E thin-bridge seam (SDD Section 4.2): role suggestions from the saved
// profile. The MCP suggestRoles tool delegates here instead of composing
// loadMasterProfile plus candidateCapabilitiesFromProfile plus suggestRoles
// itself. Read-only; never runs a search, evaluation, or generation.
export async function suggestRolesForProfile(
  options: { profilePath?: string; dataRoot?: string } = {},
): Promise<string[]> {
  const profile = await loadMasterProfile(options.profilePath, options.dataRoot);
  return suggestRoles(candidateCapabilitiesFromProfile(profile));
}

// Phase E thin-bridge seam (SDD Section 4.2): pattern suggestions over the
// stored application history plus the saved preferences. The MCP
// analyzeApplicationPatterns tool delegates here instead of composing
// readApplicationHistory plus loadJobPreferences plus analyzeApplicationPatterns
// itself. Read-only; nothing is written, generated, or sent.
export async function getApplicationPatternSuggestions(
  options: { historyPath?: string; preferencesPath?: string; dataRoot?: string } = {},
): Promise<PatternSuggestion[]> {
  const dataRoot = resolveDataRoot(options.dataRoot);
  const history = await readApplicationHistory(options.historyPath, options.dataRoot);
  const preferences = await loadJobPreferences(options.preferencesPath ?? join(dataRoot, 'jobPreferences.yaml'));
  return analyzeApplicationPatterns(history, {
    targetRoles: preferences.targetRoles ?? [],
    preferredLocations: preferences.preferredLocations,
  });
}

export interface OutreachMessageSummary {
  markdownPath: string;
  platform: string;
  contactId: string;
  contactName: string;
  claimableTokens: string[];
  excludedTokens: string[];
}

// MCP tool handler (SDD Section 4.2), named for Step 7's jobSearchServer.ts:
// draftOutreachMessage(contactId, companyName, roleTitle, platform?). Shares
// the same core path as the draftOutreach CLI command and never chains into
// generate, draftCoverLetter, evaluate, or search (Section 1.5).
export async function draftOutreachMessage(
  contactId: string,
  companyName: string,
  roleTitle: string,
  platform?: string,
  options: { dataRoot?: string } = {},
): Promise<OutreachMessageSummary> {
  const result = await draftOutreachPackageMessage({
    contactId,
    companyName,
    roleTitle,
    platform,
    dataRoot: options.dataRoot,
  });
  return {
    markdownPath: result.markdownPath,
    platform: result.platform,
    contactId: result.contact.contactId,
    contactName: result.contact.name,
    claimableTokens: result.claimableTokens,
    excludedTokens: result.excludedTokens,
  };
}

export interface CoverLetterSummary {
  markdownPath: string;
  claimableTokens: string[];
  excludedTokens: string[];
}

// MCP tool handler (SDD Section 4.2), named for Step 7's jobSearchServer.ts:
// draftCoverLetter(companyName, roleTitle, postingRequirements?). Shares the
// same core path as the draftCoverLetter CLI command and never chains into
// generate, draftOutreachMessage, evaluate, or search (Section 1.5).
export async function draftCoverLetterForRole(
  companyName: string,
  roleTitle: string,
  postingRequirements?: string,
  options: { dataRoot?: string; postingHash?: string } = {},
): Promise<CoverLetterSummary> {
  const explicit = postingRequirements
    ? postingRequirements
        .split(',')
        .map((requirement) => requirement.trim())
        .filter((requirement) => requirement.length > 0)
    : undefined;
  const resolved = await resolveCoverLetterRequirements(
    companyName,
    roleTitle,
    explicit,
    options.postingHash,
    options.dataRoot,
  );
  const result = await draftCoverLetter({
    companyName,
    roleTitle,
    postingRequirements: resolved.requirements,
    dataRoot: options.dataRoot,
  });
  return {
    markdownPath: result.markdownPath,
    claimableTokens: result.claimableTokens,
    excludedTokens: result.excludedTokens,
  };
}

export interface ApplicationConfirmationOutcome {
  record: ApplicationRecord;
  alreadyConfirmed: boolean;
}

// MCP tool handler (SDD Section 4.2): confirmApplicationSubmission. Strictly
// local manual confirmation: the human submits the application on the portal
// themselves, then calls this to record it in applicationHistory.json. This is
// the ONLY allowed path into appliedConfirmed - nothing here or anywhere in
// the engine auto-submits or contacts anyone (Section 1.5). Transitions are
// schema-guarded: only evaluated/generated records may be confirmed.
export async function confirmApplicationSubmission(
  companyName: string,
  roleTitle: string,
  notes: string,
  options: { historyPath?: string; dataRoot?: string; postingHash?: string } = {},
): Promise<ApplicationConfirmationOutcome> {
  const historyPath = options.historyPath ?? resolveApplicationHistoryPath(undefined, options.dataRoot);
  const history = await readApplicationHistory(historyPath, options.dataRoot);
  const applicationId = generateApplicationId(companyName, roleTitle);
  // Findings 20-22: one id can map to several records (the same company and
  // role in different cities). A hash confirms exactly one; without a hash a
  // single pending record keeps the one-step behavior, and several pending
  // records require an explicit hash instead of confirming the whole set.
  const matches = history.applications.filter(
    (application) => application.applicationId === applicationId,
  );
  if (matches.length === 0) {
    throw new Error(
      `No application record found for '${companyName}' / '${roleTitle}' (id ${applicationId}) in the canonical data root. ` +
        'Run evaluate or search first so the posting is logged before confirming.',
    );
  }
  let target: ApplicationRecord;
  if (options.postingHash !== undefined) {
    const exact = matches.find(
      (application) => application.postingHash === options.postingHash,
    );
    if (exact === undefined) {
      throw new Error(
        `No application record found with id ${applicationId} and postingHash ${options.postingHash}.`,
      );
    }
    target = exact;
  } else {
    const pending = matches.filter((record) => record.status !== 'appliedConfirmed');
    if (pending.length > 1) {
      throw new Error(
        [
          ...describeApplicationMatches(applicationId, matches),
          'Confirmation needs the postingHash of the record you submitted; nothing was confirmed.',
        ].join('\n'),
      );
    }
    target = pending[0] ?? matches[0];
  }
  if (
    target.status !== 'evaluated' &&
    target.status !== 'generated' &&
    target.status !== 'appliedConfirmed'
  ) {
    throw new Error(
      `Application ${applicationId} is '${target.status}'; only evaluated or generated applications can be confirmed as submitted.`,
    );
  }
  if (target.status === 'appliedConfirmed') {
    return { record: target, alreadyConfirmed: true };
  }
  const confirmed = await updateApplicationStatus(
    applicationId,
    'appliedConfirmed',
    notes,
    historyPath,
    options.dataRoot,
    target.postingHash,
  );
  return { record: confirmed, alreadyConfirmed: false };
}

// CLI handler (SDD Section 4.1): parsePdf. Thin read-only dispatch over the
// existing parsePdfDocument core (shared with the MCP parsePdfDocument tool).
// Never chains into evaluate or generate (Section 1.5).
export async function runParsePdfCommand(args: ParsedPdfArgs): Promise<CliDispatchResult> {
  if (args.help === true) {
    return { exitCode: 0, printedLines: parsePdfHelpText() };
  }
  if (args.filePath === undefined || args.filePath.length === 0) {
    return {
      exitCode: 1,
      printedLines: [
        'parsePdf requires --filePath.',
        '',
        'Usage:',
        '  node dist/cli/jobSearchCore.js parsePdf --filePath "./myResume.pdf"',
      ],
    };
  }
  try {
    const parsed = await parsePdfDocument(args.filePath, args.dataRoot);
    return {
      exitCode: 0,
      printedLines: [
        `Parsed PDF: ${args.filePath}`,
        `Pages: ${parsed.pageCount}`,
        `Characters: ${parsed.text.length}`,
      ],
    };
  } catch (error) {
    return { exitCode: 1, printedLines: [(error as Error).message] };
  }
}

// CLI handler (SDD Section 4.1): confirmApp. Thin dispatch over the existing
// confirmApplicationSubmission core (shared with the MCP tool of the same
// name). Manual recording only: the user confirms after submitting on the
// portal themselves. Never chains into any other capability (Section 1.5).
export async function runConfirmAppCommand(args: ParsedConfirmAppArgs): Promise<CliDispatchResult> {
  if (args.help === true) {
    return { exitCode: 0, printedLines: confirmAppHelpText() };
  }
  const company = args.company ?? '';
  const role = args.role ?? '';
  if (company.length === 0 || role.length === 0) {
    return {
      exitCode: 1,
      printedLines: [
        'confirmApp requires --company and --role.',
        '',
        'Usage:',
        '  node dist/cli/jobSearchCore.js confirmApp --company "AcmeCorp" --role "SeniorEngineer" [--notes "Submitted via Greenhouse"]',
      ],
    };
  }
  try {
    const outcome = await confirmApplicationSubmission(company, role, args.notes ?? '', {
      dataRoot: args.dataRoot,
      postingHash: args.postingHash,
    });
    const note = outcome.alreadyConfirmed ? 'was already confirmed' : 'confirmed';
    return {
      exitCode: 0,
      printedLines: [`Application ${outcome.record.applicationId} ${note}.`, `Status: ${outcome.record.status}`],
    };
  } catch (error) {
    return { exitCode: 1, printedLines: [(error as Error).message] };
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  let result: CliDispatchResult;
  try {
    result = await dispatchCli(argv);
  } catch (error) {
    console.error(formatFatalError(error));
    process.exit(1);
  }
  for (const line of result.printedLines) {
    console.log(line);
  }
  process.exit(result.exitCode);
}

if (require.main === module) {
  void main();
}