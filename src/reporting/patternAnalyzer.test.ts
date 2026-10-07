import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ApplicationHistory, ApplicationRecord } from '../utils/jobFunnelTracker';
import { analyzeApplicationPatterns, type PatternSuggestion } from './patternAnalyzer';

// EUO-07 RED: application pattern analysis. Fixture history carries 2
// interviewed/offer roles (both frontend: TypeScript + React) and 3 rejected
// roles (data/backend/devops), all with postingFacts.locationType remote, and
// role titles that cluster on the "frontend engineer" stem.

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
    statusHistory: [{ stage: 'evaluated', timestamp: '2026-08-08T10:00:00Z' }],
    ...overrides,
  };
}

function interviewedFrontendHistory(): ApplicationHistory {
  return {
    applications: [
      stubApplication({
        applicationId: 'app2026AcmeFrontendEngineer',
        companyName: 'AcmeCorp',
        roleTitle: 'Senior Frontend Engineer',
        jobUrl: 'https://example.com/job2',
        postingHash: 'hash2',
        status: 'interviewing',
        postingDescription: 'TypeScript and React role building customer-facing web applications.',
        postingFacts: { locationType: 'remote' },
      }),
      stubApplication({
        applicationId: 'app2026GlobexFrontendEngineer',
        companyName: 'GlobexCorp',
        roleTitle: 'Frontend Engineer',
        jobUrl: 'https://example.com/job3',
        postingHash: 'hash3',
        status: 'offer',
        postingDescription: 'React and TypeScript frontend role on the design system team.',
        postingFacts: { locationType: 'remote' },
      }),
      stubApplication({
        applicationId: 'app2026InitechDataEngineer',
        companyName: 'Initech',
        roleTitle: 'Data Engineer',
        jobUrl: 'https://example.com/job4',
        postingHash: 'hash4',
        status: 'rejected',
        postingDescription: 'Python and Spark data pipeline role.',
        postingFacts: { locationType: 'remote' },
      }),
      stubApplication({
        applicationId: 'app2026UmbrellaBackendEngineer',
        companyName: 'UmbrellaCorp',
        roleTitle: 'Backend Engineer',
        jobUrl: 'https://example.com/job5',
        postingHash: 'hash5',
        status: 'rejected',
        postingDescription: 'Java and Spring backend services role.',
        postingFacts: { locationType: 'remote' },
      }),
      stubApplication({
        applicationId: 'app2026HooliDevOpsEngineer',
        companyName: 'Hooli',
        roleTitle: 'DevOps Engineer',
        jobUrl: 'https://example.com/job6',
        postingHash: 'hash6',
        status: 'rejected',
        postingDescription: 'AWS and Kubernetes infrastructure role.',
        postingFacts: { locationType: 'remote' },
      }),
    ],
  };
}

function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

// EUO-17 fixture: applied roles and locations that drift from stated
// preferences (targetRoles: Senior Engineer / Staff Engineer, preferredLocations:
// Remote). Both records carry applied statuses and an onsite locationType.
function driftHistory(): ApplicationHistory {
  return {
    applications: [
      stubApplication({
        applicationId: 'app2026AcmeDataEngineer',
        companyName: 'AcmeCorp',
        roleTitle: 'Data Engineer',
        jobUrl: 'https://example.com/job7',
        postingHash: 'hash7',
        status: 'appliedConfirmed',
        postingFacts: { locationType: 'onsite' },
      }),
      stubApplication({
        applicationId: 'app2026GlobexDevOpsEngineer',
        companyName: 'GlobexCorp',
        roleTitle: 'DevOps Engineer',
        jobUrl: 'https://example.com/job8',
        postingHash: 'hash8',
        status: 'rejected',
        postingFacts: { locationType: 'onsite' },
      }),
    ],
  };
}

const driftPreferences = {
  targetRoles: ['Senior Engineer', 'Staff Engineer'],
  preferredLocations: ['Remote'],
};

// EUO-16 fixture: two variants with opposing outcomes - usStandardResume reached
// interviewing/offer twice, usDetailedResume was rejected twice.
function variantOutcomeHistory(): ApplicationHistory {
  return {
    applications: [
      stubApplication({
        applicationId: 'app2026AcmeFrontendEngineer',
        companyName: 'AcmeCorp',
        roleTitle: 'Senior Frontend Engineer',
        jobUrl: 'https://example.com/job2',
        postingHash: 'hash2',
        status: 'interviewing',
        resumeVariant: 'usStandardResume',
      }),
      stubApplication({
        applicationId: 'app2026GlobexFrontendEngineer',
        companyName: 'GlobexCorp',
        roleTitle: 'Frontend Engineer',
        jobUrl: 'https://example.com/job3',
        postingHash: 'hash3',
        status: 'offer',
        resumeVariant: 'usStandardResume',
      }),
      stubApplication({
        applicationId: 'app2026InitechDataEngineer',
        companyName: 'Initech',
        roleTitle: 'Data Engineer',
        jobUrl: 'https://example.com/job4',
        postingHash: 'hash4',
        status: 'rejected',
        resumeVariant: 'usDetailedResume',
      }),
      stubApplication({
        applicationId: 'app2026UmbrellaBackendEngineer',
        companyName: 'UmbrellaCorp',
        roleTitle: 'Backend Engineer',
        jobUrl: 'https://example.com/job5',
        postingHash: 'hash5',
        status: 'rejected',
        resumeVariant: 'usDetailedResume',
      }),
    ],
  };
}

describe('analyzeApplicationPatterns', () => {
  it('reports skill/domain frequency in interviewed vs rejected roles', () => {
    const suggestions = analyzeApplicationPatterns(interviewedFrontendHistory());
    const skillDomain = suggestions.find((suggestion) => suggestion.kind === 'skillDomain');
    expect(skillDomain).toBeDefined();
    expect(skillDomain?.message).toContain('frontend');
    expect(skillDomain?.evidence).toEqual(['Frontend Engineer', 'Senior Frontend Engineer']);
  });

  it('suggests a location pattern when applied roles share one work mode', () => {
    const suggestions = analyzeApplicationPatterns(interviewedFrontendHistory());
    const location = suggestions.find((suggestion) => suggestion.kind === 'location');
    expect(location).toBeDefined();
    expect(location?.message).toContain('remote');
    expect(location?.evidence).toHaveLength(5);
  });

  it('suggests adding clustered role titles to targetRoles', () => {
    const suggestions = analyzeApplicationPatterns(interviewedFrontendHistory());
    const roleTitle = suggestions.find((suggestion) => suggestion.kind === 'roleTitle');
    expect(roleTitle).toBeDefined();
    expect(roleTitle?.message).toContain('frontend engineer');
    expect(roleTitle?.evidence).toEqual(['Frontend Engineer', 'Senior Frontend Engineer']);
  });

  it('emits no variant suggestion when records carry no variant tag', () => {
    const suggestions = analyzeApplicationPatterns(interviewedFrontendHistory());
    expect(suggestions.some((suggestion) => suggestion.kind === 'variant')).toBe(false);
  });

  it('correlates outcomes with the resume variant used (EUO-16)', () => {
    const suggestions = analyzeApplicationPatterns(variantOutcomeHistory());
    const variantSuggestions = suggestions.filter((suggestion) => suggestion.kind === 'variant');
    expect(variantSuggestions).toHaveLength(2);

    const standard = variantSuggestions.find((suggestion) => suggestion.message.includes('usStandardResume'));
    expect(standard).toBeDefined();
    expect(standard?.message).toContain('2 interviewing/offer');
    expect(standard?.message).toContain('0 rejected');
    expect(standard?.message).toContain('default');

    const detailed = variantSuggestions.find((suggestion) => suggestion.message.includes('usDetailedResume'));
    expect(detailed).toBeDefined();
    expect(detailed?.message).toContain('0 interviewing/offer');
    expect(detailed?.message).toContain('2 rejected');
    expect(detailed?.message).toContain('reviewing its fit');
  });

  it('returns an empty result for empty history without error', () => {
    expect(analyzeApplicationPatterns({ applications: [] })).toEqual([]);
  });

  it('flags applied roles outside targetRoles as role-title drift (EUO-17)', () => {
    const suggestions = analyzeApplicationPatterns(driftHistory(), driftPreferences);
    const drift = suggestions.find((suggestion) => suggestion.kind === 'roleTitleDrift');
    expect(drift).toBeDefined();
    expect(drift?.message).toContain('targetRoles');
    expect(drift?.evidence).toEqual(['Data Engineer', 'DevOps Engineer']);
  });

  it('does not flag applied roles inside targetRoles as drift (EUO-17)', () => {
    const history: ApplicationHistory = {
      applications: [
        stubApplication({
          roleTitle: 'Senior Engineer',
          status: 'appliedConfirmed',
          postingFacts: { locationType: 'remote' },
        }),
        stubApplication({
          roleTitle: 'Staff Engineer',
          status: 'rejected',
          postingFacts: { locationType: 'remote' },
        }),
      ],
    };
    const suggestions = analyzeApplicationPatterns(history, driftPreferences);
    expect(suggestions.some((suggestion) => suggestion.kind === 'roleTitleDrift')).toBe(false);
  });

  it('does not flag a role containing a target role as drift (EUO-17)', () => {
    const history: ApplicationHistory = {
      applications: [
        stubApplication({
          roleTitle: 'Senior Engineer',
          status: 'appliedConfirmed',
          postingFacts: { locationType: 'remote' },
        }),
      ],
    };
    const suggestions = analyzeApplicationPatterns(history, {
      targetRoles: ['Engineer'],
      preferredLocations: [],
    });
    expect(suggestions.some((suggestion) => suggestion.kind === 'roleTitleDrift')).toBe(false);
  });

  it('flags applied locations outside preferredLocations as location drift (EUO-17)', () => {
    const suggestions = analyzeApplicationPatterns(driftHistory(), driftPreferences);
    const drift = suggestions.find((suggestion) => suggestion.kind === 'locationDrift');
    expect(drift).toBeDefined();
    expect(drift?.message).toContain('preferredLocations');
    expect(drift?.evidence).toEqual(['Data Engineer', 'DevOps Engineer']);
  });

  it('emits no drift suggestions without preferences or with empty preferences (EUO-17)', () => {
    const withoutPreferences = analyzeApplicationPatterns(driftHistory());
    expect(
      withoutPreferences.some(
        (suggestion) => suggestion.kind === 'roleTitleDrift' || suggestion.kind === 'locationDrift',
      ),
    ).toBe(false);

    const withEmptyPreferences = analyzeApplicationPatterns(driftHistory(), {
      targetRoles: [],
      preferredLocations: [],
    });
    expect(
      withEmptyPreferences.some(
        (suggestion) => suggestion.kind === 'roleTitleDrift' || suggestion.kind === 'locationDrift',
      ),
    ).toBe(false);
  });

  it('is deterministic and never writes the history file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'weJobSearch-patternAnalyzer-'));
    try {
      const historyPath = join(dir, 'applicationHistory.json');
      const history = interviewedFrontendHistory();
      await writeFile(historyPath, JSON.stringify(history, null, 2), 'utf8');
      const before = sha256(await readFile(historyPath));

      const first = analyzeApplicationPatterns(history);
      const second = analyzeApplicationPatterns(history);
      expect(first).toEqual(second);

      const after = sha256(await readFile(historyPath));
      expect(after).toBe(before);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});