import { describe, expect, it } from 'vitest';
import type { ApplicationRecord } from '../utils/jobFunnelTracker';
import { excludedResultColumns } from './excludedResultsFormatter';
import {
  formatReviewQueue,
  reviewQueueColumns,
  reviewQueueToMarkdown,
  type ReviewQueueTable,
} from './reviewQueueFormatter';

function record(overrides: Partial<ApplicationRecord> = {}): ApplicationRecord {
  return {
    applicationId: 'app2026SampleCorpPlatformLead',
    companyName: 'SampleCorp',
    roleTitle: 'Platform Lead',
    jobUrl: 'https://example.com/jobs/platform-lead',
    postingHash: 'hashA',
    sourceAggregators: ['test'],
    salaryRange: null,
    fitScore: 2.9,
    fitStatus: 'manualReview',
    referralContact: null,
    status: 'evaluated',
    statusHistory: [{ stage: 'evaluated', timestamp: '2026-08-08T10:00:00Z' }],
    ...overrides,
  };
}

describe('reviewQueueFormatter: dedicated lightweight contract (not excludedResultsFormatter)', () => {
  it('owns a distinct column set for "needs a human decision"', () => {
    expect(reviewQueueColumns).toEqual([
      'Sr. No.',
      'Application ID',
      'Job Title',
      'Organization',
      'Location',
      'Fit Score',
      'Current Status',
      'Link',
    ]);
    expect(reviewQueueColumns).toHaveLength(8);
  });

  it('keeps only manualReview records and numbers sequentially from 1', () => {
    const records = [
      record({ applicationId: 'reviewA' }),
      record({ fitStatus: 'strongFit', applicationId: 'keep-out' }),
      record({ fitStatus: 'weakFit', applicationId: 'keep-out-2' }),
      record({ fitStatus: 'hardRejected', applicationId: 'keep-out-3' }),
      record({ applicationId: 'reviewB' }),
    ];
    const table = formatReviewQueue(records);
    expect(table.rows.map((row) => row.applicationId)).toEqual(['reviewA', 'reviewB']);
    expect(table.rows.map((row) => row.srNo)).toEqual([1, 2]);
  });

  it('surfaces the current status as the actionable handle, with link and score', () => {
    const table = formatReviewQueue([record({ status: 'generated' })]);
    const row = table.rows[0];
    expect(row.currentStatus).toBe('generated');
    expect(row.organization).toBe('SampleCorp');
    expect(row.jobTitle).toBe('Platform Lead');
    expect(row.link).toBe('https://example.com/jobs/platform-lead');
    expect(row.fitScore).toBe(2.9);
    // Records predate raw location persistence, so Location falls back to the
    // stored postingFacts locationType and to 'unknown' when that is missing
    // or blank, so the column never renders an empty cell.
    expect(row.location).toBe('unknown');
    const remote = formatReviewQueue([record({ postingFacts: { locationType: 'remote' } })]);
    expect(remote.rows[0].location).toBe('remote');
  });

  it('renders to markdown with the full header row', () => {
    const table = formatReviewQueue([record()]);
    const markdown = reviewQueueToMarkdown(table);
    expect(markdown.columns).toEqual(reviewQueueColumns);
    expect(markdown.columns).toHaveLength(8);
    expect(markdown.rows[0][1]).toBe('app2026SampleCorpPlatformLead');
    expect(markdown.rows[0][4]).toBe('unknown');
  });

  it('renders cells in the order of the table columns (column-driven, byte-identical for the default order)', () => {
    const table = formatReviewQueue([record({ status: 'generated' })]);
    const markdown = reviewQueueToMarkdown(table);
    const row = table.rows[0];
    // Default column order: cells match the positional contract exactly.
    expect(markdown.rows[0]).toEqual([
      String(row.srNo),
      row.applicationId,
      row.jobTitle,
      row.organization,
      row.location,
      row.fitScore.toFixed(1),
      row.currentStatus,
      row.link,
    ]);
    // A reordered column list reorders the rendered cells to match.
    const reordered: ReviewQueueTable = {
      columns: ['Link', 'Fit Score', 'Application ID'],
      rows: table.rows,
    };
    const reorderedMarkdown = reviewQueueToMarkdown(reordered);
    expect(reorderedMarkdown.columns).toEqual(['Link', 'Fit Score', 'Application ID']);
    expect(reorderedMarkdown.rows[0]).toEqual([row.link, row.fitScore.toFixed(1), row.applicationId]);
  });

  it('returns an empty rows list when nothing is awaiting review', () => {
    const table = formatReviewQueue([record({ fitStatus: 'strongFit' })]);
    expect(table.rows).toEqual([]);
    expect(table.columns).toEqual(reviewQueueColumns);
  });

  it('differs from the batch Excluded Results table in the documented way (queue view vs batch table)', () => {
    // Queue view: manualReview rows awaiting a human decision, keyed by
    // Application ID with a Current Status action handle, no diagnostic column.
    expect(reviewQueueColumns).toContain('Application ID');
    expect(reviewQueueColumns).toContain('Current Status');
    expect(reviewQueueColumns).not.toContain('Justification');
    // Batch table: hardRejected/weakFit rows with a diagnostic Justification
    // for over-rejection auditing, no per-application action handle.
    expect(excludedResultColumns).toContain('Justification');
    expect(excludedResultColumns).not.toContain('Application ID');
    expect(excludedResultColumns).not.toContain('Current Status');
  });

  it("renders 'unknown' for a missing or blank locationType (Phase F)", () => {
    const missing = formatReviewQueue([record({ postingFacts: undefined })]);
    expect(missing.rows[0].location).toBe('unknown');
    const blankFacts = { locationType: '' } as unknown as ApplicationRecord['postingFacts'];
    const blank = formatReviewQueue([record({ postingFacts: blankFacts })]);
    expect(blank.rows[0].location).toBe('unknown');
    const markdown = reviewQueueToMarkdown(missing);
    expect(markdown.rows[0][4]).toBe('unknown');
  });
});
