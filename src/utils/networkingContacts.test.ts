import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  addNetworkingContact,
  buildNetworkingContact,
  defaultNetworkingContactsPath,
  generateContactId,
  readNetworkingContacts,
  writeNetworkingContacts,
  type NetworkingContact,
  type NetworkingContacts,
} from './networkingContacts';
import { canonicalContactsPath } from './canonicalDataRoot';

interface ContactSandbox {
  dir: string;
  path: string;
}

async function withSandbox<T>(fn: (sandbox: ContactSandbox) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'weJobSearch-contacts-'));
  const previousRoot = process.env.WEJOBSEARCHDATAROOT;
  process.env.WEJOBSEARCHDATAROOT = dir;
  const path = join(dir, 'networkingContacts.json');
  try {
    return await fn({ dir, path });
  } finally {
    if (previousRoot === undefined) {
      delete process.env.WEJOBSEARCHDATAROOT;
    } else {
      process.env.WEJOBSEARCHDATAROOT = previousRoot;
    }
    await rm(dir, { recursive: true, force: true });
  }
}

function exampleContact(overrides: Partial<NetworkingContact> = {}): NetworkingContact {
  return {
    contactId: 'contact001',
    name: 'Jane Sample',
    company: 'SampleCorp',
    relationship: 'formerColleague',
    lastContactDate: '2026-07-15',
    linkedApplicationIds: [],
    followUpDue: '2026-08-20',
    ...overrides,
  };
}

describe('networkingContacts: structural contract (SDD Requirement 6)', () => {
  it('writes a real file whose structure matches the committed example template', async () => {
    await withSandbox(async ({ path }) => {
      const example = await readFile(join(process.cwd(), 'profile', 'networkingContacts.example.json'), 'utf8');
      const exampleParse = JSON.parse(example) as { contacts: object[] };
      const contact = exampleContact();
      await writeNetworkingContacts({ contacts: [contact] }, path);
      const written = JSON.parse(await readFile(path, 'utf8'));
      const expectedKeys = Object.keys(exampleParse.contacts[0]).sort();
      const writtenDeepKeys = Object.keys(written.contacts[0]).sort();
      expect(written.contacts).toHaveLength(1);
      expect(writtenDeepKeys).toEqual(expectedKeys);
      expect(writtenDeepKeys).toEqual([
        'company',
        'contactId',
        'followUpDue',
        'lastContactDate',
        'linkedApplicationIds',
        'name',
        'relationship',
      ]);
    });
  });

  it('adds a second contact with generated contact002 and correct defaults', async () => {
    await withSandbox(async ({ path }) => {
      await writeNetworkingContacts({ contacts: [exampleContact()] }, path);
      const added = await addNetworkingContact(
        { name: 'Ali Patel', company: 'BetaLabs', relationship: 'recruiter' },
        path,
      );
      expect(added.contactId).toBe('contact002');
      expect(added.relationship).toBe('recruiter');
      expect(added.linkedApplicationIds).toEqual([]);
      expect(added.followUpDue).toBe('');
      const all = await readNetworkingContacts(path);
      expect(all.contacts.map((c) => c.contactId).sort()).toEqual(['contact001', 'contact002']);
    });
  });

  it('persists linkedApplicationIds and followUpDue when provided', async () => {
    await withSandbox(async ({ path }) => {
      const contact = await addNetworkingContact(
        { name: 'Dev Ross', company: 'GammaCo', linkedApplicationIds: ['app2026GammaCoLead'], followUpDue: '2026-09-01' },
        path,
      );
      expect(contact.linkedApplicationIds).toEqual(['app2026GammaCoLead']);
      expect(contact.followUpDue).toBe('2026-09-01');
    });
  });

  it('defaults relationship to unspecified when omitted', () => {
    const contact = buildNetworkingContact({ name: 'Ana Costa', company: 'SampleCorp' });
    expect(contact.relationship).toBe('unspecified');
  });

  it('rejects missing name and company at build time', () => {
    expect(() => buildNetworkingContact({ name: '', company: 'X' })).toThrow(/non-empty name/);
    expect(() => buildNetworkingContact({ name: 'X', company: '' })).toThrow(/non-empty company/);
  });

  it('generates contact001 as first id and continues past existing ids', () => {
    expect(generateContactId([])).toBe('contact001');
    expect(generateContactId([exampleContact(), exampleContact({ contactId: 'contact007' })])).toBe('contact008');
  });
});

describe('networkingContacts: validate-before-write (SDD Section 6.4)', () => {
  it('refuses to write over a malformed existing file', async () => {
    await withSandbox(async ({ path }) => {
      await writeFile(path, '{not-json', 'utf8');
      await expect(writeNetworkingContacts({ contacts: [exampleContact()] }, path)).rejects.toThrow(
        /Malformed networking contacts/,
      );
    });
  });

  it('refuses to write structurally invalid content', async () => {
    await withSandbox(async ({ path }) => {
      const invalid = {
        contacts: [{ ...exampleContact(), followUpDue: 42 }],
      } as unknown as NetworkingContacts;
      await expect(writeNetworkingContacts(invalid, path)).rejects.toThrow(
        /Refusing to write invalid networking contacts/,
      );
    });
  });

  it('does not corrupt the file when a write fails on schema mismatch', async () => {
    await withSandbox(async ({ path }) => {
      await writeNetworkingContacts({ contacts: [exampleContact()] }, path);
      const invalid = {
        contacts: [{ ...exampleContact(), followUpDue: 42 }],
      } as unknown as NetworkingContacts;
      await expect(writeNetworkingContacts(invalid, path)).rejects.toThrow();
      const after = await readNetworkingContacts(path);
      expect(after.contacts[0].contactId).toBe('contact001');
    });
  });
});

describe('networkingContacts: real-file location', () => {
  it('defaults to the canonical data root', () => {
    expect(defaultNetworkingContactsPath()).toBe(canonicalContactsPath());
  });
});

describe('networkingContacts Phase D: followUpDue validation and write guards', () => {
  it('rejects an unparseable followUpDue at intake instead of passing it through', () => {
    expect(() =>
      buildNetworkingContact({ name: 'Jane Sample', company: 'SampleCorp', followUpDue: 'not-a-date' }),
    ).toThrow(/not a parseable date/);
    expect(
      buildNetworkingContact({ name: 'Jane Sample', company: 'SampleCorp', followUpDue: '2026-08-20' })
        .followUpDue,
    ).toBe('2026-08-20');
    expect(
      buildNetworkingContact({ name: 'Jane Sample', company: 'SampleCorp' }).followUpDue,
    ).toBe('');
  });

  it('refuses to write inside the read-only documents directory', async () => {
    await withSandbox(async ({ dir }) => {
      await expect(
        writeNetworkingContacts({ contacts: [] }, join(dir, 'documents', 'networkingContacts.json')),
      ).rejects.toThrow(/read-only source directory/);
    });
  });

  it('routes malformed-file errors through the redacted path form', async () => {
    await withSandbox(async ({ path }) => {
      await writeFile(path, '{not json', 'utf8');
      const message = await readNetworkingContacts(path).then(
        () => 'no error',
        (error: Error) => error.message,
      );
      const { redactHomePrefix } = await import('./canonicalDataRoot');
      expect(message).toContain(redactHomePrefix(path));
    });
  });
});
