import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createIsolatedDataRootFromFixtures } from '../testUtils/isolatedRoot';
import { extractPdfText } from '../utils/atsChecker';
import { shippedTemplatesRoot } from '../utils/canonicalDataRoot';
import {
  applicationFolderSegment,
  applyReductionBudget,
  assertProfilePopulated,
  generateResume,
  generateResumePreview,
  hallucinatedWording,
  mapProfileToBinding,
  parseMasterProfile,
  parseResumeVariants,
  partitionClaimableKeywords,
  reductionBudgets,
  ResumeAtsComplianceError,
  ResumeEeoViolationError,
  ResumeGenerationError,
  ResumeProfilePlaceholderError,
  selectVariant,
  serializeBinding,
  summarizeTokenSet,
  textContainsToken,
  unionProfilesTokens,
  type PostingMetadata,
  type ResumeBinding,
  type ResumeVariantsConfig,
} from './resumeGenerator';

const profileMarkdown = `
## Contact
- Name: Jane Doe
- Email: jane.doe@example.com
- Phone: +1 555 0100
- City / State: Austin, TX
- LinkedIn: https://linkedin.com/in/janedoe
- Portfolio: https://janedoe.dev

## Work Authorization
- US Citizen: yes
- Requires Visa Sponsorship: no

## Summary
This engineer focuses on TypeScript, Rust, and reliability.

## Skills
- Languages: TypeScript, Rust, SQL
- Tools: AWS, Kubernetes
- Go

## Experience
### Senior Engineer | ReactCorp | San Francisco, CA
- Start: 2021-03
- End: Present
- Led the migration to microservices.
- Reduced p99 latency.

## Education
### BSc Computer Science | University of Texas
- Start: 2016
- End: 2020

## Certifications
- AWS Certified Solutions Architect
`;

function parseProfile(): ReturnType<typeof parseMasterProfile> {
  return parseMasterProfile(profileMarkdown);
}

function bindingFor(): ResumeBinding {
  return mapProfileToBinding(parseProfile());
}

function allowedTokenSet(profile: ReturnType<typeof parseMasterProfile>): ReadonlySet<string> {
  return unionProfilesTokens(mapProfileToBinding(profile));
}

function seniorPosting(): PostingMetadata {
  return {
    companyName: 'AcmeCorp',
    roleTitle: 'SeniorEngineer',
    targetsFederal: false,
    domainTags: [],
    requiredKeywords: ['microservices'],
  };
}

function federalPosting(): PostingMetadata {
  return {
    companyName: 'GovSystems',
    roleTitle: 'SiteReliabilityEngineer',
    targetsFederal: true,
    domainTags: ['GSE'],
    requiredKeywords: [],
  };
}

function fakeVariantsConfig(): ResumeVariantsConfig {
  return parseResumeVariants(`
variants:
  usStandardResume:
    template: templates/usStandardResume.typ
    triggers: {}
  usDetailedResume:
    template: templates/usDetailedResume.typ
    triggers:
      targetsFederal: true
      domainTag: GSE
`);
}

describe('parseMasterProfile', () => {
  it('parses contact, summary, skills, experience, education, and certifications', () => {
    const profile = parseProfile();
    expect(profile.name).toBe('Jane Doe');
    expect(profile.cityState).toBe('Austin, TX');
    expect(profile.email).toBe('jane.doe@example.com');
    expect(profile.phone).toBe('+1 555 0100');
    expect(profile.linkedIn).toBe('https://linkedin.com/in/janedoe');
    expect(profile.portfolio).toBe('https://janedoe.dev');
    expect(profile.summary).toContain('reliability');
    expect(profile.skills).toContainEqual({ category: 'Languages', items: ['TypeScript', 'Rust', 'SQL'] });
    expect(profile.skills).toContainEqual({ category: '', items: ['Go'] });
    expect(profile.experience[0].roleTitle).toBe('Senior Engineer');
    expect(profile.experience[0].employer).toBe('ReactCorp');
    expect(profile.experience[0].location).toBe('San Francisco, CA');
    expect(profile.education[0].degree).toBe('BSc Computer Science');
    expect(profile.certifications).toContain('AWS Certified Solutions Architect');
  });

  it('separates Start/End from skill bullets in experience entries', () => {
    const profile = parseProfile();
    const entry = profile.experience[0];
    expect(entry.startDate).toBe('2021-03');
    expect(entry.endDate).toBe('Present');
    expect(entry.bullets).toEqual(['Led the migration to microservices.', 'Reduced p99 latency.']);
  });

  it('never reads the Work Authorization block into resume fields', () => {
    const binding = bindingFor();
    expect(binding.summary + binding.name).not.toMatch(/Citizen|Sponsorship/i);
    expect(Object.keys(binding).sort()).not.toContain('workAuthorization');
    expect(JSON.stringify(binding)).not.toMatch(/US Citizen|Requires Visa/);
  });
});

describe('zero-hallucination token scan', () => {
  it('accepts any skill/tool token that lives in masterProfile.md', () => {
    const allowed = allowedTokenSet(parseProfile());
    // Shipped templates render contact values only (never "Email:" labels),
    // so the synthetic text mirrors rendered values, not profile labels.
    const pdfText =
      'jane doe austin tx typescript rust sql aws kubernetes go migration microservices latency experience education skills';
    const hallucinated = hallucinatedWording(pdfText, allowed);
    expect(hallucinated).toEqual([]);
  });

  it('flags tokens that come from nowhere', () => {
    const allowed = allowedTokenSet(parseProfile());
    const pdfText = 'kubectl ransomware notInProfile';
    const hallucinated = hallucinatedWording(pdfText, allowed);
    expect(hallucinated).toContain('notinprofile');
    expect(hallucinated).toContain('kubectl');
  });

  it('ignores pdf-parse page-marker tokens like "of"', () => {
    const allowed = allowedTokenSet(parseProfile());
    expect(hallucinatedWording('jane doe austin tx typescript\n-- 1 of 1 --', allowed)).toEqual([]);
  });

  it('treats profile numbers as allowed but flags numbers from nowhere', () => {
    // Phase D: the old blanket numeric skip masked hallucinated figures.
    // Profile numbers (phone digits, years) are already in the allowed set
    // via unionProfilesTokens; an unknown pure number is a figure from
    // nowhere and must fail like any other hallucinated token.
    const allowed = allowedTokenSet(parseProfile());
    expect(hallucinatedWording('555 2021', allowed)).toEqual([]);
    expect(hallucinatedWording('555 2021 999999', allowed)).toContain('999999');
  });

  it('excludes raw-text-only work authorization tokens from the allowed set', () => {
    const allowed = allowedTokenSet(parseProfile());
    // Work-authorization prose lives in the raw profile text but never in the
    // EEO-whitelisted binding: a template leak of these words must fail.
    expect(allowed.has('citizen')).toBe(false);
    expect(allowed.has('sponsorship')).toBe(false);
    expect(allowed.has('visa')).toBe(false);
    // Genuine binding content stays allowed.
    expect(allowed.has('typescript')).toBe(true);
    expect(allowed.has('austin')).toBe(true);
  });
});

describe('textContainsToken (B14d whole-token excluded check)', () => {
  it('does not match excluded java inside javascript', () => {
    expect(textContainsToken('Built systems in JavaScript and TypeScript.', 'java')).toBe(false);
    expect(textContainsToken('Built systems in Java and TypeScript.', 'java')).toBe(true);
  });

  it('matches multi-word keywords across line breaks, case-insensitively', () => {
    expect(textContainsToken('Deep background in Machine\nLearning systems.', 'machine learning')).toBe(true);
    expect(textContainsToken('No relevant background.', 'machine learning')).toBe(false);
  });

  it('never matches empty keywords', () => {
    expect(textContainsToken('Anything at all.', '')).toBe(false);
    expect(textContainsToken('Anything at all.', '   ')).toBe(false);
  });

  it('matches non-word tokens like C# without matching substrings (U41 shared matcher)', () => {
    expect(textContainsToken('Built services in C# and .NET.', 'C#')).toBe(true);
    expect(textContainsToken('Built services in JavaScript.', 'Java')).toBe(false);
  });
});

describe('matcher consistency (Phase E single token matcher)', () => {
  it('claimable filter excludes java when the profile only has javascript', () => {
    const profileTokens = summarizeTokenSet('Built systems in JavaScript and TypeScript.');
    const { claimable, excluded } = partitionClaimableKeywords(profileTokens, ['java', 'javascript', 'typescript']);
    expect(claimable).toEqual(['javascript', 'typescript']);
    expect(excluded).toEqual(['java']);
  });

  it('claimable filter never matches empty keywords', () => {
    const profileTokens = summarizeTokenSet('Built systems in Java.');
    const { claimable, excluded } = partitionClaimableKeywords(profileTokens, ['', '   ', 'java']);
    expect(claimable).toEqual(['java']);
    expect(excluded).toEqual(['', '   ']);
  });

  it('density policy keeps the unrelated bullet when java is not genuinely present', () => {
    const base = bindingFor();
    const binding: ResumeBinding = {
      ...base,
      experience: [{ ...base.experience[0], bullets: ['Reduced p99 latency.', 'Built systems in JavaScript.'] }],
    };
    const reduced = applyReductionBudget(binding, reductionBudgets[4], ['java']);
    expect(reduced.experience[0].bullets).toEqual(['Reduced p99 latency.']);
  });

  it('density policy keeps the javascript bullet for a genuine javascript keyword', () => {
    const base = bindingFor();
    const binding: ResumeBinding = {
      ...base,
      experience: [{ ...base.experience[0], bullets: ['Reduced p99 latency.', 'Built systems in JavaScript.'] }],
    };
    const reduced = applyReductionBudget(binding, reductionBudgets[4], ['javascript']);
    expect(reduced.experience[0].bullets).toEqual(['Built systems in JavaScript.']);
  });
});

describe('mapProfileToBinding (EEO whitelist)', () => {
  it('copies exactly the ten resume fields', () => {
    const binding = bindingFor();
    expect(Object.keys(binding).sort()).toEqual([
      'certifications',
      'cityState',
      'education',
      'email',
      'experience',
      'linkedIn',
      'name',
      'phone',
      'portfolio',
      'skills',
      'summary',
    ]);
  });

  it('drops gender, age, photo, and street address even when the source carries them', () => {
    const dirty = `
## Contact
- Name: Jane Doe
- Email: jane@example.com
- Phone: 555
- City / State: Austin, TX
- Gender: Female
- Age: 33
- Photo: /tmp/me.png
- Street Address: 123 Main St

## Summary
x

## Skills
- Languages: TypeScript

## Experience
### Dev | Co | NY
- Start: 2020

## Education
### BSc | U
- Start: 2010
- End: 2014
`;
    const profile = parseMasterProfile(dirty);
    const binding = mapProfileToBinding(profile);
    expect(binding).not.toHaveProperty('gender');
    expect(binding).not.toHaveProperty('age');
    expect(binding).not.toHaveProperty('photo');
    expect(binding).not.toHaveProperty('streetAddress');
    expect(binding).not.toHaveProperty('maritalStatus');
    const typst = serializeBinding(binding);
    expect(/\b(gender|age|photo|street|marital)\b/i.test(typst)).toBe(false);
    expect(/\b(image|photo|headshot)\b/i.test(typst)).toBe(false);
  });
});

describe('serializeBinding', () => {
  it('emits a parseable Typst #let profile = (...) assignment', () => {
    const typst = serializeBinding(bindingFor());
    expect(typst).toContain('#let profile = (');
    expect(typst).toContain('name: "Jane Doe"');
    expect(typst).toContain('cityState: "Austin, TX"');
    expect(typst).toContain('bullets:');
    expect(typst).toContain('certifications: ("AWS Certified Solutions Architect",)');
    expect(typst).not.toContain('_');
  });
});

describe('applyReductionBudget', () => {
  it('keeps keyword-hitting bullets across reductions', () => {
    const binding = bindingFor();
    const reduced = applyReductionBudget(binding, reductionBudgets[0], ['microservices']);
    expect(reduced.summary).toBe('');
    expect(reduced.experience[0].bullets).toContain('Led the migration to microservices.');
    expect(reduced.experience[0].bullets).toContain('Reduced p99 latency.');
  });

  it('drops certifications when the budget says so', () => {
    const reduced = applyReductionBudget(bindingFor(), reductionBudgets[1], []);
    expect(reduced.certifications).toEqual([]);
  });

  it('clamps education to the budget cap', () => {
    const reduced = applyReductionBudget(bindingFor(), reductionBudgets[4], []);
    expect(reduced.education.length).toBeLessThanOrEqual(1);
  });
});

describe('variant selection via resumeVariants.yaml', () => {
  const config = fakeVariantsConfig();

  it('auto-selects the detailed variant for federal targeting', () => {
    const selected = selectVariant(config, federalPosting());
    expect(selected.name).toBe('usDetailedResume');
    expect(selected.selectionKind).toBe('auto');
    expect(selected.matchedTriggers).toEqual(['targetsFederal', 'domainTag']);
  });

  it('falls back to the trigger-less default variant', () => {
    const selected = selectVariant(config, seniorPosting());
    expect(selected.name).toBe('usStandardResume');
    expect(selected.selectionKind).toBe('defaultFallback');
  });

  it('honors an explicit variant and rejects unknown ones', () => {
    const selected = selectVariant(config, seniorPosting(), 'usDetailedResume');
    expect(selected.selectionKind).toBe('explicit');
    expect(() => selectVariant(config, seniorPosting(), 'nope')).toThrow(/Unknown --variant/);
  });
});

describe('assertProfilePopulated', () => {
  it('rejects a profile still carrying REPLACE_ME placeholders', () => {
    const placeholderMarkdown = profileMarkdown.replace('Jane Doe', 'REPLACE_ME');
    expect(() => assertProfilePopulated(parseMasterProfile(placeholderMarkdown))).toThrow(
      ResumeProfilePlaceholderError,
    );
  });

  it('rejects a profile with an empty required field', () => {
    const profile = parseProfile();
    profile.email = '';
    expect(() => assertProfilePopulated(profile)).toThrow(/email/i);
  });
});

describe('generateResumePreview', () => {
  const previewVariantsYaml = `variants:
  usStandardResume:
    template: templates/usStandardResume.typ
    triggers: {}
  usDetailedResume:
    template: templates/usDetailedResume.typ
    triggers:
      targetsFederal: true
      domainTag: GSE
`;

  async function previewSandbox<T>(fn: (paths: { profilePath: string; variantsPath: string; outputDirectory: string }) => Promise<T>): Promise<T> {
    const isolated = await createIsolatedDataRootFromFixtures();
    try {
      const profilePath = join(isolated.root, 'masterProfile.md');
      const variantsPath = join(isolated.root, 'resumeVariants.yaml');
      const outputDirectory = join(isolated.root, 'previews');
      await writeFile(profilePath, profileMarkdown, 'utf8');
      await writeFile(variantsPath, previewVariantsYaml, 'utf8');
      return await fn({ profilePath, variantsPath, outputDirectory });
    } finally {
      await isolated.restore();
    }
  }

  it('compiles the profile to one page and passes ATS reading order with an explicit variant', async () => {
    await previewSandbox(async ({ profilePath, variantsPath, outputDirectory }) => {
      const result = await generateResumePreview({
        explicitVariant: 'usDetailedResume',
      });
      expect(result.variantName).toBe('usDetailedResume');
      expect(result.pageCount).toBe(1);
      expect(result.atsCheck.passed).toBe(true);
      expect(result.hallucinatedTokens).toEqual([]);
      const pdfBytes = await readFile(result.pdfPath);
      expect(pdfBytes.length).toBeGreaterThan(0);
      const typContent = await readFile(result.typPath, 'utf8');
      expect(typContent).toContain('#let profile = (');
    });
  });

  it('defaults to the trigger-less variant when no explicit variant is given', async () => {
    await previewSandbox(async ({ profilePath, variantsPath, outputDirectory }) => {
      const result = await generateResumePreview({
      });
      expect(result.variantName).toBe('usStandardResume');
      expect(result.pageCount).toBe(1);
      expect(result.atsCheck.passed).toBe(true);
    });
  });

  it('prints the city and state once in the PDF text of both variants', async () => {
    await previewSandbox(async () => {
      for (const explicitVariant of ['usStandardResume', 'usDetailedResume'] as const) {
        const result = await generateResumePreview({ explicitVariant });
        expect(result.pageCount).toBe(1);
        const pdfText = await extractPdfText(await readFile(result.pdfPath));
        const occurrences = pdfText.split('Austin, TX').length - 1;
        expect(occurrences, `${explicitVariant} should print Austin, TX exactly once`).toBe(1);
      }
    });
  });
});

describe('template allowlist (H1b: shipped templates/ primary, <dataRoot>/templates/ secondary)', () => {
  it('resolves user templates from <dataRoot>/templates/ when shipped has no match', async () => {
    const isolated = await createIsolatedDataRootFromFixtures();
    try {
      const dataRoot = isolated.root;
      const userTemplates = join(dataRoot, 'templates');
      await mkdir(userTemplates, { recursive: true });
      // A uniquely named template that exists ONLY under the user templates
      // dir: the allowlist must fall through to the secondary root.
      const realTemplate = await readFile(join(shippedTemplatesRoot(), 'usStandardResume.typ'), 'utf8');
      await writeFile(join(userTemplates, 'customStandard.typ'), realTemplate, 'utf8');
      await writeFile(join(dataRoot, 'masterProfile.md'), profileMarkdown, 'utf8');
      await writeFile(
        join(dataRoot, 'resumeVariants.yaml'),
        'variants:\n  customStandard:\n    template: customStandard.typ\n    triggers: {}\n',
        'utf8',
      );

      const result = await generateResumePreview({
        dataRoot,
      });
      expect(result.variantName).toBe('customStandard');
      expect(result.templatePath).toBe(join(userTemplates, 'customStandard.typ'));
      expect(result.pageCount).toBe(1);
      expect(result.atsCheck.passed).toBe(true);
    } finally {
      await isolated.restore();
    }
  });

  it('prefers shipped templates/ for templates/-prefixed references', async () => {
    const isolated = await createIsolatedDataRootFromFixtures();
    try {
      const dataRoot = isolated.root;
      await writeFile(join(dataRoot, 'masterProfile.md'), profileMarkdown, 'utf8');
      await writeFile(
        join(dataRoot, 'resumeVariants.yaml'),
        'variants:\n  customStandard:\n    template: templates/usStandardResume.typ\n    triggers: {}\n',
        'utf8',
      );

      const result = await generateResumePreview({
        dataRoot,
      });
      expect(result.templatePath).toBe(join(shippedTemplatesRoot(), 'usStandardResume.typ'));
      expect(result.pageCount).toBe(1);
    } finally {
      await isolated.restore();
    }
  });
});

describe('user template EEO guard (B8 hostile template fails closed)', () => {
  async function rejectHostileUserTemplate(insert: string): Promise<void> {
    const isolated = await createIsolatedDataRootFromFixtures();
    try {
      const dataRoot = isolated.root;
      const userTemplates = join(dataRoot, 'templates');
      await mkdir(userTemplates, { recursive: true });
      const shippedTemplate = await readFile(join(shippedTemplatesRoot(), 'usStandardResume.typ'), 'utf8');
      const hostileTemplate = shippedTemplate.replace(
        '#let p = guardEeoClean(profile)',
        `#let p = guardEeoClean(profile)\n${insert}`,
      );
      await writeFile(join(userTemplates, 'hostileEeo.typ'), hostileTemplate, 'utf8');
      await writeFile(join(dataRoot, 'masterProfile.md'), profileMarkdown, 'utf8');
      await writeFile(
        join(dataRoot, 'resumeVariants.yaml'),
        'variants:\n  hostileEeo:\n    template: hostileEeo.typ\n    triggers: {}\n',
        'utf8',
      );

      await expect(
        generateResumePreview({
          dataRoot,
        }),
      ).rejects.toThrow(ResumeEeoViolationError);
      await expect(readFile(join(dataRoot, 'previews', 'previewResume.typ'), 'utf8')).rejects.toThrow(/ENOENT/);
    } finally {
      await isolated.restore();
    }
  }

  it('rejects hardcoded EEO prose before generating any output', async () => {
    await rejectHostileUserTemplate('#text[Gender: Female]');
  });

  it('rejects quoted EEO prose before generating any output', async () => {
    await rejectHostileUserTemplate('#text["Gender: Female"]');
  });

  it('rejects an external image before generating any output', async () => {
    await rejectHostileUserTemplate('#image("photo.png")');
  });

  it('rejects Typst data-loader directives before generating any output', async () => {
    await rejectHostileUserTemplate('#let salaries = csv("salaries.csv")');
  });

  it('rejects bare code-mode file-loading calls with no hash prefix', async () => {
    await rejectHostileUserTemplate('#{ import "evil.typ" }');
  });
});

describe('reduction loop cap and artifact cleanup (U23a)', () => {
  const generationVariantsYaml = `variants:
  usStandardResume:
    template: templates/usStandardResume.typ
    triggers: {}
`;

  async function generationSandbox<T>(
    profileText: string,
    fn: (dataRoot: string) => Promise<T>,
  ): Promise<T> {
    const isolated = await createIsolatedDataRootFromFixtures();
    try {
      await writeFile(join(isolated.root, 'masterProfile.md'), profileText, 'utf8');
      await writeFile(join(isolated.root, 'resumeVariants.yaml'), generationVariantsYaml, 'utf8');
      return await fn(isolated.root);
    } finally {
      await isolated.restore();
    }
  }

  const overflowingExperience = Array.from({ length: 10 }, (unusedElement, role) =>
    [
      `### Role${role} | Corp${role} | Remote`,
      '- Start: 2020',
      '- End: 2021',
      ...Array.from({ length: 8 }, (unusedBullet, bullet) => `- Shipped feature ${role}.${bullet} across distributed systems.`),
    ].join('\n'),
  ).join('\n\n');

  const quokkaProfile = profileMarkdown.replace(
    'This engineer focuses on TypeScript, Rust, and reliability.',
    'This engineer focuses on quokka husbandry alongside TypeScript and Rust.',
  );

  it('caps reduction attempts at the budget count instead of repeating the last budget', async () => {
      await generationSandbox(profileMarkdown, async (dataRoot) => {
        // A single unshrinkable bullet: budgets trim bullet counts, never
        // bullet length, so this document overflows every reduction pass.
        const giantBullet = `### Senior Engineer | ReactCorp | San Francisco, CA\n- Start: 2021-03\n- End: Present\n- ${'word '.repeat(800)}`;
        const giantProfile = profileMarkdown.replace(
          /### Senior Engineer \| ReactCorp \| San Francisco, CA\n- Start: 2021-03\n- End: Present\n- Led the migration to microservices\.\n- Reduced p99 latency\./,
          giantBullet,
        );
        await writeFile(join(dataRoot, 'masterProfile.md'), giantProfile, 'utf8');
        await expect(
          generateResume({
            companyName: 'AcmeCorp',
            roleTitle: 'SeniorEngineer',
            posting: { ...seniorPosting(), requiredKeywords: [] },
            explicitVariant: 'usStandardResume',
            maxReductionAttempts: 99,
            dataRoot,
          }),
        ).rejects.toThrow(`${reductionBudgets.length} reduction attempts exhausted`);
        // Phase D: an over-limit compile failure must not leave a multi-page
        // PDF on disk that looks like a finished resume.
        const outputFolder = join(
          dataRoot,
          'applications',
          applicationFolderSegment('AcmeCorp', 'SeniorEngineer'),
        );
        expect(existsSync(join(outputFolder, 'tailoredResume.pdf'))).toBe(false);
        expect(existsSync(join(outputFolder, 'tailoredResume.typ'))).toBe(false);
      });
    }, 180000);

  it('removes Typst and PDF artifacts when the ATS check fails', async () => {
      const overflowingProfile = quokkaProfile.replace(
        /### Senior Engineer \| ReactCorp \| San Francisco, CA\n- Start: 2021-03\n- End: Present\n- Led the migration to microservices\.\n- Reduced p99 latency\./,
        overflowingExperience,
      );
      await generationSandbox(overflowingProfile, async (dataRoot) => {
        const outputFolder = join(
          dataRoot,
          'applications',
          applicationFolderSegment('AcmeCorp', 'SeniorEngineer'),
        );
        const failure = await generateResume({
          companyName: 'AcmeCorp',
          roleTitle: 'SeniorEngineer',
          posting: { ...seniorPosting(), requiredKeywords: ['quokka'] },
          explicitVariant: 'usStandardResume',
          dataRoot,
        }).then(
          () => null,
          (error: unknown) => error,
        );
        expect(failure).toBeInstanceOf(ResumeAtsComplianceError);
        expect((failure as Error).message).toContain('quokka');
        expect(existsSync(join(outputFolder, 'tailoredResume.typ'))).toBe(false);
        expect(existsSync(join(outputFolder, 'tailoredResume.pdf'))).toBe(false);
      });
    }, 180000);
});

describe('variants-missing error redaction (U39)', () => {
  it('redacts the home directory prefix from the missing-variants error', async () => {
    const isolated = await createIsolatedDataRootFromFixtures();
    try {
      await writeFile(join(isolated.root, 'masterProfile.md'), profileMarkdown, 'utf8');
      const failure = await generateResume({
        companyName: 'AcmeCorp',
        roleTitle: 'SeniorEngineer',
        explicitVariant: 'usStandardResume',
        dataRoot: isolated.root,
      }).then(
        () => null,
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(ResumeGenerationError);
      const message = (failure as Error).message;
      expect(message).toContain('resumeVariants.yaml not found');
      expect(message).toContain('<dataRoot>');
      expect(message).not.toContain(os.homedir());
    } finally {
      await isolated.restore();
    }
  });
});

describe('applicationFolderSegment collisions and empties (Phase D)', () => {
  it('separates company and role parts so concatenations cannot collide', () => {
    expect(applicationFolderSegment('AcmeCorp', 'SeniorEngineer')).toBe('AcmeCorp-SeniorEngineer');
    expect(applicationFolderSegment('AB', 'CD')).not.toBe(applicationFolderSegment('ABC', 'D'));
    expect(applicationFolderSegment('Acme Corp!', 'Senior Engineer (ML)')).toBe('AcmeCorp-SeniorEngineerML');
  });

  it('throws loudly when a part sanitizes to empty instead of resolving to the output root', () => {
    expect(() => applicationFolderSegment('', 'SeniorEngineer')).toThrow(/empty after sanitizing/);
    expect(() => applicationFolderSegment('AcmeCorp', '')).toThrow(/empty after sanitizing/);
    expect(() => applicationFolderSegment('!!!', '???')).toThrow(/empty after sanitizing/);
  });
});
