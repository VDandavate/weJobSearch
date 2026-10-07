import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { RawPosting } from '../scrapers/jobSpyAdapter';
import {
  computePostingHash,
  type ApplicationHistory,
} from '../utils/jobFunnelTracker';
import {
  defaultFuzzyThreshold,
  deduplicatePostings,
  isFuzzyDuplicate,
  levenshteinDistance,
  normalizeCompanyName,
  normalizeLocation,
  normalizeRoleTitle,
} from './postingDeduplicator';

// Step 11 test suite for the cross-aggregator deduplicator (SDD Requirement 7,
// AGENTS.md Step 11). All postings are synthetic fixtures. Exact-hash matching
// is asserted against the committed fixtures/sampleApplicationHistory.json
// schema contract, and fuzzy near-duplicate matching covers the "Senior
// Engineer" vs "Sr. Engineer" example from the SDD.

function makePosting(overrides: Partial<RawPosting> = {}): RawPosting {
  return {
    sourceAggregator: 'test',
    companyName: 'AcmeCorp',
    roleTitle: 'Senior Platform Engineer',
    location: 'Remote',
    jobUrl: 'https://acme.example.com/jobs/senior-platform-engineer',
    description: 'Body',
    hasFullDescription: true,
    postedAt: null,
    ...overrides,
  };
}

const remoteSeniorEngineerHash = 'a5c98a2b0b660d22a6940b5105468d5e13aebb1c5b5606a12827ed1dc0ac008c';

async function withEmptyHistory(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'wejobsearch-dedup-'));
  process.env.WEJOBSEARCHDATAROOT = dir;
  const historyPath = join(dir, 'applicationHistory.json');
  await writeFile(historyPath, JSON.stringify({ applications: [] }), 'utf8');
  return historyPath;
}

describe('normalization helpers', () => {
  it('normalizes company names, role titles, and locations deterministically', () => {
    expect(normalizeCompanyName('AcmeCorp Inc')).toBe('acmecorp');
    expect(normalizeCompanyName('AcmeCorp, LLC')).toBe('acmecorp');
    expect(normalizeRoleTitle('Senior Engineer')).toBe('senior engineer');
    expect(normalizeRoleTitle('Sr. Engineer')).toBe('senior engineer');
    expect(normalizeLocation('New York, NY')).toBe('newyorkny');
  });

  it('computes a zero distance for near-identical role titles', () => {
    expect(levenshteinDistance('senior engineer', 'senior engineer')).toBe(0);
    expect(levenshteinDistance('senior engineer', 'sr engineer')).toBeGreaterThan(0);
    expect(levenshteinDistance('', 'abc')).toBe(3);
  });
});

describe('isFuzzyDuplicate', () => {
  it('matches the SDD example: Senior Engineer vs Sr. Engineer at the same company', () => {
    const candidate = {
      companyName: 'AcmeCorp',
      roleTitle: 'Sr. Engineer',
      location: 'Remote',
    };
    const existing = {
      companyName: 'AcmeCorp',
      roleTitle: 'Senior Engineer',
      location: 'Remote',
    };
    expect(isFuzzyDuplicate(candidate, existing, defaultFuzzyThreshold)).toBe(true);
  });

  it('rejects a different company even with an identical role title', () => {
    expect(
      isFuzzyDuplicate(
        { companyName: 'AcmeCorp', roleTitle: 'Senior Engineer' },
        { companyName: 'GlobexCorp', roleTitle: 'Senior Engineer' },
      ),
    ).toBe(false);
  });

  it('requires matching locations when both are provided', () => {
    expect(
      isFuzzyDuplicate(
        { companyName: 'AcmeCorp', roleTitle: 'Senior Engineer', location: 'Remote' },
        { companyName: 'AcmeCorp', roleTitle: 'Senior Engineer', location: 'Austin, TX' },
      ),
    ).toBe(false);
  });

  it('falls back to a title-only match when either location is absent', () => {
    expect(
      isFuzzyDuplicate(
        { companyName: 'AcmeCorp', roleTitle: 'Senior Engineer' },
        { companyName: 'AcmeCorp', roleTitle: 'Sr. Engineer', location: 'Remote' },
      ),
    ).toBe(true);
  });

  it('merges New York spelling variants while keeping distinct cities apart', () => {
    const nyPairs: [string, string][] = [
      ['New York, NY', 'New York'],
      ['NYC', 'New York'],
      ['Austin', 'Austin, TX'],
    ];
    for (const [left, right] of nyPairs) {
      expect(
        isFuzzyDuplicate(
          { companyName: 'AcmeCorp', roleTitle: 'Senior Engineer', location: left },
          { companyName: 'AcmeCorp', roleTitle: 'Senior Engineer', location: right },
        ),
      ).toBe(true);
    }
    expect(
      isFuzzyDuplicate(
        { companyName: 'AcmeCorp', roleTitle: 'Senior Engineer', location: 'Boston, MA' },
        { companyName: 'AcmeCorp', roleTitle: 'Senior Engineer', location: 'Austin, TX' },
      ),
    ).toBe(false);
    expect(
      isFuzzyDuplicate(
        { companyName: 'AcmeCorp', roleTitle: 'Senior Engineer', location: 'York' },
        { companyName: 'AcmeCorp', roleTitle: 'Senior Engineer', location: 'New York' },
      ),
    ).toBe(false);
  });

  it('no longer auto-merges a defined city against missing location data', () => {
    expect(
      isFuzzyDuplicate(
        { companyName: 'AcmeCorp', roleTitle: 'Senior Engineer', location: 'Austin, TX' },
        { companyName: 'AcmeCorp', roleTitle: 'Senior Engineer' },
      ),
    ).toBe(false);
  });

  it('merges long titles with qualifier additions or typo clusters', () => {
    expect(
      isFuzzyDuplicate(
        { companyName: 'AcmeCorp', roleTitle: 'Senior Staff Platform Engineer, Infrastructure' },
        { companyName: 'AcmeCorp', roleTitle: 'Senior Staff Platform Engineer' },
      ),
    ).toBe(true);
    expect(
      isFuzzyDuplicate(
        { companyName: 'AcmeCorp', roleTitle: 'Senior Distinguished Platform Engineer' },
        { companyName: 'AcmeCorp', roleTitle: 'Senior Distingished Platform Engnieer' },
      ),
    ).toBe(true);
  });

  it('refuses long-title substitutions and unrelated long titles', () => {
    expect(
      isFuzzyDuplicate(
        { companyName: 'AcmeCorp', roleTitle: 'Senior Platform Engineer' },
        { companyName: 'AcmeCorp', roleTitle: 'Senior Data Engineer' },
      ),
    ).toBe(false);
    expect(
      isFuzzyDuplicate(
        { companyName: 'AcmeCorp', roleTitle: 'Senior Platform Engineer, Infrastructure' },
        { companyName: 'AcmeCorp', roleTitle: 'Senior Data Engineer, Infrastructure' },
      ),
    ).toBe(false);
  });

  it('respects a custom threshold', () => {
    const candidate = { companyName: 'AcmeCorp', roleTitle: 'Lead Platform Engineer' };
    const existing = { companyName: 'AcmeCorp', roleTitle: 'Senior Platform Engineer' };
    expect(isFuzzyDuplicate(candidate, existing, 3)).toBe(false);
  });
});

describe('deduplicatePostings: within-batch exact and fuzzy', () => {
  it('merges an exact-hash duplicate from a second aggregator', async () => {
    const historyPath = await withEmptyHistory();
    try {
      const result = await deduplicatePostings(
        [
          makePosting({ sourceAggregator: 'hiringCafe' }),
          makePosting({ sourceAggregator: 'linkedin' }),
        ],
        { historyPath },
      );
      expect(result.uniquePostings).toHaveLength(1);
      expect(result.uniquePostings[0].sourceAggregators).toEqual(['hiringCafe', 'linkedin']);
      expect(result.mergedPostings).toHaveLength(1);
      expect(result.mergedPostings[0].matchKind).toBe('withinBatch');
      expect(result.mergedPostings[0].matchedApplicationId).toBeNull();
    } finally {
      await rm(historyPath, { recursive: true, force: true });
    }
  });

  it('fuzzy-merges a near-duplicate role title within a single batch', async () => {
    const historyPath = await withEmptyHistory();
    try {
      const result = await deduplicatePostings(
        [
          makePosting({ roleTitle: 'Senior Platform Engineer', sourceAggregator: 'hiringCafe' }),
          makePosting({ roleTitle: 'Senior Platform Enginer', sourceAggregator: 'wellfound' }),
        ],
        { historyPath },
      );
      expect(result.uniquePostings).toHaveLength(1);
      expect(result.mergedPostings).toHaveLength(1);
      expect(result.mergedPostings[0].matchKind).toBe('fuzzyRoleTitle');
      expect(result.uniquePostings[0].roleTitle).toBe('Senior Platform Engineer');
    } finally {
      await rm(historyPath, { recursive: true, force: true });
    }
  });

  it('exact-hashes seniority variants within a single batch', async () => {
    const historyPath = await withEmptyHistory();
    try {
      const result = await deduplicatePostings(
        [
          makePosting({ roleTitle: 'Senior Platform Engineer', sourceAggregator: 'hiringCafe' }),
          makePosting({ roleTitle: 'Sr. Platform Engineer', sourceAggregator: 'wellfound' }),
        ],
        { historyPath },
      );
      expect(result.uniquePostings).toHaveLength(1);
      expect(result.mergedPostings).toHaveLength(1);
      expect(result.mergedPostings[0].matchKind).toBe('withinBatch');
      expect(result.uniquePostings[0].roleTitle).toBe('Senior Platform Engineer');
    } finally {
      await rm(historyPath, { recursive: true, force: true });
    }
  });
});

describe('deduplicatePostings: history-aware matching against the fixture hash contract', () => {
  it('matches the exact postingHash stored in a history record', async () => {
    const historyPath = await withEmptyHistory();
    try {
      const history: ApplicationHistory = {
        applications: [
          {
            applicationId: 'app2026AcmeCorpSeniorPlatformEngineer',
            companyName: 'AcmeCorp',
            roleTitle: 'Senior Platform Engineer',
            jobUrl: 'https://acme.example.com/jobs/senior-platform-engineer',
            postingHash: remoteSeniorEngineerHash,
            sourceAggregators: ['hiringCafe'],
            salaryRange: 'USD 165000 - 195000/yr',
            fitScore: 4.8,
            fitStatus: 'strongFit',
            referralContact: null,
            status: 'evaluated',
            statusHistory: [{ stage: 'evaluated', timestamp: '2026-07-01T10:00:00Z' }],
          },
        ],
      };
      await writeFile(historyPath, JSON.stringify(history), 'utf8');

      const result = await deduplicatePostings(
        [
          makePosting({
            companyName: 'AcmeCorp',
            roleTitle: 'Senior Platform Engineer',
            location: 'Remote',
            sourceAggregator: 'linkedin',
          }),
        ],
        { historyPath },
      );
      expect(result.uniquePostings).toHaveLength(0);
      expect(result.mergedPostings).toHaveLength(1);
      expect(result.mergedPostings[0].matchKind).toBe('exactHash');
      expect(result.mergedPostings[0].matchedApplicationId).toBe('app2026AcmeCorpSeniorPlatformEngineer');
      expect(result.mergedPostings[0].sourceAggregators).toEqual(['hiringCafe', 'linkedin']);
    } finally {
      await rm(historyPath, { recursive: true, force: true });
    }
  });

  it('computes the same postingHash that the committed fixture history stores', () => {
    expect(computePostingHash('AcmeCorp', 'Senior Platform Engineer', 'Remote')).toBe(
      remoteSeniorEngineerHash,
    );
  });

  it('does not mutate history when nothing in the batch matched a record', async () => {
    const historyPath = await withEmptyHistory();
    try {
      const result = await deduplicatePostings(
        [makePosting({ roleTitle: 'Unrelated Role' })],
        { historyPath },
      );
      expect(result.uniquePostings).toHaveLength(1);
      expect(result.mergedPostings).toHaveLength(0);
    } finally {
      await rm(historyPath, { recursive: true, force: true });
    }
  });
});
