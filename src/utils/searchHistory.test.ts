import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { generateSearchHistoryId, readSearchHistory, recordSearch } from './searchHistory';
import type { SearchHistoryEntry } from './searchHistory';
import { generateSearchId } from './savedSearches';

async function withTempFile<T>(fn: (filePath: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'weJobSearch-searchHistory-test-'));
  const previousRoot = process.env.WEJOBSEARCHDATAROOT;
  process.env.WEJOBSEARCHDATAROOT = dir;
  const filePath = join(dir, 'searchHistory.json');
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

function historyEntry(overrides: Partial<SearchHistoryEntry> = {}): SearchHistoryEntry {
  return {
    searchId: generateSearchHistoryId('staff engineer', 'Remote', new Date('2026-08-18T00:00:00Z')),
    keywords: 'staff engineer',
    location: 'Remote',
    timestamp: '2026-08-18T10:00:00.000Z',
    resultCount: 4,
    ...overrides,
  };
}

describe('generateSearchHistoryId', () => {
  it('combines the year with normalized keywords and location', () => {
    expect(
      generateSearchHistoryId('senior software engineer', 'Remote', new Date('2026-08-18T00:00:00Z')),
    ).toBe('search2026seniorsoftwareengineerRemote');
  });

  it('is deterministic for the same query within the same year', () => {
    expect(
      generateSearchHistoryId('staff engineer', 'Remote', new Date('2026-08-18T00:00:00Z')),
    ).toBe(generateSearchHistoryId('staff engineer', 'Remote', new Date('2026-08-19T00:00:00Z')));
  });
});

describe('readSearchHistory', () => {
  it('returns an empty history when the file does not exist', async () => {
    await withTempFile(async (filePath) => {
      const history = await readSearchHistory(filePath);
      expect(history).toEqual({ searches: [] });
    });
  });

  it('throws a clear error on malformed JSON', async () => {
    await withTempFile(async (filePath) => {
      await writeFile(filePath, '{not json', 'utf8');
      await expect(readSearchHistory(filePath)).rejects.toThrow(/not valid JSON/);
    });
  });

  it('throws a clear error on a schema-invalid history', async () => {
    await withTempFile(async (filePath) => {
      await writeFile(filePath, JSON.stringify({ searches: [{ keywords: 42 }] }), 'utf8');
      await expect(readSearchHistory(filePath)).rejects.toThrow(/Malformed search history/);
    });
  });
});

describe('recordSearch', () => {
  it('records a query with timestamp and result count and reads it back', async () => {
    await withTempFile(async (filePath) => {
      const entry = historyEntry();
      await recordSearch(entry, filePath);
      const history = await readSearchHistory(filePath);
      expect(history.searches).toHaveLength(1);
      expect(history.searches[0]).toEqual(entry);
    });
  });

  it('is idempotent: an identical searchId updates the entry instead of duplicating it', async () => {
    await withTempFile(async (filePath) => {
      await recordSearch(historyEntry({ timestamp: '2026-08-18T10:00:00.000Z', resultCount: 4 }), filePath);
      await recordSearch(historyEntry({ timestamp: '2026-08-18T11:00:00.000Z', resultCount: 7 }), filePath);
      const history = await readSearchHistory(filePath);
      expect(history.searches).toHaveLength(1);
      expect(history.searches[0].timestamp).toBe('2026-08-18T11:00:00.000Z');
      expect(history.searches[0].resultCount).toBe(7);
    });
  });

  it('keeps distinct queries as separate entries in run order', async () => {
    await withTempFile(async (filePath) => {
      await recordSearch(historyEntry(), filePath);
      await recordSearch(
        historyEntry({
          searchId: generateSearchHistoryId('platform lead', 'Remote', new Date('2026-08-18T00:00:00Z')),
          keywords: 'platform lead',
          timestamp: '2026-08-18T12:00:00.000Z',
        }),
        filePath,
      );
      const history = await readSearchHistory(filePath);
      expect(history.searches).toHaveLength(2);
      expect(history.searches.map((entry) => entry.keywords)).toEqual(['staff engineer', 'platform lead']);
    });
  });

  it('refuses to overwrite a malformed existing file', async () => {
    await withTempFile(async (filePath) => {
      await writeFile(filePath, '{not json', 'utf8');
      await expect(recordSearch(historyEntry(), filePath)).rejects.toThrow(/not valid JSON/);
      const raw = await readFile(filePath, 'utf8');
      expect(raw).toBe('{not json');
    });
  });

  it('refuses to write an entry that fails the schema', async () => {
    await withTempFile(async (filePath) => {
      await expect(
        recordSearch({ ...historyEntry(), resultCount: 'four' } as unknown as SearchHistoryEntry, filePath),
      ).rejects.toThrow(/Refusing to write invalid search history/);
    });
  });
});

describe('persisted file shape', () => {
  it('writes a valid searchHistory.json with camelCase keys only', async () => {
    await withTempFile(async (filePath) => {
      await recordSearch(historyEntry(), filePath);
      const raw = await readFile(filePath, 'utf8');
      expect(raw).toContain('"searchId"');
      expect(raw).toContain('"keywords"');
      expect(raw).toContain('"location"');
      expect(raw).toContain('"timestamp"');
      expect(raw).toContain('"resultCount"');
      expect(raw).not.toContain('_');
    });
  });
});

describe('search identity unification (Phase 5a)', () => {
  it('history run ids match saved-search definition ids for the same query', () => {
    const referenceDate = new Date('2026-08-18T00:00:00Z');
    expect(generateSearchHistoryId('staff engineer', 'Remote', referenceDate)).toBe(
      generateSearchId('staff engineer', 'Remote', referenceDate),
    );
  });

  it('re-recording moves the entry to the end without duplicating it', async () => {
    await withTempFile(async (filePath) => {
      const first = historyEntry();
      const second = historyEntry({
        searchId: generateSearchHistoryId(
          'platform lead',
          'Remote',
          new Date('2026-08-18T00:00:00Z'),
        ),
        keywords: 'platform lead',
        timestamp: '2026-08-18T12:00:00.000Z',
      });
      await recordSearch(first, filePath);
      await recordSearch(second, filePath);
      await recordSearch(
        { ...first, timestamp: '2026-08-18T13:00:00.000Z', resultCount: 9 },
        filePath,
      );
      const history = await readSearchHistory(filePath);
      expect(history.searches).toHaveLength(2);
      expect(history.searches.map((entry) => entry.keywords)).toEqual([
        'platform lead',
        'staff engineer',
      ]);
      expect(history.searches[1].resultCount).toBe(9);
    });
  });

  it('stores run metadata only: no cached postings payload and no cache key', async () => {
    await withTempFile(async (filePath) => {
      await recordSearch(historyEntry(), filePath);
      const raw = await readFile(filePath, 'utf8');
      expect(raw).not.toContain('postings');
      expect(raw).not.toContain('cacheKey');
    });
  });

  it('routes malformed-file errors through the redacted path form (Phase D)', async () => {
    const { redactHomePrefix } = await import('./canonicalDataRoot');
    await withTempFile(async (filePath) => {
      await writeFile(filePath, '{not json', 'utf8');
      const message = await readSearchHistory(filePath).then(
        () => 'no error',
        (error: Error) => error.message,
      );
      expect(message).toContain('Malformed search history');
      expect(message).toContain(redactHomePrefix(filePath));
    });
  });
});