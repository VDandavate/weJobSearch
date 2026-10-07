import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  addSavedSearch,
  generateSearchId,
  readSavedSearches,
} from './savedSearches';

async function withTempFile<T>(fn: (filePath: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'weJobSearch-savedSearches-test-'));
  const previousRoot = process.env.WEJOBSEARCHDATAROOT;
  process.env.WEJOBSEARCHDATAROOT = dir;
  const filePath = join(dir, 'savedSearches.json');
  try {
    return await fn(filePath);
  } finally {
    if (previousRoot === undefined) {
      delete process.env.WEJOBSEARCHDATAROOT;
    } else {
      process.env.WEJOBSEARCHDATAROOT = previousRoot;
    }
    await rm(dir, { recursive: true, force: true });
  }
}

describe('generateSearchId', () => {
  it('combines the year with normalized keywords and location', () => {
    expect(
      generateSearchId('senior software engineer', 'Remote', new Date('2026-08-18T00:00:00Z')),
    ).toBe('search2026seniorsoftwareengineerRemote');
  });

  it('omits the location segment when absent', () => {
    expect(generateSearchId('staff engineer', undefined, new Date('2026-08-18T00:00:00Z'))).toBe(
      'search2026staffengineer',
    );
  });
});

describe('readSavedSearches', () => {
  it('returns an empty store when the file does not exist', async () => {
    await withTempFile(async (filePath) => {
      const store = await readSavedSearches(filePath);
      expect(store).toEqual({ searches: [] });
    });
  });

  it('throws a clear error on malformed JSON', async () => {
    await withTempFile(async (filePath) => {
      await writeFile(filePath, '{not json', 'utf8');
      await expect(readSavedSearches(filePath)).rejects.toThrow(/not valid JSON/);
    });
  });

  it('throws a clear error on a schema-invalid store', async () => {
    await withTempFile(async (filePath) => {
      await writeFile(filePath, JSON.stringify({ searches: [{ keywords: 42 }] }), 'utf8');
      await expect(readSavedSearches(filePath)).rejects.toThrow(/Malformed saved searches/);
    });
  });
});

describe('addSavedSearch', () => {
  it('adds a search and persists it', async () => {
    await withTempFile(async (filePath) => {
      const search = await addSavedSearch({ keywords: 'staff engineer', location: 'Remote' }, filePath);
      expect(search.keywords).toBe('staff engineer');
      expect(search.location).toBe('Remote');
      expect(search.searchId).toBe(generateSearchId('staff engineer', 'Remote'));
      expect(search.createdAt).toBeDefined();
      const store = await readSavedSearches(filePath);
      expect(store.searches).toHaveLength(1);
      expect(store.searches[0]).toEqual(search);
    });
  });

  it('rejects an empty keyword string', async () => {
    await withTempFile(async (filePath) => {
      await expect(addSavedSearch({ keywords: '   ' }, filePath)).rejects.toThrow(/must not be empty/);
    });
  });

  it('rejects a duplicate keywords+location pair', async () => {
    await withTempFile(async (filePath) => {
      await addSavedSearch({ keywords: 'staff engineer', location: 'Remote' }, filePath);
      await expect(
        addSavedSearch({ keywords: 'staff engineer', location: 'Remote' }, filePath),
      ).rejects.toThrow(/already exists/);
    });
  });

  it('allows the same keywords under a different location', async () => {
    await withTempFile(async (filePath) => {
      await addSavedSearch({ keywords: 'staff engineer', location: 'Remote' }, filePath);
      await addSavedSearch({ keywords: 'staff engineer', location: 'New York, NY' }, filePath);
      const store = await readSavedSearches(filePath);
      expect(store.searches).toHaveLength(2);
    });
  });

  it('refuses to overwrite a malformed existing store', async () => {
    await withTempFile(async (filePath) => {
      await writeFile(filePath, '{not json', 'utf8');
      await expect(addSavedSearch({ keywords: 'staff engineer' }, filePath)).rejects.toThrow(
        /not valid JSON/,
      );
    });
  });
});

describe('persisted file shape', () => {
  it('writes a valid savedSearches.json with camelCase keys only', async () => {
    await withTempFile(async (filePath) => {
      await addSavedSearch({ keywords: 'staff engineer', location: 'Remote' }, filePath);
      const raw = await readFile(filePath, 'utf8');
      expect(raw).toContain('"searchId"');
      expect(raw).toContain('"keywords"');
      expect(raw).toContain('"createdAt"');
      expect(raw).not.toContain('_');
    });
  });
});

describe('search identity characterization (Phase 5a)', () => {
  it('produces a year-scoped human-readable id', () => {
    expect(
      generateSearchId('staff engineer', 'Remote', new Date('2026-08-18T00:00:00Z')),
    ).toBe('search2026staffengineerRemote');
  });

  it('is case-sensitive: casing variants produce distinct ids', () => {
    const referenceDate = new Date('2026-08-18T00:00:00Z');
    expect(generateSearchId('Staff Engineer', 'Remote', referenceDate)).not.toBe(
      generateSearchId('staff engineer', 'Remote', referenceDate),
    );
  });

  it('strips non-alphanumeric characters rather than hashing', () => {
    expect(
      generateSearchId('staff-engineer (platform)', 'Remote', new Date('2026-08-18T00:00:00Z')),
    ).toBe('search2026staffengineerplatformRemote');
  });

  it('save persists the definition only: no results payload and no TTL field', async () => {
    await withTempFile(async (filePath) => {
      const search = await addSavedSearch(
        { keywords: 'staff engineer', location: 'Remote' },
        filePath,
      );
      const raw = await readFile(filePath, 'utf8');
      const parsed = JSON.parse(raw) as { searches: Array<Record<string, unknown>> };
      expect(Object.keys(parsed.searches[0]).sort()).toEqual([
        'createdAt',
        'keywords',
        'location',
        'searchId',
      ]);
      expect(search).toEqual(parsed.searches[0]);
    });
  });
});
describe('rootDir isolation (U43)', () => {
  it('addSavedSearch under an explicit rootDir does not touch the env root', async () => {
    const envDir = await mkdtemp(join(tmpdir(), 'weJobSearch-u43-env-'));
    const otherDir = await mkdtemp(join(tmpdir(), 'weJobSearch-u43-'));
    const previous = process.env.WEJOBSEARCHDATAROOT;
    process.env.WEJOBSEARCHDATAROOT = envDir;
    try {
      await addSavedSearch(
        { keywords: 'staff engineer', location: 'Remote' },
        join(otherDir, 'savedSearches.json'),
        otherDir,
      );
      expect(existsSync(join(envDir, 'savedSearches.json'))).toBe(false);
      const stored = await readSavedSearches(join(otherDir, 'savedSearches.json'), otherDir);
      expect(stored.searches).toHaveLength(1);
    } finally {
      if (previous === undefined) {
        delete process.env.WEJOBSEARCHDATAROOT;
      } else {
        process.env.WEJOBSEARCHDATAROOT = previous;
      }
      await rm(envDir, { recursive: true, force: true });
      await rm(otherDir, { recursive: true, force: true });
    }
  });
});

describe('savedSearches Phase D: write guards and redacted errors', () => {
  it('refuses to write inside the read-only documents directory', async () => {
    await withTempFile(async (filePath) => {
      await expect(
        addSavedSearch(
          { keywords: 'Staff Engineer' },
          join(dirname(filePath), 'documents', 'savedSearches.json'),
        ),
      ).rejects.toThrow(/read-only source directory/);
    });
  });

  it('routes malformed-file errors through the redacted path form', async () => {
    await withTempFile(async (filePath) => {
      await writeFile(filePath, '{not json', 'utf8');
      const message = await readSavedSearches(filePath).then(
        () => 'no error',
        (error: Error) => error.message,
      );
      const { redactHomePrefix } = await import('./canonicalDataRoot');
      expect(message).toContain(redactHomePrefix(filePath));
    });
  });
});
