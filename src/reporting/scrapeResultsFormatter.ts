import type { FitAssessment } from '../evaluators/fitEvaluator';
import type { RawPosting } from '../scrapers/jobSpyAdapter';
import type { FitStatus } from '../utils/jobFunnelTracker';

// Active Results table (SDD Requirement 2a). Owns the fixed 7-column core
// contract for the active batch: any command that displays scrape results
// calls formatScrapeResults; no command builds its own ad hoc table. The core
// columns below (exact labels, exact order) are asserted verbatim by a test
// that pins them as literals independent of this constant, so a future
// session cannot add, remove, or reorder a core column without the test
// failing loudly (SDD Section 6.3). There are no conditional columns: every
// row carries exactly these seven cells.
//
// The Fit Score label is kept as-is: "Match Score" is documented as an alias
// in the CLI help text only, never as a rename.
//
// Input is an array of evaluated postings (fitEvaluator output plus RawPosting
// fields plus a pre-computed Brief). The caller never pre-splits the array:
// this formatter routes manualReview/strongFit into the Active table and the
// excluded formatter routes the rest. The Brief field is a pre-computed input,
// never generated here: the CLI's deterministic briefGenerator owns Brief
// generation for the evaluate/search pipeline, and this formatter truncates
// each Brief to the fixed 150-character ceiling (briefMaxLength) before
// display (SDD Requirement 2a grounding rule).

export const activeResultColumns = [
  'Sr. No.',
  'Job Title',
  'Organization',
  'Brief',
  'Fit Score',
  'Justification',
  'Link',
] as const;

export type ActiveResultCoreColumn = (typeof activeResultColumns)[number];

export type ActiveResultColumn = ActiveResultCoreColumn;

export const briefMaxLength = 150;

export interface EvaluatedPosting {
  posting: RawPosting;
  brief: string;
  assessment: FitAssessment;
}

export function isActiveFitStatus(status: FitStatus): boolean {
  return status === 'manualReview' || status === 'strongFit';
}

export function truncateBrief(brief: string): string {
  return truncateWithEllipsis(brief, briefMaxLength);
}

// Ellipsis truncation whose TOTAL length never exceeds maxLength (a 150-char
// ceiling means 147 content chars plus '...', never 153). Shared with the
// briefGenerator so both truncation sites honor the same ceiling.
export function truncateWithEllipsis(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  if (maxLength <= 3) {
    return value.slice(0, maxLength);
  }
  return `${value.slice(0, maxLength - 3)}...`;
}

// A literal pipe would split a markdown table row into extra cells, so every
// string cell is escaped before rendering. Numeric cells need no escaping.
export function escapeMarkdownCellValue(value: string): string {
  return value.replace(/\|/g, '\\|');
}

// Shared row-mapping behind the three cell-value plus markdown pairs (active,
// excluded, review queue): each formatter keeps its own cell function and
// column contract, but the mechanical rows-times-columns map lives here once.
export function buildMarkdownCells<Row, Column>(
  rows: readonly Row[],
  columns: readonly Column[],
  cellValue: (row: Row, column: Column) => string,
): string[][] {
  return rows.map((row) => columns.map((column) => cellValue(row, column)));
}

export interface ActiveResultRow {
  srNo: number;
  jobTitle: string;
  organization: string;
  brief: string;
  fitScore: number;
  justification: string;
  link: string;
}

export interface ActiveResultsTable {
  columns: readonly ActiveResultColumn[];
  rows: ActiveResultRow[];
}

export interface MarkdownTable {
  columns: readonly string[];
  rows: readonly (readonly string[])[];
}

export function renderMarkdown(table: MarkdownTable): string {
  const header = `| ${table.columns.join(' | ')} |`;
  const separator = `| ${table.columns.map(() => '---').join(' | ')} |`;
  const body = table.rows.map((row) => `| ${row.join(' | ')} |`);
  return [header, separator, ...body].join('\n');
}

// A manualReview routing decision (hasFullDescription:false reroute, custom
// rule, unparsable salary) is already a one-line reason in assessment.notes;
// prefer it verbatim so the human sees exactly why the post was surfaced.
function findRoutingNote(notes: string[]): string | undefined {
  return notes.find((note) =>
    /routed to manualReview|flagged for manualReview|cannot be interpreted automatically|unparseable or incomparable/i.test(
      note,
    ),
  );
}

function activeJustification(assessment: FitAssessment): string {
  const routingNote = findRoutingNote(assessment.notes);
  let reason: string;
  if (routingNote !== undefined) {
    reason = routingNote;
  } else if (assessment.deductions.length > 0) {
    reason = assessment.deductions.map((deduction) => deduction.label).join('; ');
  } else {
    reason = 'meets all evaluated requirements';
  }
  return `${assessment.fitStatus} — ${reason}`;
}

function buildActiveRow(entry: EvaluatedPosting, srNo: number): ActiveResultRow {
  return {
    srNo,
    jobTitle: entry.posting.roleTitle,
    organization: entry.posting.companyName,
    brief: truncateBrief(entry.brief),
    fitScore: entry.assessment.fitScore,
    justification: activeJustification(entry.assessment),
    link: entry.posting.jobUrl,
  };
}

export function formatScrapeResults(postings: readonly EvaluatedPosting[]): ActiveResultsTable {
  const active = postings.filter((entry) => isActiveFitStatus(entry.assessment.fitStatus));
  const rows = active.map((entry, index) => buildActiveRow(entry, index + 1));
  return { columns: activeResultColumns, rows };
}

function activeCellValue(row: ActiveResultRow, column: ActiveResultColumn): string {
  switch (column) {
    case 'Sr. No.':
      return String(row.srNo);
    case 'Job Title':
      return escapeMarkdownCellValue(row.jobTitle);
    case 'Organization':
      return escapeMarkdownCellValue(row.organization);
    case 'Brief':
      return escapeMarkdownCellValue(row.brief);
    case 'Fit Score':
      return row.fitScore.toFixed(1);
    case 'Justification':
      return escapeMarkdownCellValue(row.justification);
    case 'Link':
      return escapeMarkdownCellValue(row.link);
  }
}

export function activeResultsToMarkdown(table: ActiveResultsTable): MarkdownTable {
  return {
    columns: [...table.columns],
    rows: buildMarkdownCells(table.rows, table.columns, activeCellValue),
  };
}
