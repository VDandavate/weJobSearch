import { createHash } from 'node:crypto';
import { copyFile, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  importConnections,
  parseConnectionsCsv,
  type ImportConnectionsResult,
} from './linkedInImport';
import {
  buildNetworkingContact,
  readNetworkingContacts,
  writeNetworkingContacts,
  type NetworkingContact,
} from './networkingContacts';

// ---------------------------------------------------------------------------
// Helpers (EUO-14, N10): the only data used is the committed synthetic fixture
// and OS temp dirs. The fixture CSV is copied into each sandbox so the
// fixtures/ directory itself is never written to.
// ---------------------------------------------------------------------------

const sampleCsvPath = resolve(__dirname, '..', '..', 'fixtures', 'sampleConnections.csv');

function sha256Of(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

interface ImportSandbox {
  dir: string;
  csvPath: string;
  contactsPath: string;
}

async function withSandbox<T>(fn: (sandbox: ImportSandbox) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'weJobSearch-import-'));
  const previousRoot = process.env.WEJOBSEARCHDATAROOT;
  process.env.WEJOBSEARCHDATAROOT = dir;
  const csvPath = join(dir, 'connections.csv');
  await copyFile(sampleCsvPath, csvPath);
  try {
    return await fn({ dir, csvPath, contactsPath: join(dir, 'networkingContacts.json') });
  } finally {
    if (previousRoot === undefined) {
      delete process.env.WEJOBSEARCHDATAROOT;
    } else {
      process.env.WEJOBSEARCHDATAROOT = previousRoot;
    }
    await rm(dir, { recursive: true, force: true });
  }
}

async function readCsvHash(csvPath: string): Promise<string> {
  return sha256Of(await readFile(csvPath, 'utf8'));
}

function sampleContact(overrides: Partial<NetworkingContact> = {}): NetworkingContact {
  return {
    contactId: 'contact001',
    name: 'Jane Sample',
    company: 'SampleCorp',
    relationship: 'formerColleague',
    lastContactDate: '2026-07-15',
    linkedApplicationIds: [],
    followUpDue: '',
    ...overrides,
  };
}

const referenceDate = new Date('2026-08-19T12:00:00Z');

// ---------------------------------------------------------------------------
// parseConnectionsCsv — pure, deterministic CSV parse of the LinkedIn
// connections-export shape
// ---------------------------------------------------------------------------

describe('parseConnectionsCsv: LinkedIn connections-export shape', () => {
  it('parses the committed fixture into name/company/relationship entries', async () => {
    const fixtureText = await readFile(sampleCsvPath, 'utf8');
    const connections = parseConnectionsCsv(fixtureText);
    expect(connections).toHaveLength(3);
    expect(connections.map((c) => c.name)).toEqual(['Jane Sample', 'John Doe', 'Ali Patel']);
    expect(connections.map((c) => c.company)).toEqual(['SampleCorp', 'Acme, Inc.', 'BetaLabs']);
    expect(connections.every((c) => c.relationship === 'linkedInConnection')).toBe(true);
  });

  it('handles quoted fields containing commas as a single field', () => {
    const csv = 'First Name,Last Name,URL,Email Address,Company,Position,Connected On\n' +
      'John,Doe,http://linkedin.com/in/johndoe,john.doe@example.com,"Acme, Inc.",Staff Engineer,01 Aug 2026\n';
    const connections = parseConnectionsCsv(csv);
    expect(connections).toHaveLength(1);
    expect(connections[0].name).toBe('John Doe');
    expect(connections[0].company).toBe('Acme, Inc.');
  });

  it('ignores the header row and tolerates a UTF-8 BOM', () => {
    const csv = '\uFEFFFirst Name,Last Name,Company\nJane,Sample,SampleCorp\n';
    const connections = parseConnectionsCsv(csv);
    expect(connections).toHaveLength(1);
    expect(connections[0].name).toBe('Jane Sample');
    expect(connections[0].company).toBe('SampleCorp');
  });

  it('returns an empty list for empty and header-only input', () => {
    expect(parseConnectionsCsv('')).toEqual([]);
    expect(parseConnectionsCsv('First Name,Last Name,Company\n')).toEqual([]);
  });

  it('skips rows that lack a name or a company', () => {
    const csv = 'First Name,Last Name,Company\n' +
      'Jane,Sample,SampleCorp\n' +
      ',,Acme\n' +
      'John,Doe,\n';
    const connections = parseConnectionsCsv(csv);
    expect(connections).toHaveLength(1);
    expect(connections[0].name).toBe('Jane Sample');
  });
});

// ---------------------------------------------------------------------------
// importConnections — confirmation-gated write (N9)
// ---------------------------------------------------------------------------

describe('importConnections: confirmation gate (N9)', () => {
  it('without confirmation, proposes additions and writes nothing', async () => {
    await withSandbox(async ({ csvPath, contactsPath }) => {
      const before = await readCsvHash(csvPath);
      const result = await importConnections(csvPath, { confirmed: false, contactsPath });

      expect(result.written).toBe(false);
      expect(result.proposedAdditions).toHaveLength(3);
      expect(result.proposedAdditions.map((c) => c.name)).toEqual([
        'Jane Sample',
        'John Doe',
        'Ali Patel',
      ]);
      // No contacts file may appear.
      await expect(readFile(contactsPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readCsvHash(csvPath)).toBe(before);
    });
  });

  it('without confirmation, leaves an existing contacts file byte-identical', async () => {
    await withSandbox(async ({ csvPath, contactsPath }) => {
      await writeNetworkingContacts({ contacts: [sampleContact()] }, contactsPath);
      const before = sha256Of(await readFile(contactsPath, 'utf8'));

      const result = await importConnections(csvPath, { confirmed: false, contactsPath });

      expect(result.written).toBe(false);
      expect(result.proposedAdditions).toHaveLength(2); // Jane Sample already present
      expect(sha256Of(await readFile(contactsPath, 'utf8'))).toBe(before);
      const current = await readNetworkingContacts(contactsPath);
      expect(current.contacts).toHaveLength(1);
    });
  });

  it('with confirmation, writes the merged contacts file', async () => {
    await withSandbox(async ({ csvPath, contactsPath }) => {
      const result = await importConnections(csvPath, {
        confirmed: true,
        contactsPath,
        referenceDate,
      });

      expect(result.written).toBe(true);
      expect(result.proposedAdditions).toHaveLength(3);
      const all = await readNetworkingContacts(contactsPath);
      expect(all.contacts).toHaveLength(3);
      expect(all.contacts.map((c) => c.contactId).sort()).toEqual([
        'contact001',
        'contact002',
        'contact003',
      ]);
      expect(all.contacts[0].relationship).toBe('linkedInConnection');
      expect(all.contacts[0].lastContactDate).toBe('2026-08-19');
    });
  });
});

// ---------------------------------------------------------------------------
// importConnections — dedup against existing contacts
// ---------------------------------------------------------------------------

describe('importConnections: dedup against existing contacts', () => {
  it('skips an existing name+company and assigns sequential ids past existing contacts', async () => {
    await withSandbox(async ({ csvPath, contactsPath }) => {
      await writeNetworkingContacts({ contacts: [sampleContact()] }, contactsPath);

      const result = await importConnections(csvPath, {
        confirmed: true,
        contactsPath,
        referenceDate,
      });

      expect(result.proposedAdditions).toHaveLength(2);
      expect(result.proposedAdditions.map((c) => c.name)).toEqual(['John Doe', 'Ali Patel']);
      const all = await readNetworkingContacts(contactsPath);
      expect(all.contacts).toHaveLength(3);
      expect(all.contacts.map((c) => c.contactId).sort()).toEqual([
        'contact001',
        'contact002',
        'contact003',
      ]);
      // No duplicate contactId and no duplicate name+company in the merged set.
      expect(new Set(all.contacts.map((c) => c.contactId)).size).toBe(3);
      const nameCompanyKeys = all.contacts.map((c) => `${c.name}|${c.company}`);
      expect(new Set(nameCompanyKeys).size).toBe(3);
      expect(all.contacts.filter((c) => c.name === 'Jane Sample' && c.company === 'SampleCorp')).toHaveLength(1);
    });
  });

  it('deduplicates repeated rows within the same CSV', async () => {
    await withSandbox(async ({ dir, contactsPath }) => {
      const dupCsvPath = join(dir, 'dups.csv');
      await writeFile(
        dupCsvPath,
        'First Name,Last Name,Company\nJane,Sample,SampleCorp\nJane,Sample,SampleCorp\n',
        'utf8',
      );

      const result = await importConnections(dupCsvPath, { confirmed: true, contactsPath });

      expect(result.proposedAdditions).toHaveLength(1);
      const all = await readNetworkingContacts(contactsPath);
      expect(all.contacts).toHaveLength(1);
      expect(all.contacts[0].contactId).toBe('contact001');
    });
  });
});

// ---------------------------------------------------------------------------
// importConnections — data safety (N6, N10)
// ---------------------------------------------------------------------------

describe('importConnections: read-only source (N6)', () => {
  it('leaves the source CSV byte-identical after a confirmed import', async () => {
    await withSandbox(async ({ csvPath, contactsPath }) => {
      const before = await readCsvHash(csvPath);
      const result = await importConnections(csvPath, { confirmed: true, contactsPath });
      expect(result.written).toBe(true);
      expect(await readCsvHash(csvPath)).toBe(before);
    });
  });

  it('throws a clear error naming the path for a missing CSV', async () => {
    await withSandbox(async ({ dir, contactsPath }) => {
      const missing = join(dir, 'does-not-exist.csv');
      await expect(importConnections(missing, { confirmed: true, contactsPath })).rejects.toThrow(
        missing,
      );
    });
  });
});

// ---------------------------------------------------------------------------
// moduleOwnership (Phase 5c): single-consumer map. Each row names a module
// plus its consumer or standalone status. Wired modules must have at least one
// non-test importer under src; standalone modules must carry an explicit
// @standalone marker in their source. Red proof: this check flagged
// linkedInImport (zero non-test importers, no marker) before the standalone
// note landed in linkedInImport.ts.
// ---------------------------------------------------------------------------

interface OwnershipRow {
  moduleFile: string;
  consumerNote: string;
  standalone: boolean;
}

const ownershipTable: OwnershipRow[] = [
  {
    moduleFile: 'linkedInImport.ts',
    consumerNote: 'standalone CSV utility: parseConnectionsCsv plus importConnections, no CLI or MCP importer by design',
    standalone: true,
  },
  {
    moduleFile: 'documentIngestor.ts',
    consumerNote: 'ingestDocuments MCP tool in jobSearchServer.ts',
    standalone: false,
  },
  {
    moduleFile: 'patternAnalyzer.ts',
    consumerNote: 'analyzeApplicationPatterns MCP tool in jobSearchServer.ts',
    standalone: false,
  },
  {
    moduleFile: 'reviewQueueFormatter.ts',
    consumerNote: 'review queue surface in jobSearchCore.ts',
    standalone: false,
  },
  {
    moduleFile: 'docxParser.ts',
    consumerNote: 'documentIngestor.ts ingestDocuments',
    standalone: false,
  },
];

function ownershipBaseName(moduleFile: string): string {
  return moduleFile.replace(/\.ts$/, '');
}

async function listNonTestSources(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const found: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...(await listNonTestSources(full)));
    } else if (entry.isFile() && full.endsWith('.ts') && !full.endsWith('.test.ts')) {
      found.push(full);
    }
  }
  return found;
}

function importsModule(source: string, base: string): boolean {
  return new RegExp('from\\s+["\'][^"\']*/' + base + '["\']').test(source);
}

describe('moduleOwnership: single-consumer map (Phase 5c)', () => {
  it('covers every in-scope module exactly once', () => {
    expect(ownershipTable.map((row) => row.moduleFile).sort()).toEqual(
      [
        'linkedInImport.ts',
        'documentIngestor.ts',
        'patternAnalyzer.ts',
        'reviewQueueFormatter.ts',
        'docxParser.ts',
      ].sort(),
    );
  });

  it('wired modules have a non-test importer; standalone modules carry an explicit marker', async () => {
    const srcRoot = resolve(__dirname, '..');
    const sources = await listNonTestSources(srcRoot);
    const contents = await Promise.all(
      sources.map(async (file) => ({ file, text: await readFile(file, 'utf8') })),
    );
    const unowned: string[] = [];
    for (const row of ownershipTable) {
      const base = ownershipBaseName(row.moduleFile);
      const importerCount = contents.filter(
        (entry) => !entry.file.endsWith('/' + row.moduleFile) && importsModule(entry.text, base),
      ).length;
      const ownSource = contents.find((entry) => entry.file.endsWith('/' + row.moduleFile));
      const hasMarker = ownSource !== undefined && ownSource.text.includes('@standalone');
      if (row.standalone) {
        if (!hasMarker) {
          unowned.push(row.moduleFile + ': standalone but no @standalone marker');
        }
      } else if (importerCount === 0) {
        unowned.push(row.moduleFile + ': no non-test importer (' + row.consumerNote + ')');
      }
    }
    expect(unowned).toEqual([]);
  });

  it('linkedInImport works standalone with only a CSV path and a contacts path', async () => {
    const fixtureText = await readFile(sampleCsvPath, 'utf8');
    expect(parseConnectionsCsv(fixtureText)).toHaveLength(3);
    await withSandbox(async ({ csvPath, contactsPath }) => {
      const result: ImportConnectionsResult = await importConnections(csvPath, {
        confirmed: false,
        contactsPath,
      });
      expect(result.written).toBe(false);
      expect(result.proposedAdditions).toHaveLength(3);
      await expect(readFile(contactsPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    });
  });
});
