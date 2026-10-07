import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildOutreachMarkdown,
  draftOutreachMessage,
  loadOutreachContact,
  normalizeOutreachPlatform,
  outreachScaffoldTokens,
  OutreachContactNotFoundError,
  OutreachInvalidPlatformError,
  OutreachProfilePlaceholderError,
  type OutreachMessageResult,
} from './outreachMessageGenerator';
import {
  mapProfileToBinding,
  parseMasterProfile,
  summarizeTokenSet,
  unionProfilesTokens,
  type ResumeBinding,
} from './resumeGenerator';
import { hallucinatedProseTokens } from './coverLetterGenerator';

// Synthetic grounding profile (fixture-style, never a real person). Mirrors
// the profile used by the cover letter and resume Step-5 verification, so the
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

// Synthetic contact entry (SDD Requirement 6 shape). The contact is a real
// person distinct from the candidate, proving the greeting targets the contact,
// not the profile's own name.
const contactsJson = (overrides: Partial<Record<string, string>> = {}): string =>
  JSON.stringify({
    contacts: [
      {
        contactId: 'contact001',
        name: 'Sam Rivera',
        company: 'SampleCorp',
        relationship: 'formerColleague',
        lastContactDate: '2026-07-01',
        linkedApplicationIds: [],
        followUpDue: '2026-08-20',
        ...overrides,
      },
    ],
  });

interface Sandbox {
  root: string;
  profilePath: string;
  contactsPath: string;
  outputDirectory: string;
}

async function withSandbox<T>(fn: (sandbox: Sandbox) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'wejob-outreach-'));
  const previousRoot = process.env.WEJOBSEARCHDATAROOT;
  process.env.WEJOBSEARCHDATAROOT = root;
  const sandbox: Sandbox = {
    root,
    profilePath: join(root, 'masterProfile.md'),
    contactsPath: join(root, 'networkingContacts.json'),
    outputDirectory: join(root, 'applications'),
  };
  await writeFile(sandbox.profilePath, profileMarkdown, 'utf8');
  await writeFile(sandbox.contactsPath, contactsJson(), 'utf8');
  try {
    return await fn(sandbox);
  } finally {
    if (previousRoot === undefined) {
      delete process.env.WEJOBSEARCHDATAROOT;
    } else {
      process.env.WEJOBSEARCHDATAROOT = previousRoot;
    }
    await rm(root, { recursive: true, force: true });
  }
}

function bindingFor(): { binding: ResumeBinding; profileTokens: ReadonlySet<string> } {
  const profile = parseMasterProfile(profileMarkdown);
  const binding = mapProfileToBinding(profile);
  return { binding, profileTokens: unionProfilesTokens(binding) };
}

describe('normalizeOutreachPlatform', () => {
  it('defaults to linkedin when no platform is given', () => {
    expect(normalizeOutreachPlatform(undefined)).toBe('linkedin');
    expect(normalizeOutreachPlatform('')).toBe('linkedin');
  });

  it('accepts linkedin and email case-insensitively', () => {
    expect(normalizeOutreachPlatform('linkedin')).toBe('linkedin');
    expect(normalizeOutreachPlatform('EMAIL')).toBe('email');
  });

  it('rejects any other platform', () => {
    expect(() => normalizeOutreachPlatform('sms')).toThrow(OutreachInvalidPlatformError);
    expect(() => normalizeOutreachPlatform('sms')).toThrow(/Supported platforms: linkedin, email/);
  });
});

describe('loadOutreachContact', () => {
  it('finds a contact by contactId for name/company/relationship context', async () => {
    await withSandbox(async ({ contactsPath }) => {
      const contact = await loadOutreachContact('contact001', contactsPath);
      expect(contact.name).toBe('Sam Rivera');
      expect(contact.company).toBe('SampleCorp');
      expect(contact.relationship).toBe('formerColleague');
    });
  });

  it('errors clearly on an unknown contactId instead of drafting a generic message', async () => {
    await withSandbox(async ({ contactsPath }) => {
      await expect(loadOutreachContact('contact999', contactsPath)).rejects.toThrow(
        OutreachContactNotFoundError,
      );
      await expect(loadOutreachContact('contact999', contactsPath)).rejects.toThrow(/contactId 'contact999'/);
      await expect(loadOutreachContact('contact999', contactsPath)).rejects.toThrow(/Known contactIds: contact001/);
    });
  });

  it('resolves the default contacts path under the effective root, not an import-time path', async () => {
    await withSandbox(async () => {
      const contact = await loadOutreachContact('contact001');
      expect(contact.name).toBe('Sam Rivera');
      expect(contact.company).toBe('SampleCorp');
    });
  });

  it('threads an explicit rootDir into the default contacts path', async () => {
    await withSandbox(async ({ root }) => {
      const previousRoot = process.env.WEJOBSEARCHDATAROOT;
      delete process.env.WEJOBSEARCHDATAROOT;
      try {
        const contact = await loadOutreachContact('contact001', undefined, root);
        expect(contact.name).toBe('Sam Rivera');
        expect(contact.company).toBe('SampleCorp');
      } finally {
        if (previousRoot !== undefined) {
          process.env.WEJOBSEARCHDATAROOT = previousRoot;
        }
      }
    });
  });
});

describe('buildOutreachMarkdown platform variants', () => {
  it('linkedin draft is short, informal, and has no subject or email signature block', () => {
    const { binding } = bindingFor();
    const contact = {
      contactId: 'contact001',
      name: 'Sam Rivera',
      company: 'SampleCorp',
      relationship: 'formerColleague',
      lastContactDate: '2026-07-01',
      linkedApplicationIds: [],
      followUpDue: '2026-08-20',
    };
    const markdown = buildOutreachMarkdown(
      binding,
      contact,
      { companyName: 'AcmeCorp', roleTitle: 'SeniorMle', platform: 'linkedin' },
      'Site reliability engineer with Kubernetes and incident response experience.',
    );
    expect(markdown).toContain('Hi Sam,');
    expect(markdown).toContain("I'm currently pursuing the SeniorMle role at AcmeCorp.");
    expect(markdown).toContain("I'd appreciate the chance to connect and learn more about your work.");
    expect(markdown).toContain('Best,');
    expect(markdown).toContain('Jordan Reyes');
    expect(markdown).not.toContain('Subject:');
    expect(markdown).not.toContain('Best regards,');
    expect(markdown).not.toContain('|');
  });

  it('email variant has a subject line, more formal closing, and a signature block', () => {
    const { binding } = bindingFor();
    const markdown = buildOutreachMarkdown(
      binding,
      {
        contactId: 'contact001',
        name: 'Sam Rivera',
        company: 'SampleCorp',
        relationship: 'formerColleague',
        lastContactDate: '2026-07-01',
        linkedApplicationIds: [],
        followUpDue: '2026-08-20',
      },
      { companyName: 'AcmeCorp', roleTitle: 'SeniorMle', platform: 'email' },
      'SRE with Kubernetes and incident response background.',
    );
    expect(markdown).toContain('Subject: SeniorMle role at AcmeCorp');
    expect(markdown).toContain('Hi Sam,');
    expect(markdown).toContain("I'm currently pursuing the SeniorMle role at AcmeCorp.");
    expect(markdown).toContain('I would be happy to discuss the opportunity in more detail.');
    expect(markdown).toContain('Best regards,');
    expect(markdown).toContain('Denver, CO');
    expect(markdown).toContain('jordan.reyes@example.com');
    expect(markdown).toContain('|'); // signature block separator
  });

  it('the relationship from the contact file drives tone context', () => {
    const { binding } = bindingFor();
    const recruiter = buildOutreachMarkdown(
      binding,
      {
        contactId: 'contact002',
        name: 'Sam Rivera',
        company: 'SampleCorp',
        relationship: 'recruiter',
        lastContactDate: '2026-07-01',
        linkedApplicationIds: [],
        followUpDue: '',
      },
      { companyName: 'AcmeCorp', roleTitle: 'SeniorMle', platform: 'linkedin' },
      'SRE background.',
    );
    expect(recruiter).toContain('As a recruiter at SampleCorp,');
  });

  it('every prose token traces to profile, scaffold, contact, or target for both platforms', () => {
    const { binding, profileTokens } = bindingFor();
    const contact = {
      contactId: 'contact001',
      name: 'Sam Rivera',
      company: 'SampleCorp',
      relationship: 'formerColleague',
      lastContactDate: '2026-07-01',
      linkedApplicationIds: [],
      followUpDue: '2026-08-20',
    };
    const contactTokens = summarizeTokenSet(`${contact.name} ${contact.company}`);
    const targetTokens = summarizeTokenSet('AcmeCorp SeniorMle');
    const allowedTokens = new Set<string>([
      ...profileTokens,
      ...outreachScaffoldTokens,
      ...contactTokens,
      ...targetTokens,
    ]);
    for (const platform of ['linkedin', 'email'] as const) {
      const markdown = buildOutreachMarkdown(
        binding,
        contact,
        { companyName: 'AcmeCorp', roleTitle: 'SeniorMle', platform },
        'Site reliability engineer with deep experience in Kubernetes, distributed systems, and incident response.',
      );
      const hallucinated = hallucinatedProseTokens(markdown, allowedTokens);
      expect(hallucinated).toEqual([]);
    }
  });

  it('output is plain Markdown, not a Typst document', () => {
    const { binding } = bindingFor();
    const markdown = buildOutreachMarkdown(
      binding,
      {
        contactId: 'contact001',
        name: 'Sam Rivera',
        company: 'SampleCorp',
        relationship: 'formerColleague',
        lastContactDate: '2026-07-01',
        linkedApplicationIds: [],
        followUpDue: '2026-08-20',
      },
      { companyName: 'AcmeCorp', roleTitle: 'SeniorMle', platform: 'linkedin' },
      'SRE background.',
    );
    expect(markdown).not.toMatch(/^#let\s+profile/m);
  });
});

describe('draftOutreachMessage end to end', () => {
  it('writes outreachMessage.md for the contact, linkedin by default', async () => {
    await withSandbox(async ({ profilePath, contactsPath, outputDirectory }) => {
      const result: OutreachMessageResult = await draftOutreachMessage({
        contactId: 'contact001',
        companyName: 'AcmeCorp',
        roleTitle: 'SeniorMle',
      });
      expect(result.platform).toBe('linkedin');
      expect(result.contact.name).toBe('Sam Rivera');
      expect(result.markdownPath).toContain(join(outputDirectory, 'AcmeCorp-SeniorMle', 'outreachMessage.md'));
      const outp = await readFile(result.markdownPath, 'utf8');
      expect(outp).toContain('Hi Sam,');
      expect(outp).toContain('AcmeCorp');
      expect(outp).not.toContain('Subject:');
      const files = await readdir(join(outputDirectory, 'AcmeCorp-SeniorMle'));
      expect(files).toEqual(['outreachMessage.md']);
    });
  });

  it('writes a cold-email variant when --platform email is used', async () => {
    await withSandbox(async ({ profilePath, contactsPath, outputDirectory }) => {
      const result = await draftOutreachMessage({
        contactId: 'contact001',
        companyName: 'AcmeCorp',
        roleTitle: 'SeniorMle',
        platform: 'email',
      });
      expect(result.platform).toBe('email');
      const outp = await readFile(result.markdownPath, 'utf8');
      expect(outp).toContain('Subject: SeniorMle');
      expect(outp).toContain('Best regards,');
    });
  });

  it('never injects a posting-only claim (cassandra is not in masterProfile.md)', async () => {
    await withSandbox(async ({ profilePath, contactsPath, outputDirectory }) => {
      const result = await draftOutreachMessage({
        contactId: 'contact001',
        companyName: 'AcmeCorp',
        roleTitle: 'SeniorMle',
        postingRequirements: ['kubernetes', 'cassandra-cluster-administration'],
      });
      expect(result.claimableTokens).toContain('kubernetes');
      expect(result.excludedTokens.length).toBeGreaterThan(0);
      const outp = await readFile(result.markdownPath, 'utf8');
      expect(outp.toLowerCase()).toContain('kubernetes');
      expect(outp.toLowerCase()).not.toContain('cassandra');
    });
  });

  it('rejects an unknown contactId with a clear error before drafting anything', async () => {
    await withSandbox(async ({ profilePath, contactsPath, outputDirectory }) => {
      await expect(
        draftOutreachMessage({
          contactId: 'contact999',
          companyName: 'AcmeCorp',
          roleTitle: 'SeniorMle',
        }),
      ).rejects.toThrow(OutreachContactNotFoundError);
      await expect(
        draftOutreachMessage({
          contactId: 'contact999',
          companyName: 'AcmeCorp',
          roleTitle: 'SeniorMle',
        }),
      ).rejects.toThrow(/No networking contact with contactId 'contact999'/);
      // No generic draft and no output folder survive an unknown contact.
      await expect(readdir(join(outputDirectory, 'AcmeCorp-SeniorMle'))).rejects.toThrowError();
    });
  });

  it('rejects an uninitialized profile with the same placeholder guard as generate', async () => {
    await withSandbox(async ({ contactsPath, outputDirectory, profilePath }) => {
      await writeFile(profilePath, profileMarkdown.replace('Jordan Reyes', 'REPLACE_ME'), 'utf8');
      await expect(
        draftOutreachMessage({
          contactId: 'contact001',
          companyName: 'AcmeCorp',
          roleTitle: 'SeniorMle',
        }),
      ).rejects.toThrow(OutreachProfilePlaceholderError);
    });
  });

  it('resolves the contacts file and profile from the configured dataRoot', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wejob-outreach-configroot-'));
    const previousRoot = process.env.WEJOBSEARCHDATAROOT;
    try {
      const dataRoot = join(root, 'customData');
      await mkdir(dataRoot, { recursive: true });
      await writeFile(join(dataRoot, 'masterProfile.md'), profileMarkdown, 'utf8');
      await writeFile(join(dataRoot, 'networkingContacts.json'), contactsJson(), 'utf8');
      process.env.WEJOBSEARCHDATAROOT = dataRoot;

      const result = await draftOutreachMessage({
        contactId: 'contact001',
        companyName: 'AcmeCorp',
        roleTitle: 'SeniorMle',
        dataRoot,
      });
      expect(result.contact.name).toBe('Sam Rivera');
      expect(result.markdownPath).toContain(join(dataRoot, 'applications', 'AcmeCorp-SeniorMle', 'outreachMessage.md'));
    } finally {
      if (previousRoot === undefined) {
        delete process.env.WEJOBSEARCHDATAROOT;
      } else {
        process.env.WEJOBSEARCHDATAROOT = previousRoot;
      }
      await rm(root, { recursive: true, force: true });
    }
  });
});