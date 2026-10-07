import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { evaluateFit, loadJobPreferences } from './evaluators/fitEvaluator';
import { extractPostingFacts } from './evaluators/postingFactsExtractor';
import { extractPostingRequirements } from './evaluators/postingRequirementsExtractor';
import { candidateCapabilitiesFromProfile } from './evaluators/profileCapabilitiesExtractor';
import { generateBrief } from './generators/briefGenerator';
import { parseMasterProfile } from './generators/resumeGenerator';
import { formatExcludedResults } from './reporting/excludedResultsFormatter';
import { formatScrapeResults, type EvaluatedPosting } from './reporting/scrapeResultsFormatter';
import type { RawPosting } from './scrapers/jobSpyAdapter';

// Step 11 fixture end-to-end test (SDD Sections 6.2 and 6.3, AGENTS.md
// Step 11): drive the real pipeline against the committed fixtures/ directory
// only, never against profile/. sampleProfile.md -> candidate capabilities,
// the sample posting -> posting requirements + posting facts, the sample
// preferences drive fitEvaluator, and both fixed result-table formatters
// render the outcome (SDD Requirement 2a). All names are synthetic.
//
// Ownership (Phase 7c): @standalone end-to-end verification. No source module
// exists by design (there is deliberately no src/fixturesPipeline.ts): this
// file wires the real evaluator, extractor, and formatter modules directly
// against fixtures/. If a fixturesPipeline source module is ever created,
// replace this note with the consumer name instead of leaving both.

const fixturesRoot = resolve(__dirname, '..', 'fixtures');

async function loadSamplePosting(): Promise<RawPosting> {
  const postingText = await readFile(resolve(fixturesRoot, 'sampleJobPosting.txt'), 'utf8');
  return {
    sourceAggregator: 'fixtures',
    companyName: 'AcmeCorp',
    roleTitle: 'Senior Platform Engineer',
    location: 'Remote',
    jobUrl: 'https://acme.example.com/jobs/senior-platform-engineer',
    description: postingText,
    hasFullDescription: true,
    postedAt: null,
    rawSalaryText: 'USD 165,000 - 195,000/yr',
  };
}

async function loadSampleProfile() {
  const profileMarkdown = await readFile(resolve(fixturesRoot, 'sampleProfile.md'), 'utf8');
  const profile = parseMasterProfile(profileMarkdown);
  return {
    profile,
    candidate: candidateCapabilitiesFromProfile(profile),
    preferences: await loadPreferencesFixture(),
  };
}

async function loadPreferencesFixture() {
  return loadJobPreferences(resolve(fixturesRoot, 'sampleJobPreferences.yaml'));
}

async function evaluateSamplePosting(): Promise<EvaluatedPosting> {
  const posting = await loadSamplePosting();
  const { candidate, preferences } = await loadSampleProfile();
  const requirements = extractPostingRequirements(posting);
  const assessment = evaluateFit({
    posting,
    requirements,
    candidate,
    preferences,
    postingFacts: extractPostingFacts(posting),
  });
  return { posting, brief: generateBrief(posting.description), assessment };
}

describe('fixture-backed pipeline: sampleProfile + sampleJobPosting + sampleJobPreferences', () => {
  it('derives the expected candidate capabilities from the sample profile', async () => {
    const { candidate } = await loadSampleProfile();
    expect(candidate.skills).toEqual(
      expect.arrayContaining(['TypeScript', 'Rust', 'Python', 'Kubernetes', 'AWS', 'Terraform', 'Go', 'React', 'Node.js']),
    );
    expect(candidate.yearsOfExperience).toBeGreaterThanOrEqual(8);
    expect(candidate.domains).toEqual(expect.arrayContaining(['FinTech']));
  });

  it('extracts posting requirements and posting facts from the sample posting', async () => {
    const posting = await loadSamplePosting();
    const requirements = extractPostingRequirements(posting);
    const facts = extractPostingFacts(posting);
    expect(requirements.requiredSkills).toEqual(expect.arrayContaining(['TypeScript', 'Kubernetes', 'AWS']));
    expect(requirements.requiredYearsOfExperience).toBeGreaterThanOrEqual(6);
    expect(requirements.requiredDomains).toEqual(expect.arrayContaining(['FinTech']));
    expect(facts.locationType).toBe('remote');
    expect(facts.employerType).toBe('unknown');
  });

  it('evaluates the sample posting to a strongFit against the sample preferences', async () => {
    const evaluated = await evaluateSamplePosting();
    expect(evaluated.assessment.fitStatus).toBe('strongFit');
    expect(evaluated.assessment.fitScore).toBe(5);
    expect(evaluated.assessment.rejectedNonNegotiableIds).toEqual([]);
    expect(evaluated.assessment.deductions).toHaveLength(0);
  });

  it('produces a grounded brief from the sample posting without hallucination', async () => {
    const evaluated = await evaluateSamplePosting();
    expect(evaluated.brief.length).toBeGreaterThan(0);
    expect(evaluated.brief.length).toBeLessThanOrEqual(153);
    expect(evaluated.posting.description).toContain(evaluated.brief.slice(0, 20));
  });

  it('renders both fixed result tables with no ad hoc deviation (SDD Requirement 2a)', async () => {
    const evaluatedSample = await evaluateSamplePosting();
    const excludedEntry: EvaluatedPosting = {
      posting: {
        sourceAggregator: 'fixtures',
        companyName: 'SampleStaffing',
        roleTitle: 'Onsite SRE',
        location: 'New York, NY',
        jobUrl: 'https://staffing.example.com/jobs/onsite-sre',
        description: 'Onsite staffing-agency role.',
        hasFullDescription: true,
        postedAt: null,
      },
      brief: 'Onsite staffing-agency role.',
      assessment: {
        fitScore: 0,
        fitStatus: 'hardRejected',
        deductions: [],
        nonNegotiableChecks: [],
        rejectedNonNegotiableIds: ['noRelocation'],
        notes: [],
        baseScore: 5,
        hasFullDescription: true,
      },
    };

    const batch: EvaluatedPosting[] = [evaluatedSample, excludedEntry];
    const active = formatScrapeResults(batch);
    const excluded = formatExcludedResults(batch);

    // Fixed 7/6-column cores with no trailing extras (SDD Requirement 2a).
    expect([...active.columns]).toEqual([
      'Sr. No.',
      'Job Title',
      'Organization',
      'Brief',
      'Fit Score',
      'Justification',
      'Link',
    ]);
    expect([...excluded.columns]).toEqual([
      'Sr. No.',
      'Job Title',
      'Organization',
      'Fit Score',
      'Justification',
      'Link',
    ]);

    // The strongFit sample posting appears only in the active table.
    expect(active.rows.map((row) => row.jobTitle)).toEqual(['Senior Platform Engineer']);
    expect(excluded.rows.map((row) => row.jobTitle)).toEqual(['Onsite SRE']);
    expect(active.rows[0].organization).toBe('AcmeCorp');
  });
});