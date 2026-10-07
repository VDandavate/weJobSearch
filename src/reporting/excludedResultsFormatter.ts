import type { FitAssessment } from '../evaluators/fitEvaluator';
import {
  buildMarkdownCells,
  escapeMarkdownCellValue,
  isActiveFitStatus,
  type EvaluatedPosting,
  type MarkdownTable,
} from './scrapeResultsFormatter';

// Excluded Results table (SDD Requirement 2a). Owns the fixed 6-column core
// contract for the excluded subset (hardRejected/weakFit), rendered separately
// so a promising role is never buried among clear rejections and the user can
// audit whether the evaluator is over-rejecting. The exact core columns below
// are asserted verbatim by a test that pins them as literals independent of
// this constant, so they cannot be added, removed from, or reordered by a
// future session (SDD Section 6.3). There are no conditional columns.
//
// The Fit Score label is kept as-is: "Match Score" is documented as an alias
// in the CLI help text only, never as a rename.
//
// The caller never pre-splits the array: this formatter keeps everything whose
// fitStatus is not active (manualReview/strongFit). The Justification column
// carries the full reason for exclusion — the specific nonNegotiables ruleId
// that fired for hardRejected, or the dominant deduction(s) for weakFit.
// The Brief input field is accepted pre-computed and is not part of this
// core contract.

export const excludedResultColumns = [
  'Sr. No.',
  'Job Title',
  'Organization',
  'Fit Score',
  'Justification',
  'Link',
] as const;

export type ExcludedResultCoreColumn = (typeof excludedResultColumns)[number];

export type ExcludedResultColumn = ExcludedResultCoreColumn;

export interface ExcludedResultRow {
  srNo: number;
  jobTitle: string;
  organization: string;
  fitScore: number;
  justification: string;
  link: string;
}

export interface ExcludedResultsTable {
  columns: readonly ExcludedResultColumn[];
  rows: ExcludedResultRow[];
}

export function excludedJustification(assessment: FitAssessment): string {
  if (assessment.fitStatus === 'hardRejected') {
    if (assessment.rejectedNonNegotiableIds.length > 0) {
      return `hardRejected — nonNegotiable rule(s) fired: ${assessment.rejectedNonNegotiableIds.join(', ')}`;
    }
    if (assessment.deductions.length > 0) {
      return `hardRejected — score reduced to 0 by deductions: ${assessment.deductions
        .map((deduction) => deduction.label)
        .join('; ')}`;
    }
    return 'hardRejected — score reduced to 0 by the rejection gate';
  }
  if (assessment.deductions.length > 0) {
    return `weakFit — dominant deduction(s): ${assessment.deductions
      .map((deduction) => deduction.label)
      .join('; ')}`;
  }
  return 'weakFit — score falls in the weakFit band';
}

function buildExcludedRow(entry: EvaluatedPosting, srNo: number): ExcludedResultRow {
  return {
    srNo,
    jobTitle: entry.posting.roleTitle,
    organization: entry.posting.companyName,
    fitScore: entry.assessment.fitScore,
    justification: excludedJustification(entry.assessment),
    link: entry.posting.jobUrl,
  };
}

export function formatExcludedResults(postings: readonly EvaluatedPosting[]): ExcludedResultsTable {
  const excluded = postings.filter((entry) => !isActiveFitStatus(entry.assessment.fitStatus));
  const rows = excluded.map((entry, index) => buildExcludedRow(entry, index + 1));
  return { columns: excludedResultColumns, rows };
}

function excludedCellValue(row: ExcludedResultRow, column: ExcludedResultColumn): string {
  switch (column) {
    case 'Sr. No.':
      return String(row.srNo);
    case 'Job Title':
      return escapeMarkdownCellValue(row.jobTitle);
    case 'Organization':
      return escapeMarkdownCellValue(row.organization);
    case 'Fit Score':
      return row.fitScore.toFixed(1);
    case 'Justification':
      return escapeMarkdownCellValue(row.justification);
    case 'Link':
      return escapeMarkdownCellValue(row.link);
  }
}

export function excludedResultsToMarkdown(table: ExcludedResultsTable): MarkdownTable {
  return {
    columns: [...table.columns],
    rows: buildMarkdownCells(table.rows, table.columns, excludedCellValue),
  };
}
