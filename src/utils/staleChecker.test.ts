import { describe, expect, it } from 'vitest';
import type { ApplicationRecord } from './jobFunnelTracker';
import {
  defaultStalenessWindowDays,
  isStale,
  lastUpdateTimestampOf,
} from './staleChecker';

// Step 11 test suite for staleness handling (SDD Requirement 4, AGENTS.md
// Step 11): applications sitting in appliedConfirmed with no update for the
// configurable window (default 45 days) are flagged staleNoResponse in
// reporting. This is a visibility flag only; the checker never deletes or
// overwrites history. All records are synthetic fixtures.

const referenceDate = new Date('2026-08-09T12:00:00Z');

// Phase 7c: single named day-math constant for every relative fixture date in
// this file (was an inline 24 * 60 * 60 * 1000). The anchor above is a fixed
// historical test instant, never the live clock.

function makeRecord(overrides: Partial<ApplicationRecord> = {}): ApplicationRecord {
  return {
    applicationId: 'app2026AcmeCorpSeniorEngineer',
    companyName: 'AcmeCorp',
    roleTitle: 'SeniorEngineer',
    jobUrl: 'https://acme.example.com/jobs/senior-engineer',
    postingHash: 'a5c98a2b0b660d22a6940b5105468d5e13aebb1c5b5606a12827ed1dc0ac008c',
    sourceAggregators: ['linkedin'],
    salaryRange: 'USD 165000 - 195000/yr',
    fitScore: 4.8,
    fitStatus: 'strongFit',
    referralContact: null,
    status: 'appliedConfirmed',
    statusHistory: [{ stage: 'appliedConfirmed', timestamp: '2026-05-01T00:00:00Z' }],
    ...overrides,
  };
}

const millisecondsPerDay = 24 * 60 * 60 * 1000;

const isoDaysAgo = (days: number): string =>
  new Date(referenceDate.getTime() - days * millisecondsPerDay).toISOString();

describe('lastUpdateTimestampOf', () => {
  it('returns null for a record with no status history', () => {
    expect(lastUpdateTimestampOf(makeRecord({ statusHistory: [] }))).toBeNull();
  });

  it('returns the maximum timestamp across the history', () => {
    const record = makeRecord({
      statusHistory: [
        { stage: 'evaluated', timestamp: '2026-04-01T00:00:00Z' },
        { stage: 'appliedConfirmed', timestamp: '2026-05-20T00:00:00Z' },
        { stage: 'appliedConfirmed', timestamp: '2026-06-01T00:00:00Z' },
      ],
    });
    expect(lastUpdateTimestampOf(record)).toBe('2026-06-01T00:00:00Z');
  });

  it('orders non-ISO but parseable dates by instant, not lexicographic string', () => {
    // Phase D: '08/18/2026' sorts AFTER '2026-01-01T00:00:00Z' by instant but
    // BEFORE it lexicographically ('0' < '2'). The old lexical max returned
    // the January ISO string; the parsed-time max returns August.
    const record = makeRecord({
      statusHistory: [
        { stage: 'evaluated', timestamp: '2026-01-01T00:00:00Z' },
        { stage: 'appliedConfirmed', timestamp: '08/18/2026' },
      ],
    });
    expect(lastUpdateTimestampOf(record)).toBe('08/18/2026');
  });
});

describe('isStale: date-boundary behavior', () => {
  it('flags a record at exactly the window boundary as stale (>=)', () => {
    const record = makeRecord({
      statusHistory: [{ stage: 'appliedConfirmed', timestamp: isoDaysAgo(defaultStalenessWindowDays) }],
    });
    expect(isStale(record, { referenceDate })).toBe(true);
  });

  it('does not flag a record one day inside the window', () => {
    const record = makeRecord({
      statusHistory: [
        { stage: 'appliedConfirmed', timestamp: isoDaysAgo(defaultStalenessWindowDays - 1) },
      ],
    });
    expect(isStale(record, { referenceDate })).toBe(false);
  });

  it('flags a record older than the window', () => {
    const record = makeRecord({
      statusHistory: [
        { stage: 'appliedConfirmed', timestamp: isoDaysAgo(defaultStalenessWindowDays + 1) },
      ],
    });
    expect(isStale(record, { referenceDate })).toBe(true);
  });

  it('never flags records that are not appliedConfirmed, whatever their age', () => {
    const oldEvaluated = makeRecord({
      status: 'evaluated',
      statusHistory: [{ stage: 'evaluated', timestamp: isoDaysAgo(120) }],
    });
    const oldRejected = makeRecord({
      status: 'rejected',
      statusHistory: [{ stage: 'rejected', timestamp: isoDaysAgo(120) }],
    });
    expect(isStale(oldEvaluated, { referenceDate })).toBe(false);
    expect(isStale(oldRejected, { referenceDate })).toBe(false);
  });

  it('returns false when appliedConfirmed but the history has no timestamp', () => {
    const record = makeRecord({ status: 'appliedConfirmed', statusHistory: [] });
    expect(isStale(record, { referenceDate })).toBe(false);
  });

  it('honors a custom window', () => {
    const record = makeRecord({
      statusHistory: [{ stage: 'appliedConfirmed', timestamp: isoDaysAgo(20) }],
    });
    expect(isStale(record, { referenceDate, windowDays: 15 })).toBe(true);
    expect(isStale(record, { referenceDate, windowDays: 25 })).toBe(false);
  });
});

describe('timestamp validation (F7/U45)', () => {
  function appliedRecord(timestamps: string[]): ApplicationRecord {
    return {
      applicationId: 'app2026SampleCorpStaffEngineer',
      companyName: 'SampleCorp',
      roleTitle: 'Staff Engineer',
      jobUrl: 'https://example.com/job1',
      postingHash: 'abc123',
      sourceAggregators: ['test'],
      salaryRange: null,
      fitScore: 4.2,
      fitStatus: 'strongFit',
      referralContact: null,
      status: 'appliedConfirmed',
      statusHistory: timestamps.map((timestamp) => ({ stage: 'appliedConfirmed' as const, timestamp })),
    };
  }

  it('ignores malformed timestamps when computing the latest update', () => {
    const record = appliedRecord(['not-a-date', '2026-04-12T10:00:00Z']);
    expect(lastUpdateTimestampOf(record)).toBe('2026-04-12T10:00:00Z');
  });

  it('returns null (never stale) when no timestamp parses', () => {
    const record = appliedRecord(['not-a-date', 'also-bad']);
    expect(lastUpdateTimestampOf(record)).toBeNull();
    expect(
      isStale(record, { referenceDate: new Date('2026-08-08T10:00:00Z') }),
    ).toBe(false);
  });

  it('never flags a record with a future timestamp as stale', () => {
    const record = appliedRecord(['2999-01-01T00:00:00Z']);
    expect(
      isStale(record, { referenceDate: new Date('2026-08-08T10:00:00Z') }),
    ).toBe(false);
  });
});
