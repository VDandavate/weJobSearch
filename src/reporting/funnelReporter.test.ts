import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { ApplicationHistory, ApplicationRecord } from '../utils/jobFunnelTracker';
import type { NetworkingContact } from '../utils/networkingContacts';
import type { SearchHistory } from '../utils/searchHistory';
import {
  buildFunnelReport,
  conversionStatistics,
  formatFunnelReportTable,
  isFollowUpOverdue,
  loadFunnelReport,
  nextActionHintFor,
} from './funnelReporter';

const referenceDate = new Date('2026-08-08T12:00:00Z');

// Phase 7c: every fixture date in this file derives from the anchor above, so
// the suite is immune to wall-clock travel (pinned by the time-travel guards
// at the bottom of this file). The anchor itself is a fixed historical test
// instant, never the live clock; app2026-style ids are opaque identifiers,
// not dates, and carry no clock dependence.
const millisecondsPerDay = 24 * 60 * 60 * 1000;

const isoHoursBeforeAnchor = (hours: number): string =>
  new Date(referenceDate.getTime() - hours * 60 * 60 * 1000).toISOString();

const isoDaysBeforeAnchor = (days: number): string =>
  new Date(referenceDate.getTime() - days * millisecondsPerDay).toISOString();

const anchorDateString = referenceDate.toISOString().slice(0, 10);

const dayStringOffsetFromAnchor = (days: number): string =>
  new Date(referenceDate.getTime() + days * millisecondsPerDay).toISOString().slice(0, 10);

function stubApplication(overrides: Partial<ApplicationRecord> = {}): ApplicationRecord {
  return {
    applicationId: 'app2026SampleCorpStaffEngineer',
    companyName: 'SampleCorp',
    roleTitle: 'Staff Engineer',
    jobUrl: 'https://example.com/job1',
    postingHash: 'abc123',
    sourceAggregators: ['test'],
    salaryRange: 'USD 160,000 - 190,000',
    fitScore: 4.2,
    fitStatus: 'strongFit',
    referralContact: null,
    status: 'evaluated',
    statusHistory: [{ stage: 'evaluated', timestamp: isoHoursBeforeAnchor(2) }],
    ...overrides,
  };
}

function stubContact(overrides: Partial<NetworkingContact> = {}): NetworkingContact {
  return {
    contactId: 'contact001',
    name: 'Jane Sample',
    company: 'SampleCorp',
    relationship: 'formerColleague',
    lastContactDate: dayStringOffsetFromAnchor(-24),
    linkedApplicationIds: [],
    followUpDue: dayStringOffsetFromAnchor(12),
    ...overrides,
  };
}

describe('buildFunnelReport: counts by fitStatus and status', () => {
  it('counts each fitStatus and each status, including zeroed buckets', () => {
    const history: ApplicationHistory = {
      applications: [
        stubApplication({ fitStatus: 'strongFit' }),
        stubApplication({ fitStatus: 'manualReview', applicationId: 'a2', roleTitle: 'Platform Lead' }),
        stubApplication({ fitStatus: 'weakFit', applicationId: 'a3', roleTitle: 'Ruby Engineer' }),
        stubApplication({ fitStatus: 'hardRejected', applicationId: 'a4', roleTitle: 'Onsite Ops' }),
      ],
    };
    const report = buildFunnelReport(history, { contacts: [] }, { referenceDate });
    expect(report.fitStatusCounts).toEqual({
      strongFit: 1,
      manualReview: 1,
      weakFit: 1,
      hardRejected: 1,
    });
    expect(report.statusCounts.evaluated).toBe(4);
    expect(report.statusCounts.generated).toBe(0);
    expect(report.statusCounts.appliedConfirmed).toBe(0);
    expect(report.statusCounts.staleNoResponse).toBe(0);
    expect(report.statusCounts.offer).toBe(0);
    expect(report.totalApplications).toBe(4);
  });

  it('derives staleNoResponse from staleChecker window logic without mutating history', () => {
    const stale = stubApplication({
      applicationId: 'app-stale',
      roleTitle: 'Stale Role',
      status: 'appliedConfirmed',
      statusHistory: [
        { stage: 'evaluated', timestamp: isoDaysBeforeAnchor(99) },
        { stage: 'appliedConfirmed', timestamp: isoDaysBeforeAnchor(85) },
      ],
    });
    const fresh = stubApplication({
      applicationId: 'app-fresh',
      roleTitle: 'Fresh Role',
      status: 'appliedConfirmed',
      statusHistory: [
        { stage: 'evaluated', timestamp: isoDaysBeforeAnchor(7) },
        { stage: 'appliedConfirmed', timestamp: isoDaysBeforeAnchor(6) },
      ],
    });
    const report = buildFunnelReport(
      { applications: [stale, fresh] },
      { contacts: [] },
      { referenceDate, stalenessWindowDays: 45 },
    );
    expect(report.statusCounts.staleNoResponse).toBe(1);
    expect(report.statusCounts.appliedConfirmed).toBe(1);
    expect(stale.status).toBe('appliedConfirmed');
    expect(stale.statusHistory).toHaveLength(2);
  });
});

describe('buildFunnelReport: referral conversion', () => {
  it('separates referral linked from cold apply and computes conversion rates', () => {
    const history: ApplicationHistory = {
      applications: [
        stubApplication({ referralContact: 'contact001' }),
        stubApplication({ referralContact: 'contact001', status: 'appliedConfirmed', applicationId: 'ref2' }),
        stubApplication({ referralContact: 'contact001', status: 'rejected', applicationId: 'ref3' }),
        stubApplication({ referralContact: null }),
        stubApplication({ referralContact: null, status: 'appliedConfirmed', applicationId: 'cold2' }),
        stubApplication({ referralContact: null, applicationId: 'cold3' }),
      ],
    };
    const report = buildFunnelReport(history, { contacts: [] }, { referenceDate });
    expect(report.referralConversion.referralLinked).toEqual({ evaluated: 3, converted: 2, conversionRate: 2 / 3 });
    expect(report.referralConversion.coldApply).toEqual({ evaluated: 3, converted: 1, conversionRate: 1 / 3 });
  });

  it('returns null conversion rate when a cohort has no applications', () => {
    const report = buildFunnelReport(
      { applications: [stubApplication({ referralContact: 'contact001' })] },
      { contacts: [] },
      { referenceDate },
    );
    expect(report.referralConversion.coldApply).toEqual({ evaluated: 0, converted: 0, conversionRate: null });
  });

  it('counts a linked-but-null-contact record in exactly one cohort', () => {
    const linkedOnly = stubApplication({ applicationId: 'linkedOnly', referralContact: null });
    const cold = stubApplication({ applicationId: 'coldOnly', referralContact: null });
    const contacts = {
      contacts: [stubContact({ linkedApplicationIds: ['linkedOnly'] })],
    };
    const report = buildFunnelReport({ applications: [linkedOnly, cold] }, contacts, { referenceDate });
    expect(report.referralConversion.referralLinked.evaluated).toBe(1);
    expect(report.referralConversion.coldApply.evaluated).toBe(1);
    expect(
      report.referralConversion.referralLinked.evaluated + report.referralConversion.coldApply.evaluated,
    ).toBe(2);
  });
});

describe('buildFunnelReport: manualReview queue and follow-up', () => {
  it('lists manualReview applications awaiting action', () => {
    const history: ApplicationHistory = {
      applications: [
        stubApplication({ fitStatus: 'manualReview', roleTitle: 'Platform Lead', jobUrl: 'https://x/job/p' }),
        stubApplication({ fitStatus: 'strongFit' }),
      ],
    };
    const report = buildFunnelReport(history, { contacts: [] }, { referenceDate });
    expect(report.awaitingManualReview).toHaveLength(1);
    expect(report.awaitingManualReview[0]).toMatchObject({
      companyName: 'SampleCorp',
      roleTitle: 'Platform Lead',
      jobUrl: 'https://x/job/p',
      fitScore: 4.2,
    });
  });

  it('flags only contacts whose followUpDue is strictly in the past', () => {
    const now = new Date(referenceDate.getTime());
    expect(isFollowUpOverdue(dayStringOffsetFromAnchor(-1), now)).toBe(true);
    expect(isFollowUpOverdue(anchorDateString, now)).toBe(false);
    expect(isFollowUpOverdue(dayStringOffsetFromAnchor(1), now)).toBe(false);
    expect(isFollowUpOverdue('', now)).toBe(false);
  });

  it('compares non-ISO parseable dates by day value and never flags unparseable input (Phase D)', () => {
    // '08/01/2026' is strictly before the 2026-08-19 anchor by instant but
    // sorts AFTER '2026-08-19' lexicographically ('0' < '2'); the old lexical
    // compare missed it. An unparseable value is invalid intake, not a past
    // date, so it is never overdue.
    const now = new Date('2026-08-19T12:00:00.000Z');
    expect(isFollowUpOverdue('08/01/2026', now)).toBe(true);
    expect(isFollowUpOverdue('08/19/2026', now)).toBe(false);
    expect(isFollowUpOverdue('not-a-date', now)).toBe(false);
  });

  it('surfaces an overdue contact and sorts oldest first', () => {
    const contacts = { contacts: [stubContact({ contactId: 'contact002', followUpDue: dayStringOffsetFromAnchor(-7) })] };
    const report = buildFunnelReport({ applications: [] }, contacts, { referenceDate });
    expect(report.overdueFollowUps).toHaveLength(1);
    expect(report.overdueFollowUps[0]).toMatchObject({ contactId: 'contact002', name: 'Jane Sample', company: 'SampleCorp', relationship: 'formerColleague', followUpDue: dayStringOffsetFromAnchor(-7) });
    const sorted = buildFunnelReport({ applications: [] }, { contacts: [stubContact({ contactId: 'later', followUpDue: dayStringOffsetFromAnchor(-3) }), stubContact({ contactId: 'earlier', followUpDue: dayStringOffsetFromAnchor(-19) })] }, { referenceDate });
    expect(sorted.overdueFollowUps.map((c) => c.contactId)).toEqual(['earlier', 'later']);
  });
});

describe('formatFunnelReportTable', () => {
  it('renders every mandated section into readable lines', () => {
    const history = { applications: [stubApplication({ fitStatus: 'manualReview', roleTitle: 'Platform Lead', referralContact: 'contact001' })] };
    const contacts = { contacts: [stubContact({ followUpDue: dayStringOffsetFromAnchor(4) })] };
    const report = buildFunnelReport(history, contacts, { referenceDate });
    const lines = formatFunnelReportTable(report).join('\n');
    expect(lines).toContain(`Funnel report (reference ${anchorDateString})`);
    expect(lines).toContain('By fit status:');
    expect(lines).toContain('| Fit Status | Count |');
    expect(lines).toContain('By application status:');
    expect(lines).toContain('Referral-linked vs. cold-apply conversion:');
    expect(lines).toContain('Cold apply');
    expect(lines).toContain('| Cohort | Evaluated | Converted | Conversion rate |');
  });
});

describe('nextActionHintFor (SRA-03)', () => {
  it('suggests decide: review or archive for manualReview evaluated postings', () => {
    expect(nextActionHintFor(stubApplication({ fitStatus: 'manualReview' }), { referenceDate })).toBe(
      'decide: review or archive',
    );
  });

  it('suggests generate resume for strongFit evaluated postings', () => {
    expect(nextActionHintFor(stubApplication({ fitStatus: 'strongFit' }), { referenceDate })).toBe(
      'generate resume',
    );
  });

  it('suggests apply: confirm submission for generated postings', () => {
    expect(nextActionHintFor(stubApplication({ status: 'generated' }), { referenceDate })).toBe(
      'apply: confirm submission',
    );
  });

  it('suggests follow up for stale appliedConfirmed postings', () => {
    const stale = stubApplication({
      status: 'appliedConfirmed',
      statusHistory: [
        { stage: 'evaluated', timestamp: isoDaysBeforeAnchor(99) },
        { stage: 'appliedConfirmed', timestamp: isoDaysBeforeAnchor(85) },
      ],
    });
    expect(nextActionHintFor(stale, { referenceDate, stalenessWindowDays: 45 })).toBe('follow up');
  });

  it('suggests follow up for staleNoResponse postings', () => {
    expect(nextActionHintFor(stubApplication({ status: 'staleNoResponse' }), { referenceDate })).toBe(
      'follow up',
    );
  });

  it('returns null for states with no suggested action', () => {
    expect(nextActionHintFor(stubApplication({ status: 'rejected' }), { referenceDate })).toBeNull();
    expect(nextActionHintFor(stubApplication({ status: 'interviewing' }), { referenceDate })).toBeNull();
    expect(nextActionHintFor(stubApplication({ status: 'offer' }), { referenceDate })).toBeNull();
    expect(nextActionHintFor(stubApplication({ fitStatus: 'weakFit' }), { referenceDate })).toBeNull();
    expect(nextActionHintFor(stubApplication({ fitStatus: 'hardRejected' }), { referenceDate })).toBeNull();
    expect(nextActionHintFor(stubApplication({ status: 'appliedConfirmed' }), { referenceDate })).toBeNull();
  });

  it('includes hint entries in the report and renders them in the table', () => {
    const history = {
      applications: [
        stubApplication({ fitStatus: 'manualReview', roleTitle: 'Platform Lead' }),
        stubApplication({ status: 'generated', applicationId: 'gen1', roleTitle: 'Generated Role' }),
        stubApplication({ status: 'rejected', applicationId: 'rej1', roleTitle: 'Rejected Role' }),
      ],
    };
    const report = buildFunnelReport(history, { contacts: [] }, { referenceDate });
    expect(report.nextActionHints).toHaveLength(2);
    expect(report.nextActionHints[0].hint).toBe('decide: review or archive');
    expect(report.nextActionHints[1].hint).toBe('apply: confirm submission');
    const lines = formatFunnelReportTable(report).join('\n');
    expect(lines).toContain('Next actions:');
    expect(lines).toContain('decide: review or archive');
    expect(lines).toContain('apply: confirm submission');
  });
});

describe('loadFunnelReport: file-driven aggregation', () => {
  it('reads real file paths and aggregates', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'weJobSearch-report-'));
    const previousRoot = process.env.WEJOBSEARCHDATAROOT;
    process.env.WEJOBSEARCHDATAROOT = dir;
    try {
      const historyPath = join(dir, 'applicationHistory.json');
      const contactsPath = join(dir, 'networkingContacts.json');
      const searchHistoryPath = join(dir, 'searchHistory.json');
      await writeFile(historyPath, JSON.stringify({ applications: [stubApplication()] }), 'utf8');
      await writeFile(contactsPath, JSON.stringify({ contacts: [stubContact()] }), 'utf8');
      const report = await loadFunnelReport({ historyPath, contactsPath, searchHistoryPath, referenceDate });
      expect(report.totalApplications).toBe(1);
      expect(report.statusCounts.evaluated).toBe(1);
      expect(report.recentSearches).toEqual([]);
    } finally {
      if (previousRoot === undefined) {
        delete process.env.WEJOBSEARCHDATAROOT;
      } else {
        process.env.WEJOBSEARCHDATAROOT = previousRoot;
      }
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('reads searchHistory.json and surfaces recent searches', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'weJobSearch-report-'));
    const previousRoot = process.env.WEJOBSEARCHDATAROOT;
    process.env.WEJOBSEARCHDATAROOT = dir;
    try {
      const historyPath = join(dir, 'applicationHistory.json');
      const contactsPath = join(dir, 'networkingContacts.json');
      const searchHistoryPath = join(dir, 'searchHistory.json');
      await writeFile(historyPath, JSON.stringify({ applications: [] }), 'utf8');
      await writeFile(contactsPath, JSON.stringify({ contacts: [] }), 'utf8');
      await writeFile(
        searchHistoryPath,
        JSON.stringify({
          searches: [
            {
              searchId: 'search2026StaffEngineerRemote',
              keywords: 'staff engineer',
              location: 'Remote',
              timestamp: isoDaysBeforeAnchor(7),
              resultCount: 3,
            },
          ],
        }),
        'utf8',
      );
      const report = await loadFunnelReport({ historyPath, contactsPath, searchHistoryPath, referenceDate });
      expect(report.recentSearches).toHaveLength(1);
      expect(report.recentSearches[0].keywords).toBe('staff engineer');
      expect(report.recentSearches[0].resultCount).toBe(3);
    } finally {
      if (previousRoot === undefined) {
        delete process.env.WEJOBSEARCHDATAROOT;
      } else {
        process.env.WEJOBSEARCHDATAROOT = previousRoot;
      }
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('buildFunnelReport: recent searches (EUO-13)', () => {
  function searchHistory(searches: SearchHistory['searches']): SearchHistory {
    return { searches };
  }

  it('lists recent searches newest first', () => {
    const report = buildFunnelReport(
      { applications: [] },
      { contacts: [] },
      {
        referenceDate,
        searchHistory: searchHistory([
          {
            searchId: 'search2026StaffEngineerRemote',
            keywords: 'staff engineer',
            location: 'Remote',
            timestamp: isoDaysBeforeAnchor(7),
            resultCount: 3,
          },
          {
            searchId: 'search2026PlatformLeadRemote',
            keywords: 'platform lead',
            location: 'Remote',
            timestamp: isoHoursBeforeAnchor(2),
            resultCount: 5,
          },
        ]),
      },
    );
    expect(report.recentSearches).toHaveLength(2);
    expect(report.recentSearches[0].keywords).toBe('platform lead');
    expect(report.recentSearches[1].keywords).toBe('staff engineer');
  });

  it('caps the section at the most recent searches', () => {
    const searches = Array.from({ length: 15 }, (unused, index) => ({
      searchId: `search2026Query${index}`,
      keywords: `query ${index}`,
      location: 'Remote',
      timestamp: isoDaysBeforeAnchor(15 - index),
      resultCount: index,
    }));
    const report = buildFunnelReport(
      { applications: [] },
      { contacts: [] },
      { referenceDate, searchHistory: searchHistory(searches) },
    );
    expect(report.recentSearches).toHaveLength(10);
    expect(report.recentSearches[0].keywords).toBe('query 14');
  });

  it('renders a Recent searches section in the table with timestamps and result counts', () => {
    const report = buildFunnelReport(
      { applications: [] },
      { contacts: [] },
      {
        referenceDate,
        searchHistory: searchHistory([
          {
            searchId: 'search2026StaffEngineerRemote',
            keywords: 'staff engineer',
            location: 'Remote',
            timestamp: isoHoursBeforeAnchor(2),
            resultCount: 3,
          },
        ]),
      },
    );
    const lines = formatFunnelReportTable(report).join('\n');
    expect(lines).toContain('Recent searches:');
    expect(lines).toContain('| Timestamp | Keywords | Location | Results |');
    expect(lines).toContain('staff engineer');
    expect(lines).toContain('3');
  });

  it('renders none when there is no search history', () => {
    const report = buildFunnelReport({ applications: [] }, { contacts: [] }, { referenceDate });
    expect(report.recentSearches).toEqual([]);
    expect(formatFunnelReportTable(report).join('\n')).toContain('Recent searches: none');
  });
});

describe('wall-clock sensitivity (Phase 7c): default-clock report drifts as time advances', () => {
  it('the same fixtures go stale/overdue when the wall clock advances 30 days', () => {
    const history = {
      applications: [
        stubApplication({
          applicationId: 'app-clock-drift',
          status: 'appliedConfirmed',
          statusHistory: [
            { stage: 'evaluated', timestamp: isoDaysBeforeAnchor(49) },
            { stage: 'appliedConfirmed', timestamp: isoDaysBeforeAnchor(38) },
          ],
        }),
      ],
    };
    const contacts = { contacts: [stubContact({ followUpDue: dayStringOffsetFromAnchor(12) })] };
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(referenceDate.getTime()));
      const before = buildFunnelReport(history, contacts);
      expect(before.statusCounts.staleNoResponse).toBe(0);
      expect(before.overdueFollowUps).toHaveLength(0);
      vi.setSystemTime(new Date(referenceDate.getTime() + 30 * millisecondsPerDay));
      const after = buildFunnelReport(history, contacts);
      expect(after.statusCounts.staleNoResponse).toBe(1);
      expect(after.overdueFollowUps).toHaveLength(1);
      expect(after).not.toEqual(before);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('time-travel stability (Phase 7c): anchored reports are immune to wall-clock advance', () => {
  it.each([30, 90])(
    'an explicitly anchored report is bit-identical with the wall clock +%i days',
    (days) => {
      const history = {
        applications: [
          stubApplication(),
          stubApplication({
            applicationId: 'app-anchored-stale',
            roleTitle: 'Stale Role',
            status: 'appliedConfirmed',
            statusHistory: [
              { stage: 'evaluated', timestamp: isoDaysBeforeAnchor(99) },
              { stage: 'appliedConfirmed', timestamp: isoDaysBeforeAnchor(85) },
            ],
          }),
        ],
      };
      const contacts = { contacts: [stubContact()] };
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date(referenceDate.getTime()));
        const before = buildFunnelReport(history, contacts, { referenceDate });
        vi.setSystemTime(new Date(referenceDate.getTime() + days * millisecondsPerDay));
        const after = buildFunnelReport(history, contacts, { referenceDate });
        expect(after).toEqual(before);
        expect(after.statusCounts.staleNoResponse).toBe(1);
        expect(after.overdueFollowUps).toHaveLength(0);
      } finally {
        vi.useRealTimers();
      }
    },
  );
});
