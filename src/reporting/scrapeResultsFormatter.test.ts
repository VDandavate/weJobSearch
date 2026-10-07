import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  activeResultsToMarkdown,
  briefMaxLength,
  formatScrapeResults,
  renderMarkdown,
  truncateBrief,
  type EvaluatedPosting,
} from './scrapeResultsFormatter';
import {
  evaluateFit,
  type CandidateCapabilities,
  type JobPreferences,
  type PostingFacts,
  type PostingRequirements,
} from '../evaluators/fitEvaluator';
import type { RawPosting } from '../scrapers/jobSpyAdapter';

// Step 6b authoring verification for the Active Results formatter (SDD
// Requirement 2a). The fixtures here are synthetic evaluated postings built
// through the real fitEvaluator so the Justification column reflects actual
// Step 4b reasoning, not hand-written strings.

function makePosting(overrides: Partial<RawPosting> = {}): RawPosting {
  return {
    sourceAggregator: 'test',
    companyName: 'SampleCorp',
    roleTitle: 'Senior Engineer',
    location: 'Remote',
    jobUrl: 'https://example.com/job',
    description: 'Body',
    hasFullDescription: true,
    postedAt: null,
    ...overrides,
  };
}

function makeCandidate(
  skills: string[],
  yearsOfExperience: number,
  domains: string[] = [],
): CandidateCapabilities {
  return { skills, yearsOfExperience, domains };
}

const candidatePool = makeCandidate(
  ['TypeScript', 'React', 'Node.js', 'Kubernetes', 'AWS'],
  8,
  ['fintech'],
);

const emptyRequirements: PostingRequirements = {
  requiredSkills: [],
  requiredYearsOfExperience: null,
  requiredDomains: [],
};

function makePreferences(overrides: Partial<JobPreferences> = {}): JobPreferences {
  return {
    compensation: {
      currency: 'USD',
      minAcceptableBase: 150000,
      targetBase: 180000,
      countsBonusTowardMin: false,
      countsEquityTowardMin: false,
    },
    clearance: {
      currentStatus: 'active',
      currentLevel: 'secret',
      eligibleToObtain: true,
      requiresSponsorshipForVisa: false,
    },
    nonNegotiables: [],
    preferredLocations: ['Remote'],
    ...overrides,
  };
}

interface EvaluationOverrides {
  posting?: RawPosting;
  requirements?: PostingRequirements;
  candidate?: CandidateCapabilities;
  preferences?: JobPreferences;
  postingFacts?: PostingFacts;
}

function evaluate(overrides: EvaluationOverrides, brief: string): EvaluatedPosting {
  const posting = overrides.posting ?? makePosting();
  const assessment = evaluateFit({
    posting,
    requirements: overrides.requirements ?? emptyRequirements,
    candidate: overrides.candidate ?? candidatePool,
    preferences: overrides.preferences ?? makePreferences(),
    postingFacts: overrides.postingFacts,
  });
  return { posting, brief, assessment };
}

// Mixed synthetic batch spanning all four fitStatus values: two strongFit,
// one hasFullDescription:false manualReview reroute, one weakFit, one
// hardRejected on a nonNegotiables rule.
const mixedBatch: EvaluatedPosting[] = [
  evaluate(
    {
      posting: makePosting({
        roleTitle: 'Staff Engineer',
        companyName: 'AcmeCorp',
        jobUrl: 'https://acme.example.com/jobs/staff-engineer',
      }),
    },
    'Builds distributed backend services with TypeScript',
  ),
  evaluate(
    {
      posting: makePosting({
        roleTitle: 'Frontend Lead',
        companyName: 'GlobexCorp',
        jobUrl: 'https://globex.example.com/jobs/frontend-lead',
      }),
      requirements: { ...emptyRequirements, requiredDomains: ['healthcare'] },
    },
    'Owns the React SPA for a healthcare platform',
  ),
  evaluate(
    {
      posting: makePosting({
        roleTitle: 'Platform Architect',
        companyName: 'UmbrellaLabs',
        jobUrl: 'https://umbrella.example.com/jobs/platform-architect',
        hasFullDescription: false,
      }),
      requirements: {
        ...emptyRequirements,
        requiredSkills: ['Ruby', 'Go', 'GraphQL'],
        requiredDomains: ['healthcare'],
      },
    },
    'Large irregular platform',
  ),
  evaluate(
    {
      posting: makePosting({
        roleTitle: 'DevOps Engineer',
        companyName: 'NimbusSystems',
        jobUrl: 'https://nimbus.example.com/jobs/devops-engineer',
        location: 'New York, NY',
      }),
      requirements: {
        ...emptyRequirements,
        requiredSkills: ['Ruby'],
        requiredDomains: ['healthcare'],
      },
      preferences: makePreferences({
        preferredLocations: ['Remote'],
        nonNegotiables: [
          { id: 'noRelocation', category: 'location', rule: 'reject outside preferred locations' },
        ],
      }),
    },
    'Scaling cloud infrastructure for regulated clients',
  ),
  evaluate(
    {
      posting: makePosting({
        roleTitle: 'QA Automation',
        companyName: 'TestWorks',
        jobUrl: 'https://testworks.example.com/jobs/qa-automation',
      }),
      requirements: {
        ...emptyRequirements,
        requiredSkills: ['Ruby'],
        requiredDomains: ['healthcare'],
      },
    },
    'Builds test suites for a pediatric application',
  ),
];

describe('scrapeResultsFormatter: fixed column contract (SDD Requirement 2a)', () => {
  // SDD-independent guard: the expected headers below are pinned literals,
  // never read from the formatter constants under test, so the guard cannot
  // be rewritten to enforce drift. A companion case asserts this file never
  // imports those constants (grep-assertable).
  it('owns the exact 7-column core set, in order, with no extras', () => {
    const table = formatScrapeResults(mixedBatch);
    expect([...table.columns]).toEqual([
      'Sr. No.',
      'Job Title',
      'Organization',
      'Brief',
      'Fit Score',
      'Justification',
      'Link',
    ]);
    expect(table.columns).toHaveLength(7);
  });

  it('never imports the formatter column constants it guards', () => {
    const source = readFileSync(join(__dirname, 'scrapeResultsFormatter.test.ts'), 'utf8');
    const importLines = source.split('\n').filter((line) => line.startsWith('import '));
    for (const line of importLines) {
      expect(line).not.toMatch(/activeResult(Extra)?Columns/);
    }
  });
});

describe('formatScrapeResults: auto routing and ordering', () => {
  it('keeps only manualReview and strongFit, dropping rejected and weak', () => {
    const table = formatScrapeResults(mixedBatch);
    expect(table.rows.map((row) => row.jobTitle)).toEqual([
      'Staff Engineer',
      'Frontend Lead',
      'Platform Architect',
    ]);
  });

  it('numbers Sr. No. sequentially from 1 for the active batch only', () => {
    const table = formatScrapeResults(mixedBatch);
    expect(table.rows.map((row) => row.srNo)).toEqual([1, 2, 3]);
    expect(table.rows[0].srNo).toBe(1);
  });

  it('fills each cell from the expected source field', () => {
    const table = formatScrapeResults(mixedBatch);
    const row = table.rows[0];
    expect(row.organization).toBe('AcmeCorp');
    expect(row.link).toBe('https://acme.example.com/jobs/staff-engineer');
    expect(row.fitScore).toBe(5);
  });

  it('renders sensibly through the shared markdown renderer', () => {
    const table = activeResultsToMarkdown(formatScrapeResults(mixedBatch));
    const text = renderMarkdown(table);
    expect(text).toContain('| Sr. No. | Job Title | Organization | Brief | Fit Score | Justification | Link |');
    expect(text).toContain('| 1 | Staff Engineer | AcmeCorp | Builds distributed backend services with TypeScript |');
  });
});

describe('formatScrapeResults: Brief truncation', () => {
  it('passes a brief at or under the max length through unchanged', () => {
    const short = evaluate(
      { posting: makePosting({ roleTitle: 'Short Post' }) },
      'A concise one-line summary.',
    );
    const table = formatScrapeResults([short]);
    expect(table.rows[0].brief).toBe('A concise one-line summary.');
  });

  it('truncates a longer brief to 150 total characters including the ellipsis', () => {
    const longBrief = 'x'.repeat(briefMaxLength + 50);
    const entry = evaluate({ posting: makePosting({ roleTitle: 'Long Post' }) }, longBrief);
    const table = formatScrapeResults([entry]);
    const truncated = table.rows[0].brief;
    expect(truncated).toHaveLength(briefMaxLength);
    expect(truncated.startsWith('x'.repeat(briefMaxLength - 3))).toBe(true);
    expect(truncated.endsWith('...')).toBe(true);
  });

  it('truncateBrief is deterministic and does not touch short input', () => {
    expect(truncateBrief('short brief')).toBe('short brief');
    const long = 'y'.repeat(briefMaxLength + 5);
    expect(truncateBrief(long)).toHaveLength(briefMaxLength);
    expect(truncateBrief(long).endsWith('...')).toBe(true);
  });
});

describe('formatScrapeResults: Justification carries Step 4b reasoning', () => {
  it('labels a strongFit row with the status plus a plain reason when no deduction applied', () => {
    const table = formatScrapeResults(mixedBatch);
    const row = table.rows[0];
    expect(row.justification).toContain('strongFit');
    expect(row.justification).toContain('meets all evaluated requirements');
  });

  it('surfaces the hasFullDescription:false reroute reasoning in Justification', () => {
    const table = formatScrapeResults(mixedBatch);
    const row = table.rows.find((candidate) => candidate.jobTitle === 'Platform Architect');
    expect(row).toBeDefined();
    expect(row?.justification).toContain('manualReview');
    expect(row?.justification).toContain('hasFullDescription=false');
    expect(row?.justification).toContain('routed to manualReview');
  });
});

describe('formatScrapeResults: safe against future column drift', () => {
  it('always returns exactly the 7-column core, even for sparse rows', () => {
    const table = formatScrapeResults(mixedBatch);
    expect([...table.columns]).toEqual([
      'Sr. No.',
      'Job Title',
      'Organization',
      'Brief',
      'Fit Score',
      'Justification',
      'Link',
    ]);
    const bare = evaluate({ posting: makePosting({ location: '', sourceAggregator: '' }) }, 'A concise brief.');
    const bareTable = formatScrapeResults([bare]);
    expect([...bareTable.columns]).toEqual([...table.columns]);
    expect(bareTable.columns).toHaveLength(7);
  });
});

describe('scrapeResultsFormatter: markdown cell safety (Phase F)', () => {
  // Literal pins only: the 7 headers and the 150 ceiling are written out,
  // never imported from the formatter constants under test.
  it('escapes pipes in string cells so a markdown row keeps exactly 7 cells', () => {
    const entry = evaluate(
      { posting: makePosting({ roleTitle: 'Staff | Principal Engineer' }) },
      'Brief with | pipe',
    );
    const table = formatScrapeResults([entry]);
    expect(table.rows).toHaveLength(1);
    const markdown = activeResultsToMarkdown(table);
    expect(markdown.columns).toEqual([
      'Sr. No.',
      'Job Title',
      'Organization',
      'Brief',
      'Fit Score',
      'Justification',
      'Link',
    ]);
    expect(markdown.rows[0][1]).toBe('Staff \\| Principal Engineer');
    expect(markdown.rows[0][3]).toBe('Brief with \\| pipe');
    expect(renderMarkdown(markdown)).toContain('Staff \\| Principal Engineer');
  });

  it('totals an overlong brief to exactly 150 characters including the ellipsis', () => {
    expect(truncateBrief('q'.repeat(200))).toHaveLength(150);
    expect(truncateBrief('q'.repeat(200))).toBe('q'.repeat(147) + '...');
    expect(truncateBrief('q'.repeat(149))).toHaveLength(149);
  });
});
