import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  excludedJustification,
  excludedResultsToMarkdown,
  formatExcludedResults,
} from './excludedResultsFormatter';
import {
  evaluateFit,
  type CandidateCapabilities,
  type FitAssessment,
  type JobPreferences,
  type PostingFacts,
  type PostingRequirements,
} from '../evaluators/fitEvaluator';
import { renderMarkdown, type EvaluatedPosting } from './scrapeResultsFormatter';
import type { RawPosting } from '../scrapers/jobSpyAdapter';

// Step 6b authoring verification for the Excluded Results formatter (SDD
// Requirement 2a). Fixtures are synthetic and run through the real
// fitEvaluator so Justification reflects Step 4b reasoning verbatim.

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

// Mixed batch: one weakFit, two hardRejected (one on a nonNegotiables rule,
// one purely from deductions), plus a strongFit and a manualReview reroute
// that the excluded table must drop.
const excludedBatch: EvaluatedPosting[] = [
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
    'Large irregular platform', // dropped: rerouted to manualReview
  ),
  evaluate(
    {
      posting: makePosting({
        roleTitle: 'Ruby Developer',
        companyName: 'HopperSoft',
        jobUrl: 'https://hopper.example.com/jobs/ruby-developer',
      }),
      requirements: {
        ...emptyRequirements,
        requiredSkills: ['Go'],
        requiredDomains: ['healthcare'],
      },
    },
    'Builds on the Ruby monolith for a growing product', // weakFit
  ),
  evaluate(
    {
      posting: makePosting({
        roleTitle: 'Staff Engineer',
        companyName: 'AcmeCorp',
        jobUrl: 'https://acme.example.com/jobs/staff-engineer',
      }),
    },
    'Builds distributed backend services with TypeScript', // dropped: strongFit
  ),
  evaluate(
    {
      posting: makePosting({
        roleTitle: 'Onsite DevOps',
        companyName: 'NimbusSystems',
        jobUrl: 'https://nimbus.example.com/jobs/onsite-devops',
        location: 'New York, NY',
        rawSalaryText: 'USD 50,000 - 60,000 per year',
      }),
      preferences: makePreferences({
        preferredLocations: ['Remote'],
        nonNegotiables: [
          { id: 'belowMinSalary', category: 'compensation', rule: 'reject below the pay floor' },
        ],
      }),
    },
    'Scaling infrastructure for a Manhattan HQ', // hardRejected: rule fired
  ),
  evaluate(
    {
      posting: makePosting({
        roleTitle: 'Generic Analyst',
        companyName: 'DataMatters',
        jobUrl: 'https://datamatters.example.com/jobs/generic-analyst',
      }),
      requirements: {
        ...emptyRequirements,
        requiredSkills: ['Ruby', 'Go'],
        requiredDomains: ['healthcare'],
      },
    },
    'Summarizes business metrics for leadership', // hardRejected: deductions
  ),
];

describe('excludedResultsFormatter: fixed column contract (SDD Requirement 2a)', () => {
  // SDD-independent guard: pinned literals, never the formatter constants
  // (see the no-import case below), so the guard cannot enforce drift.
  it('owns the exact 6-column core set, in order, with no extras', () => {
    const table = formatExcludedResults(excludedBatch);
    expect([...table.columns]).toEqual([
      'Sr. No.',
      'Job Title',
      'Organization',
      'Fit Score',
      'Justification',
      'Link',
    ]);
    expect(table.columns).toHaveLength(6);
  });

  it('never imports the formatter column constants it guards', () => {
    const source = readFileSync(join(__dirname, 'excludedResultsFormatter.test.ts'), 'utf8');
    const importLines = source.split('\n').filter((line) => line.startsWith('import '));
    for (const line of importLines) {
      expect(line).not.toMatch(/excludedResult(Extra)?Columns/);
    }
  });
});

describe('formatExcludedResults: auto routing from the full batch', () => {
  it('keeps only hardRejected and weakFit', () => {
    const table = formatExcludedResults(excludedBatch);
    expect(table.rows.map((row) => row.jobTitle)).toEqual([
      'Ruby Developer',
      'Onsite DevOps',
      'Generic Analyst',
    ]);
  });

  it('numbers Sr. No. sequentially from 1 for the excluded batch only', () => {
    const table = formatExcludedResults(excludedBatch);
    expect(table.rows.map((row) => row.srNo)).toEqual([1, 2, 3]);
    expect(table.rows[0].srNo).toBe(1);
  });

  it('fills cells from the expected source fields', () => {
    const table = formatExcludedResults(excludedBatch);
    const row = table.rows[1];
    expect(row.organization).toBe('NimbusSystems');
    expect(row.link).toBe('https://nimbus.example.com/jobs/onsite-devops');
    expect(row.fitScore).toBe(0);
  });
});

describe('excludedJustification: full reason per fitStatus', () => {
  it('names the specific nonNegotiables ruleId for a hardRejected row', () => {
    const table = formatExcludedResults(excludedBatch);
    const row = table.rows.find((candidate) => candidate.jobTitle === 'Onsite DevOps');
    expect(row).toBeDefined();
    expect(row?.justification).toContain('hardRejected');
    expect(row?.justification).toContain('belowMinSalary');
  });

  it('lists the dominant deductions for a weakFit row', () => {
    const table = formatExcludedResults(excludedBatch);
    const row = table.rows.find((candidate) => candidate.jobTitle === 'Ruby Developer');
    expect(row).toBeDefined();
    expect(row?.justification).toContain('weakFit');
    expect(row?.justification).toContain('go');
    expect(row?.justification).toContain('healthcare');
  });

  it('explains a deductions-driven hardRejected row when no ruleId fired', () => {
    const table = formatExcludedResults(excludedBatch);
    const row = table.rows.find((candidate) => candidate.jobTitle === 'Generic Analyst');
    expect(row).toBeDefined();
    expect(row?.justification).toContain('hardRejected');
    expect(row?.justification).toContain('reduced to 0');
    expect(row?.justification).toContain('ruby');
  });

  it('guards the empty-deduction hardRejected branch directly', () => {
    const assessment: FitAssessment = {
      fitScore: 0,
      fitStatus: 'hardRejected',
      deductions: [],
      nonNegotiableChecks: [],
      rejectedNonNegotiableIds: [],
      notes: [],
      baseScore: 5,
      hasFullDescription: true,
    };
    expect(excludedJustification(assessment)).toBe('hardRejected — score reduced to 0 by the rejection gate');
  });
});

describe('excludedResultsFormatter: markdown cell safety (Phase F)', () => {
  // Literal pins only: the 6 headers are written out, never imported from
  // the formatter constants under test.
  it('escapes pipes in string cells so a markdown row keeps exactly 6 cells', () => {
    const entry = evaluate(
      {
        posting: makePosting({
          roleTitle: 'Ruby | Go Developer',
          companyName: 'Hopper | Soft',
        }),
        requirements: {
          ...emptyRequirements,
          requiredSkills: ['Go'],
          requiredDomains: ['healthcare'],
        },
      },
      'Builds on the Ruby monolith',
    );
    const table = formatExcludedResults([entry]);
    expect(table.rows).toHaveLength(1);
    const markdown = excludedResultsToMarkdown(table);
    expect(markdown.columns).toEqual([
      'Sr. No.',
      'Job Title',
      'Organization',
      'Fit Score',
      'Justification',
      'Link',
    ]);
    expect(markdown.rows[0][1]).toBe('Ruby \\| Go Developer');
    expect(markdown.rows[0][2]).toBe('Hopper \\| Soft');
    const lines = renderMarkdown(markdown).split('\n');
    expect(lines).toHaveLength(3);
    // Six cells render as seven unescaped pipes (leading, five separators,
    // trailing); the two escaped pipes inside cells do not split the row.
    expect(lines[2].split(/(?<!\\)\|/)).toHaveLength(8);
  });
});
