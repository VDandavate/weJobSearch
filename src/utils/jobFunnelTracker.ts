import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';
import {
  applicationHistoryFileName,
  applicationsDirectoryName,
  assertConfinedToRoot,
  redactHomePrefix,
} from './canonicalDataRoot';
import { normalizeCompanyName, normalizeLocation, normalizeRoleTitle } from './postingIdentity';
import {
  readJsonStoreFile,
  resolveStoreFilePath,
  resolveStoreRoot,
  writeJsonStoreFile,
} from './jsonStore';

export const applicationStatusSchema = z.enum([
  'evaluated',
  'generated',
  'appliedConfirmed',
  'staleNoResponse',
  'rejected',
  'interviewing',
  'offer',
]);
export type ApplicationStatus = z.infer<typeof applicationStatusSchema>;

export const fitStatusSchema = z.enum(['strongFit', 'manualReview', 'weakFit', 'hardRejected']);
export type FitStatus = z.infer<typeof fitStatusSchema>;

export const statusHistoryEntrySchema = z.object({
  stage: applicationStatusSchema,
  // Phase D: timestamps are ISO datetimes (this tool always writes
  // Date.toISOString()); a non-datetime string is malformed data, not a
  // timestamp, and must fail validation loudly instead of flowing into
  // staleness math as NaN.
  timestamp: z.string().datetime(),
  notes: z.string().optional(),
});

// Optional posting facts persisted at evaluate time (SRA-02), so the detail
// view and review flow can re-read what the posting said about location,
// employer type, and clearance without re-scraping. All fields optional so
// records written before this schema extension still parse unchanged.
export const postingFactsSchema = z.object({
  locationType: z.enum(['remote', 'hybrid', 'onsite', 'unknown']).optional(),
  employerType: z.enum(['staffingAgency', 'unknown']).optional(),
  requiredClearanceLevel: z
    .enum(['publicTrust', 'secret', 'topSecret', 'tsSci', 'none', 'unknown'])
    .optional(),
});
export type PostingFactsRecord = z.infer<typeof postingFactsSchema>;

export const applicationRecordSchema = z.object({
  applicationId: z.string(),
  companyName: z.string(),
  roleTitle: z.string(),
  jobUrl: z.string(),
  postingHash: z.string(),
  sourceAggregators: z.array(z.string()),
  salaryRange: z.string().nullable().optional(),
  fitScore: z.number(),
  fitStatus: fitStatusSchema,
  referralContact: z.string().nullable().optional(),
  // Resume variant used when the tailored resume was generated (EUO-16, G9):
  // recorded at generation time so pattern analysis can correlate outcomes
  // with the variant. Optional/nullable so records written before this field
  // existed still parse unchanged.
  resumeVariant: z.string().nullable().optional(),
  status: applicationStatusSchema,
  statusHistory: z.array(statusHistoryEntrySchema),
  postingDescription: z.string().optional(),
  postingFacts: postingFactsSchema.optional(),
});
export type ApplicationRecord = z.infer<typeof applicationRecordSchema>;

export const applicationHistorySchema = z.object({
  applications: z.array(applicationRecordSchema),
});
export type ApplicationHistory = z.infer<typeof applicationHistorySchema>;

// Config-driven history location (v0.2.1 Lane A). The default is resolved at
// call time (not import time) so the WEJOBSEARCHDATAROOT environment override
// and an explicit data root are honored: CLI filePath > dataRoot >
// WEJOBSEARCHDATAROOT env > canonical default.
export function resolveApplicationHistoryPath(
  cliHistoryPath?: string | null,
  dataRoot?: string | null,
): string {
  if (cliHistoryPath !== undefined && cliHistoryPath !== null && cliHistoryPath.trim().length > 0) {
    const root = resolveStoreRoot(dataRoot);
    assertConfinedToRoot(root, cliHistoryPath, 'historyPath');
    return cliHistoryPath;
  }
  const root = resolveStoreRoot(dataRoot);
  const historyPath = join(root, applicationsDirectoryName, applicationHistoryFileName);
  assertConfinedToRoot(root, historyPath, 'historyPath');
  return historyPath;
}

export function generateApplicationId(companyName: string, roleTitle: string, referenceDate?: Date): string {  const year = (referenceDate ?? new Date()).getFullYear();
  const normalizedCompany = companyName.replace(/[^A-Za-z0-9]/g, '');
  const normalizedRole = roleTitle.replace(/[^A-Za-z0-9]/g, '');
  return `app${year}${normalizedCompany}${normalizedRole}`;
}

export function computePostingHash(companyName: string, roleTitle: string, location: string): string {
  // Hash the normalized forms (legal-suffix-stripped company, seniority-
  // expanded title, normalized location) so spelling variants of the same
  // posting — "Acme Inc / Sr Engineer" vs "Acme / Senior Engineer" — share
  // one hash instead of generating duplicate records. The final strip keeps
  // the preimage fully alphanumeric, matching the historical hash contract.
  const normalized =
    `${normalizeCompanyName(companyName)}${normalizeRoleTitle(roleTitle)}${normalizeLocation(location)}`.replace(
      /[^a-z0-9]/g,
      '',
    );
  return createHash('sha256').update(normalized).digest('hex');
}

export async function readApplicationHistory(
  filePath?: string | null,
  rootDir?: string | null,
): Promise<ApplicationHistory> {
  // Confinement is checked against the effective root: an explicit rootDir
  // (relocated reads) or the env/canonical data root otherwise. The default
  // path is derived from that same root (U43) — defaulting from
  // resolveDataRoot() first made relocated reads resolve the canonical path
  // and then fail confinement against the relocated root.
  const root = resolveStoreRoot(rootDir);
  const resolvedPath = resolveStoreFilePath(filePath, resolveApplicationHistoryPath(undefined, root));
  return readJsonStoreFile({
    resolvedPath,
    root,
    label: 'readApplicationHistory',
    noun: 'application history',
    schema: applicationHistorySchema,
    missing: () => ({ applications: [] }),
  });
}

export async function writeApplicationHistory(
  history: ApplicationHistory,
  filePath?: string | null,
  rootDir?: string | null,
): Promise<void> {
  const root = resolveStoreRoot(rootDir);
  const resolvedPath = resolveStoreFilePath(filePath, resolveApplicationHistoryPath(undefined, root));
  await writeJsonStoreFile({
    data: history,
    resolvedPath,
    noun: 'application history',
    schema: applicationHistorySchema,
    verifyExisting: () => readApplicationHistory(resolvedPath, root),
    confine: { root, label: 'writeApplicationHistory' },
  });
}

export class DuplicateApplicationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DuplicateApplicationError';
  }
}

export async function logApplication(
  record: ApplicationRecord,
  filePath: string = resolveApplicationHistoryPath(),
  rootDir?: string | null,
): Promise<ApplicationRecord> {
  const history = await readApplicationHistory(filePath, rootDir);
  // Identity is the postingHash (hash primary, Phase A): the hash encodes the
  // normalized company, role, AND location, so the same role in a new city is
  // a distinct record (different hash, same applicationId) while the same
  // posting seen twice is rejected as a duplicate regardless of how the
  // applicationId happens to be spelled - a differently-spelled company name
  // that normalizes to the same hash must not fork a second record.
  const duplicate = history.applications.some((existing) => existing.postingHash === record.postingHash);
  if (duplicate) {
    // Phase D: typed idempotency signal. Callers (searchOrchestrator's
    // persistEvaluationIfNew) match on instanceof, never on an
    // 'already exists' message substring, so rewording this message cannot
    // silently break the already-recorded path.
    throw new DuplicateApplicationError(
      `Application with id ${record.applicationId} (postingHash ${record.postingHash}) already exists in ${redactHomePrefix(filePath)}`,
    );
  }
  history.applications.push(record);
  await writeApplicationHistory(history, filePath, rootDir);
  return record;
}

export interface AppendApplicationHistoryResult {
  added: ApplicationRecord[];
  duplicates: ApplicationRecord[];
}

// Batch append (audit finding 7): one read, one schema validation, one merge,
// one atomic write for the whole batch instead of a read-rewrite per posting.
// Identity is postingHash, as in logApplication: a hash already in the file or
// earlier in the same batch is reported as a duplicate and never written, so a
// duplicate inside the batch cannot fork a record. A malformed existing file
// fails during the read, before anything is written.
export async function appendApplicationHistory(
  records: readonly ApplicationRecord[],
  filePath?: string | null,
  rootDir?: string | null,
): Promise<AppendApplicationHistoryResult> {
  const root = resolveStoreRoot(rootDir);
  const resolvedPath = resolveStoreFilePath(filePath, resolveApplicationHistoryPath(undefined, root));
  const history = await readApplicationHistory(resolvedPath, root);
  const knownHashes = new Set(history.applications.map((application) => application.postingHash));
  const added: ApplicationRecord[] = [];
  const duplicates: ApplicationRecord[] = [];
  for (const record of records) {
    if (knownHashes.has(record.postingHash)) {
      duplicates.push(record);
      continue;
    }
    knownHashes.add(record.postingHash);
    history.applications.push(record);
    added.push(record);
  }
  if (added.length > 0) {
    await writeJsonStoreFile({
      data: history,
      resolvedPath,
      noun: 'application history',
      schema: applicationHistorySchema,
      confine: { root, label: 'appendApplicationHistory' },
    });
  }
  return { added, duplicates };
}

export async function updateApplicationStatus(
  applicationId: string,
  newStatus: ApplicationStatus,
  notes?: string,
  filePath: string = resolveApplicationHistoryPath(),
  rootDir?: string | null,
  postingHash?: string,
): Promise<ApplicationRecord> {
  const history = await readApplicationHistory(filePath, rootDir);
  const record = findApplicationRecord(history, applicationId, postingHash, filePath);
  record.status = newStatus;
  record.statusHistory.push({ stage: newStatus, timestamp: new Date().toISOString(), notes });
  await writeApplicationHistory(history, filePath, rootDir);
  return record;
}

// A2: record lookup is unambiguous. When postingHash is supplied the target is
// the record matching BOTH the id and the hash; without it, an id shared by
// several records (the same company and role evaluated in different cities)
// is an error instead of a silent first-match pick.
function findApplicationRecord(
  history: ApplicationHistory,
  applicationId: string,
  postingHash: string | undefined,
  filePath: string,
): ApplicationRecord {
  const matches = history.applications.filter((application) => application.applicationId === applicationId);
  if (postingHash !== undefined) {
    const exact = matches.find((application) => application.postingHash === postingHash);
    if (exact === undefined) {
      throw new Error(
        `No application found with id ${applicationId} and postingHash ${postingHash} in ${redactHomePrefix(filePath)}`,
      );
    }
    return exact;
  }
  if (matches.length > 1) {
    throw new Error(
      `Application id ${applicationId} is ambiguous: ${matches.length} records share it (the same company and role in different cities). Retry with the postingHash of the target record in ${redactHomePrefix(filePath)}`,
    );
  }
  if (matches.length === 0) {
    throw new Error(`No application found with id ${applicationId} in ${redactHomePrefix(filePath)}`);
  }
  return matches[0];
}

// Records that a tailored resume was generated for an application (EUO-16):
// sets status to 'generated' and stores the resume variant used, so pattern
// analysis can later correlate outcomes with variants. Idempotent on
// re-generation: the variant is updated but no duplicate statusHistory entry
// is appended when the record is already in the generated stage.
// A3: forward-only gate, mirrored from the confirmApplicationSubmission guard
// in jobSearchCore.ts - only evaluated and generated records may be marked as
// generated, so a record that has already moved past generation
// (appliedConfirmed, interviewing, offer, staleNoResponse, rejected) is never
// regressed. A2: postingHash disambiguates when several records share the id.
export async function markResumeGenerated(
  applicationId: string,
  variant: string,
  filePath: string = resolveApplicationHistoryPath(),
  rootDir?: string | null,
  postingHash?: string,
): Promise<ApplicationRecord> {
  const history = await readApplicationHistory(filePath, rootDir);
  const record = findApplicationRecord(history, applicationId, postingHash, filePath);
  if (record.status !== 'evaluated' && record.status !== 'generated') {
    throw new Error(
      `Application ${applicationId} is '${record.status}'; only evaluated or generated applications can be marked as generated.`,
    );
  }
  record.status = 'generated';
  record.resumeVariant = variant;
  if (record.statusHistory.at(-1)?.stage !== 'generated') {
    record.statusHistory.push({ stage: 'generated', timestamp: new Date().toISOString() });
  }
  await writeApplicationHistory(history, filePath, rootDir);
  return record;
}
