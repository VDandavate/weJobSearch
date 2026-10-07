import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { RawPosting } from '../scrapers/jobSpyAdapter';
import {
  defaultMaxSearchCacheEntries,
  defaultSearchCacheTtlMinutes,
  generateSearchCacheKey,
  getCachedSearch,
  pruneSearchCacheEntries,
  putCachedSearch,
  readSearchCache,
  type CachedSearchEntry,
} from './searchCache';

// Search result caching (SRA-06 work item, parent spec docs/weJobSearch-SDD.md):
// identical keyword/location queries within a configurable TTL window return
// cached raw scrape results instead of re-scraping. The store follows the same
// persistence contract as the other tracking modules: atomic writes (temp file
// + rename), schema-validated before write, and a malformed existing file is
// never silently overwritten.

function samplePosting(overrides: Partial<RawPosting> = {}): RawPosting {
  return {
    sourceAggregator: 'stubAlpha',
    companyName: 'SampleCorp',
    roleTitle: 'Staff Engineer',
    location: 'Remote',
    jobUrl: 'https://alpha.test/jobs/1',
    description: 'Senior distributed systems role using TypeScript and Rust.',
    hasFullDescription: true,
    postedAt: '2026-08-10T00:00:00.000Z',
    rawSalaryText: 'USD 140,000 - 180,000 per year',
    ...overrides,
  };
}

function sampleResults() {
  return [
    {
      sourceName: 'stubAlpha',
      postings: [samplePosting()],
    },
    {
      sourceName: 'stubBeta',
      postings: [samplePosting({ companyName: 'OtherCorp', jobUrl: 'https://beta.test/jobs/1' })],
    },
  ];
}

async function withCacheFile<T>(fn: (filePath: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'weJobSearch-cache-'));
  const previousRoot = process.env.WEJOBSEARCHDATAROOT;
  process.env.WEJOBSEARCHDATAROOT = dir;
  try {
    return await fn(join(dir, 'searchCache.json'));
  } finally {
    if (previousRoot === undefined) {
      delete process.env.WEJOBSEARCHDATAROOT;
    } else {
      process.env.WEJOBSEARCHDATAROOT = previousRoot;
    }
    await rm(dir, { recursive: true, force: true });
  }
}

describe('generateSearchCacheKey', () => {
  it('normalizes keywords and location so equivalent queries share a key', () => {
    expect(generateSearchCacheKey('Staff Engineer', 'Remote')).toBe(
      generateSearchCacheKey(' staff  engineer ', 'remote'),
    );
  });

  it('distinguishes different locations for the same keywords', () => {
    expect(generateSearchCacheKey('Staff Engineer', 'Remote')).not.toBe(
      generateSearchCacheKey('Staff Engineer', 'New York'),
    );
  });
});

describe('getCachedSearch / putCachedSearch', () => {
  it('returns null on a miss for an unknown query', async () => {
    await withCacheFile(async (filePath) => {
      const cached = await getCachedSearch({
        filePath,
        keywords: 'Staff Engineer',
        location: 'Remote',
        ttlMinutes: defaultSearchCacheTtlMinutes,
      });
      expect(cached).toBeNull();
    });
  });

  it('returns cached results within the TTL window', async () => {
    await withCacheFile(async (filePath) => {
      const now = new Date('2026-08-19T12:00:00.000Z');
      await putCachedSearch({
        filePath,
        keywords: 'Staff Engineer',
        location: 'Remote',
        results: sampleResults(),
        now,
      });
      const cached = await getCachedSearch({
        filePath,
        keywords: 'Staff Engineer',
        location: 'Remote',
        ttlMinutes: 30,
        now: new Date('2026-08-19T12:20:00.000Z'),
      });
      expect(cached).not.toBeNull();
      expect(cached?.results).toHaveLength(2);
      expect(cached?.results[0].postings[0].roleTitle).toBe('Staff Engineer');
      expect(cached?.failedSources).toEqual([]);
    });
  });

  it('treats an entry older than the TTL as expired and returns null', async () => {
    await withCacheFile(async (filePath) => {
      const now = new Date('2026-08-19T12:00:00.000Z');
      await putCachedSearch({
        filePath,
        keywords: 'Staff Engineer',
        location: 'Remote',
        results: sampleResults(),
        now,
      });
      const cached = await getCachedSearch({
        filePath,
        keywords: 'Staff Engineer',
        location: 'Remote',
        ttlMinutes: 30,
        now: new Date('2026-08-19T13:00:00.000Z'),
      });
      expect(cached).toBeNull();
    });
  });

  it('upserts by cache key so a re-run replaces the previous entry', async () => {
    await withCacheFile(async (filePath) => {
      const now = new Date('2026-08-19T12:00:00.000Z');
      await putCachedSearch({
        filePath,
        keywords: 'Staff Engineer',
        location: 'Remote',
        results: sampleResults(),
        now,
      });
      await putCachedSearch({
        filePath,
        keywords: 'staff engineer',
        location: 'REMOTE',
        results: [sampleResults()[0]],
        now: new Date('2026-08-19T12:10:00.000Z'),
      });
      const cache = await readSearchCache(filePath);
      const matching = cache.entries.filter((entry) => entry.cacheKey === generateSearchCacheKey('Staff Engineer', 'Remote'));
      expect(matching).toHaveLength(1);
      expect(matching[0].results).toHaveLength(1);
    });
  });
});

describe('search cache write discipline', () => {
  it('writes atomically and refuses to overwrite a malformed existing file', async () => {
    await withCacheFile(async (filePath) => {
      await writeFile(filePath, 'not json at all', 'utf8');
      await expect(
        putCachedSearch({
          filePath,
          keywords: 'Staff Engineer',
          location: 'Remote',
          results: sampleResults(),
        }),
      ).rejects.toThrow(/Malformed search cache/);
      const raw = await readFile(filePath, 'utf8');
      expect(raw).toBe('not json at all');
    });
  });
});

describe('search cache characterization (Phase 5a)', () => {
  it('hits across casing and whitespace variants of the same query', async () => {
    await withCacheFile(async (filePath) => {
      const now = new Date('2026-08-19T12:00:00.000Z');
      await putCachedSearch({
        filePath,
        keywords: 'Staff Engineer',
        location: 'Remote',
        results: sampleResults(),
        now,
      });
      const cached = await getCachedSearch({
        filePath,
        keywords: '  STAFF   engineer ',
        location: 'remote',
        ttlMinutes: 30,
        now: new Date('2026-08-19T12:10:00.000Z'),
      });
      expect(cached).not.toBeNull();
      expect(cached?.results).toHaveLength(2);
    });
  });

  it('treats ttlMinutes as minutes, not seconds', async () => {
    await withCacheFile(async (filePath) => {
      const now = new Date('2026-08-19T12:00:00.000Z');
      await putCachedSearch({
        filePath,
        keywords: 'Staff Engineer',
        location: 'Remote',
        results: sampleResults(),
        now,
      });
      const after29Min = await getCachedSearch({
        filePath,
        keywords: 'Staff Engineer',
        location: 'Remote',
        ttlMinutes: 30,
        now: new Date('2026-08-19T12:29:00.000Z'),
      });
      expect(after29Min).not.toBeNull();
      const after31Min = await getCachedSearch({
        filePath,
        keywords: 'Staff Engineer',
        location: 'Remote',
        ttlMinutes: 30,
        now: new Date('2026-08-19T12:31:00.000Z'),
      });
      expect(after31Min).toBeNull();
    });
  });

  it('treats an entry exactly at the TTL boundary as fresh', async () => {
    await withCacheFile(async (filePath) => {
      const now = new Date('2026-08-19T12:00:00.000Z');
      await putCachedSearch({
        filePath,
        keywords: 'Staff Engineer',
        location: 'Remote',
        results: sampleResults(),
        now,
      });
      const cached = await getCachedSearch({
        filePath,
        keywords: 'Staff Engineer',
        location: 'Remote',
        ttlMinutes: 30,
        now: new Date('2026-08-19T12:30:00.000Z'),
      });
      expect(cached).not.toBeNull();
    });
  });

  it('round-trips whatever results it is given: partial-failure skipping is caller policy, not cache policy', async () => {
    await withCacheFile(async (filePath) => {
      const partial = [sampleResults()[0]];
      await putCachedSearch({
        filePath,
        keywords: 'Staff Engineer',
        location: 'Remote',
        results: partial,
        now: new Date('2026-08-19T12:00:00.000Z'),
      });
      const cached = await getCachedSearch({
        filePath,
        keywords: 'Staff Engineer',
        location: 'Remote',
        ttlMinutes: 30,
        now: new Date('2026-08-19T12:05:00.000Z'),
      });
      expect(cached?.results).toEqual(partial);
    });
  });

  it('stores raw postings only: no run metadata and no TTL field per entry', async () => {
    await withCacheFile(async (filePath) => {
      await putCachedSearch({
        filePath,
        keywords: 'Staff Engineer',
        location: 'Remote',
        results: sampleResults(),
        now: new Date('2026-08-19T12:00:00.000Z'),
      });
      const raw = await readFile(filePath, 'utf8');
      expect(raw).not.toContain('searchId');
      expect(raw).not.toContain('resultCount');
    });
  });
});

describe('search cache partial-failure policy (Phase 6b)', () => {
  it('round-trips the failed source names alongside the successful subset', async () => {
    await withCacheFile(async (filePath) => {
      const partial = [sampleResults()[0]];
      await putCachedSearch({
        filePath,
        keywords: 'Staff Engineer',
        location: 'Remote',
        results: partial,
        failedSources: ['stubBeta'],
        now: new Date('2026-08-19T12:00:00.000Z'),
      });
      const cached = await getCachedSearch({
        filePath,
        keywords: 'Staff Engineer',
        location: 'Remote',
        ttlMinutes: 30,
        now: new Date('2026-08-19T12:05:00.000Z'),
      });
      expect(cached).not.toBeNull();
      expect(cached?.results).toEqual(partial);
      expect(cached?.failedSources).toEqual(['stubBeta']);
    });
  });

  it('defaults failedSources to empty for entries written without it', async () => {
    await withCacheFile(async (filePath) => {
      await putCachedSearch({
        filePath,
        keywords: 'Staff Engineer',
        location: 'Remote',
        results: sampleResults(),
        now: new Date('2026-08-19T12:00:00.000Z'),
      });
      const cached = await getCachedSearch({
        filePath,
        keywords: 'Staff Engineer',
        location: 'Remote',
        ttlMinutes: 30,
        now: new Date('2026-08-19T12:05:00.000Z'),
      });
      expect(cached?.failedSources).toEqual([]);
    });
  });

  it('reads entries written before the failedSources field existed', async () => {
    await withCacheFile(async (filePath) => {
      const legacy = {
        entries: [
          {
            cacheKey: generateSearchCacheKey('Staff Engineer', 'Remote'),
            keywords: 'Staff Engineer',
            location: 'Remote',
            createdAt: '2026-08-19T12:00:00.000Z',
            results: sampleResults(),
          },
        ],
      };
      await writeFile(filePath, JSON.stringify(legacy), 'utf8');
      const cached = await getCachedSearch({
        filePath,
        keywords: 'Staff Engineer',
        location: 'Remote',
        ttlMinutes: 30,
        now: new Date('2026-08-19T12:05:00.000Z'),
      });
      expect(cached).not.toBeNull();
      expect(cached?.results).toHaveLength(2);
      expect(cached?.failedSources).toEqual([]);
    });
  });
});

describe('searchCache Phase D: bounded size and write guards', () => {
  function cacheEntry(cacheKey: string, createdAt: string): CachedSearchEntry {
    return {
      cacheKey,
      keywords: cacheKey,
      location: 'Remote',
      createdAt,
      results: [],
      failedSources: [],
    };
  }

  it('pruneSearchCacheEntries keeps the newest entries and drops unparseable dates', () => {
    const entries = [
      cacheEntry('oldest', '2026-08-10T00:00:00.000Z'),
      cacheEntry('newest', '2026-08-12T00:00:00.000Z'),
      cacheEntry('middle', '2026-08-11T00:00:00.000Z'),
      cacheEntry('broken', 'not-a-date'),
    ];
    const pruned = pruneSearchCacheEntries(entries, 2);
    expect(pruned.map((entry) => entry.cacheKey)).toEqual(['newest', 'middle']);
  });

  it('putCachedSearch prunes the file to the entry cap, newest kept', async () => {
    await withCacheFile(async (filePath) => {
      const base = new Date('2026-08-19T12:00:00.000Z').getTime();
      for (let index = 0; index < defaultMaxSearchCacheEntries + 5; index += 1) {
        await putCachedSearch({
          filePath,
          keywords: `Engineer ${index}`,
          location: 'Remote',
          results: [],
          now: new Date(base + index * 1000),
        });
      }
      const cache = await readSearchCache(filePath);
      expect(cache.entries).toHaveLength(defaultMaxSearchCacheEntries);
      expect(cache.entries.map((entry) => entry.keywords)).toContain(
        `Engineer ${defaultMaxSearchCacheEntries + 4}`,
      );
      expect(cache.entries.map((entry) => entry.keywords)).not.toContain('Engineer 0');
    });
  });

  it('refuses to write inside the read-only documents directory', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'weJobSearch-cache-guard-'));
    const previousRoot = process.env.WEJOBSEARCHDATAROOT;
    process.env.WEJOBSEARCHDATAROOT = dir;
    try {
      await expect(
        putCachedSearch({
          filePath: join(dir, 'documents', 'searchCache.json'),
          keywords: 'Staff Engineer',
          location: 'Remote',
          results: [],
        }),
      ).rejects.toThrow(/read-only source directory/);
    } finally {
      if (previousRoot === undefined) {
        delete process.env.WEJOBSEARCHDATAROOT;
      } else {
        process.env.WEJOBSEARCHDATAROOT = previousRoot;
      }
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('routes malformed-file errors through the redacted path form', async () => {
    await withCacheFile(async (filePath) => {
      await writeFile(filePath, '{not json', 'utf8');
      const message = await readSearchCache(filePath).then(
        () => 'no error',
        (error: Error) => error.message,
      );
      const { redactHomePrefix } = await import('./canonicalDataRoot');
      expect(message).toContain(redactHomePrefix(filePath));
    });
  });
});
