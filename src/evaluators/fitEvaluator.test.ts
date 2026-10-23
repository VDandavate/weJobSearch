import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  classifyScore,
  evaluateFit,
  loadJobPreferences,
  parseJobPreferences,
  type CandidateCapabilities,
  type FitEvaluationInput,
  type JobPreferences,
} from './fitEvaluator';
import type { PostingRequirements } from './fitEvaluator';
import type { RawPosting } from '../scrapers/jobSpyAdapter';

// Step 11 owns the official fixtures/ test suite (SDD Section 6.3). This file
// is the Step 4 evaluator authoring verification requested in the session
// brief; it may be absorbed, moved, or superseded once fixtures/ lands.

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
    preferredLocations: [],
    ...overrides,
  };
}

function run(overrides: Partial<FitEvaluationInput>): ReturnType<typeof evaluateFit> {
  return evaluateFit({
    posting: makePosting(),
    requirements: emptyRequirements,
    candidate: candidatePool,
    preferences: makePreferences(),
    ...overrides,
  });
}

describe('classifyScore: score-band boundaries from the Requirement 2 table', () => {
  it('maps each boundary exactly', () => {
    expect(classifyScore(0)).toBe('hardRejected');
    expect(classifyScore(0.1)).toBe('weakFit');
    expect(classifyScore(2.4)).toBe('weakFit');
    expect(classifyScore(2.5)).toBe('manualReview');
    expect(classifyScore(3.4)).toBe('manualReview');
    expect(classifyScore(3.5)).toBe('strongFit');
    expect(classifyScore(5)).toBe('strongFit');
  });
});

describe('evaluateFit: deduction rules independently', () => {
  it('scores 5.0 strongFit when nothing applies', () => {
    const assessment = evaluateFit({
      posting: makePosting(),
      requirements: emptyRequirements,
      candidate: candidatePool,
      preferences: makePreferences(),
    });
    expect(assessment.fitScore).toBe(5);
    expect(assessment.fitStatus).toBe('strongFit');
    expect(assessment.deductions).toHaveLength(0);
  });

  it('deducts 2.5 per missing hard requirement with full description', () => {
    const assessment = evaluateFit({
      posting: makePosting(),
      requirements: { ...emptyRequirements, requiredSkills: ['Ruby'] },
      candidate: candidatePool,
      preferences: makePreferences(),
    });
    expect(assessment.fitScore).toBe(2.5);
    expect(assessment.fitStatus).toBe('manualReview');
    expect(assessment.deductions).toHaveLength(1);
    expect(assessment.deductions[0]).toMatchObject({
      kind: 'missingHardRequirement',
      amount: -2.5,
      label: expect.stringContaining('ruby') as string,
    });
  });

  it('two missing hard requirements drops the score to zero (hardRejected band)', () => {
    const assessment = evaluateFit({
      posting: makePosting(),
      requirements: { ...emptyRequirements, requiredSkills: ['Ruby', 'Go'] },
      candidate: candidatePool,
      preferences: makePreferences(),
    });
    expect(assessment.fitScore).toBe(0);
    expect(assessment.fitStatus).toBe('hardRejected');
    expect(assessment.deductions).toHaveLength(2);
  });

  it('caps a years-of-experience deficit at 2.5 with no other deductions', () => {
    const assessment = evaluateFit({
      posting: makePosting(),
      requirements: { ...emptyRequirements, requiredYearsOfExperience: 12 },
      candidate: makeCandidate(['TypeScript'], 3, ['fintech']),
      preferences: makePreferences(),
    });
    expect(assessment.fitScore).toBe(2.5);
    expect(assessment.fitStatus).toBe('manualReview');
    expect(assessment.deductions).toContainEqual(
      expect.objectContaining({ kind: 'yearsOfExperienceCap' }),
    );
  });

  it('deducts 1.0 for a domain discrepancy without exiting the strong band', () => {
    const assessment = evaluateFit({
      posting: makePosting(),
      requirements: { ...emptyRequirements, requiredDomains: ['healthcare'] },
      candidate: candidatePool,
      preferences: makePreferences(),
    });
    expect(assessment.fitScore).toBe(4);
    expect(assessment.fitStatus).toBe('strongFit');
    expect(assessment.deductions[0]).toMatchObject({
      kind: 'domainDiscrepancy',
      amount: -1,
    });
  });

  it('missing skill plus domain discrepancy lands in weakFit', () => {
    const assessment = evaluateFit({
      posting: makePosting(),
      requirements: {
        ...emptyRequirements,
        requiredSkills: ['Ruby'],
        requiredDomains: ['healthcare'],
      },
      candidate: candidatePool,
      preferences: makePreferences(),
    });
    expect(assessment.fitScore).toBe(1.5);
    expect(assessment.fitStatus).toBe('weakFit');
  });
});

describe('evaluateFit: nonNegotiables gate per category', () => {
  it('location violation hard-rejects with the rule id', () => {
    const assessment = evaluateFit({
      posting: makePosting({ location: 'New York, NY' }),
      requirements: emptyRequirements,
      candidate: candidatePool,
      postingFacts: { locationType: 'onsite' },
      preferences: makePreferences({
        preferredLocations: ['Remote'],
        nonNegotiables: [
          { id: 'noRelocation', category: 'location', rule: 'reject outside preferred' },
        ],
      }),
    });
    expect(assessment.fitScore).toBe(0);
    expect(assessment.fitStatus).toBe('hardRejected');
    expect(assessment.rejectedNonNegotiableIds).toContain('noRelocation');
    expect(
      assessment.nonNegotiableChecks.find((check) => check.id === 'noRelocation')?.outcome,
    ).toBe('violated');
  });

  it('location compliant posting passes the gate', () => {
    const assessment = evaluateFit({
      posting: makePosting({ location: 'Hybrid' }),
      requirements: emptyRequirements,
      candidate: candidatePool,
      preferences: makePreferences({
        preferredLocations: ['Remote'],
        nonNegotiables: [
          { id: 'noRelocation', category: 'location', rule: 'reject outside preferred' },
        ],
      }),
    });
    expect(assessment.fitStatus).toBe('strongFit');
    expect(
      assessment.nonNegotiableChecks.find((check) => check.id === 'noRelocation')?.outcome,
    ).toBe('compliant');
  });

  it('employerType staffing-agency tag hard-rejects', () => {
    const assessment = evaluateFit({
      posting: makePosting(),
      requirements: emptyRequirements,
      candidate: candidatePool,
      postingFacts: { employerType: 'staffingAgency' },
      preferences: makePreferences({
        nonNegotiables: [
          { id: 'noStaffingAgencies', category: 'employerType', rule: 'reject staffing' },
        ],
      }),
    });
    expect(assessment.fitStatus).toBe('hardRejected');
    expect(assessment.rejectedNonNegotiableIds).toContain('noStaffingAgencies');
  });

  it('employerType with no signal is not rejected', () => {
    const assessment = evaluateFit({
      posting: makePosting(),
      requirements: emptyRequirements,
      candidate: candidatePool,
      postingFacts: {},
      preferences: makePreferences({
        nonNegotiables: [
          { id: 'noStaffingAgencies', category: 'employerType', rule: 'reject staffing' },
        ],
      }),
    });
    expect(assessment.fitStatus).toBe('strongFit');
    expect(
      assessment.nonNegotiableChecks.find((check) => check.id === 'noStaffingAgencies')?.outcome,
    ).toBe('unknown');
  });

  it('clearance above current with eligibility false hard-rejects', () => {
    const assessment = evaluateFit({
      posting: makePosting(),
      requirements: emptyRequirements,
      candidate: candidatePool,
      postingFacts: { requiredClearanceLevel: 'topSecret' },
      preferences: makePreferences({
        clearance: {
          currentStatus: 'active',
          currentLevel: 'secret',
          eligibleToObtain: false,
          requiresSponsorshipForVisa: false,
        },
        nonNegotiables: [
          { id: 'clearanceMismatch', category: 'clearance', rule: 'reject above current' },
        ],
      }),
    });
    expect(assessment.fitStatus).toBe('hardRejected');
    expect(assessment.rejectedNonNegotiableIds).toContain('clearanceMismatch');
  });

  it('clearance eligibility to obtain true passes despite higher level', () => {
    const assessment = evaluateFit({
      posting: makePosting(),
      requirements: emptyRequirements,
      candidate: candidatePool,
      postingFacts: { requiredClearanceLevel: 'topSecret' },
      preferences: makePreferences({
        clearance: {
          currentStatus: 'none',
          currentLevel: null,
          eligibleToObtain: true,
          requiresSponsorshipForVisa: false,
        },
        nonNegotiables: [
          { id: 'clearanceMismatch', category: 'clearance', rule: '' },
        ],
      }),
    });
    expect(assessment.fitStatus).toBe('strongFit');
    expect(
      assessment.nonNegotiableChecks.find((check) => check.id === 'clearanceMismatch')?.outcome,
    ).toBe('compliant');
  });

  it('compensation below the minimum base hard-rejects', () => {
    const assessment = evaluateFit({
      posting: makePosting({ rawSalaryText: 'USD 140,000 - 160,000/yr' }),
      requirements: emptyRequirements,
      candidate: candidatePool,
      preferences: makePreferences({
        nonNegotiables: [
          { id: 'belowMinSalary', category: 'compensation', rule: 'reject below min' },
        ],
      }),
    });
    expect(assessment.fitStatus).toBe('hardRejected');
    expect(assessment.rejectedNonNegotiableIds).toContain('belowMinSalary');
  });

  it('currency mismatch with a compensation nonNegotiable records unknown without capping the band', () => {
    // Phase D: salary-unknown is separated from score — an unparseable or
    // incomparable salary records an 'unknown' check outcome plus a note, but
    // the deductive band stands, so a skills-strong posting still reaches
    // strongFit where the SDD allows it.
    const assessment = evaluateFit({
      posting: makePosting({ rawSalaryText: 'EUR 55,000 - 65,000 per year' }),
      requirements: emptyRequirements,
      candidate: candidatePool,
      preferences: makePreferences({
        nonNegotiables: [
          { id: 'belowMinSalary', category: 'compensation', rule: 'reject if below min' },
        ],
      }),
    });
    expect(assessment.fitStatus).toBe('strongFit');
    expect(assessment.fitScore).toBe(5);
    expect(assessment.rejectedNonNegotiableIds).toHaveLength(0);
    expect(
      assessment.nonNegotiableChecks.find((check) => check.id === 'belowMinSalary')?.outcome,
    ).toBe('unknown');
    expect(assessment.notes.join(' ')).toContain('belowMinSalary');
  });

  it('custom nonNegotiable always routes to manualReview', () => {
    const assessment = evaluateFit({
      posting: makePosting(),
      requirements: emptyRequirements,
      candidate: candidatePool,
      preferences: makePreferences({
        nonNegotiables: [
          { id: 'futureOptions', category: 'custom', rule: 'user-typed preference' },
        ],
      }),
    });
    expect(assessment.fitStatus).toBe('manualReview');
    expect(assessment.nonNegotiableChecks).toHaveLength(1);
    expect(
      assessment.nonNegotiableChecks.find((check) => check.id === 'futureOptions')?.outcome,
    ).toBe('unknown');
  });

  it('null salary with a compensation nonNegotiable records unknown without capping the band', () => {
    // Phase D: same salary-unknown separation as the currency-mismatch case —
    // no parseable salary is not a rejection and not a manualReview routing;
    // the band follows the deductive score alone.
    const assessment = evaluateFit({
      posting: makePosting({ rawSalaryText: undefined }),
      requirements: emptyRequirements,
      candidate: candidatePool,
      preferences: makePreferences({
        nonNegotiables: [
          { id: 'belowMinSalary', category: 'compensation', rule: 'reject if below min' },
        ],
      }),
    });
    expect(assessment.fitStatus).toBe('strongFit');
    expect(assessment.fitScore).toBe(5);
    expect(assessment.rejectedNonNegotiableIds).toHaveLength(0);
    expect(
      assessment.nonNegotiableChecks.find((check) => check.id === 'belowMinSalary')?.outcome,
    ).toBe('unknown');
  });
});

describe('evaluateFit: hasFullDescription handling', () => {
  it('capped missing-requirement deduction on a partial posting routes to manualReview', () => {
    const assessment = evaluateFit({
      posting: makePosting({ hasFullDescription: false }),
      requirements: {
        ...emptyRequirements,
        requiredSkills: ['Ruby', 'Go', 'GraphQL'],
        requiredDomains: ['healthcare'],
      },
      candidate: candidatePool,
      preferences: makePreferences(),
    });
    expect(assessment.hasFullDescription).toBe(false);
    expect(assessment.fitStatus).toBe('manualReview');
    expect(assessment.notes.join(' ')).toContain('manualReview');
  });

  it('the same posting with a full description scores much lower', () => {
    const full = evaluateFit({
      posting: makePosting({ hasFullDescription: true }),
      requirements: {
        ...emptyRequirements,
        requiredSkills: ['Ruby', 'Go', 'GraphQL'],
        requiredDomains: ['healthcare'],
      },
      candidate: candidatePool,
      preferences: makePreferences(),
    });
    const partial = evaluateFit({
      posting: makePosting({ hasFullDescription: false }),
      requirements: {
        ...emptyRequirements,
        requiredSkills: ['Ruby', 'Go', 'GraphQL'],
        requiredDomains: ['healthcare'],
      },
      candidate: candidatePool,
      preferences: makePreferences(),
    });
    expect(full.fitScore).toBeLessThan(partial.fitScore);
    expect(full.fitStatus).toBe('hardRejected');
  });
});

describe('jobPreferences yaml schema and loader', () => {
  const yamlContent = `compensation:
  currency: USD
  minAcceptableBase: 150000
  targetBase: 180000
  countsBonusTowardMin: false
  countsEquityTowardMin: false

clearance:
  currentStatus: active
  currentLevel: secret
  eligibleToObtain: false
  requiresSponsorshipForVisa: false

nonNegotiables:
  - id: belowMinSalary
    category: compensation
    rule: "reject if posted base salary is below minAcceptableBase"

preferredLocations:
  - Remote
`;

  it('parses a valid jobPreferences.yaml document', () => {
    const parsed = parseJobPreferences(yamlContent);
    expect(parsed.compensation.minAcceptableBase).toBe(150000);
    expect(parsed.clearance.eligibleToObtain).toBe(false);
    expect(parsed.nonNegotiables).toHaveLength(1);
    expect(parsed.nonNegotiables[0]).toMatchObject({
      id: 'belowMinSalary',
      category: 'compensation',
    });
    expect(parsed.preferredLocations).toEqual(['Remote']);
  });

  it('rejects an invalid document with a readable error', () => {
    expect(() => parseJobPreferences('nonNegotiables: nope')).toThrow(/Invalid jobPreferences YAML/);
  });

  it('normalizes a syntactically invalid document to the readable error', () => {
    expect(() => parseJobPreferences('compensation: {\n')).toThrow(/^Invalid jobPreferences YAML: /);
  });

  it('accepts an empty targetRoles array', () => {
    const parsed = parseJobPreferences(`${yamlContent}\ntargetRoles: []\n`);
    expect(parsed.targetRoles).toEqual([]);
  });

  it('accepts a populated targetRoles array', () => {
    const parsed = parseJobPreferences(
      `${yamlContent}\ntargetRoles:\n  - Senior Software Engineer\n  - Staff Engineer\n`,
    );
    expect(parsed.targetRoles).toEqual(['Senior Software Engineer', 'Staff Engineer']);
  });

  it('rejects a non-array targetRoles value', () => {
    expect(() => parseJobPreferences(`${yamlContent}\ntargetRoles: Senior Engineer\n`)).toThrow(
      /Invalid jobPreferences YAML/,
    );
  });

  it('rejects non-string entries in targetRoles', () => {
    expect(() => parseJobPreferences(`${yamlContent}\ntargetRoles:\n  - 42\n`)).toThrow(
      /Invalid jobPreferences YAML/,
    );
  });

  it('accepts a document without targetRoles (backward compatible)', () => {
    const parsed = parseJobPreferences(yamlContent);
    expect(parsed.targetRoles).toBeUndefined();
  });

  it('accepts a positive searchCacheTtlMinutes', () => {
    const parsed = parseJobPreferences(`${yamlContent}\nsearchCacheTtlMinutes: 30\n`);
    expect(parsed.searchCacheTtlMinutes).toBe(30);
  });

  it('rejects a negative searchCacheTtlMinutes', () => {
    expect(() => parseJobPreferences(`${yamlContent}\nsearchCacheTtlMinutes: -5\n`)).toThrow(
      /Invalid jobPreferences YAML/,
    );
  });

  it('rejects a zero searchCacheTtlMinutes', () => {
    expect(() => parseJobPreferences(`${yamlContent}\nsearchCacheTtlMinutes: 0\n`)).toThrow(
      /Invalid jobPreferences YAML/,
    );
  });

  it('rejects a fractional searchCacheTtlMinutes', () => {
    expect(() => parseJobPreferences(`${yamlContent}\nsearchCacheTtlMinutes: 2.5\n`)).toThrow(
      /Invalid jobPreferences YAML/,
    );
  });

  it('loads from disk', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wejobsearch-'));
    const filePath = join(dir, 'jobPreferences.yaml');
    await writeFile(filePath, yamlContent, 'utf8');
    const loaded = await loadJobPreferences(filePath);
    expect(loaded.compensation.minAcceptableBase).toBe(150000);
    await rm(dir, { recursive: true, force: true });
  });

  it('loadJobPreferences fails fast on a malformed file on disk', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wejobsearch-'));
    try {
      const filePath = join(dir, 'jobPreferences.yaml');
      await writeFile(filePath, 'nonNegotiables: nope\n', 'utf8');
      await expect(loadJobPreferences(filePath)).rejects.toThrow(/Invalid jobPreferences YAML/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('jobPreferences directories block (config-driven directories)', () => {
  const baseYaml = `compensation:
  currency: USD
  minAcceptableBase: 150000
  targetBase: 180000
  countsBonusTowardMin: false
  countsEquityTowardMin: false

clearance:
  currentStatus: active
  currentLevel: secret
  eligibleToObtain: false
  requiresSponsorshipForVisa: false

nonNegotiables: []

preferredLocations: []
`;

  it('parses a document without a directories block (backward compatible)', () => {
    const parsed = parseJobPreferences(baseYaml);
    expect(parsed.directories).toBeUndefined();
    expect(parsed.preferredLocations).toEqual([]);
    expect(parsed.nonNegotiables).toEqual([]);
  });

  it('defaults every missing directories key to null', () => {
    const parsed = parseJobPreferences(`${baseYaml}directories:\n  outputRoot: /tmp/customOut\n`);
    expect(parsed.directories).toEqual({
      dataRoot: null,
      outputRoot: '/tmp/customOut',
      resumeVariantsFile: null,
    });
  });

  it('parses a fully populated directories block', () => {
    const parsed = parseJobPreferences(
      `${baseYaml}directories:\n  outputRoot: /tmp/out\n  resumeVariantsFile: /tmp/variants.yaml\n`,
    );
    expect(parsed.directories).toEqual({
      dataRoot: null,
      outputRoot: '/tmp/out',
      resumeVariantsFile: '/tmp/variants.yaml',
    });
  });

  it('rejects a set directories.dataRoot loudly instead of silently ignoring it', () => {
    expect(() => parseJobPreferences(`${baseYaml}directories:\n  dataRoot: /tmp/data\n`)).toThrow(
      /directories\.dataRoot is no longer supported/,
    );
  });

  it('strips a stale templateRoot key instead of rejecting the file', () => {
    const parsed = parseJobPreferences(
      `${baseYaml}directories:\n  outputRoot: /tmp/out\n  templateRoot: /tmp/tmpl\n`,
    );
    expect(parsed.directories).toEqual({
      dataRoot: null,
      outputRoot: '/tmp/out',
      resumeVariantsFile: null,
    });
  });

  it('fails fast on a non-string directories value', () => {
    expect(() => parseJobPreferences(`${baseYaml}directories:\n  dataRoot: 42\n`)).toThrow(
      /Invalid jobPreferences YAML/,
    );
  });
});

describe('evaluateFit: neutral location handling', () => {
  it('falls back to unknown for a posting with no location signal and never rejects it', () => {
    const assessment = evaluateFit({
      posting: makePosting({ location: 'Austin, TX' }),
      requirements: emptyRequirements,
      candidate: candidatePool,
      preferences: makePreferences({
        preferredLocations: ['Remote'],
        nonNegotiables: [
          { id: 'noRelocation', category: 'location', rule: 'reject outside preferred' },
        ],
      }),
    });
    expect(assessment.rejectedNonNegotiableIds).toEqual([]);
    expect(assessment.fitStatus).not.toBe('hardRejected');
    expect(
      assessment.nonNegotiableChecks.find((check) => check.id === 'noRelocation')?.outcome,
    ).toBe('unknown');
  });

  it('imposes no location penalty when preferredLocations is empty', () => {
    // A posting with an explicit remote signal is compliant; postings with no
    // location signal report 'unknown' (never 'violated'). Either way the
    // score is untouched: empty defaults never penalize location.
    const remote = evaluateFit({
      posting: makePosting({ location: 'Remote' }),
      requirements: emptyRequirements,
      candidate: candidatePool,
      preferences: makePreferences({
        preferredLocations: [],
        nonNegotiables: [
          { id: 'noRelocation', category: 'location', rule: 'reject outside preferred' },
        ],
      }),
    });
    expect(remote.fitStatus).toBe('strongFit');
    expect(
      remote.nonNegotiableChecks.find((check) => check.id === 'noRelocation')?.outcome,
    ).toBe('compliant');

    for (const location of ['New York, NY', 'Austin, TX']) {
      const assessment = evaluateFit({
        posting: makePosting({ location }),
        requirements: emptyRequirements,
        candidate: candidatePool,
        preferences: makePreferences({
          preferredLocations: [],
          nonNegotiables: [
            { id: 'noRelocation', category: 'location', rule: 'reject outside preferred' },
          ],
        }),
      });
      expect(assessment.fitStatus).toBe('strongFit');
      expect(assessment.rejectedNonNegotiableIds).toEqual([]);
      expect(
        assessment.nonNegotiableChecks.find((check) => check.id === 'noRelocation')?.outcome,
      ).toBe('unknown');
    }
  });

  it('treats remoteOnly as a generic location-category id, distinct from the --remoteOnly display filter', () => {
    // The id carries no built-in onsite meaning: with empty preferredLocations
    // even an explicitly onsite posting is compliant. The --remoteOnly CLI flag
    // (a display filter in the search layer) never reaches this evaluator.
    const neutral = evaluateFit({
      posting: makePosting({ location: 'New York, NY' }),
      requirements: emptyRequirements,
      candidate: candidatePool,
      postingFacts: { locationType: 'onsite' },
      preferences: makePreferences({
        preferredLocations: [],
        nonNegotiables: [
          { id: 'remoteOnly', category: 'location', rule: 'flag for manualReview if posting is fully onsite' },
        ],
      }),
    });
    expect(neutral.fitStatus).toBe('strongFit');
    expect(
      neutral.nonNegotiableChecks.find((check) => check.id === 'remoteOnly')?.outcome,
    ).toBe('compliant');

    const strict = evaluateFit({
      posting: makePosting({ location: 'New York, NY' }),
      requirements: emptyRequirements,
      candidate: candidatePool,
      postingFacts: { locationType: 'onsite' },
      preferences: makePreferences({
        preferredLocations: ['Remote'],
        nonNegotiables: [
          { id: 'remoteOnly', category: 'location', rule: 'flag for manualReview if posting is fully onsite' },
        ],
      }),
    });
    // Phase D, grounded in the SDD Requirement 1a remoteOnly example: a
    // manualReview-worded location rule flags manualReview for a fully onsite
    // posting — it never hard-rejects. A reject-worded rule (noRelocation)
    // still rejects; see the noRelocation test above.
    expect(strict.fitStatus).toBe('manualReview');
    expect(strict.rejectedNonNegotiableIds).toHaveLength(0);
    expect(
      strict.nonNegotiableChecks.find((check) => check.id === 'remoteOnly')?.outcome,
    ).toBe('unknown');
    expect(strict.notes.join(' ')).toContain('manualReview');
  });
});

describe('evaluateFit: compensation preference wiring (Phase D)', () => {
  const compensationRule = { id: 'belowMinSalary', category: 'compensation', rule: 'reject if below min' } as const;

  it('records a targetBase note without rejecting when the posting clears the floor but not the target', () => {
    // min 150000, target 180000; posting floor 160000 clears the floor only.
    const assessment = evaluateFit({
      posting: makePosting({ rawSalaryText: 'USD 160,000 - 170,000/yr' }),
      requirements: emptyRequirements,
      candidate: candidatePool,
      preferences: makePreferences({ nonNegotiables: [{ ...compensationRule }] }),
    });
    expect(assessment.fitStatus).toBe('strongFit');
    expect(assessment.rejectedNonNegotiableIds).toHaveLength(0);
    const check = assessment.nonNegotiableChecks.find((entry) => entry.id === 'belowMinSalary');
    expect(check?.outcome).toBe('compliant');
    expect(check?.note).toContain('below targetBase 180000');
  });

  it('records meeting targetBase when the posting clears both bars', () => {
    const assessment = evaluateFit({
      posting: makePosting({ rawSalaryText: 'USD 190,000 - 210,000/yr' }),
      requirements: emptyRequirements,
      candidate: candidatePool,
      preferences: makePreferences({ nonNegotiables: [{ ...compensationRule }] }),
    });
    expect(assessment.fitStatus).toBe('strongFit');
    const check = assessment.nonNegotiableChecks.find((entry) => entry.id === 'belowMinSalary');
    expect(check?.outcome).toBe('compliant');
    expect(check?.note).toContain('meets targetBase 180000');
  });

  it('strict counting holds the posted floor to the minimum; generous counting lets the range top satisfy it', () => {
    // Range 140000-160000 against min 150000: strict (bonus/equity excluded)
    // violates on the 140000 floor; generous (bonus counts) passes on the
    // 160000 top. Same posting, same minimum — only the user's counting
    // posture differs, and it lives in jobPreferences.yaml, not in code.
    const posting = makePosting({ rawSalaryText: 'USD 140,000 - 160,000/yr' });
    const strict = evaluateFit({
      posting,
      requirements: emptyRequirements,
      candidate: candidatePool,
      preferences: makePreferences({ nonNegotiables: [{ ...compensationRule }] }),
    });
    expect(strict.fitStatus).toBe('hardRejected');
    expect(strict.rejectedNonNegotiableIds).toContain('belowMinSalary');

    const generous = evaluateFit({
      posting,
      requirements: emptyRequirements,
      candidate: candidatePool,
      preferences: makePreferences({
        compensation: {
          currency: 'USD',
          minAcceptableBase: 150000,
          targetBase: 180000,
          countsBonusTowardMin: true,
          countsEquityTowardMin: false,
        },
        nonNegotiables: [{ ...compensationRule }],
      }),
    });
    expect(generous.fitStatus).toBe('strongFit');
    expect(generous.rejectedNonNegotiableIds).toHaveLength(0);
    expect(
      generous.nonNegotiableChecks.find((entry) => entry.id === 'belowMinSalary')?.outcome,
    ).toBe('compliant');
  });
});

describe('jobPreferencesSchema: searchRadiusMiles', () => {
  it('accepts optional positive searchRadiusMiles', () => {
    const prefs = parseJobPreferences(`
compensation:
  currency: USD
  minAcceptableBase: 100000
  targetBase: 150000
  countsBonusTowardMin: false
  countsEquityTowardMin: false
clearance:
  currentStatus: none
  currentLevel: null
  eligibleToObtain: false
  requiresSponsorshipForVisa: false
nonNegotiables: []
preferredLocations:
  - Remote
searchRadiusMiles: 25
`);
    expect(prefs.searchRadiusMiles).toBe(25);
  });

  it('rejects non-positive searchRadiusMiles', () => {
    expect(() => parseJobPreferences(`
compensation:
  currency: USD
  minAcceptableBase: 100000
  targetBase: 150000
  countsBonusTowardMin: false
  countsEquityTowardMin: false
clearance:
  currentStatus: none
  currentLevel: null
  eligibleToObtain: false
  requiresSponsorshipForVisa: false
nonNegotiables: []
preferredLocations:
  - Remote
searchRadiusMiles: 0
`)).toThrow();
    expect(() => parseJobPreferences(`
compensation:
  currency: USD
  minAcceptableBase: 100000
  targetBase: 150000
  countsBonusTowardMin: false
  countsEquityTowardMin: false
clearance:
  currentStatus: none
  currentLevel: null
  eligibleToObtain: false
  requiresSponsorshipForVisa: false
nonNegotiables: []
preferredLocations:
  - Remote
searchRadiusMiles: -5
`)).toThrow();
  });

  it('omits searchRadiusMiles when not provided', () => {
    const prefs = parseJobPreferences(`
compensation:
  currency: USD
  minAcceptableBase: 100000
  targetBase: 150000
  countsBonusTowardMin: false
  countsEquityTowardMin: false
clearance:
  currentStatus: none
  currentLevel: null
  eligibleToObtain: false
  requiresSponsorshipForVisa: false
nonNegotiables: []
preferredLocations:
  - Remote
`);
    expect(prefs.searchRadiusMiles).toBeUndefined();
  });
});
