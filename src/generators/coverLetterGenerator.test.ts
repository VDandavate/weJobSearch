import { describe, expect, it } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createIsolatedDataRootFromFixtures } from '../testUtils/isolatedRoot';
import {
  buildCoverLetterMarkdown,
  coverLetterScaffoldTokens,
  CoverLetterProfilePlaceholderError,
  draftCoverLetter,
  hallucinatedProseTokens,
  type CoverLetterResult,
} from './coverLetterGenerator';
import {
  mapProfileToBinding,
  parseMasterProfile,
  summarizeTokenSet,
  unionProfilesTokens,
  type ResumeBinding,
} from './resumeGenerator';

// Synthetic grounding profile (fixture-style, never a real person). Mirrors
// profile/masterProfile.example.md structure. The values intentionally match
// the fixture profile used by Step 5b's pipeline verification, so the
// hallucination-risk assertions are meaningful: "cassandra" belongs to the
// posting only, never to this profile.
const profileMarkdown = `
## Contact
- Name: Jordan Reyes
- Email: jordan.reyes@example.com
- Phone: +1 555 0199
- City / State: Denver, CO
- LinkedIn: https://linkedin.com/in/jordanreyes
- Portfolio: https://jordanreyes.dev

## Work Authorization
- US Citizen: yes
- Requires Visa Sponsorship: no

## Summary
Site reliability engineer with deep experience in Kubernetes, distributed systems, and incident response.

## Skills
- Languages: TypeScript, Go, Rust
- Platforms: Kubernetes, AWS, GCP
- Practices: SRE, IaC, Terraform, CI/CD

## Experience
### Staff Site Reliability Engineer | TerraformCloud | Denver, CO
- Start: 2020-04
- End: Present
- Ran the migration of 40 microservices onto GKE across three regions.
- Built an on-call rotation and incident runbook library used by 80 engineers.

### Senior Platform Engineer | GraphiteSystems | Seattle, WA
- Start: 2016-08
- End: 2020-03
- Owned Terraform modules used across 25 production environments.

## Education
### MS Computer Science | Colorado School of Mines
- Start: 2014
- End: 2016

## Certifications
- Certified Kubernetes Administrator
`;

function bindingFor(): { binding: ResumeBinding; profileTokens: ReadonlySet<string> } {
  const profile = parseMasterProfile(profileMarkdown);
  const binding = mapProfileToBinding(profile);
  const profileTokens = unionProfilesTokens(binding);
  return { binding, profileTokens };
}

describe('buildCoverLetterMarkdown grounding', () => {
  it('references a posting requirement only where the profile genuinely supports it', () => {
    const { binding } = bindingFor();
    const markdown = buildCoverLetterMarkdown(
      binding,
      { companyName: 'AcmeCorp', roleTitle: 'SeniorEngineer' },
      ['kubernetes'],
    );
    expect(markdown).toContain('kubernetes');
    expect(markdown).toContain('SeniorEngineer role at AcmeCorp');
  });

  it('never renders a posting-only requirement token', () => {
    const { binding } = bindingFor();
    const markdown = buildCoverLetterMarkdown(
      binding,
      { companyName: 'AcmeCorp', roleTitle: 'SeniorEngineer' },
      [],
    );
    // "cassandra" exists only in a hosted posting, never in masterProfile.md.
    expect(markdown.toLowerCase()).not.toContain('cassandra');
    expect(markdown.toLowerCase()).not.toContain('terraform');
  });

  it('keeps the prose token traceability guarantee like the resume scanner', () => {
    const { binding, profileTokens } = bindingFor();
    const markdown = buildCoverLetterMarkdown(
      binding,
      { companyName: 'AcmeCorp', roleTitle: 'SeniorEngineer' },
      ['kubernetes'],
    );
    const allowedTokens = new Set<string>([
      ...profileTokens,
      ...coverLetterScaffoldTokens,
      ...summarizeTokenSet('AcmeCorp SeniorEngineer'),
    ]);
    const hallucinated = hallucinatedProseTokens(markdown, allowedTokens);
    // Date and number tokens are opaque to the prose scanner, and every letter
    // content token must trace to the profile or the letter scaffold.
    expect(hallucinated).toEqual([]);
  });

  it('output is plain Markdown, not a Typst document', () => {    const { binding } = bindingFor();
    const markdown = buildCoverLetterMarkdown(
      binding,
      { companyName: 'AcmeCorp', roleTitle: 'SeniorEngineer' },
      ['kubernetes'],
    );
    expect(markdown).not.toMatch(/^#let\s+profile/m);
    expect(markdown).not.toContain('BEGIN_PROFILE');
    expect(markdown).toMatch(/^#/m);
  });

  it('emits no evidence bullets when nothing overlaps the claimable tokens', () => {
    const { binding } = bindingFor();
    const markdown = buildCoverLetterMarkdown(
      binding,
      { companyName: 'AcmeCorp', roleTitle: 'SeniorEngineer' },
      ['cobol'],
    );
    expect(markdown).not.toContain('Ran the migration');
    expect(markdown).not.toContain('on-call rotation');
    expect(markdown).not.toContain('Terraform modules');
  });
});

describe('draftCoverLetter end to end', () => {
  it('writes coverLetter.md into applications/<company><role>/ and reports held-back requirements', async () => {
    const isolated = await createIsolatedDataRootFromFixtures();
    try {
      const tempRoot = isolated.root;
      const profilePath = join(tempRoot, 'masterProfile.md');
      await writeFile(profilePath, profileMarkdown, 'utf8');
      const outputDirectory = join(tempRoot, 'applications');

      const result: CoverLetterResult = await draftCoverLetter({
        companyName: 'AcmeCorp',
        roleTitle: 'SeniorMle',
        postingRequirements: ['kubernetes', 'cassandra-cluster-administration'],
        dataRoot: tempRoot,
      });

      expect(result.markdownPath).toContain(join(outputDirectory, 'AcmeCorp-SeniorMle', 'coverLetter.md'));
      expect(result.claimableTokens).toContain('kubernetes');
      // "cassandra-cluster-administration" is posting-only; it must be held back.
      expect(result.excludedTokens.length).toBeGreaterThan(0);
      const letter = await readFile(result.markdownPath, 'utf8');
      expect(letter).toContain('kubernetes');
      expect(letter.toLowerCase()).not.toContain('cassandra');
    } finally {
      await isolated.restore();
    }
  });

  it('rejects an uninitialized profile with the same placeholder guard as generate', async () => {
    const isolated = await createIsolatedDataRootFromFixtures();
    try {
      const tempRoot = isolated.root;
      const profilePath = join(tempRoot, 'masterProfile.md');
      await writeFile(
        profilePath,
        profileMarkdown.replace('Jordan Reyes', 'REPLACE_ME'),
        'utf8',
      );
      await expect(
        draftCoverLetter({
          companyName: 'AcmeCorp',
          roleTitle: 'SeniorEngineer',
          dataRoot: tempRoot,
        }),
      ).rejects.toThrow(CoverLetterProfilePlaceholderError);
    } finally {
      await isolated.restore();
    }
  });

  it('writes the letter under the configured outputRoot when outputDirectory is omitted', async () => {
    const isolated = await createIsolatedDataRootFromFixtures();
    try {
      const tempRoot = isolated.root;
      const profilePath = join(tempRoot, 'masterProfile.md');
      await writeFile(profilePath, profileMarkdown, 'utf8');
      const outputRoot = join(tempRoot, 'customApplications');

      const result = await draftCoverLetter({
        companyName: 'AcmeCorp',
        roleTitle: 'SeniorMle',
        dataRoot: tempRoot,
        directories: { outputRoot, resumeVariantsFile: null },
      });

      expect(result.markdownPath).toBe(join(outputRoot, 'AcmeCorp-SeniorMle', 'coverLetter.md'));
      const letter = await readFile(result.markdownPath, 'utf8');
      expect(letter).toContain('SeniorMle role at AcmeCorp');
    } finally {
      await isolated.restore();
    }
  });
});
