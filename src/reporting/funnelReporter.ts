import { readApplicationHistory, type ApplicationHistory, type ApplicationRecord } from '../utils/jobFunnelTracker';
import {
  defaultStalenessWindowDays,
  isStale,
} from '../utils/staleChecker';
import { readNetworkingContacts, type NetworkingContacts } from '../utils/networkingContacts';
import { readSearchHistory, type SearchHistory, type SearchHistoryEntry } from '../utils/searchHistory';
import { assertConfinedToRoot, resolveDataRoot } from '../utils/canonicalDataRoot';
import { basename, join } from 'node:path';
import { writeFileAtomically } from '../utils/atomicWrite';

// Funnel reporting (SDD Requirement 9). Reads applicationHistory.json (now
// populated by evaluate/search per Requirement 4's evaluation-persistence
// sub-note) and networkingContacts.json, and produces a summary covering the
// five mandated sections: count by fitStatus, count by status (with
// staleNoResponse derived via staleChecker.ts — a visibility flag only, never
// mutating history, per Requirement 4), referral-linked vs. cold-apply
// conversion, applications awaiting manualReview action, and contacts with
// overdue follow-ups. This command turns the tracker into a dashboard; it
// triggers no generation, outreach, or contact of anyone (Section 1.5).

// H4 PII hygiene: redaction is ON by default for file output.
// Identity fields (names, companies, contact IDs) are replaced with
// placeholder tokens; numeric fit scores are kept as-is since they
// carry no identity information. Terminal output always prints a
// one-line warning that identities are shown; file output is
// redacted unless --noRedact is passed.

export const allFitStatuses = ['strongFit', 'manualReview', 'weakFit', 'hardRejected'] as const;
export type FitStatusKey = (typeof allFitStatuses)[number];

export const allApplicationStatuses = [
  'evaluated',
  'generated',
  'appliedConfirmed',
  'staleNoResponse',
  'rejected',
  'interviewing',
  'offer',
] as const;
export type ApplicationStatusKey = (typeof allApplicationStatuses)[number];

export interface ConversionStatistics {
  evaluated: number;
  converted: number;
  conversionRate: number | null;
}

export interface ReferralConversionSummary {
  referralLinked: ConversionStatistics;
  coldApply: ConversionStatistics;
}

export interface AwaitingManualReviewEntry {
  applicationId: string;
  companyName: string;
  roleTitle: string;
  jobUrl: string;
  fitScore: number;
}

export interface OverdueFollowUpEntry {
  contactId: string;
  name: string;
  company: string;
  relationship: string;
  followUpDue: string;
}

// Per-application next-action hint (SRA-03, goal G5): derived from status +
// fitStatus + staleness, display-only. The report says what to do next; it
// never performs the action.
export interface NextActionHintEntry {
  applicationId: string;
  companyName: string;
  roleTitle: string;
  status: ApplicationStatusKey;
  fitStatus: FitStatusKey;
  hint: string;
}

export interface FunnelReport {
  generatedAt: string;
  totalApplications: number;
  fitStatusCounts: Record<FitStatusKey, number>;
  statusCounts: Record<ApplicationStatusKey, number>;
  referralConversion: ReferralConversionSummary;
  awaitingManualReview: AwaitingManualReviewEntry[];
  overdueFollowUps: OverdueFollowUpEntry[];
  nextActionHints: NextActionHintEntry[];
  // Recent searches (EUO-13, G7): the last maxRecentSearchesShown completed
  // searches, newest first, so past queries are reviewable and repeatable.
  recentSearches: SearchHistoryEntry[];
}

export interface FunnelReportOptions {
  referenceDate?: Date;
  stalenessWindowDays?: number;
  searchHistory?: SearchHistory;
}

export interface LoadFunnelReportOptions extends FunnelReportOptions {
  historyPath?: string;
  contactsPath?: string;
  searchHistoryPath?: string;
  dataRoot?: string;
  // H4: output file path for the report. When provided, the report
  // is written to this path (redacted by default). Resolved through
  // assertConfinedToRoot — basename only, confined inside the data root.
  outputPath?: string;
}

// Display cap for the recent-searches report section (EUO-13). A presentation
// limit, not a configurable threshold (N4 governs salary/clearance rules).
export const maxRecentSearchesShown = 10;

function zeroFitStatusCounts(): Record<FitStatusKey, number> {
  const empty = {} as Record<FitStatusKey, number>;
  for (const status of allFitStatuses) {
    empty[status] = 0;
  }
  return empty;
}

function zeroStatusCounts(): Record<ApplicationStatusKey, number> {
  const empty = {} as Record<ApplicationStatusKey, number>;
  for (const status of allApplicationStatuses) {
    empty[status] = 0;
  }
  return empty;
}

// A "converted" application is one the user has acted on beyond merely being
// evaluated: any recorded status other than the initial `evaluated` log entry
// (generated, appliedConfirmed, staleNoResponse from a stale appliedConfirmed,
// rejected, interviewing, or offer). The conversion rate is converted /
// evaluated, or null when there are no evaluated applications in the cohort
// (no meaningful rate, not a fabricated 0%).
export function conversionStatistics(records: readonly ApplicationRecord[]): ConversionStatistics {
  const converted = records.filter((record) => record.status !== 'evaluated').length;
  return {
    evaluated: records.length,
    converted,
    conversionRate: records.length === 0 ? null : converted / records.length,
  };
}

// A follow-up is overdue when followUpDue is non-empty and strictly earlier
// than the reference date. Phase D: comparison is by parsed day value, not
// lexicographic string order — non-ISO but parseable dates (for example
// '08/01/2026') compare by their instant, and an unparseable value is never
// overdue (it is invalid input, validated at intake, not a past date).
export function isFollowUpOverdue(followUpDue: string, referenceDate: Date): boolean {
  if (followUpDue.length === 0) {
    return false;
  }
  const dueTime = Date.parse(followUpDue);
  if (Number.isNaN(dueTime)) {
    return false;
  }
  const todayIso = referenceDate.toISOString().slice(0, 10);
  const dueIso = new Date(dueTime).toISOString().slice(0, 10);
  return dueIso < todayIso;
}

// The next-action hint for one application (SRA-03): null means no action is
// suggested. Rules are display-only and derived, never written back to history.
export function nextActionHintFor(
  record: ApplicationRecord,
  options: { referenceDate?: Date; stalenessWindowDays?: number } = {},
): string | null {
  const referenceDate = options.referenceDate ?? new Date();
  const windowDays = options.stalenessWindowDays ?? defaultStalenessWindowDays;
  if (record.fitStatus === 'manualReview' && record.status === 'evaluated') {
    return 'decide: review or archive';
  }
  if (record.fitStatus === 'strongFit' && record.status === 'evaluated') {
    return 'generate resume';
  }
  if (record.status === 'generated') {
    return 'apply: confirm submission';
  }
  if (record.status === 'staleNoResponse') {
    return 'follow up';
  }
  if (record.status === 'appliedConfirmed' && isStale(record, { referenceDate, windowDays })) {
    return 'follow up';
  }
  return null;
}

export function buildFunnelReport(
  history: ApplicationHistory,
  contacts: NetworkingContacts,
  options: FunnelReportOptions = {},
): FunnelReport {
  const referenceDate = options.referenceDate ?? new Date();
  const windowDays = options.stalenessWindowDays ?? defaultStalenessWindowDays;
  const records = history.applications;

  const fitStatusCounts = zeroFitStatusCounts();
  const statusCounts = zeroStatusCounts();

  for (const record of records) {
    fitStatusCounts[record.fitStatus] += 1;
    const staleStatusOnly = record.status === 'appliedConfirmed' && isStale(record, { referenceDate, windowDays });
    if (staleStatusOnly) {
      statusCounts.staleNoResponse += 1;
    } else {
      statusCounts[record.status] += 1;
    }
  }

  // An application is referral-linked if its record carries a referralContact
  // OR any networking contact's linkedApplicationIds references it (Requirement
  // 6: contacts track people, postings record the linkage either way).
  const referencedApplicationIds = new Set<string>();
  for (const contact of contacts.contacts) {
    for (const applicationId of contact.linkedApplicationIds) {
      referencedApplicationIds.add(applicationId);
    }
  }
  // Referral predicate shared by both cohorts: a record is referral-linked
  // when it carries a referralContact OR any networking contact references it
  // via linkedApplicationIds. Single definition so the cohorts partition the
  // records instead of overlapping.
  function isReferralLinkedRecord(record: ApplicationRecord, referencedIds: Set<string>): boolean {
    return (
      (record.referralContact !== null && record.referralContact !== undefined && record.referralContact !== '') ||
      referencedIds.has(record.applicationId)
    );
  }

  const referralLinkedRecords = records.filter((record) => isReferralLinkedRecord(record, referencedApplicationIds));
  // Cold means not referral-linked by either signal: a record referenced via
  // linkedApplicationIds with an empty referralContact belongs to exactly one
  // cohort (referral), never both.
  const coldApplyRecords = records.filter(
    (record) => !isReferralLinkedRecord(record, referencedApplicationIds),
  );

  const awaitingManualReview = records
    .filter((record) => record.fitStatus === 'manualReview')
    .map((record) => ({
      applicationId: record.applicationId,
      companyName: record.companyName,
      roleTitle: record.roleTitle,
      jobUrl: record.jobUrl,
      fitScore: record.fitScore,
    }));

  const overdueFollowUps = contacts.contacts
    .filter((contact) => isFollowUpOverdue(contact.followUpDue, referenceDate))
    .map((contact) => ({
      contactId: contact.contactId,
      name: contact.name,
      company: contact.company,
      relationship: contact.relationship,
      followUpDue: contact.followUpDue,
    }))
    .sort((first, second) => first.followUpDue.localeCompare(second.followUpDue));

  const nextActionHints = records
    .map((record) => {
      const hint = nextActionHintFor(record, { referenceDate, stalenessWindowDays: windowDays });
      if (hint === null) {
        return null;
      }
      return {
        applicationId: record.applicationId,
        companyName: record.companyName,
        roleTitle: record.roleTitle,
        status: record.status,
        fitStatus: record.fitStatus,
        hint,
      };
    })
    .filter((entry): entry is NextActionHintEntry => entry !== null);

  // EUO-13: the stored search history (entries in run order, oldest first)
  // becomes a report section of the most recent searches, newest first. A
  // missing/empty history simply yields an empty section.
  const recentSearches = (options.searchHistory?.searches ?? [])
    .slice(-maxRecentSearchesShown)
    .reverse();

  return {
    generatedAt: referenceDate.toISOString(),
    totalApplications: records.length,
    fitStatusCounts,
    statusCounts,
    referralConversion: {
      referralLinked: conversionStatistics(referralLinkedRecords),
      coldApply: conversionStatistics(coldApplyRecords),
    },
    awaitingManualReview,
    overdueFollowUps,
    nextActionHints,
    recentSearches,
  };
}

export async function loadFunnelReport(options: LoadFunnelReportOptions = {}): Promise<FunnelReport> {
  const root =
    options.dataRoot !== undefined && options.dataRoot.trim().length > 0 ? options.dataRoot : undefined;
  const history = await readApplicationHistory(options.historyPath, root);
  const contacts = await readNetworkingContacts(options.contactsPath, root);
  const searchHistory = await readSearchHistory(options.searchHistoryPath, root);
  return buildFunnelReport(history, contacts, {
    referenceDate: options.referenceDate,
    stalenessWindowDays: options.stalenessWindowDays,
    searchHistory,
  });
}

// H4 PII hygiene: single-sourced warning strings (R3/U45). Every terminal
// and file warning below references these constants; no handler builds its
// own copy, so the wording cannot drift between surfaces.
export const identitiesShownNote =
  'NOTE: Identities (names, companies, contact IDs) are shown in terminal output. Use --output for redacted file output.';
export const fileNotRedactedWarning =
  'WARNING: funnel report file output is NOT redacted. Identity fields (names, companies, contact IDs) are visible.';

// H4 PII hygiene: create a redacted copy of the report where
// identity-bearing fields (names, companies, contact IDs, plus the
// company/role-encoding applicationId, roleTitle, and jobUrl — B4/U45) are
// replaced with placeholder tokens. Numeric fit scores are kept
// as-is since they carry no identity information. recentSearches holds the
// operator's own past queries (needed repeatable for EUO-13) and is left
// untouched; callers that must not leak queries should omit the section.
export function redactFunnelReport(report: FunnelReport): FunnelReport {
  return {
    ...report,
    awaitingManualReview: report.awaitingManualReview.map((entry) => ({
      ...entry,
      applicationId: '<redacted>',
      companyName: '<redacted>',
      roleTitle: '<redacted>',
      jobUrl: '<redacted>',
    })),
    overdueFollowUps: report.overdueFollowUps.map((entry) => ({
      ...entry,
      contactId: '<redacted>',
      name: '<redacted>',
      company: '<redacted>',
      relationship: '<redacted>',
    })),
    nextActionHints: report.nextActionHints.map((entry) => ({
      ...entry,
      applicationId: '<redacted>',
      companyName: '<redacted>',
      roleTitle: '<redacted>',
    })),
  };
}

// Write a funnel report to a file. The path is confined to the
// data root (basename only, asserted via assertConfinedToRoot).
// H4: file output is redacted by default; pass redact=false to
// opt out (which also emits a loud warning).
export async function writeFunnelReportToFile(
  report: FunnelReport,
  outputPath: string,
  options: { redact?: boolean; dataRoot?: string; format?: 'table' | 'json' } = {},
): Promise<string> {
  const dataRoot =
    options.dataRoot !== undefined && options.dataRoot.trim().length > 0
      ? options.dataRoot
      : resolveDataRoot();
  const safeName = basename(outputPath);
  const confinedPath = assertConfinedToRoot(dataRoot, join(dataRoot, safeName), 'reportOutput');
  const shouldRedact = options.redact !== false;
  const displayReport = shouldRedact ? redactFunnelReport(report) : report;
  // O2/U45: --format is honored for file output too (previously the json
  // branch returned the same table bytes). The redact flag is threaded into
  // the table formatter so the identities-shown NOTE fires exactly when
  // identities are actually shown — never for a redacted file (B3/U45).
  const content =
    options.format === 'json'
      ? JSON.stringify(displayReport, null, 2)
      : formatFunnelReportTable(displayReport, shouldRedact).join('\n');
  // H4 warning: if not redacting, warn loudly that identities are exposed
  if (!shouldRedact) {
    console.warn(fileNotRedactedWarning);
  }
  await writeFileAtomically(confinedPath, content);
  return confinedPath;
}

function formatPercent(statistics: ConversionStatistics): string {
  if (statistics.conversionRate === null) {
    return '—';
  }
  return `${(statistics.conversionRate * 100).toFixed(1)}%`;
}

function countTableRows(headers: readonly string[], rows: readonly (readonly string[])[]): string[] {
  const header = `| ${headers.join(' | ')} |`;
  const separator = `| ${headers.map(() => '---').join(' | ')} |`;
  const body = rows.map((row) => `| ${row.join(' | ')} |`);
  return [header, separator, ...body];
}

// Human-readable CLI rendering (report --format table). The report owns its
// own lightweight table layout; it is not one of the two fixed scrape-result
// tables owned by scrapeResultsFormatter.ts / excludedResultsFormatter.ts, so
// prefixed headers keep every section readable in one printout.
// H4: when redact is true, identity fields are replaced with
// placeholder tokens; fit scores and numeric fields are kept.
// Terminal output always prints a one-line warning that identities
// are shown; file output is redacted by default.
export function formatFunnelReportTable(report: FunnelReport, redact = false): string[] {
  const displayReport = redact ? redactFunnelReport(report) : report;
  const lines: string[] = [];
  // H4: warn exactly when identities are shown, i.e. when the caller asked
  // for no redaction. (B3/U45: the CLI wrapper previously warned in the
  // opposite case; the single-sourced string lives above.)
  if (!redact) {
    console.warn(identitiesShownNote);
  }
  const dateLabel = displayReport.generatedAt.slice(0, 10);
  lines.push(`Funnel report (reference ${dateLabel}) — ${displayReport.totalApplications} application(s) evaluated`);
  lines.push('');
  lines.push('By fit status:');
  const fitRows = allFitStatuses.map(
    (status): readonly string[] => [status, String(displayReport.fitStatusCounts[status])],
  );
  lines.push(...countTableRows(['Fit Status', 'Count'], fitRows));
  lines.push('');
  lines.push('By application status:');
  const statusRows = allApplicationStatuses.map(
    (status): readonly string[] => [status, String(displayReport.statusCounts[status])],
  );
  lines.push(...countTableRows(['Status', 'Count'], statusRows));
  lines.push('');
  lines.push('Referral-linked vs. cold-apply conversion:');
  const referralStatistics = displayReport.referralConversion.referralLinked;
  const coldStatistics = displayReport.referralConversion.coldApply;
  const conversionRows: readonly (readonly string[])[] = [
    ['Referral-linked', String(referralStatistics.evaluated), String(referralStatistics.converted), formatPercent(referralStatistics)],
    ['Cold apply', String(coldStatistics.evaluated), String(coldStatistics.converted), formatPercent(coldStatistics)],
  ];
  lines.push(...countTableRows(['Cohort', 'Evaluated', 'Converted', 'Conversion rate'], conversionRows));
  lines.push('');
  if (displayReport.awaitingManualReview.length === 0) {
    lines.push('Applications awaiting manualReview action: none');
  } else {
    lines.push(`Applications awaiting manualReview action: ${displayReport.awaitingManualReview.length}`);
    const reviewRows = displayReport.awaitingManualReview.map(
      (entry): readonly string[] => [entry.applicationId, entry.companyName, entry.roleTitle, entry.fitScore.toFixed(1)],
    );
    lines.push(...countTableRows(['Application ID', 'Organization', 'Job Title', 'Fit Score'], reviewRows));
  }
  lines.push('');
  if (displayReport.overdueFollowUps.length === 0) {
    lines.push('Contacts with overdue follow-ups: none');
  } else {
    lines.push(`Contacts with overdue follow-ups: ${displayReport.overdueFollowUps.length}`);
    const followUpRows = displayReport.overdueFollowUps.map(
      (entry): readonly string[] => [entry.contactId, entry.name, entry.company, entry.relationship, entry.followUpDue],
    );
    lines.push(...countTableRows(['Contact ID', 'Name', 'Company', 'Relationship', 'Follow-up due'], followUpRows));
  }
  lines.push('');
  if (displayReport.nextActionHints.length === 0) {
    lines.push('Next actions: none');
  } else {
    lines.push(`Next actions: ${displayReport.nextActionHints.length}`);
    const hintRows = displayReport.nextActionHints.map(
      (entry): readonly string[] => [
        entry.applicationId,
        entry.companyName,
        entry.roleTitle,
        entry.status,
        entry.fitStatus,
        entry.hint,
      ],
    );
    lines.push(...countTableRows(['Application ID', 'Organization', 'Job Title', 'Status', 'Fit Status', 'Hint'], hintRows));
  }
  lines.push('');
  if (displayReport.recentSearches.length === 0) {
    lines.push('Recent searches: none');
  } else {
    lines.push(`Recent searches: ${displayReport.recentSearches.length}`);
    const searchRows = displayReport.recentSearches.map(
      (entry): readonly string[] => [
        entry.timestamp.slice(0, 16).replace('T', ' '),
        entry.keywords,
        entry.location,
        String(entry.resultCount),
      ],
    );
    lines.push(...countTableRows(['Timestamp', 'Keywords', 'Location', 'Results'], searchRows));
  }
  return lines;
}
