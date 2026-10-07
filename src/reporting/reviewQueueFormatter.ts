import type { ApplicationRecord } from '../utils/jobFunnelTracker';
import { buildMarkdownCells, type MarkdownTable } from './scrapeResultsFormatter';

// Review Queue table (SDD Requirement 9 / Requirement 2 manualReview tier).
// A deliberately light, dedicated table for "here's what needs a human
// decision", NOT a reuse of excludedResultsFormatter.ts, which owns the
// Excluded Results contract for hardRejected/weakFit and would mislabel
// manualReview rows as excluded. The column set below is asserted verbatim by
// a test so a future session cannot silently reorder or extend it.
//
// Rows are applicationHistory records with fitStatus manualReview. The
// ApplicationRecord does not persist the evaluator's routing notes, so this
// table surfaces the current status (the handle to act on generator,
// confirm, or mark rejected) rather than a diagnostic justification.
//
// Why two formatters (Phase 5c): this file is the queue view — manualReview
// rows awaiting a human decision, keyed by Application ID with a Current
// Status action handle. excludedResultsFormatter.ts is the batch table —
// hardRejected/weakFit rows with a diagnostic Justification for
// over-rejection auditing. Reusing one for the other would mislabel queue
// rows as excluded or batch rows as actionable, so both stay.
//
// Ownership (Phase 5c): consumed by the review queue surface in
// src/cli/jobSearchCore.ts. Single consumer by design, not dead code.

export const reviewQueueColumns = [
  'Sr. No.',
  'Application ID',
  'Job Title',
  'Organization',
  'Location',
  'Fit Score',
  'Current Status',
  'Link',
] as const;

export type ReviewQueueColumn = (typeof reviewQueueColumns)[number];

export interface ReviewQueueRow {
  srNo: number;
  applicationId: string;
  jobTitle: string;
  organization: string;
  location: string;
  fitScore: number;
  currentStatus: string;
  link: string;
}

export interface ReviewQueueTable {
  columns: readonly ReviewQueueColumn[];
  rows: ReviewQueueRow[];
}

function isAwaitingManualReview(record: ApplicationRecord): boolean {
  return record.fitStatus === 'manualReview';
}

export function formatReviewQueue(records: readonly ApplicationRecord[]): ReviewQueueTable {
  const pending = records.filter(isAwaitingManualReview);
  // ApplicationRecord predates raw location persistence, so Location falls
  // back to the stored postingFacts locationType (which is the whole location
  // for remote roles) and to 'unknown' when that is missing or blank, so the
  // column never renders an empty cell.
  const rows = pending.map((record, index) => {
    const locationType = record.postingFacts?.locationType;
    return {
      srNo: index + 1,
      applicationId: record.applicationId,
      jobTitle: record.roleTitle,
      organization: record.companyName,
      location: locationType !== undefined && locationType.length > 0 ? locationType : 'unknown',
      fitScore: record.fitScore,
      currentStatus: record.status,
      link: record.jobUrl,
    };
  });
  return { columns: reviewQueueColumns, rows };
}

function reviewQueueCellValue(row: ReviewQueueRow, column: ReviewQueueColumn): string {
  switch (column) {
    case 'Sr. No.':
      return String(row.srNo);
    case 'Application ID':
      return row.applicationId;
    case 'Job Title':
      return row.jobTitle;
    case 'Organization':
      return row.organization;
    case 'Location':
      return row.location;
    case 'Fit Score':
      return row.fitScore.toFixed(1);
    case 'Current Status':
      return row.currentStatus;
    case 'Link':
      return row.link;
  }
}

export function reviewQueueToMarkdown(table: ReviewQueueTable): MarkdownTable {
  return {
    columns: table.columns,
    rows: buildMarkdownCells(table.rows, table.columns, reviewQueueCellValue),
  };
}
