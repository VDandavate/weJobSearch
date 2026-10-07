import { describe, expect, it } from 'vitest';
import {
  classifyClearanceRequirement,
  classifyEmployerType,
  classifyLocationType,
  extractPostingFacts,
} from './postingFactsExtractor';
import { evaluateFit } from './fitEvaluator';
import type { RawPosting } from '../scrapers/jobSpyAdapter';
import type { CandidateCapabilities, JobPreferences, PostingRequirements } from './fitEvaluator';

// Step 11 owns the official fixtures/ test suite (SDD Section 6.3). This file
// is the Step 4c authoring verification requested in the session brief; it may
// be absorbed, moved, or superseded once fixtures/ lands, alongside the same
// note already carried at the top of fitEvaluator.test.ts.

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

describe('classifyLocationType: pattern matching against location text', () => {
  it('classifies remote phrasings', () => {
    expect(classifyLocationType('Remote')).toBe('remote');
    expect(classifyLocationType('Remote - United States')).toBe('remote');
    expect(classifyLocationType('Fully Remote (US)')).toBe('remote');
    expect(classifyLocationType('100% remote')).toBe('remote');
    expect(classifyLocationType('Work from home')).toBe('remote');
    expect(classifyLocationType('WFH friendly')).toBe('remote');
    expect(classifyLocationType('Telecommute okay')).toBe('remote');
  });

  it('classifies hybrid phrasings', () => {
    expect(classifyLocationType('Hybrid - New York, NY')).toBe('hybrid');
    expect(classifyLocationType('Hybrid (3 days a week in office)')).toBe('hybrid');
  });

  it('classifies onsite phrasings', () => {
    expect(classifyLocationType('On-site in San Francisco')).toBe('onsite');
    expect(classifyLocationType('Onsite')).toBe('onsite');
    expect(classifyLocationType('On site at our HQ')).toBe('onsite');
    expect(classifyLocationType('In office at our HQ')).toBe('onsite');
  });

  it('defaults a location with no work-mode signal to unknown, not onsite', () => {
    expect(classifyLocationType('New York, NY')).toBe('unknown');
    expect(classifyLocationType('Anywhere in the US')).toBe('unknown');
    expect(classifyLocationType('')).toBe('unknown');
    expect(classifyLocationType(undefined)).toBe('unknown');
    expect(classifyLocationType(null)).toBe('unknown');
  });

  it('remote wins over hybrid and negated remote never fabricates remote', () => {
    expect(classifyLocationType('Remote or Hybrid')).toBe('remote');
    expect(classifyLocationType('On-site, not remote')).toBe('onsite');
    expect(classifyLocationType('No remote option')).toBe('unknown');
  });
});

describe('classifyEmployerType: staffing/agency heuristics', () => {
  it('detects staffing agencies from companyName', () => {
    expect(classifyEmployerType('AcmeStaffing LLC', '', undefined)).toBe('staffingAgency');
    expect(classifyEmployerType('Apex Recruiting Partners', '', undefined)).toBe('staffingAgency');
    expect(classifyEmployerType('Talent Solutions Group', '', undefined)).toBe('staffingAgency');
    expect(classifyEmployerType('Tech Placement Inc', '', undefined)).toBe('staffingAgency');
  });

  it('detects staffing agencies from description phrases', () => {
    expect(classifyEmployerType('AcmeCorp', 'We are a recruiting agency working on behalf of our client.', undefined)).toBe('staffingAgency');
    expect(classifyEmployerType('AcmeCorp', 'Hiring on behalf of our client in the fintech space.', undefined)).toBe('staffingAgency');
    expect(classifyEmployerType('AcmeCorp', 'This is a contract-to-hire role with our staffing partner.', undefined)).toBe('staffingAgency');
    expect(classifyEmployerType('AcmeCorp', 'Third party place employment agency listing.', undefined)).toBe('staffingAgency');
  });

  it('detects staffing agencies from the jobUrl hostname', () => {
    expect(classifyEmployerType('Delta Solutions', '', 'https://staffing.example.com/job/1')).toBe('staffingAgency');
    expect(classifyEmployerType('Delta Solutions', '', 'https://jobs.recruitingco.com/job/2')).toBe('staffingAgency');
  });

  it('defaults to unknown (never directEmployer) when no signal is present', () => {
    expect(classifyEmployerType('AcmeCorp', 'We build great software. Full-time, direct hire.', 'https://acmecorp.com/careers/1')).toBe('unknown');
    expect(classifyEmployerType('AcmeCorp', 'We are recruiting a Senior Engineer for our own team.', undefined)).toBe('unknown');
    expect(classifyEmployerType('AcmeCorp', '', undefined)).toBe('unknown');
    expect(classifyEmployerType(undefined, undefined, undefined)).toBe('unknown');
  });
});

describe('classifyClearanceRequirement: stated clearance levels and honest defaults', () => {
  it('detects each named clearance level', () => {
    expect(classifyClearanceRequirement('Active Public Trust clearance required')).toBe('publicTrust');
    expect(classifyClearanceRequirement('Must hold an active Secret clearance')).toBe('secret');
    expect(classifyClearanceRequirement('Top Secret clearance required')).toBe('topSecret');
    expect(classifyClearanceRequirement('Qualified candidates must hold TS/SCI')).toBe('tsSci');
    expect(classifyClearanceRequirement('Historic TS//SCI eligible')).toBe('tsSci');
  });

  it('reports the highest level mentioned, not the first', () => {
    expect(classifyClearanceRequirement('Secret clearance required; Top Secret preferred')).toBe('topSecret');
  });

  it('routes ambiguous clearance language to unknown', () => {
    expect(classifyClearanceRequirement('Applicants must hold a current security clearance')).toBe('unknown');
    expect(classifyClearanceRequirement('Must be able to obtain a security clearance')).toBe('unknown');
    expect(classifyClearanceRequirement('Clearance required for this federal position')).toBe('unknown');
    expect(classifyClearanceRequirement('Must be eligible to be cleared for government work')).toBe('unknown');
  });

  it('defaults to none only when no clearance language appears', () => {
    expect(classifyClearanceRequirement('')).toBe('none');
    expect(classifyClearanceRequirement(undefined)).toBe('none');
    expect(classifyClearanceRequirement('We offer competitive salary and benefits.')).toBe('none');
    expect(classifyClearanceRequirement('Must be a US citizen')).toBe('none');
  });

  it('never flags incidental uses of the word secret', () => {
    expect(classifyClearanceRequirement('The secret to winning is teamwork.')).toBe('none');
    expect(classifyClearanceRequirement('We value top secretaries and admins.')).toBe('none');
  });
});

describe('extractPostingFacts: the single entry point', () => {
  it('derives all three fields from a RawPosting', () => {
    expect(
      extractPostingFacts(
        makePosting({
          companyName: 'Acme Staffing',
          location: 'Hybrid - Chicago',
          description: 'TS/SCI clearance required; listing on behalf of a client',
        }),
      ),
    ).toEqual({
      locationType: 'hybrid',
      employerType: 'staffingAgency',
      requiredClearanceLevel: 'tsSci',
    });
  });

  it('returns honest unknown defaults when no signals are present', () => {
    expect(
      extractPostingFacts(
        makePosting({
          companyName: 'AcmeCorp',
          location: 'New York, NY',
          description: 'We build modern web applications.',
        }),
      ),
    ).toEqual({
      locationType: 'unknown',
      employerType: 'unknown',
      requiredClearanceLevel: 'none',
    });
  });

  it('the extractor output drives the fitEvaluator nonNegotiables gate', () => {
    const agencyFacts = extractPostingFacts(
      makePosting({ companyName: 'AcmeStaffing LLC', description: 'Hiring on behalf of our client' }),
    );
    const preferences: JobPreferences = {
      compensation: {
        currency: 'USD',
        minAcceptableBase: 150000,
        targetBase: 180000,
        countsBonusTowardMin: false,
        countsEquityTowardMin: false,
      },
      clearance: {
        currentStatus: 'none',
        currentLevel: null,
        eligibleToObtain: false,
        requiresSponsorshipForVisa: false,
      },
      nonNegotiables: [
        { id: 'noStaffingAgencies', category: 'employerType', rule: 'reject staffing' },
      ],
      preferredLocations: ['Remote'],
    };
    const requirements: PostingRequirements = {
      requiredSkills: [],
      requiredYearsOfExperience: null,
      requiredDomains: [],
    };
    const candidate: CandidateCapabilities = {
      skills: ['TypeScript'],
      yearsOfExperience: 6,
      domains: [],
    };
    const assessment = evaluateFit({
      posting: makePosting({ companyName: 'AcmeStaffing LLC', description: 'Hiring a temp to perm' }),
      requirements,
      candidate,
      preferences,
      postingFacts: agencyFacts,
    });
    expect(assessment.fitStatus).toBe('hardRejected');
    expect(assessment.rejectedNonNegotiableIds).toContain('noStaffingAgencies');
  });
});
