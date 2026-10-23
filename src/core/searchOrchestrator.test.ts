import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { RawPosting, SourceAdapter } from '../scrapers/jobSpyAdapter';
import { JobSpyAdapterRegistry } from '../scrapers/jobSpyAdapter';
import { RateLimiter } from '../scrapers/rateLimiter';
import { readApplicationHistory } from '../utils/jobFunnelTracker';
import { addSavedSearch } from '../utils/savedSearches';
import { writeFileAtomically } from '../utils/atomicWrite';
import {
  buildProfileQueries,
  evaluateAndPersistPosting,
  evaluateJobPosting,
  generateForRole,
  resolveEvaluationContext,
  runSavedSearchesDigest,
  runSearchBatch,
  searchByProfile,
  searchJobPostings,
} from './searchOrchestrator';
import { confirmApplicationSubmission } from '../cli/jobSearchCore';

// Count atomic writes to the tracker with the real writer still in place.
vi.mock('../utils/atomicWrite', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/atomicWrite')>();
  return { ...actual, writeFileAtomically: vi.fn(actual.writeFileAtomically) };
});

// Phase 7a seam coverage: the pipeline moved verbatim from jobSearchCore.ts.
// These pin the extracted entry points through the new import path; the full
// characterization suite still runs through the dispatcher re-exports.

const preferencesYaml = `
compensation:
  currency: USD
  minAcceptableBase: 100000
  targetBase: 150000
  countsBonusTowardMin: false
  countsEquityTowardMin: false
clearance:
  currentStatus: none
  currentLevel: null
  eligibleToObtain: false
  requiresSponsorshipForVisa: false
nonNegotiables:
  - id: noRelocation
    category: location
    rule: reject if the posting requires working at a location outside the preferredLocations list
  - id: belowMinSalary
    category: compensation
    rule: reject if the posted base salary falls below minAcceptableBase
preferredLocations:
  - Remote
`;

const profileMarkdown = `# Jane Sample

## Summary
Senior software engineer with 6 years of experience building distributed systems.

## Skills
TypeScript, Python, Rust, distributed systems, API design

## Experience
### SampleCorp - Senior Software Engineer (2020 - Present)
- Built distributed APIs serving millions of requests using TypeScript and Python.
`;

function posting(overrides: Partial<RawPosting> = {}): RawPosting {
  return {
    sourceAggregator: 'stubAlpha',
    companyName: 'SampleCorp',
    roleTitle: 'Staff Engineer',
    location: 'Remote',
    jobUrl: 'https://alpha.test/jobs/1',
    description: 'Senior distributed systems role using TypeScript and Rust. 5+ years of experience.',
    hasFullDescription: true,
    postedAt: null,
    rawSalaryText: 'USD 140,000 - 180,000 per year',
    ...overrides,
  };
}

class StubAdapter implements SourceAdapter {
  readonly sourceName: string;

  private readonly postings: RawPosting[];

  private readonly fetcher: (url: string) => RawPosting | null;

  constructor(name: string, postings: RawPosting[], fetcher?: (url: string) => RawPosting | null) {
    this.sourceName = name;
    this.postings = postings;
    this.fetcher = fetcher ?? (() => null);
  }

  async search(): Promise<RawPosting[]> {
    return [...this.postings];
  }

  async fetchPostingByUrl(url: string): Promise<RawPosting | null> {
    return this.fetcher(url);
  }
}

function makeRegistry(entries: { name: string; postings: RawPosting[] }[]): JobSpyAdapterRegistry {
  const registry = new JobSpyAdapterRegistry();
  for (const entry of entries) {
    registry.register(
      new StubAdapter(entry.name, entry.postings),
      undefined,
      new RateLimiter({ sourceName: entry.name, minDelayMs: 0, maxDelayMs: 0 }),
    );
  }
  return registry;
}

interface SandboxPaths {
  dir: string;
  historyPath: string;
  preferencesPath: string;
  profilePath: string;
  searchHistoryPath: string;
}

async function withSandbox<T>(fn: (paths: SandboxPaths) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'weJobSearch-orchestrator-'));
  const previousRoot = process.env.WEJOBSEARCHDATAROOT;
  process.env.WEJOBSEARCHDATAROOT = dir;
  const paths: SandboxPaths = {
    dir,
    historyPath: join(dir, 'applications', 'applicationHistory.json'),
    preferencesPath: join(dir, 'jobPreferences.yaml'),
    profilePath: join(dir, 'masterProfile.md'),
    searchHistoryPath: join(dir, 'searchHistory.json'),
  };
  await writeFile(paths.preferencesPath, preferencesYaml, 'utf8');
  await writeFile(paths.profilePath, profileMarkdown, 'utf8');
  try {
    return await fn(paths);
  } finally {
    if (previousRoot === undefined) {
      delete process.env.WEJOBSEARCHDATAROOT;
    } else {
      process.env.WEJOBSEARCHDATAROOT = previousRoot;
    }
    await rm(dir, { recursive: true, force: true });
  }
}

describe('buildProfileQueries', () => {
  it('quotes each target role with the top three skills', () => {
    expect(buildProfileQueries(['Senior Engineer'], ['TypeScript', 'Python', 'Rust', 'Go'])).toEqual([
      '"Senior Engineer" TypeScript Python Rust',
    ]);
  });

  it('falls back to skills when no target roles exist', () => {
    expect(buildProfileQueries([], ['TypeScript'])).toEqual(['TypeScript']);
    expect(buildProfileQueries([], [])).toEqual([]);
  });
});

describe('runSearchBatch', () => {
  it('scrapes, dedups, evaluates, persists, and serves the retry from cache', async () => {
    await withSandbox(async (paths) => {
      const registry = makeRegistry([{ name: 'stubAlpha', postings: [posting()] }]);
      const first = await runSearchBatch('senior engineer', 'Remote', {
        registry,
      });
      expect(first.evaluatedCount).toBe(1);
      expect(first.newRecords).toBe(1);
      expect(first.servedFromCache).toBe(false);
      const second = await runSearchBatch('senior engineer', 'Remote', {
        registry,
      });
      expect(second.evaluatedCount).toBe(1);
      expect(second.alreadyRecorded).toBe(1);
      expect(second.servedFromCache).toBe(true);
      const history = await readApplicationHistory(paths.historyPath);
      expect(history.applications).toHaveLength(1);
    });
  });

  it('persists a 300-posting batch with one history write and does not fork a within-batch duplicate', async () => {
    await withSandbox(async (paths) => {
      const postings: RawPosting[] = [];
      for (let index = 1; index <= 300; index += 1) {
        postings.push(
          posting({
            companyName: `BatchCorp${index}`,
            roleTitle: `Staff Engineer ${index}`,
            jobUrl: `https://alpha.test/jobs/${index}`,
          }),
        );
      }
      // The same posting seen on a second source: one record, two aggregators.
      const duplicate: RawPosting = {
        ...postings[0],
        sourceAggregator: 'stubBeta',
        jobUrl: 'https://beta.test/jobs/1',
      };
      const registry = makeRegistry([
        { name: 'stubAlpha', postings },
        { name: 'stubBeta', postings: [duplicate] },
      ]);
      vi.mocked(writeFileAtomically).mockClear();
      const outcome = await runSearchBatch('staff engineer', 'Remote', { registry });
      expect(outcome.evaluatedCount).toBe(300);
      expect(outcome.newRecords).toBe(300);
      expect(outcome.alreadyRecorded).toBe(0);
      const historyWrites = vi
        .mocked(writeFileAtomically)
        .mock.calls.filter(([targetPath]) => targetPath.endsWith('applicationHistory.json'));
      expect(historyWrites).toHaveLength(1);
      const history = await readApplicationHistory(paths.historyPath);
      expect(history.applications).toHaveLength(300);
      const merged = history.applications.find((record) => record.companyName === 'BatchCorp1');
      expect(merged?.sourceAggregators.sort()).toEqual(['stubAlpha', 'stubBeta']);
    });
  });
});

describe('evaluateJobPosting', () => {
  it('evaluates one fetched URL and persists exactly one record', async () => {
    await withSandbox(async (paths) => {
      const strong = posting();
      const registry = new JobSpyAdapterRegistry();
      registry.register(
        new StubAdapter('stubAlpha', [], (url) => (url === strong.jobUrl ? strong : null)),
        undefined,
        new RateLimiter({ sourceName: 'stubAlpha', minDelayMs: 0, maxDelayMs: 0 }),
      );
      const outcome = await evaluateJobPosting(strong.jobUrl, {
        registry,
      });
      expect(outcome.posting.jobUrl).toBe(strong.jobUrl);
      expect(outcome.alreadyRecorded).toBe(false);
      const repeat = await evaluateJobPosting(strong.jobUrl, {
        registry,
      });
      expect(repeat.alreadyRecorded).toBe(true);
    });
  });

  it('surfaces the detail-unavailable error when a claiming adapter returns no detail', async () => {
    await withSandbox(async (paths) => {
      const registry = new JobSpyAdapterRegistry();
      registry.register(
        new StubAdapter('stubAlpha', []),
        undefined,
        new RateLimiter({ sourceName: 'stubAlpha', minDelayMs: 0, maxDelayMs: 0 }),
      );
      await expect(
        evaluateJobPosting('https://alpha.test/jobs/missing', {
          registry,
        }),
      ).rejects.toThrow('returned no posting detail');
    });
  });
});

describe('evaluateAndPersistPosting', () => {
  it('is idempotent across reruns of the same posting', async () => {
    await withSandbox(async (paths) => {
      const context = await resolveEvaluationContext({});
      const first = await evaluateAndPersistPosting(posting(), ['stubAlpha'], context, null);
      expect(first.alreadyRecorded).toBe(false);
      const second = await evaluateAndPersistPosting(posting(), ['stubAlpha'], context, null);
      expect(second.alreadyRecorded).toBe(true);
      const history = await readApplicationHistory(paths.historyPath);
      expect(history.applications).toHaveLength(1);
      const only = history.applications[0];
      expect(second.record.postingHash).toBe(only.postingHash);
      expect(second.record.applicationId).toBe(only.applicationId);
      expect(second.record.fitScore).toBe(only.fitScore);
      expect(second.record.sourceAggregators).toEqual(only.sourceAggregators);
      expect(first.record.postingHash).toBe(only.postingHash);
      expect(first.record.applicationId).toBe(only.applicationId);
      expect(first.record.fitScore).toBe(only.fitScore);
    });
  });

  it('reports a fuzzy duplicate as already present without writing a second record', async () => {
    await withSandbox(async (paths) => {
      const first = await runSearchBatch('staff engineer', 'Remote', {
        registry: makeRegistry([{ name: 'stubAlpha', postings: [posting()] }]),
      });
      expect(first.newRecords).toBe(1);
      const second = await runSearchBatch('staff eng', 'Remote', {
        registry: makeRegistry([
          { name: 'stubAlpha', postings: [posting({ roleTitle: 'Staff Eng' })] },
        ]),
      });
      expect(second.newRecords).toBe(0);
      expect(second.alreadyRecorded).toBe(1);
      const history = await readApplicationHistory(paths.historyPath);
      expect(history.applications).toHaveLength(1);
    });
  });
});

describe('searchJobPostings and searchByProfile', () => {
  it('renders both fixed result tables from the merged entries', async () => {
    await withSandbox(async (paths) => {
      const registry = makeRegistry([{ name: 'stubAlpha', postings: [posting()] }]);
      const outcome = await searchJobPostings('senior engineer', 'Remote', {
        registry,
      });
      expect(outcome.entries).toHaveLength(1);
      expect(outcome.activeResults.rows.length + outcome.excludedResults.rows.length).toBe(1);
      // Fixed 7/6-column cores, exact and without extras (SDD Requirement 2a).
      const onlyRow = [...outcome.activeResults.rows, ...outcome.excludedResults.rows][0];
      expect(onlyRow).toMatchObject({ organization: 'SampleCorp' });
      expect([...outcome.activeResults.columns]).toEqual([
        'Sr. No.',
        'Job Title',
        'Organization',
        'Brief',
        'Fit Score',
        'Justification',
        'Link',
      ]);
      expect([...outcome.excludedResults.columns]).toEqual([
        'Sr. No.',
        'Job Title',
        'Organization',
        'Fit Score',
        'Justification',
        'Link',
      ]);
    });
  });

  it('throws when the profile has no roles and no skills to search for', async () => {
    await withSandbox(async (paths) => {
      await writeFile(paths.profilePath, '# Empty\n', 'utf8');
      const registry = makeRegistry([]);
      await expect(
        searchByProfile({
          registry,
        }),
      ).rejects.toThrow('nothing to search for');
    });
  });

  it('returns empty tables when no saved searches exist', async () => {
    await withSandbox(async (paths) => {
      const registry = makeRegistry([]);
      const outcome = await runSavedSearchesDigest({
        registry,
      });
      expect(outcome.evaluatedCount).toBe(0);
    });
  });

  it('runs each saved search once and records no duplicates on rerun', async () => {
    await withSandbox(async (paths) => {
      await addSavedSearch({ keywords: 'staff engineer', location: 'Remote' });
      await addSavedSearch({ keywords: 'platform lead', location: 'Remote' });
      const registry = makeRegistry([
        {
          name: 'stubAlpha',
          postings: [
            posting({ roleTitle: 'Staff Engineer', jobUrl: 'https://alpha.test/jobs/1' }),
            posting({ roleTitle: 'Platform Lead', jobUrl: 'https://alpha.test/jobs/2' }),
          ],
        },
      ]);
      const first = await runSavedSearchesDigest({ registry });
      expect(first.newRecords).toBe(2);
      // Both saved searches hit the same stub postings: the second query
      // re-sees the two records the first query just persisted.
      expect(first.alreadyRecorded).toBe(2);
      const second = await runSavedSearchesDigest({ registry });
      expect(second.newRecords).toBe(0);
      expect(second.alreadyRecorded).toBeGreaterThan(0);
      const history = await readApplicationHistory(paths.historyPath);
      expect(history.applications).toHaveLength(2);
      const hashes = history.applications.map((record) => record.postingHash);
      expect(new Set(hashes).size).toBe(2);
    });
  });
});

describe('relocated dataRoot end to end (U42)', () => {
  it('searches, persists, and caches under an explicit dataRoot that differs from the environment', async () => {
    await withSandbox(async (paths) => {
      const relocated = await mkdtemp(join(tmpdir(), 'weJobSearch-u42-'));
      try {
        await writeFile(
          join(relocated, 'jobPreferences.yaml'),
          await readFile(paths.preferencesPath, 'utf8'),
          'utf8',
        );
        await writeFile(
          join(relocated, 'masterProfile.md'),
          await readFile(paths.profilePath, 'utf8'),
          'utf8',
        );
        const registry = makeRegistry([{ name: 'stubAlpha', postings: [posting()] }]);
        const outcome = await runSearchBatch('staff engineer', 'Remote', {
          registry,
          dataRoot: relocated,
        });
        expect(outcome.newRecords).toBe(1);
        expect(outcome.alreadyRecorded).toBe(0);
        const history = await readApplicationHistory(join(relocated, 'applications', 'applicationHistory.json'), relocated);
        expect(history.applications).toHaveLength(1);
      } finally {
        await rm(relocated, { recursive: true, force: true });
      }
    });
  });
});

describe('generateForRole single generate seam (Phase A)', () => {
  const variantsYaml =
    'variants:\n  usStandardResume:\n    template: templates/usStandardResume.typ\n    triggers: {}\n';

  // Full Jane Sample profile: generateResume requires populated contact
  // fields, which the minimal search-oriented sandbox profile lacks. Written
  // per-test so the other suites keep their existing fixture.
  const fullProfileMarkdown = `# Jane Sample

## Contact
- Name: Jane Sample
- Email: jane@sample.example
- City / State: Austin, TX

## Summary
Senior platform engineer with 8+ years of experience building distributed systems.

## Skills
- Languages: TypeScript, Rust, Python
- Infrastructure: AWS, Kubernetes, Docker, Terraform

## Experience
### Senior Engineer | SampleCorp | Remote
- Start: 2020
- End: 2026
- Built event-driven pipelines with Kafka.

## Education
### BS Computer Science | SampleState University
- Start: 2010
- End: 2014

## Certifications
- AWS Certified Developer
`;

  function cityRegistry(): JobSpyAdapterRegistry {
    const registry = new JobSpyAdapterRegistry();
    const fetcher = (url: string): RawPosting | null => {
      if (url === 'https://alpha.test/jobs/nyc') {
        return posting({ jobUrl: 'https://alpha.test/jobs/nyc', location: 'New York, NY' });
      }
      if (url === 'https://alpha.test/jobs/sfo') {
        return posting({ jobUrl: 'https://alpha.test/jobs/sfo', location: 'San Francisco, CA' });
      }
      return null;
    };
    registry.register(
      new StubAdapter('stubAlpha', [], fetcher),
      undefined,
      new RateLimiter({ sourceName: 'stubAlpha', minDelayMs: 0, maxDelayMs: 0 }),
    );
    return registry;
  }

  // Both seam tests drive a full Typst compile through generateForRole. On
  // machines without a system typst binary the WASM fallback compile can
  // exceed the 5s default timeout under full-suite parallel load, so the
  // tests carry an explicit budget.
  it('evaluating the same company and role in two cities yields two distinct records the seam marks together', async () => {
    await withSandbox(async (paths) => {
      await writeFile(join(paths.dir, 'resumeVariants.yaml'), variantsYaml, 'utf8');
      await writeFile(paths.profilePath, fullProfileMarkdown, 'utf8');
      const registry = cityRegistry();
      await evaluateJobPosting('https://alpha.test/jobs/nyc', { registry, dataRoot: paths.dir });
      await evaluateJobPosting('https://alpha.test/jobs/sfo', { registry, dataRoot: paths.dir });
      const before = await readApplicationHistory(paths.historyPath, paths.dir);
      expect(before.applications).toHaveLength(2);
      expect(before.applications[0].applicationId).toBe(before.applications[1].applicationId);
      expect(before.applications[0].postingHash).not.toBe(before.applications[1].postingHash);
      const outcome = await generateForRole('SampleCorp', 'Staff Engineer', { dataRoot: paths.dir });
      expect(outcome.result.variantName).toBe('usStandardResume');
      expect(outcome.markedApplicationIds).toHaveLength(2);
      expect(outcome.skippedApplicationIds).toHaveLength(0);
      const after = await readApplicationHistory(paths.historyPath, paths.dir);
      expect(after.applications).toHaveLength(2);
      expect(after.applications.every((record) => record.status === 'generated')).toBe(true);
      expect(
        after.applications.every((record) => record.resumeVariant === 'usStandardResume'),
      ).toBe(true);
    });
  }, 30000);

  it('re-generating after confirmation leaves the appliedConfirmed record intact', async () => {
    await withSandbox(async (paths) => {
      await writeFile(join(paths.dir, 'resumeVariants.yaml'), variantsYaml, 'utf8');
      await writeFile(paths.profilePath, fullProfileMarkdown, 'utf8');
      const registry = cityRegistry();
      await evaluateJobPosting('https://alpha.test/jobs/nyc', { registry, dataRoot: paths.dir });
      const confirmed = await confirmApplicationSubmission(
        'SampleCorp',
        'Staff Engineer',
        'Submitted via portal',
        { dataRoot: paths.dir },
      );
      expect(confirmed.record.status).toBe('appliedConfirmed');
      const outcome = await generateForRole('SampleCorp', 'Staff Engineer', { dataRoot: paths.dir });
      expect(outcome.result.variantName).toBe('usStandardResume');
      expect(outcome.markedApplicationIds).toHaveLength(0);
      expect(outcome.skippedApplicationIds).toHaveLength(1);
      const after = await readApplicationHistory(paths.historyPath, paths.dir);
      expect(after.applications).toHaveLength(1);
      expect(after.applications[0].status).toBe('appliedConfirmed');
      expect(after.applications[0].statusHistory.at(-1)?.stage).toBe('appliedConfirmed');
      expect(after.applications[0].resumeVariant).toBeUndefined();
    });
  }, 30000);
});
