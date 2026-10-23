import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { RawPosting, SourceAdapter } from '../scrapers/jobSpyAdapter';
import { JobSpyAdapterRegistry } from '../scrapers/jobSpyAdapter';
import { RateLimiter } from '../scrapers/rateLimiter';
import { readApplicationHistory } from '../utils/jobFunnelTracker';
import { generateApplicationId } from '../utils/jobFunnelTracker';
import { computePostingHash, logApplication } from '../utils/jobFunnelTracker';
import { readNetworkingContacts } from '../utils/networkingContacts';
import { addSavedSearch, readSavedSearches } from '../utils/savedSearches';
import { readSearchHistory } from '../utils/searchHistory';
import { redactHomePrefix } from '../utils/canonicalDataRoot';
import { createIsolatedDataRootFromFixtures } from '../testUtils/isolatedRoot';
import type { PromptContext } from './initWizard';
import {
  formatFatalError,
  formatImportDataSuccessLines,
  runDigestCommand,
  runDraftCoverLetter,
  runEvaluateCommand,
  runGenerate,
  runPreviewResumeCommand,
  runReviewCommand,
  runSearchBatch,
  runSearchCommand,
  runShowCommand,
  runUpdateStatusCommand,
  runValidateCommand,
} from './jobSearchCore';
import {
  buildProfileQueries,
  commandNames,
  dispatchCli,
  parseAddContactArgs,
  parseConfirmAppArgs,
  parseExportDataArgs,
  parseImportDataArgs,
  parseOutreachArgs,
  parsePdfArgs,
  parsePreviewResumeArgs,
  parseReportArgs,
  parseReviewQueueArgs,
  runAddContactCommand,
  runConfirmAppCommand,
  runDraftOutreachCommand,
  runExportDataCommand,
  runImportDataCommand,
  runParsePdfCommand,
  runReportCommand,
  runReviewQueueCommand,
  searchByProfile,
  searchJobPostings,
} from './jobSearchCore';

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

const preferencesWithTargetRolesYaml = `
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
targetRoles:
  - Senior Engineer
  - Staff Engineer
`;

const preferencesEmptyLocationsYaml = `
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
preferredLocations: []
`;

const profileMarkdown = `# Jane Sample

## Contact
- Email: jane@sample.example
- Location: Austin, TX

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

// Populated profile used by the resume preview tests (assertProfilePopulated
// requires name, cityState, and email; the search-pipeline profileMarkdown
// above is not resume-shaped).
const previewProfileMarkdown = `# Jane Sample

## Contact
- Name: Jane Sample
- Email: jane.sample@example.com
- Phone: +1 555 0100
- City / State: Austin, TX
- LinkedIn: https://linkedin.com/in/janesample
- Portfolio: https://janesample.dev

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

// Exact header lines (trailing cell border included) pinned per SDD Section
// 6.3, matching the strict formatter tests: the CLI renders the fixed
// 7-column and 6-column cores verbatim, so every assertion below compares
// whole header lines in order. A prefix match would let extra columns slip
// in after the last pinned cell; exact ordered equality fails loudly instead.
const activeHeaderLine = '| Sr. No. | Job Title | Organization | Brief | Fit Score | Justification | Link |';
const excludedHeaderLine = '| Sr. No. | Job Title | Organization | Fit Score | Justification | Link |';

function headerLinesOf(text: string): string[] {
  return text.split('\n').filter((line) => line.startsWith('| Sr. No.'));
}

interface StubAdapterDefinition {
  name: string;
  postings?: RawPosting[];
  fetcher?: (url: string) => RawPosting | null;
}

class StubAdapter implements SourceAdapter {
  readonly sourceName: string;

  private readonly postings: RawPosting[];

  private readonly fetcher: (url: string) => RawPosting | null;

  constructor(adapter: StubAdapterDefinition) {
    this.sourceName = adapter.name;
    this.postings = adapter.postings ?? [];
    this.fetcher = adapter.fetcher ?? (() => null);
  }

  async search(): Promise<RawPosting[]> {
    return [...this.postings];
  }

  async fetchPostingByUrl(url: string): Promise<RawPosting | null> {
    return this.fetcher(url);
  }
}

// Adapter that always fails, so tests can pin the mixed-success
// (Phase 6b) path: one source ok, one throwing.
class ThrowingAdapter implements SourceAdapter {
  readonly sourceName: string;

  attempts = 0;

  constructor(name: string) {
    this.sourceName = name;
  }

  async search(): Promise<RawPosting[]> {
    this.attempts += 1;
    throw new Error(`boom from ${this.sourceName}`);
  }

  async fetchPostingByUrl(): Promise<RawPosting | null> {
    return null;
  }
}

function makeRegistry(adapters: StubAdapterDefinition[]): JobSpyAdapterRegistry {
  const registry = new JobSpyAdapterRegistry();
  for (const adapter of adapters) {
    registry.register(
      new StubAdapter(adapter),
      undefined,
      new RateLimiter({ sourceName: adapter.name, minDelayMs: 0, maxDelayMs: 0 }),
    );
  }
  return registry;
}

// Adapter that records every keyword/location pair it is asked to search, so
// tests can assert the exact queries searchByProfile derives from the profile.
class RecordingAdapter implements SourceAdapter {
  readonly sourceName: string;

  readonly queries: string[] = [];

  private readonly postings: RawPosting[];

  constructor(name: string, postings: RawPosting[]) {
    this.sourceName = name;
    this.postings = postings;
  }

  async search(keywords: string, location: string): Promise<RawPosting[]> {
    this.queries.push(`${keywords}||${location}`);
    return [...this.postings];
  }

  async fetchPostingByUrl(): Promise<RawPosting | null> {
    return null;
  }
}

function makeRecordingRegistry(adapters: RecordingAdapter[]): JobSpyAdapterRegistry {
  const registry = new JobSpyAdapterRegistry();
  for (const adapter of adapters) {
    registry.register(
      adapter,
      undefined,
      new RateLimiter({ sourceName: adapter.sourceName, minDelayMs: 0, maxDelayMs: 0 }),
    );
  }
  return registry;
}

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

interface SandboxPaths {
  historyPath: string;
  preferencesPath: string;
  profilePath: string;
  profileName: string;
  savedSearchesPath: string;
  searchHistoryPath: string;
}

async function withSandbox<T>(fn: (paths: SandboxPaths) => Promise<T>): Promise<T> {
  const isolated = await createIsolatedDataRootFromFixtures();
  const dir = isolated.root;
  const paths: SandboxPaths = {
    historyPath: join(dir, 'applications', 'applicationHistory.json'),
    preferencesPath: join(dir, 'jobPreferences.yaml'),
    profilePath: join(dir, 'masterProfile.md'),
    profileName: join(dir, 'masterProfile.md'),
    savedSearchesPath: join(dir, 'savedSearches.json'),
    searchHistoryPath: join(dir, 'searchHistory.json'),
  };
  await writeFile(paths.preferencesPath, preferencesYaml, 'utf8');
  await writeFile(paths.profilePath, profileMarkdown, 'utf8');
  // withSandbox-based tests assert exact history counts, so drop the harness's
  // seeded fixture history: this sandbox starts empty, as before.
  await rm(paths.historyPath, { force: true });
  try {
    return await fn(paths);
  } finally {
    await isolated.restore();
  }
}

// Scripted PromptContext that returns answers in strict order and throws when
// the script runs out - a prompt-flow mismatch fails loudly, never hangs.
function scriptedPrompt(answers: readonly string[]): PromptContext {
  let index = 0;
  const printed: string[] = [];
  return {
    ask: async () => {
      if (index >= answers.length) {
        throw new Error(
          `Script ran out of answers after ${printed.length} printed lines: ${printed.join(' | ')}`,
        );
      }
      const value = answers[index];
      index += 1;
      return value ?? '';
    },
    print: (lines) => printed.push(...lines),
    close: () => undefined,
  };
}

describe('runSearchCommand', () => {
  it('searches every source, dedups, evaluates, persists, and renders BOTH fixed tables', async () => {
    await withSandbox(async ({ historyPath, preferencesPath, profilePath }) => {
      const strongAlpha = posting({
        roleTitle: 'Staff Engineer',
        jobUrl: 'https://alpha.test/jobs/1',
      });
      const strongBeta = posting({
        roleTitle: 'Staff Engineer',
        jobUrl: 'https://beta.test/jobs/99',
        sourceAggregator: 'stubBeta',
      });
      const reviewPosting = posting({
        roleTitle: 'Platform Lead',
        jobUrl: 'https://alpha.test/jobs/2',
        description: 'Owns the React frontend for our flagship product. 5+ years of experience.',
      });
      const weakPosting = posting({
        roleTitle: 'Ruby Automation Engineer',
        jobUrl: 'https://alpha.test/jobs/3',
        description:
          'Automation role requiring Ruby and Python. 4+ years of experience. Healthcare domain focus.',
        rawSalaryText: 'USD 120,000 - 140,000 per year',
      });
      const hardPosting = posting({
        roleTitle: 'Onsite Reliability Engineer',
        jobUrl: 'https://alpha.test/jobs/4',
        location: 'New York, NY',
        description: 'Reliability role in our New York office. Kubernetes and Docker a plus.',
        rawSalaryText: 'USD 200,000 - 240,000 per year',
      });
      const registry = makeRegistry([
        { name: 'stubAlpha', postings: [strongAlpha, reviewPosting, weakPosting, hardPosting] },
        { name: 'stubBeta', postings: [strongBeta] },
      ]);

      const result = await runSearchCommand({
        keywords: 'staff engineer',
        location: 'Remote',
        registry,
      });
      expect(result.exitCode).toBe(0);
      const text = result.printedLines.join('\n');

      expect(text).toContain('Active results:');
      expect(text).toContain('Excluded results:');
      expect(headerLinesOf(text)).toEqual([activeHeaderLine, excludedHeaderLine]);

      const staffCount = text.match(/Staff Engineer/g)?.length ?? 0;
      expect(staffCount).toBe(1);
      expect(text).toContain('Platform Lead');
      expect(text).toContain('Ruby Automation Engineer');
      expect(text).toContain('Onsite Reliability Engineer');

      const history = await readApplicationHistory(historyPath);
      expect(history.applications).toHaveLength(4);
      for (const record of history.applications) {
        expect(record.status).toBe('evaluated');
      }
      const staffRecord = history.applications.find((record) => record.roleTitle === 'Staff Engineer');
      expect(staffRecord).toBeDefined();
      expect(staffRecord?.sourceAggregators).toEqual(['stubAlpha', 'stubBeta']);
      expect(staffRecord?.fitStatus).toBe('strongFit');

      const rerun = await runSearchCommand({
        keywords: 'staff engineer',
        location: 'Remote',
        registry,
      });
      expect(rerun.exitCode).toBe(0);
      expect(rerun.printedLines.join('\n')).toContain('0 new record(s) logged, 4 already present');
      const historyAfterRerun = await readApplicationHistory(historyPath);
      expect(historyAfterRerun.applications).toHaveLength(4);
    });
  });

  it('renders both fixed table headers even when one side is empty', async () => {
    await withSandbox(async ({ historyPath, preferencesPath, profilePath }) => {
      const weakPosting = posting({
        roleTitle: 'Ruby Maintenance Engineer',
        jobUrl: 'https://alpha.test/jobs/5',
        description:
          'Maintenance role requiring Ruby. 4+ years of experience. Healthcare domain focus.',
        rawSalaryText: 'USD 130,000 - 150,000 per year',
      });
      const registry = makeRegistry([{ name: 'stubAlpha', postings: [weakPosting] }]);

      const result = await runSearchCommand({
        keywords: 'ruby',
        registry,
      });
      expect(result.exitCode).toBe(0);
      const text = result.printedLines.join('\n');
      expect(text).toContain('Active results:');
      expect(text).toContain('Excluded results:');
      // Both sides render their fixed cores with no trailing extras.
      expect(headerLinesOf(text)).toEqual([activeHeaderLine, excludedHeaderLine]);
    });
  });

  it('routes a keyword-less search through every profile query and keeps explicit keywords single-query', async () => {
    await withSandbox(async ({ historyPath, preferencesPath, profilePath }) => {
      await writeFile(preferencesPath, preferencesWithTargetRolesYaml, 'utf8');
      const profileAdapter = new RecordingAdapter('stubAlpha', []);
      const profileRegistry = makeRecordingRegistry([profileAdapter]);

      const profiled = await runSearchCommand({
        registry: profileRegistry,
      });
      expect(profiled.exitCode).toBe(0);
      // Two targetRoles entries produce two queries; nothing is sliced.
      expect(profileAdapter.queries).toHaveLength(2);
      expect(headerLinesOf(profiled.printedLines.join('\n'))).toEqual([activeHeaderLine, excludedHeaderLine]);

      const keywordAdapter = new RecordingAdapter('stubAlpha', []);
      const keywordRegistry = makeRecordingRegistry([keywordAdapter]);
      const keyworded = await runSearchCommand({
        keywords: 'staff engineer',
        registry: keywordRegistry,
      });
      expect(keyworded.exitCode).toBe(0);
      expect(keywordAdapter.queries).toHaveLength(1);

      // A keyword-less search with no roles and no skills fails loudly.
      await writeFile(preferencesPath, preferencesYaml, 'utf8');
      await writeFile(profilePath, '# Empty\n', 'utf8');
      const emptyRegistry = makeRegistry([{ name: 'stubAlpha', postings: [] }]);
      const empty = await runSearchCommand({
        registry: emptyRegistry,
      });
      expect(empty.exitCode).toBe(1);
      expect(empty.printedLines.join('\n')).toContain('nothing to search for');
    });
  });

  it('saves the search to savedSearches.json when --save is set', async () => {
    await withSandbox(async ({ historyPath, preferencesPath, profilePath, savedSearchesPath }) => {
      const registry = makeRegistry([{ name: 'stubAlpha', postings: [] }]);
      const result = await runSearchCommand({
        keywords: 'staff engineer',
        location: 'Remote',
        save: true,
        registry,
      });
      expect(result.exitCode).toBe(0);
      expect(result.printedLines.join('\n')).toContain("Saved search 'staff engineer' in 'Remote'.");
      const store = await readSavedSearches(savedSearchesPath);
      expect(store.searches).toHaveLength(1);
      expect(store.searches[0].keywords).toBe('staff engineer');
      expect(store.searches[0].location).toBe('Remote');
    });
  });

  it('fails cleanly when --save duplicates an existing search', async () => {
    await withSandbox(async ({ historyPath, preferencesPath, profilePath, savedSearchesPath }) => {
      await addSavedSearch({ keywords: 'staff engineer', location: 'Remote' }, savedSearchesPath);
      const registry = makeRegistry([{ name: 'stubAlpha', postings: [] }]);
      const result = await runSearchCommand({
        keywords: 'staff engineer',
        location: 'Remote',
        save: true,
        registry,
      });
      expect(result.exitCode).toBe(1);
      expect(result.printedLines.join('\n')).toContain('already exists');
    });
  });
});

describe('search filters (SRA-04)', () => {
  it('remoteOnly narrows the rendered set without affecting persistence', async () => {
    await withSandbox(async ({ historyPath, preferencesPath, profilePath }) => {
      const strongAlpha = posting({
        roleTitle: 'Staff Engineer',
        jobUrl: 'https://alpha.test/jobs/1',
      });
      const hardPosting = posting({
        roleTitle: 'Onsite Reliability Engineer',
        jobUrl: 'https://alpha.test/jobs/4',
        location: 'New York, NY',
        description: 'Reliability role in our New York office. Kubernetes and Docker a plus.',
        rawSalaryText: 'USD 200,000 - 240,000 per year',
      });
      const registry = makeRegistry([{ name: 'stubAlpha', postings: [strongAlpha, hardPosting] }]);

      const result = await runSearchCommand({
        keywords: 'staff engineer',
        remoteOnly: true,
        registry,
      });
      expect(result.exitCode).toBe(0);
      const text = result.printedLines.join('\n');
      expect(text).toContain('Filters: remoteOnly. Shown 1 of 2 evaluated posting(s).');
      expect(text).toContain('Staff Engineer');
      expect(text).not.toContain('Onsite Reliability Engineer');
      expect(headerLinesOf(text)).toEqual([activeHeaderLine, excludedHeaderLine]);

      const history = await readApplicationHistory(historyPath);
      expect(history.applications).toHaveLength(2);
    });
  });

  it('minFit narrows the rendered set to postings at or above the threshold', async () => {
    await withSandbox(async ({ historyPath, preferencesPath, profilePath }) => {
      const strongAlpha = posting({
        roleTitle: 'Staff Engineer',
        jobUrl: 'https://alpha.test/jobs/1',
      });
      const weakPosting = posting({
        roleTitle: 'Ruby Automation Engineer',
        jobUrl: 'https://alpha.test/jobs/3',
        description:
          'Automation role requiring Ruby and Python. 4+ years of experience. Healthcare domain focus.',
        rawSalaryText: 'USD 120,000 - 140,000 per year',
      });
      const registry = makeRegistry([{ name: 'stubAlpha', postings: [strongAlpha, weakPosting] }]);

      const result = await runSearchCommand({
        keywords: 'staff engineer',
        minFit: 3.5,
        registry,
      });
      expect(result.exitCode).toBe(0);
      const text = result.printedLines.join('\n');
      expect(text).toContain('Filters: minFit 3.5. Shown 1 of 2 evaluated posting(s).');
      expect(text).toContain('Staff Engineer');
      expect(text).not.toContain('Ruby Automation Engineer');
    });
  });

  it('minSalary narrows by the low end of the stated range and keeps salary-less postings', async () => {
    await withSandbox(async ({ historyPath, preferencesPath, profilePath }) => {
      const strongAlpha = posting({
        roleTitle: 'Staff Engineer',
        jobUrl: 'https://alpha.test/jobs/1',
        rawSalaryText: 'USD 160,000 - 190,000 per year',
      });
      const noSalary = posting({
        roleTitle: 'Platform Lead',
        jobUrl: 'https://alpha.test/jobs/2',
        rawSalaryText: undefined,
        description: 'Owns the React frontend for our flagship product. 5+ years of experience.',
      });
      const lowSalary = posting({
        roleTitle: 'Ruby Automation Engineer',
        jobUrl: 'https://alpha.test/jobs/3',
        description:
          'Automation role requiring Ruby and Python. 4+ years of experience. Healthcare domain focus.',
        rawSalaryText: 'USD 120,000 - 140,000 per year',
      });
      const registry = makeRegistry([{ name: 'stubAlpha', postings: [strongAlpha, noSalary, lowSalary] }]);

      const result = await runSearchCommand({
        keywords: 'staff engineer',
        minSalary: 150000,
        registry,
      });
      expect(result.exitCode).toBe(0);
      const text = result.printedLines.join('\n');
      expect(text).toContain('Filters: minSalary 150000. Shown 2 of 3 evaluated posting(s).');
      expect(text).toContain('Staff Engineer');
      expect(text).toContain('Platform Lead');
      expect(text).not.toContain('Ruby Automation Engineer');
    });
  });

  it('maxAgeDays narrows by posted date and keeps postings without a posted date', async () => {
    await withSandbox(async ({ historyPath, preferencesPath, profilePath }) => {
      const oldPosting = posting({
        roleTitle: 'Old Role',
        jobUrl: 'https://alpha.test/jobs/6',
        postedAt: new Date(Date.now() - 30 * 86_400_000).toISOString(),
      });
      const noDate = posting({
        roleTitle: 'Staff Engineer',
        jobUrl: 'https://alpha.test/jobs/1',
      });
      const registry = makeRegistry([{ name: 'stubAlpha', postings: [oldPosting, noDate] }]);

      const result = await runSearchCommand({
        keywords: 'staff engineer',
        maxAgeDays: 14,
        registry,
      });
      expect(result.exitCode).toBe(0);
      const text = result.printedLines.join('\n');
      expect(text).toContain('Filters: maxAgeDays 14. Shown 1 of 2 evaluated posting(s).');
      expect(text).toContain('Staff Engineer');
      expect(text).not.toContain('Old Role');
    });
  });
});

describe('buildProfileQueries', () => {
  it('builds one deterministic query per target role containing the role and top skills', () => {
    const queries = buildProfileQueries(['Senior Engineer'], ['TypeScript', 'React', 'Node.js', 'AWS']);
    expect(queries).toHaveLength(1);
    expect(queries[0]).toContain('Senior Engineer');
    expect(queries[0]).toContain('TypeScript');
    expect(queries[0]).toContain('React');
    // Deterministic: identical input yields identical output.
    expect(buildProfileQueries(['Senior Engineer'], ['TypeScript', 'React', 'Node.js', 'AWS'])).toEqual(queries);
  });

  it('builds one query per target role in profile order', () => {
    const queries = buildProfileQueries(['Senior Engineer', 'Staff Engineer'], ['TypeScript', 'React']);
    expect(queries).toHaveLength(2);
    expect(queries[0]).toContain('Senior Engineer');
    expect(queries[1]).toContain('Staff Engineer');
  });

  it('falls back to a skills-derived query when targetRoles is empty', () => {
    const queries = buildProfileQueries([], ['TypeScript', 'React', 'Node.js', 'AWS', 'Kubernetes', 'Docker']);
    expect(queries).toHaveLength(1);
    expect(queries[0]).toContain('TypeScript');
    expect(queries[0]).toContain('React');
  });

  it('returns an empty list when there are no target roles and no skills', () => {
    expect(buildProfileQueries([], [])).toEqual([]);
  });
});

describe('searchByProfile', () => {
  it('derives one query per target role and passes it to the registry', async () => {
    await withSandbox(async ({ historyPath, preferencesPath, profilePath }) => {
      await writeFile(preferencesPath, preferencesWithTargetRolesYaml, 'utf8');
      const adapter = new RecordingAdapter('stubAlpha', []);
      const registry = makeRecordingRegistry([adapter]);

      await searchByProfile({ registry });

      expect(adapter.queries).toHaveLength(2);
      expect(adapter.queries[0]).toContain('Senior Engineer');
      expect(adapter.queries[0]).toContain('TypeScript');
      expect(adapter.queries[1]).toContain('Staff Engineer');
      // Location comes from preferredLocations[0].
      expect(adapter.queries[0]).toContain('||Remote');
    });
  });

  it('merges results across queries, deduplicates, persists, and renders BOTH fixed tables', async () => {
    await withSandbox(async ({ historyPath, preferencesPath, profilePath }) => {
      await writeFile(preferencesPath, preferencesWithTargetRolesYaml, 'utf8');
      const shared = posting({ roleTitle: 'Staff Engineer', jobUrl: 'https://alpha.test/jobs/1' });
      const senior = posting({ roleTitle: 'Senior Engineer', jobUrl: 'https://alpha.test/jobs/2' });
      // Both queries hit the same adapter, so both return the same two postings.
      const registry = makeRegistry([{ name: 'stubAlpha', postings: [shared, senior] }]);

      const outcome = await searchByProfile({
        registry,
      });

      // Fixed 7/6-column cores with no trailing extras (SDD Requirement 2a).
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

      // Cross-query dedup: 2 queries x 2 postings = 4 raw evaluations, but the
      // merged set has exactly 2 unique postings (no duplicate applicationId).
      expect(outcome.entries).toHaveLength(2);
      const applicationIds = outcome.entries.map((entry) => `${entry.posting.companyName}${entry.posting.roleTitle}`);
      expect(new Set(applicationIds).size).toBe(2);
      expect(outcome.queries).toHaveLength(2);

      const history = await readApplicationHistory(historyPath);
      expect(history.applications).toHaveLength(2);
      expect(history.applications.every((record) => record.status === 'evaluated')).toBe(true);

      // Rerun is idempotent: nothing new recorded, history length unchanged.
      const rerun = await searchByProfile({
        registry,
      });
      expect(rerun.newRecords).toBe(0);
      expect(rerun.alreadyRecorded).toBeGreaterThan(0);
      expect(rerun.entries).toHaveLength(2);
      const rerunHistory = await readApplicationHistory(historyPath);
      expect(rerunHistory.applications).toHaveLength(2);
    });
  });

  it('falls back to a skills-derived query when targetRoles is empty', async () => {
    await withSandbox(async ({ historyPath, preferencesPath, profilePath }) => {
      // Default sandbox preferences have no targetRoles.
      const adapter = new RecordingAdapter('stubAlpha', []);
      const registry = makeRecordingRegistry([adapter]);

      const outcome = await searchByProfile({ registry });

      expect(adapter.queries).toHaveLength(1);
      expect(adapter.queries[0]).toContain('TypeScript');
      expect(outcome.entries).toEqual([]);
      expect(outcome.activeResults.columns).toHaveLength(7);
      expect(outcome.excludedResults.columns).toHaveLength(6);
    });
  });

  it('throws a clear error when the profile is missing', async () => {
    await withSandbox(async ({ historyPath, preferencesPath, profilePath }) => {
      await rm(profilePath);
      const registry = makeRegistry([{ name: 'stubAlpha', postings: [] }]);
      await expect(
        searchByProfile({ registry }),
      ).rejects.toThrow('No master profile found');
    });
  });

  it('never generates a resume, cover letter, or outreach', async () => {
    await withSandbox(async ({ historyPath, preferencesPath, profilePath }) => {
      await writeFile(preferencesPath, preferencesWithTargetRolesYaml, 'utf8');
      const registry = makeRegistry([{ name: 'stubAlpha', postings: [posting()] }]);

      await searchByProfile({ registry });

      // The applications tree holds only the history file - no per-role output.
      const applicationsDir = dirname(historyPath);
      expect(await readdir(applicationsDir)).toEqual(['applicationHistory.json']);
    });
  });
});

describe('searchJobPostings location defaulting (EUO-08)', () => {
  it('defaults an omitted or whitespace location to preferredLocations[0] before the cache lookup', async () => {
    await withSandbox(async ({ historyPath, preferencesPath, profilePath }) => {
      const adapter = new RecordingAdapter('stubAlpha', []);
      const registry = makeRecordingRegistry([adapter]);

      await searchJobPostings('staff engineer', '', {
        registry,
      });
      await searchJobPostings('platform engineer', '   ', {
        registry,
      });

      // The sandbox preferencesYaml has preferredLocations: [Remote]; the
      // adapter records the location it actually received.
      expect(adapter.queries).toHaveLength(2);
      expect(adapter.queries[0]).toContain('||Remote');
      expect(adapter.queries[1]).toContain('||Remote');
    });
  });

  it('lets an explicit location win over preferredLocations', async () => {
    await withSandbox(async ({ historyPath, preferencesPath, profilePath }) => {
      const adapter = new RecordingAdapter('stubAlpha', []);
      const registry = makeRecordingRegistry([adapter]);

      await searchJobPostings('staff engineer', 'New York', {
        registry,
      });

      expect(adapter.queries).toHaveLength(1);
      expect(adapter.queries[0]).toContain('||New York');
    });
  });

  it('proceeds with an empty location when preferredLocations is empty, without error', async () => {
    await withSandbox(async ({ historyPath, preferencesPath, profilePath }) => {
      await writeFile(preferencesPath, preferencesEmptyLocationsYaml, 'utf8');
      const adapter = new RecordingAdapter('stubAlpha', []);
      const registry = makeRecordingRegistry([adapter]);

      await searchJobPostings('staff engineer', '', {
        registry,
      });

      expect(adapter.queries).toHaveLength(1);
      expect(adapter.queries[0]).toContain('||');
    });
  });
});

describe('search result caching (SRA-06)', () => {
  it('serves an identical query from the cache without re-scraping, and still persists idempotently', async () => {
    await withSandbox(async ({ historyPath, preferencesPath, profilePath }) => {
      const registry = makeRegistry([{ name: 'stubAlpha', postings: [posting()] }]);
      const searchSpy = vi.spyOn(registry, 'searchAll');
      const dependencies = {
        registry,
      };

      const first = await runSearchBatch('staff engineer', 'Remote', dependencies);
      expect(first.newRecords).toBe(1);
      expect(searchSpy).toHaveBeenCalledTimes(1);

      const second = await runSearchBatch('staff engineer', 'Remote', dependencies);
      expect(second.entries).toHaveLength(1);
      expect(second.alreadyRecorded).toBe(1);
      expect(searchSpy).toHaveBeenCalledTimes(1);

      const third = await runSearchBatch('staff engineer', 'New York', dependencies);
      expect(third.entries).toHaveLength(1);
      expect(searchSpy).toHaveBeenCalledTimes(2);
    });
  });

  it('does not cache a scrape where a source errored, so the next run retries', async () => {
    await withSandbox(async ({ historyPath, preferencesPath, profilePath }) => {
      const registry = makeRegistry([{ name: 'stubAlpha', postings: [posting()] }]);
      const searchSpy = vi.spyOn(registry, 'searchAll');
      searchSpy.mockResolvedValueOnce([
        { sourceName: 'stubAlpha', postings: [], error: new Error('rate limited') },
      ]);
      const dependencies = {
        registry,
      };

      const first = await runSearchBatch('staff engineer', 'Remote', dependencies);
      expect(first.entries).toHaveLength(0);
      expect(searchSpy).toHaveBeenCalledTimes(1);

      // The errored scrape was not cached: the next identical query re-scrapes.
      const second = await runSearchBatch('staff engineer', 'Remote', dependencies);
      expect(second.entries).toHaveLength(1);
      expect(searchSpy).toHaveBeenCalledTimes(2);
    });
  });
});

describe('search partial-failure cache policy (Phase 6b)', () => {
  it('caches the successful subset on mixed success and serves it without re-hammering, loudly', async () => {
    await withSandbox(async ({ historyPath, preferencesPath, profilePath }) => {
      const registry = new JobSpyAdapterRegistry();
      registry.register(
        new StubAdapter({ name: 'stubAlpha', postings: [posting()] }),
        undefined,
        new RateLimiter({ sourceName: 'stubAlpha', minDelayMs: 0, maxDelayMs: 0 }),
      );
      const throwing = new ThrowingAdapter('stubBeta');
      registry.register(
        throwing,
        undefined,
        new RateLimiter({ sourceName: 'stubBeta', minDelayMs: 0, maxDelayMs: 0 }),
      );
      const searchSpy = vi.spyOn(registry, 'searchAll');
      const dependencies = {
        registry,
      };

      const first = await runSearchBatch('staff engineer', 'Remote', dependencies);
      expect(first.entries).toHaveLength(1);
      expect(first.servedFromCache).toBe(false);
      const betaFirst = first.results.find((source) => source.sourceName === 'stubBeta');
      expect(betaFirst?.error?.message).toContain('boom from stubBeta');

      // Immediate retry hits the partial cache instead of hammering the failed source.
      const second = await runSearchBatch('staff engineer', 'Remote', dependencies);
      expect(searchSpy).toHaveBeenCalledTimes(1);
      expect(throwing.attempts).toBe(1);
      expect(second.servedFromCache).toBe(true);
      expect(second.entries).toHaveLength(1);
      expect(second.alreadyRecorded).toBe(1);
      // The skipped source is still reported loudly, never silently dropped.
      const betaSecond = second.results.find((source) => source.sourceName === 'stubBeta');
      expect(betaSecond?.error?.message).toMatch(/skipped|partial|cache/i);
      expect(betaSecond?.postings).toEqual([]);
    });
  });

  it('still retries a total failure instead of caching an empty batch', async () => {
    await withSandbox(async ({ historyPath, preferencesPath, profilePath }) => {
      const throwing = new ThrowingAdapter('stubBeta');
      const registry = new JobSpyAdapterRegistry();
      registry.register(
        throwing,
        undefined,
        new RateLimiter({ sourceName: 'stubBeta', minDelayMs: 0, maxDelayMs: 0 }),
      );
      const searchSpy = vi.spyOn(registry, 'searchAll');
      const dependencies = {
        registry,
      };

      const first = await runSearchBatch('staff engineer', 'Remote', dependencies);
      expect(first.entries).toHaveLength(0);
      expect(first.servedFromCache).toBe(false);
      const second = await runSearchBatch('staff engineer', 'Remote', dependencies);
      expect(searchSpy).toHaveBeenCalledTimes(2);
      expect(throwing.attempts).toBe(2);
      expect(second.servedFromCache).toBe(false);
    });
  });
});

describe('search history persistence (EUO-13)', () => {
  it('records the resolved location and unique result count after a search', async () => {
    await withSandbox(async ({ historyPath, preferencesPath, profilePath, searchHistoryPath }) => {
      const registry = makeRegistry([
        {
          name: 'stubAlpha',
          postings: [
            posting({ roleTitle: 'Staff Engineer', jobUrl: 'https://alpha.test/jobs/1' }),
            posting({ roleTitle: 'Platform Lead', jobUrl: 'https://alpha.test/jobs/2' }),
          ],
        },
      ]);

      await searchJobPostings('staff engineer', '', {
        registry,
      });

      const history = await readSearchHistory(searchHistoryPath);
      expect(history.searches).toHaveLength(1);
      expect(history.searches[0].keywords).toBe('staff engineer');
      // EUO-08 resolution: the omitted location defaults to preferredLocations[0].
      expect(history.searches[0].location).toBe('Remote');
      expect(history.searches[0].resultCount).toBe(2);
      expect(history.searches[0].timestamp).toBeDefined();
    });
  });

  it('records on the cache-hit path too, updating the same entry rather than duplicating it', async () => {
    await withSandbox(async ({ historyPath, preferencesPath, profilePath, searchHistoryPath }) => {
      const registry = makeRegistry([{ name: 'stubAlpha', postings: [posting()] }]);
      const dependencies = {
        registry,
      };

      const first = await runSearchBatch('staff engineer', 'Remote', dependencies);
      expect(first.entries).toHaveLength(1);
      const second = await runSearchBatch('staff engineer', 'Remote', dependencies);
      expect(second.entries).toHaveLength(1);

      const history = await readSearchHistory(searchHistoryPath);
      expect(history.searches).toHaveLength(1);
      expect(history.searches[0].resultCount).toBe(1);
    });
  });
});

describe('runDigestCommand', () => {
  it('reports no saved searches with a helpful message and exit 0', async () => {
    await withSandbox(async ({ historyPath, preferencesPath, profilePath }) => {
      const registry = makeRegistry([{ name: 'stubAlpha', postings: [] }]);
      const result = await runDigestCommand({
        registry,
      });
      expect(result.exitCode).toBe(0);
      const text = result.printedLines.join('\n');
      expect(text).toContain('No saved searches yet.');
      expect(text).toContain('--save');
      expect(headerLinesOf(text)).toEqual([]);
    });
  });

  it('runs every saved search, dedups across searches, and renders BOTH fixed tables', async () => {
    await withSandbox(async ({ historyPath, preferencesPath, profilePath, savedSearchesPath }) => {
      await addSavedSearch({ keywords: 'staff engineer', location: 'Remote' }, savedSearchesPath);
      await addSavedSearch({ keywords: 'platform', location: 'Remote' }, savedSearchesPath);
      const strongAlpha = posting({
        roleTitle: 'Staff Engineer',
        jobUrl: 'https://alpha.test/jobs/1',
      });
      const reviewPosting = posting({
        roleTitle: 'Platform Lead',
        jobUrl: 'https://alpha.test/jobs/2',
        description: 'Owns the React frontend for our flagship product. 5+ years of experience.',
      });
      const weakPosting = posting({
        roleTitle: 'Ruby Automation Engineer',
        jobUrl: 'https://alpha.test/jobs/3',
        description:
          'Automation role requiring Ruby and Python. 4+ years of experience. Healthcare domain focus.',
        rawSalaryText: 'USD 120,000 - 140,000 per year',
      });
      const hardPosting = posting({
        roleTitle: 'Onsite Reliability Engineer',
        jobUrl: 'https://alpha.test/jobs/4',
        location: 'New York, NY',
        description: 'Reliability role in our New York office. Kubernetes and Docker a plus.',
        rawSalaryText: 'USD 200,000 - 240,000 per year',
      });
      const registry = makeRegistry([
        { name: 'stubAlpha', postings: [strongAlpha, reviewPosting, weakPosting, hardPosting] },
      ]);

      const result = await runDigestCommand({
        registry,
      });
      expect(result.exitCode).toBe(0);
      const text = result.printedLines.join('\n');
      expect(text).toContain('Digest of 2 saved search(es)');
      expect(headerLinesOf(text)).toEqual([activeHeaderLine, excludedHeaderLine]);
      const staffCount = text.match(/Staff Engineer/g)?.length ?? 0;
      expect(staffCount).toBe(1);
      expect(text).toContain('Platform Lead');
      expect(text).toContain('Ruby Automation Engineer');
      expect(text).toContain('Onsite Reliability Engineer');
      expect(text).toContain('4 new record(s) logged, 4 already present');

      const history = await readApplicationHistory(historyPath);
      expect(history.applications).toHaveLength(4);

      const rerun = await runDigestCommand({
        registry,
      });
      expect(rerun.exitCode).toBe(0);
      expect(rerun.printedLines.join('\n')).toContain('0 new record(s) logged, 8 already present');
      const historyAfterRerun = await readApplicationHistory(historyPath);
      expect(historyAfterRerun.applications).toHaveLength(4);
    });
  });
});

describe('runShowCommand', () => {
  it('prints the stored detail for an evaluated posting', async () => {
    await withSandbox(async ({ historyPath, preferencesPath, profilePath }) => {
      const strongPosting = posting({ jobUrl: 'https://alpha.test/jobs/8' });
      const registry = makeRegistry([{ name: 'stubAlpha', postings: [strongPosting] }]);
      await runSearchCommand({
        keywords: 'staff engineer',
        registry,
      });

      const result = await runShowCommand({
        companyName: 'SampleCorp',
        roleTitle: 'Staff Engineer',
      });
      expect(result.exitCode).toBe(0);
      const text = result.printedLines.join('\n');
      expect(text).toContain('Details for SampleCorp / Staff Engineer');
      expect(text).toContain('Fit score:');
      expect(text).toContain('strongFit');
      expect(text).toContain('Senior distributed systems role using TypeScript and Rust.');
      expect(text).toContain('Location type: remote');
      expect(text).toContain('evaluated @');
    });
  });

  it('errors clearly when the posting was never evaluated', async () => {
    const result = await runShowCommand({
      companyName: 'AcmeCorp',
      roleTitle: 'SeniorEngineer',
    });
    expect(result.exitCode).toBe(1);
    expect(result.printedLines.join('\n')).toContain('No application record found');
  });
});

describe('runReviewCommand', () => {
  it('prints the detail, skips without side effects, and applies via confirmApplicationSubmission', async () => {
    await withSandbox(async ({ historyPath, preferencesPath, profilePath }) => {
      const strongPosting = posting({ jobUrl: 'https://alpha.test/jobs/8' });
      const registry = makeRegistry([{ name: 'stubAlpha', postings: [strongPosting] }]);
      await runSearchCommand({
        keywords: 'staff engineer',
        registry,
      });

      const skip = await runReviewCommand(
        { companyName: 'SampleCorp', roleTitle: 'Staff Engineer' },
        { prompt: scriptedPrompt(['s']) },
      );
      expect(skip.exitCode).toBe(0);
      expect(skip.printedLines.join('\n')).toContain('Skipped. No action taken.');
      const historyAfterSkip = await readApplicationHistory(historyPath);
      expect(historyAfterSkip.applications[0].status).toBe('evaluated');

      const apply = await runReviewCommand(
        { companyName: 'SampleCorp', roleTitle: 'Staff Engineer' },
        { prompt: scriptedPrompt(['a', 'Submitted via Greenhouse']) },
      );
      expect(apply.exitCode).toBe(0);
      expect(apply.printedLines.join('\n')).toContain('confirmed');
      const historyAfterApply = await readApplicationHistory(historyPath);
      expect(historyAfterApply.applications[0].status).toBe('appliedConfirmed');
    });
  });

  it('errors clearly when the posting was never evaluated', async () => {
    const result = await runReviewCommand(
      { companyName: 'AcmeCorp', roleTitle: 'SeniorEngineer' },
      { prompt: scriptedPrompt([]) },
    );
    expect(result.exitCode).toBe(1);
    expect(result.printedLines.join('\n')).toContain('No application record found');
  });
});

describe('runUpdateStatusCommand', () => {
  it('transitions a posting to interviewing and appends history', async () => {
    await withSandbox(async ({ historyPath, preferencesPath, profilePath }) => {
      const strongPosting = posting({ jobUrl: 'https://alpha.test/jobs/8' });
      const registry = makeRegistry([{ name: 'stubAlpha', postings: [strongPosting] }]);
      await runSearchCommand({
        keywords: 'staff engineer',
        registry,
      });

      const result = await runUpdateStatusCommand({
        companyName: 'SampleCorp',
        roleTitle: 'Staff Engineer',
        status: 'interviewing',
        notes: 'Phone screen scheduled',
      });
      expect(result.exitCode).toBe(0);
      expect(result.printedLines.join('\n')).toContain('evaluated -> interviewing');
      const history = await readApplicationHistory(historyPath);
      expect(history.applications[0].status).toBe('interviewing');
      expect(history.applications[0].statusHistory).toHaveLength(2);
      expect(history.applications[0].statusHistory[1].notes).toBe('Phone screen scheduled');
    });
  });

  it('rejects appliedConfirmed as not settable here', async () => {
    await withSandbox(async ({ historyPath, preferencesPath, profilePath }) => {
      const strongPosting = posting({ jobUrl: 'https://alpha.test/jobs/8' });
      const registry = makeRegistry([{ name: 'stubAlpha', postings: [strongPosting] }]);
      await runSearchCommand({
        keywords: 'staff engineer',
        registry,
      });

      const result = await runUpdateStatusCommand({
        companyName: 'SampleCorp',
        roleTitle: 'Staff Engineer',
        status: 'appliedConfirmed',
      });
      expect(result.exitCode).toBe(1);
      expect(result.printedLines.join('\n')).toContain('confirmApplicationSubmission');
    });
  });

  it('rejects unknown status values with a readable error', async () => {
    const result = await runUpdateStatusCommand({
      companyName: 'SampleCorp',
      roleTitle: 'Staff Engineer',
      status: 'ghosted',
    });
    expect(result.exitCode).toBe(1);
    expect(result.printedLines.join('\n')).toContain("Unknown status 'ghosted'");
  });

  it('errors clearly when the posting was never evaluated', async () => {
    const result = await runUpdateStatusCommand({
      companyName: 'AcmeCorp',
      roleTitle: 'SeniorEngineer',
      status: 'offer',
    });
    expect(result.exitCode).toBe(1);
    expect(result.printedLines.join('\n')).toContain('No application record found');
  });
});

describe('show/review/updateStatus/confirmApp dataRoot relocation (U13)', () => {
  async function seedIsolatedRoot(): Promise<{ dir: string; historyPath: string }> {
    const dir = await mkdtemp(join(tmpdir(), 'weJobSearch-u13-'));
    const historyPath = join(dir, 'applications', 'applicationHistory.json');
    await logApplication(
      {
        applicationId: generateApplicationId('SampleCorp', 'Staff Engineer'),
        companyName: 'SampleCorp',
        roleTitle: 'Staff Engineer',
        jobUrl: 'https://alpha.test/jobs/8',
        postingHash: computePostingHash('SampleCorp', 'Staff Engineer', 'Remote'),
        sourceAggregators: ['stubAlpha'],
        salaryRange: null,
        fitScore: 4.2,
        fitStatus: 'strongFit',
        referralContact: null,
        status: 'evaluated',
        statusHistory: [{ stage: 'evaluated', timestamp: new Date().toISOString() }],
      },
      historyPath,
      dir,
    );
    return { dir, historyPath };
  }

  it('show honors an isolated dataRoot and ignores the ambient one', async () => {
    await withSandbox(async () => {
      const { dir } = await seedIsolatedRoot();
      try {
        const found = await runShowCommand({
          companyName: 'SampleCorp',
          roleTitle: 'Staff Engineer',
          dataRoot: dir,
        });
        expect(found.exitCode).toBe(0);
        expect(found.printedLines.join('\n')).toContain('Details for SampleCorp / Staff Engineer');
        const missing = await runShowCommand({
          companyName: 'SampleCorp',
          roleTitle: 'Staff Engineer',
        });
        expect(missing.exitCode).toBe(1);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  it('review honors an isolated dataRoot', async () => {
    await withSandbox(async () => {
      const { dir, historyPath } = await seedIsolatedRoot();
      try {
        const skip = await runReviewCommand(
          { companyName: 'SampleCorp', roleTitle: 'Staff Engineer', dataRoot: dir },
          { prompt: scriptedPrompt(['s']) },
        );
        expect(skip.exitCode).toBe(0);
        expect(skip.printedLines.join('\n')).toContain('Skipped. No action taken.');
        const history = await readApplicationHistory(historyPath, dir);
        expect(history.applications).toHaveLength(1);
        expect(history.applications[0].status).toBe('evaluated');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  it('updateStatus honors an isolated dataRoot', async () => {
    await withSandbox(async () => {
      const { dir, historyPath } = await seedIsolatedRoot();
      try {
        const result = await runUpdateStatusCommand({
          companyName: 'SampleCorp',
          roleTitle: 'Staff Engineer',
          status: 'interviewing',
          notes: 'Phone screen scheduled',
          dataRoot: dir,
        });
        expect(result.exitCode).toBe(0);
        expect(result.printedLines.join('\n')).toContain('evaluated -> interviewing');
        const history = await readApplicationHistory(historyPath, dir);
        expect(history.applications[0].status).toBe('interviewing');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  it('confirmApp honors an isolated dataRoot', async () => {
    await withSandbox(async () => {
      const { dir, historyPath } = await seedIsolatedRoot();
      try {
        const result = await runConfirmAppCommand({
          company: 'SampleCorp',
          role: 'Staff Engineer',
          notes: 'Submitted via portal',
          dataRoot: dir,
        });
        expect(result.exitCode).toBe(0);
        expect(result.printedLines.join('\n')).toContain('confirmed');
        const history = await readApplicationHistory(historyPath, dir);
        expect(history.applications[0].status).toBe('appliedConfirmed');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });
});

describe('runPreviewResumeCommand', () => {
  it('renders the profile through the Typst pipeline without a target role', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'weJobSearch-preview-'));
    const previousRootStandalone = process.env.WEJOBSEARCHDATAROOT;
    process.env.WEJOBSEARCHDATAROOT = dir;
    try {
      const profilePath = join(dir, 'masterProfile.md');
      const variantsPath = join(dir, 'resumeVariants.yaml');
      const outputDirectory = join(dir, 'previews');
      await writeFile(profilePath, previewProfileMarkdown, 'utf8');
      await writeFile(variantsPath, previewVariantsYaml, 'utf8');
      const result = await runPreviewResumeCommand({
        variant: 'usDetailedResume',
      });
      expect(result.exitCode).toBe(0);
      const text = result.printedLines.join('\n');
      expect(text).toContain('Resume preview generated.');
      expect(text).toContain('Variant: usDetailedResume');
      expect(text).toContain('Pages: 1');
      expect(text).toContain(outputDirectory);
      const files = await readdir(outputDirectory);
      expect(files).toContain('previewResume.pdf');
      expect(files).toContain('previewResume.typ');
    } finally {
      if (typeof previousRootStandalone === 'undefined' || previousRootStandalone === undefined) {
        delete process.env.WEJOBSEARCHDATAROOT;
      } else {
        process.env.WEJOBSEARCHDATAROOT = previousRootStandalone;
      }
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('parses previewResume flags from argv-style strings', () => {
    const parsed = parsePreviewResumeArgs([
      '--variant',
      'usDetailedResume',
      '--profile',
      'p.md',
      '--resumeVariantsPath',
      'v.yaml',
      '--outputDirectory',
      'out',
      '--help',
    ]);
    expect(parsed.variant).toBe('usDetailedResume');
    expect(parsed.help).toBe(true);
  });

  it('routes previewResume through dispatchCli without chaining into generate', async () => {
    const result = await dispatchCli(['previewResume', '--help']);
    expect(result.exitCode).toBe(0);
    expect(result.printedLines.join('\n')).toContain('previewResume - render a 1-page resume preview');
  });
});

describe('runEvaluateCommand', () => {
  it('fetches one posting by URL, evaluates, persists, and is idempotent on rerun', async () => {
    await withSandbox(async ({ historyPath, preferencesPath, profilePath }) => {
      const strongPosting = posting({ jobUrl: 'https://alpha.test/jobs/8' });
      const registry = makeRegistry([
        {
          name: 'stubAlpha',
          postings: [],
          fetcher: (url) => (url === 'https://alpha.test/jobs/8' ? strongPosting : null),
        },
      ]);

      const first = await runEvaluateCommand({
        jobUrl: 'https://alpha.test/jobs/8',
        registry,
      });
      expect(first.exitCode).toBe(0);
      const firstText = first.printedLines.join('\n');
      expect(firstText).toContain('Logged to applicationHistory.json with status evaluated.');
      expect(headerLinesOf(firstText)).toEqual([activeHeaderLine]);
      expect(firstText).toContain('Staff Engineer');

      const history = await readApplicationHistory(historyPath);
      expect(history.applications).toHaveLength(1);
      expect(history.applications[0].status).toBe('evaluated');

      const second = await runEvaluateCommand({
        jobUrl: 'https://alpha.test/jobs/8',
        registry,
      });
      expect(second.exitCode).toBe(0);
      expect(second.printedLines.join('\n')).toContain('Already present in application history');

      const historyAfterRerun = await readApplicationHistory(historyPath);
      expect(historyAfterRerun.applications).toHaveLength(1);
    });
  });

  it('renders the seven-column Active core for a single strongFit posting', async () => {
    await withSandbox(async ({ historyPath, preferencesPath, profilePath }) => {
      const strong = posting({ roleTitle: 'Backend Engineer', jobUrl: 'https://alpha.test/jobs/9' });
      const registry = makeRegistry([{ name: 'stubAlpha', postings: [], fetcher: () => strong }]);
      const result = await runEvaluateCommand({
        jobUrl: 'https://alpha.test/jobs/9',
        registry,
      });
      expect(result.exitCode).toBe(0);
      const text = result.printedLines.join('\n');
      expect(headerLinesOf(text)).toEqual([activeHeaderLine]);
      expect(text).toContain('Backend Engineer');
      expect(text).not.toContain('Excluded results:');
    });
  });

  it('returns a clear error for an unsupported posting URL', async () => {
    await withSandbox(async ({ preferencesPath, profilePath }) => {
      const registry = makeRegistry([]);
      const result = await runEvaluateCommand({
        jobUrl: 'https://unknown.example/jobs/7',
        registry,
      });
      expect(result.exitCode).toBe(1);
      expect(result.printedLines.join('\n')).toContain(
        'No registered adapter can fetch a single posting',
      );
    });
  });
});

describe('runAddContactCommand', () => {
  it('logs a contact to a networkingContacts.json file with generated id and defaults', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'weJobSearch-addcontact-'));
    const previousRootStandalone = process.env.WEJOBSEARCHDATAROOT;
    process.env.WEJOBSEARCHDATAROOT = dir;
    try {
      const contactsPath = join(dir, 'networkingContacts.json');
      const result = await runAddContactCommand({
        name: 'Jane Sample',
        company: 'SampleCorp',
        relationship: 'formerColleague',
      });
      expect(result.exitCode).toBe(0);
      expect(result.printedLines.join('\n')).toContain('Contact logged: Jane Sample (SampleCorp)');
      expect(result.printedLines.join('\n')).toContain('Contact ID: contact001');
      const contacts = await readNetworkingContacts(contactsPath);
      expect(contacts.contacts).toHaveLength(1);
      expect(contacts.contacts[0].contactId).toBe('contact001');
      expect(contacts.contacts[0].relationship).toBe('formerColleague');
      expect(contacts.contacts[0].linkedApplicationIds).toEqual([]);
      expect(contacts.contacts[0].followUpDue).toBe('');
    } finally {
      if (typeof previousRootStandalone === 'undefined' || previousRootStandalone === undefined) {
        delete process.env.WEJOBSEARCHDATAROOT;
      } else {
        process.env.WEJOBSEARCHDATAROOT = previousRootStandalone;
      }
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('accepts linkedApplicationIds and followUpDue flags', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'weJobSearch-addcontact-'));
    const previousRootStandalone = process.env.WEJOBSEARCHDATAROOT;
    process.env.WEJOBSEARCHDATAROOT = dir;
    try {
      const contactsPath = join(dir, 'networkingContacts.json');
      const result = await runAddContactCommand({
        name: 'Dev Ross',
        company: 'BetaLabs',
        relationship: 'recruiter',
        linkedApplicationIds: 'app2026BetaLabsBackend,app2026BetaLabsInfra',
        followUpDue: '2026-09-01',
      });
      expect(result.exitCode).toBe(0);
      const contacts = await readNetworkingContacts(contactsPath);
      expect(contacts.contacts[0].linkedApplicationIds).toEqual([
        'app2026BetaLabsBackend',
        'app2026BetaLabsInfra',
      ]);
      expect(contacts.contacts[0].followUpDue).toBe('2026-09-01');
    } finally {
      if (typeof previousRootStandalone === 'undefined' || previousRootStandalone === undefined) {
        delete process.env.WEJOBSEARCHDATAROOT;
      } else {
        process.env.WEJOBSEARCHDATAROOT = previousRootStandalone;
      }
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('fails loudly when name or company is missing', async () => {
    const result = await runAddContactCommand({ name: '', company: 'X' });
    expect(result.exitCode).toBe(1);
    expect(result.printedLines.join('\n')).toContain('addContact requires --name and --company.');
  });

  it('parses flags from argv-style strings (SDD Section 4.1 signature)', () => {
    expect(parseAddContactArgs(['--name', 'Jane Smith', '--company', 'AcmeCorp', '--relationship', 'formerColleague', '--followUpDue', '2026-08-20'])).toEqual({
      name: 'Jane Smith',
      company: 'AcmeCorp',
      relationship: 'formerColleague',
      followUpDue: '2026-08-20',
    });
    expect(parseAddContactArgs(['--help']).help).toBe(true);
  });
});

describe('runReportCommand', () => {
  it('renders a funnel table from both files and covers the mandated report inputs', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'weJobSearch-report-'));
    const previousRootStandalone = process.env.WEJOBSEARCHDATAROOT;
    process.env.WEJOBSEARCHDATAROOT = dir;
    try {
      await mkdir(join(dir, 'applications'), { recursive: true });
      const historyPath = join(dir, 'applications', 'applicationHistory.json');
      const contactsPath = join(dir, 'networkingContacts.json');
      const searchHistoryPath = join(dir, 'searchHistory.json');
      const referenceDate = '2026-08-08';
      await writeFile(
        historyPath,
        JSON.stringify({
          applications: [
            {
              applicationId: 'app2026SampleCorpStrong',
              companyName: 'SampleCorp',
              roleTitle: 'Strong Engineer',
              jobUrl: 'https://example.com/s',
              postingHash: 'h1',
              sourceAggregators: ['test'],
              salaryRange: null,
              fitScore: 4.2,
              fitStatus: 'strongFit',
              referralContact: 'contact001',
              status: 'evaluated',
              statusHistory: [{ stage: 'evaluated', timestamp: '2026-08-01T10:00:00Z' }],
            },
            {
              applicationId: 'app2026SampleColdManual',
              companyName: 'SampleCorp',
              roleTitle: 'Manual Reviewer',
              jobUrl: 'https://example.com/manual',
              postingHash: 'h2',
              sourceAggregators: ['test'],
              fitScore: 2.9,
              fitStatus: 'manualReview',
              referralContact: null,
              status: 'evaluated',
              statusHistory: [{ stage: 'evaluated', timestamp: '2026-08-02T10:00:00Z' }],
            },
            {
              applicationId: 'app2026HashStale',
              companyName: 'HashCorp',
              roleTitle: 'Hash Engineering',
              jobUrl: 'https://example.com/stale',
              postingHash: 'h3',
              sourceAggregators: ['test'],
              fitScore: 3.8,
              fitStatus: 'strongFit',
              referralContact: 'contact001',
              status: 'appliedConfirmed',
              statusHistory: [
                { stage: 'evaluated', timestamp: '2026-04-01T10:00:00Z' },
                { stage: 'appliedConfirmed', timestamp: '2026-04-12T10:00:00Z' },
              ],
            },
          ],
        }),
        'utf8',
      );
      await writeFile(
        contactsPath,
        JSON.stringify({
          contacts: [
            {
              contactId: 'contact001',
              name: 'Jane Sample',
              company: 'SampleCorp',
              relationship: 'formerColleague',
              lastContactDate: '2026-06-01',
              linkedApplicationIds: [],
              followUpDue: '2026-08-02',
            },
          ],
        }),
        'utf8',
      );
      // Run report against the real current date; override staleness by using
      // an explicit large/in-application data so the table still renders.
      const result = await runReportCommand({});
      expect(result.exitCode).toBe(0);
      const text = result.printedLines.join('\n');
      expect(text).toContain('Funnel report');
      expect(text).toContain('By fit status:');
      expect(text).toContain('strongFit');
      expect(text).toContain('manualReview');
      expect(text).toContain('By application status:');
      expect(text).toContain('Referral-linked vs. cold-apply conversion:');
      expect(text).toContain('Applications awaiting manualReview action');
    } finally {
      if (typeof previousRootStandalone === 'undefined' || previousRootStandalone === undefined) {
        delete process.env.WEJOBSEARCHDATAROOT;
      } else {
        process.env.WEJOBSEARCHDATAROOT = previousRootStandalone;
      }
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('renders JSON format when requested', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'weJobSearch-report-'));
    const previousRootStandalone = process.env.WEJOBSEARCHDATAROOT;
    process.env.WEJOBSEARCHDATAROOT = dir;
    try {
      await mkdir(join(dir, 'applications'), { recursive: true });
      const historyPath = join(dir, 'applications', 'applicationHistory.json');
      const contactsPath = join(dir, 'networkingContacts.json');
      const searchHistoryPath = join(dir, 'searchHistory.json');
      await writeFile(historyPath, JSON.stringify({ applications: [] }), 'utf8');
      await writeFile(contactsPath, JSON.stringify({ contacts: [] }), 'utf8');
      const result = await runReportCommand({ format: 'json' });
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.printedLines.join('\n'));
      expect(parsed.totalApplications).toBe(0);
      expect(parsed.fitStatusCounts.strongFit).toBe(0);
      expect(parsed.referralConversion.coldApply.conversionRate).toBeNull();
    } finally {
      if (typeof previousRootStandalone === 'undefined' || previousRootStandalone === undefined) {
        delete process.env.WEJOBSEARCHDATAROOT;
      } else {
        process.env.WEJOBSEARCHDATAROOT = previousRootStandalone;
      }
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects an unknown format', async () => {
    const result = await runReportCommand({ format: 'xml' });
    expect(result.exitCode).toBe(1);
    expect(result.printedLines.join('\n')).toContain("report --format must be 'table' or 'json'");
  });

  it('parses --format flag', () => {
    expect(parseReportArgs(['--format', 'json', '--historyPath', 'x'])).toEqual({
      format: 'json',
    });
  });
});

describe('runReviewQueueCommand', () => {
  it('surfaces only manualReview applications from history', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'weJobSearch-reviewqueue-'));
    const previousRootStandalone = process.env.WEJOBSEARCHDATAROOT;
    process.env.WEJOBSEARCHDATAROOT = dir;
    try {
      await mkdir(join(dir, 'applications'), { recursive: true });
      const historyPath = join(dir, 'applications', 'applicationHistory.json');
      await writeFile(
        historyPath,
        JSON.stringify({
          applications: [
            {
              applicationId: 'app2026SamplePlateReviewer',
              companyName: 'SampleCorp',
              roleTitle: 'Manual Reviewer',
              jobUrl: 'https://example.com/manual',
              postingHash: 'h1',
              sourceAggregators: ['test'],
              fitScore: 2.9,
              fitStatus: 'manualReview',
              status: 'evaluated',
              statusHistory: [{ stage: 'evaluated', timestamp: '2026-08-08T10:00:00Z' }],
            },
            {
              applicationId: 'appStrong',
              companyName: 'SampleCorp',
              roleTitle: 'Strong Role',
              jobUrl: 'https://example.com/strong',
              postingHash: 'h2',
              sourceAggregators: ['test'],
              fitScore: 4.1,
              fitStatus: 'strongFit',
              status: 'evaluated',
              statusHistory: [{ stage: 'evaluated', timestamp: '2026-08-08T11:00:00Z' }],
            },
          ],
        }),
        'utf8',
      );
      const result = await runReviewQueueCommand({});
      expect(result.exitCode).toBe(0);
      const text = result.printedLines.join('\n');
      expect(text).toContain('1 application(s) awaiting a human decision');
      expect(text).toContain('Manual Reviewer');
      expect(text).not.toContain('Strong Role');
      expect(text).toContain('Application ID');
      expect(text).toContain('app2026');
    } finally {
      if (typeof previousRootStandalone === 'undefined' || previousRootStandalone === undefined) {
        delete process.env.WEJOBSEARCHDATAROOT;
      } else {
        process.env.WEJOBSEARCHDATAROOT = previousRootStandalone;
      }
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('prints an empty-state message when nothing is awaiting review', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'weJobSearch-reviewqueue-'));
    const previousRootStandalone = process.env.WEJOBSEARCHDATAROOT;
    process.env.WEJOBSEARCHDATAROOT = dir;
    try {
      await mkdir(join(dir, 'applications'), { recursive: true });
      const historyPath = join(dir, 'applications', 'applicationHistory.json');
      await writeFile(historyPath, JSON.stringify({ applications: [] }), 'utf8');
      const result = await runReviewQueueCommand({});
      expect(result.exitCode).toBe(0);
      expect(result.printedLines.join('\n')).toContain('No applications are awaiting a human decision');
    } finally {
      if (typeof previousRootStandalone === 'undefined' || previousRootStandalone === undefined) {
        delete process.env.WEJOBSEARCHDATAROOT;
      } else {
        process.env.WEJOBSEARCHDATAROOT = previousRootStandalone;
      }
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('parses the history path flag', () => {
    expect(parseReviewQueueArgs(['--historyPath', 'x'])).toEqual({});
  });
});

const outreachProfileMarkdown = `# Jordan Reyes

## Contact
- Name: Jordan Reyes
- Email: jordan.reyes@example.com
- Phone: +1 555 0199
- City / State: Denver, CO
- LinkedIn: https://linkedin.com/in/jordanreyes

## Summary
Site reliability engineer with deep experience in Kubernetes, distributed systems, and incident response.

## Skills
- Languages: TypeScript, Go, Rust
- Platforms: Kubernetes, AWS, GCP

## Experience
### Staff Site Reliability Engineer | TerraformCloud | Denver, CO
- Start: 2020-04
- End: Present
- Ran the migration of 40 microservices onto GKE across three regions.

## Education
### MS Computer Science | Colorado School of Mines
- Start: 2014
- End: 2016
`;

const outreachContactsJson = JSON.stringify({
  contacts: [
    {
      contactId: 'contact001',
      name: 'Sam Rivera',
      company: 'SampleCorp',
      relationship: 'formerColleague',
      lastContactDate: '2026-07-01',
      linkedApplicationIds: [],
      followUpDue: '2026-08-20',
    },
  ],
});

describe('runDraftOutreachCommand', () => {
  it('drafts outreachMessage.md only, addressing the contact, and never writes resume or cover letter', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'weJobSearch-outreach-'));
    const previousRootStandalone = process.env.WEJOBSEARCHDATAROOT;
    process.env.WEJOBSEARCHDATAROOT = dir;
    try {
      const contactsPath = join(dir, 'networkingContacts.json');
      const profilePath = join(dir, 'masterProfile.md');
      const outputDirectory = join(dir, 'applications');
      await writeFile(contactsPath, outreachContactsJson, 'utf8');
      await writeFile(profilePath, outreachProfileMarkdown, 'utf8');

      const result = await runDraftOutreachCommand({
        contactId: 'contact001',
        company: 'AcmeCorp',
        role: 'SeniorMle',
        platform: 'linkedin',
      });
      expect(result.exitCode).toBe(0);
      const text = result.printedLines.join('\n');
      expect(text).toContain('Outreach message drafted for Sam Rivera (contactId contact001)');
      expect(text).toContain('Platform: linkedin');
      const outp = await readFile(join(outputDirectory, 'AcmeCorp-SeniorMle', 'outreachMessage.md'), 'utf8');
      expect(outp).toContain('Hi Sam,');
      expect(outp).not.toContain('Subject:');
      const folder = await readdir(join(outputDirectory, 'AcmeCorp-SeniorMle'));
      // Only the outreach draft exists: no resume, no cover letter, nothing else.
      expect(folder).toEqual(['outreachMessage.md']);
    } finally {
      if (typeof previousRootStandalone === 'undefined' || previousRootStandalone === undefined) {
        delete process.env.WEJOBSEARCHDATAROOT;
      } else {
        process.env.WEJOBSEARCHDATAROOT = previousRootStandalone;
      }
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('supports the cold-email --platform variant', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'weJobSearch-outreach-'));
    const previousRootStandalone = process.env.WEJOBSEARCHDATAROOT;
    process.env.WEJOBSEARCHDATAROOT = dir;
    try {
      const contactsPath = join(dir, 'networkingContacts.json');
      const profilePath = join(dir, 'masterProfile.md');
      await writeFile(contactsPath, outreachContactsJson, 'utf8');
      await writeFile(profilePath, outreachProfileMarkdown, 'utf8');
      const outputDirectory = join(dir, 'applications');
      const result = await runDraftOutreachCommand({
        contactId: 'contact001',
        company: 'AcmeCorp',
        role: 'SeniorMle',
        platform: 'email',
      });
      expect(result.exitCode).toBe(0);
      const outp = await readFile(join(outputDirectory, 'AcmeCorp-SeniorMle', 'outreachMessage.md'), 'utf8');
      expect(outp).toContain('Subject: SeniorMle role at AcmeCorp');
    } finally {
      if (typeof previousRootStandalone === 'undefined' || previousRootStandalone === undefined) {
        delete process.env.WEJOBSEARCHDATAROOT;
      } else {
        process.env.WEJOBSEARCHDATAROOT = previousRootStandalone;
      }
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('returns a clear error for an unknown contactId instead of a generic draft', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'weJobSearch-outreach-'));
    const previousRootStandalone = process.env.WEJOBSEARCHDATAROOT;
    process.env.WEJOBSEARCHDATAROOT = dir;
    try {
      const contactsPath = join(dir, 'networkingContacts.json');
      await writeFile(contactsPath, outreachContactsJson, 'utf8');
      const result = await runDraftOutreachCommand({
        contactId: 'contact404',
        company: 'AcmeCorp',
        role: 'SeniorMle',
      });
      expect(result.exitCode).toBe(1);
      expect(result.printedLines.join('\n')).toContain("No networking contact with contactId 'contact404'");
      expect(result.printedLines.join('\n')).toContain('Known contactIds: contact001');
    } finally {
      if (typeof previousRootStandalone === 'undefined' || previousRootStandalone === undefined) {
        delete process.env.WEJOBSEARCHDATAROOT;
      } else {
        process.env.WEJOBSEARCHDATAROOT = previousRootStandalone;
      }
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects an unsupported platform', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'weJobSearch-outreach-'));
    const previousRootStandalone = process.env.WEJOBSEARCHDATAROOT;
    process.env.WEJOBSEARCHDATAROOT = dir;
    try {
      const contactsPath = join(dir, 'networkingContacts.json');
      const profilePath = join(dir, 'masterProfile.md');
      const outputDirectory = join(dir, 'applications');
      await writeFile(contactsPath, outreachContactsJson, 'utf8');
      await writeFile(profilePath, outreachProfileMarkdown, 'utf8');
      const result = await runDraftOutreachCommand({
        contactId: 'contact001',
        company: 'AcmeCorp',
        role: 'SeniorMle',
        platform: 'sms',
      });
      expect(result.exitCode).toBe(1);
      expect(result.printedLines.join('\n')).toContain('Unknown outreach platform');
    } finally {
      if (typeof previousRootStandalone === 'undefined' || previousRootStandalone === undefined) {
        delete process.env.WEJOBSEARCHDATAROOT;
      } else {
        process.env.WEJOBSEARCHDATAROOT = previousRootStandalone;
      }
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('parses flags from argv-style strings (SDD Section 4.1 signature)', () => {
    expect(
      parseOutreachArgs([
        '--contactId',
        'contact001',
        '--company',
        'AcmeCorp',
        '--role',
        'SeniorEngineer',
        '--platform',
        'email',
      ]),
    ).toEqual({
      contactId: 'contact001',
      company: 'AcmeCorp',
      role: 'SeniorEngineer',
      platform: 'email',
    });
    expect(parseOutreachArgs(['--help']).help).toBe(true);
  });

  it('dispatchCli only routes draftOutreach, never chains into generate or draftCoverLetter', async () => {
    const menu = await dispatchCli([]);
    expect(menu.printedLines.join('\n')).toContain('draftOutreach');
    const missing = await dispatchCli(['draftOutreach']);
    expect(missing.exitCode).toBe(1);
    expect(missing.printedLines.join('\n')).toContain('draftOutreach requires --contactId, --company, and --role.');
    const help = await dispatchCli(['draftOutreach', '--help']);
    expect(help.exitCode).toBe(0);
    expect(help.printedLines.join('\n')).toContain('never sent');
    const generated = await dispatchCli(['generate', '--help']);
    expect(generated.printedLines.join('\n')).not.toContain('draftOutreach');
  });
});

describe('exportData / importData commands (EUO-10)', () => {
  async function seedRoot(rootPath: string): Promise<void> {
    await mkdir(join(rootPath, 'applications'), { recursive: true });
    await writeFile(join(rootPath, 'masterProfile.md'), '# Jane Sample\n', 'utf8');
    await writeFile(
      join(rootPath, 'jobPreferences.yaml'),
      [
        'compensation:',
        '  currency: USD',
        '  minAcceptableBase: 0',
        '  targetBase: 0',
        '  countsBonusTowardMin: false',
        '  countsEquityTowardMin: false',
        'clearance:',
        '  currentStatus: none',
        '  currentLevel: null',
        '  eligibleToObtain: true',
        '  requiresSponsorshipForVisa: false',
        'nonNegotiables: []',
        'preferredLocations: []',
      ].join('\n') + '\n',
      'utf8',
    );
    await writeFile(join(rootPath, 'screeningAnswers.json'), '{"workAuthorization":{"usCitizen":false}}', 'utf8');
    await writeFile(join(rootPath, 'networkingContacts.json'), '{"contacts":[]}', 'utf8');
    await writeFile(
      join(rootPath, 'applications', 'applicationHistory.json'),
      JSON.stringify({
        applications: [
          {
            applicationId: 'app2026SampleCorpStrong',
            companyName: 'SampleCorp',
            roleTitle: 'Strong Engineer',
            jobUrl: 'https://example.com/jobs/strong',
            postingHash: 'syntheticHashForCommandSeed',
            sourceAggregators: ['stubAlpha'],
            fitScore: 4.2,
            fitStatus: 'strongFit',
            status: 'evaluated',
            statusHistory: [{ stage: 'evaluated', timestamp: '2026-08-08T10:00:00Z' }],
          },
        ],
      }),
      'utf8',
    );
  }

  it('parses exportData flags from argv-style strings', () => {
    expect(parseExportDataArgs(['--archivePath', '/tmp/backup.tar.gz', '--rootPath', '/tmp/root'])).toEqual({
      archivePath: '/tmp/backup.tar.gz',
      rootPath: '/tmp/root',
    });
    expect(parseExportDataArgs(['--help']).help).toBe(true);
  });

  it('parses importData flags from argv-style strings', () => {
    expect(parseImportDataArgs(['--archivePath', '/tmp/backup.tar.gz', '--rootPath', '/tmp/root'])).toEqual({
      archivePath: '/tmp/backup.tar.gz',
      rootPath: '/tmp/root',
    });
    expect(parseImportDataArgs(['--help']).help).toBe(true);
  });

  it('runExportDataCommand tarballs a seeded root and reports the archive path', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'weJobSearch-exportCmd-'));
    const previousRootStandalone = process.env.WEJOBSEARCHDATAROOT;
    process.env.WEJOBSEARCHDATAROOT = dir;
    try {
      const rootPath = join(dir, 'dataRoot');
      await seedRoot(rootPath);
      const archivePath = join(dir, 'backup.tar.gz');
      const result = await runExportDataCommand({ rootPath, archivePath });
      expect(result.exitCode).toBe(0);
      expect(result.printedLines.join('\n')).toContain(archivePath);
      const archiveStat = await import('node:fs/promises').then((fs) => fs.stat(archivePath));
      expect(archiveStat.isFile()).toBe(true);
    } finally {
      if (typeof previousRootStandalone === 'undefined' || previousRootStandalone === undefined) {
        delete process.env.WEJOBSEARCHDATAROOT;
      } else {
        process.env.WEJOBSEARCHDATAROOT = previousRootStandalone;
      }
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('runImportDataCommand restores the archive into a fresh root', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'weJobSearch-importCmd-'));
    const previousRootStandalone = process.env.WEJOBSEARCHDATAROOT;
    process.env.WEJOBSEARCHDATAROOT = dir;
    try {
      const sourceRoot = join(dir, 'source');
      await seedRoot(sourceRoot);
      const archivePath = join(dir, 'backup.tar.gz');
      await runExportDataCommand({ rootPath: sourceRoot, archivePath });
      const targetRoot = join(dir, 'restored');
      const result = await runImportDataCommand({ archivePath, rootPath: targetRoot });
      expect(result.exitCode).toBe(0);
      expect(result.printedLines.join('\n')).toContain(redactHomePrefix(targetRoot));
      expect(result.printedLines.join('\n')).toContain(redactHomePrefix(archivePath));
      expect(await readFile(join(targetRoot, 'masterProfile.md'), 'utf8')).toBe('# Jane Sample\n');
      expect(await readFile(join(targetRoot, 'applications', 'applicationHistory.json'), 'utf8')).toContain(
        'app2026SampleCorpStrong',
      );
    } finally {
      if (typeof previousRootStandalone === 'undefined' || previousRootStandalone === undefined) {
        delete process.env.WEJOBSEARCHDATAROOT;
      } else {
        process.env.WEJOBSEARCHDATAROOT = previousRootStandalone;
      }
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('runImportDataCommand refuses to overwrite an existing profile file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'weJobSearch-importGuard-'));
    const previousRootStandalone = process.env.WEJOBSEARCHDATAROOT;
    process.env.WEJOBSEARCHDATAROOT = dir;
    try {
      const sourceRoot = join(dir, 'source');
      await seedRoot(sourceRoot);
      const archivePath = join(dir, 'backup.tar.gz');
      await runExportDataCommand({ rootPath: sourceRoot, archivePath });
      const targetRoot = join(dir, 'restored');
      await mkdir(targetRoot, { recursive: true });
      await writeFile(join(targetRoot, 'masterProfile.md'), 'existing', 'utf8');
      const result = await runImportDataCommand({ archivePath, rootPath: targetRoot });
      expect(result.exitCode).toBe(1);
      expect(result.printedLines.join('\n')).toContain('masterProfile.md');
      expect(await readFile(join(targetRoot, 'masterProfile.md'), 'utf8')).toBe('existing');
    } finally {
      if (typeof previousRootStandalone === 'undefined' || previousRootStandalone === undefined) {
        delete process.env.WEJOBSEARCHDATAROOT;
      } else {
        process.env.WEJOBSEARCHDATAROOT = previousRootStandalone;
      }
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('dispatchCli routes exportData and importData and lists them in the menu', async () => {
    const menu = await dispatchCli([]);
    expect(menu.printedLines.join('\n')).toContain('exportData');
    expect(menu.printedLines.join('\n')).toContain('importData');
    const missing = await dispatchCli(['exportData']);
    expect(missing.exitCode).toBe(1);
    expect(missing.printedLines.join('\n')).toContain('exportData requires --archivePath');
    const missingImport = await dispatchCli(['importData']);
    expect(missingImport.exitCode).toBe(1);
    expect(missingImport.printedLines.join('\n')).toContain('importData requires --archivePath');
    const help = await dispatchCli(['importData', '--help']);
    expect(help.exitCode).toBe(0);
    expect(help.printedLines.join('\n')).toContain('never overwrites');
  });
});

describe('CLI dead link contract (cleanup Phase 2)', () => {
  it('menu advertises every wired command and every advertised name dispatches', async () => {
    const menu = await dispatchCli([]);
    expect(menu.exitCode).toBe(0);
    const menuText = menu.printedLines.join('\n');
    for (const name of commandNames) {
      expect(menuText).toContain(name);
    }
    const lines = menu.printedLines;
    const start = lines.indexOf('Commands:');
    expect(start).toBeGreaterThanOrEqual(0);
    const advertised: string[] = [];
    for (const line of lines.slice(start + 1)) {
      if (line === '') {
        break;
      }
      advertised.push(line.trim().split(/\s+/)[0] ?? '');
    }
    expect(advertised).toContain('parsePdf');
    expect(advertised).toContain('confirmApp');
    for (const name of advertised) {
      expect(commandNames).toContain(name);
      const help = await dispatchCli([name, '--help']);
      expect(help.printedLines.join('\n')).not.toContain('not implemented yet');
      expect(help.exitCode).toBe(0);
    }
  });

  it('parses parsePdf and confirmApp flags from argv-style strings', () => {
    expect(parsePdfArgs(['--filePath', './myResume.pdf'])).toEqual({ filePath: './myResume.pdf' });
    expect(parsePdfArgs(['--filePath=./myResume.pdf'])).toEqual({ filePath: './myResume.pdf' });
    expect(parsePdfArgs(['--help']).help).toBe(true);
    expect(
      parseConfirmAppArgs([
        '--company',
        'AcmeCorp',
        '--role',
        'SeniorEngineer',
        '--notes',
        'Submitted via Greenhouse',
      ]),
    ).toEqual({
      company: 'AcmeCorp',
      role: 'SeniorEngineer',
      notes: 'Submitted via Greenhouse',
    });
    expect(parseConfirmAppArgs(['--company=AcmeCorp', '--role=SeniorEngineer'])).toEqual({
      company: 'AcmeCorp',
      role: 'SeniorEngineer',
    });
    expect(parseConfirmAppArgs(['--help']).help).toBe(true);
  });

  it('parsePdf requires --filePath, supports --help, and surfaces read errors', async () => {
    const missing = await dispatchCli(['parsePdf']);
    expect(missing.exitCode).toBe(1);
    expect(missing.printedLines.join('\n')).toContain('parsePdf requires --filePath');
    const help = await dispatchCli(['parsePdf', '--help']);
    expect(help.exitCode).toBe(0);
    expect(help.printedLines.join('\n')).toContain('Read-only');
    const pdfDir = await mkdtemp(join(tmpdir(), 'weJobSearch-parsepdf-'));
    const previousPdfRoot = process.env.WEJOBSEARCHDATAROOT;
    process.env.WEJOBSEARCHDATAROOT = pdfDir;
    try {
      const absent = await runParsePdfCommand({ filePath: join(pdfDir, 'weJobSearch-no-such.pdf') });
      expect(absent.exitCode).toBe(1);
      expect(absent.printedLines.join('\n')).toContain('Unable to read PDF');
    } finally {
      if (previousPdfRoot === undefined) {
        delete process.env.WEJOBSEARCHDATAROOT;
      } else {
        process.env.WEJOBSEARCHDATAROOT = previousPdfRoot;
      }
      await rm(pdfDir, { recursive: true, force: true });
    }
  });

  it('confirmApp requires --company and --role and supports --help', async () => {
    const missing = await dispatchCli(['confirmApp']);
    expect(missing.exitCode).toBe(1);
    expect(missing.printedLines.join('\n')).toContain('confirmApp requires --company and --role');
    const help = await dispatchCli(['confirmApp', '--help']);
    expect(help.exitCode).toBe(0);
    expect(help.printedLines.join('\n')).toContain('confirmApplicationSubmission');
    expect(help.printedLines.join('\n')).toContain('ONLY path into appliedConfirmed');
  });

  it('confirmApp delegates to confirmApplicationSubmission without auto-submitting', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'weJobSearch-confirmApp-'));
    const previousRootStandalone = process.env.WEJOBSEARCHDATAROOT;
    process.env.WEJOBSEARCHDATAROOT = dir;
    try {
      await mkdir(join(dir, 'applications'), { recursive: true });
      const historyPath = join(dir, 'applications', 'applicationHistory.json');
      const applicationId = generateApplicationId('AcmeCorp', 'SeniorEngineer');
      await writeFile(
        historyPath,
        JSON.stringify({
          applications: [
            {
              applicationId,
              companyName: 'AcmeCorp',
              roleTitle: 'SeniorEngineer',
              jobUrl: 'https://example.com/job',
              postingHash: 'fakesha256forcontracttest',
              sourceAggregators: ['indeed'],
              fitScore: 4.2,
              fitStatus: 'strongFit',
              status: 'evaluated',
              statusHistory: [{ stage: 'evaluated', timestamp: '2026-08-08T10:00:00Z' }],
            },
          ],
        }),
        'utf8',
      );
      const first = await dispatchCli([
        'confirmApp',
        '--company',
        'AcmeCorp',
        '--role',
        'SeniorEngineer',
        '--notes',
        'Submitted via Greenhouse',
        '--historyPath',
      ]);
      expect(first.exitCode).toBe(0);
      expect(first.printedLines.join('\n')).toContain(`${applicationId} confirmed`);
      const history = await readApplicationHistory(historyPath);
      expect(history.applications[0]?.status).toBe('appliedConfirmed');
      const second = await runConfirmAppCommand({
        company: 'AcmeCorp',
        role: 'SeniorEngineer',
      });
      expect(second.exitCode).toBe(0);
      expect(second.printedLines.join('\n')).toContain('was already confirmed');
      const unknown = await runConfirmAppCommand({
        company: 'NoSuchCorp',
        role: 'NoSuchRole',
      });
      expect(unknown.exitCode).toBe(1);
      expect(unknown.printedLines.join('\n')).toContain('No application record found');
    } finally {
      if (typeof previousRootStandalone === 'undefined' || previousRootStandalone === undefined) {
        delete process.env.WEJOBSEARCHDATAROOT;
      } else {
        process.env.WEJOBSEARCHDATAROOT = previousRootStandalone;
      }
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// Phase 7a god-file seam guard (RED first): jobSearchCore.ts mixes CLI
// parsing, search orchestration, evaluate/persist, generate/draft, and
// reporting in one module. The extractions (argsParser, searchOrchestrator,
// profileWriter, atomicWrite) must shrink this dispatcher and keep it free of
// inline token loops. Caps are staged: they fail on the pre-extraction
// baseline (3134 lines, 85 export lines) and tighten as later seams land.
// The dispatcher must stay under them; the orchestrator owns the pipeline.
describe('jobSearchCore module size guard (Phase 7a)', () => {
  const coreSourcePath = join(__dirname, 'jobSearchCore.ts');

  async function coreSource(): Promise<string> {
    return readFile(coreSourcePath, 'utf8');
  }

  it('stays under the staged line-count cap', async () => {
    const lines = (await coreSource()).split('\n').length;
    expect(lines).toBeLessThanOrEqual(2400);
  });

  it('stays under the staged export-declaration cap', async () => {
    const exportLines = (await coreSource())
      .split('\n')
      .filter((line) => line.startsWith('export')).length;
    expect(exportLines).toBeLessThanOrEqual(50);
  });

  it('contains no inline CLI token indexing (parsing lives in argsParser)', async () => {
    const source = await coreSource();
    expect(source).not.toContain('args[index + 1]');
  });

  it('delegates search orchestration to the extracted core module', async () => {
    const source = await coreSource();
    expect(source).toContain('searchOrchestrator');
  });
});
describe('runner catch-all error mapping (U14)', () => {
  async function withEmptyDataRoot<T>(fn: (dir: string) => Promise<T>): Promise<T> {
    const dir = await mkdtemp(join(tmpdir(), 'weJobSearch-u14-'));
    const previousRoot = process.env.WEJOBSEARCHDATAROOT;
    process.env.WEJOBSEARCHDATAROOT = dir;
    try {
      return await fn(dir);
    } finally {
      if (previousRoot === undefined) {
        delete process.env.WEJOBSEARCHDATAROOT;
      } else {
        process.env.WEJOBSEARCHDATAROOT = previousRoot;
      }
      await rm(dir, { recursive: true, force: true });
    }
  }

  it('maps a missing profile to exit 1 with a message instead of throwing', async () => {
    await withEmptyDataRoot(async () => {
      const generated = await runGenerate({ company: 'AcmeCorp', role: 'SeniorEngineer' });
      expect(generated.exitCode).toBe(1);
      expect(generated.printedLines.join('\n')).toContain('resumeVariants.yaml not found');
      const covered = await runDraftCoverLetter({ company: 'AcmeCorp', role: 'SeniorEngineer' });
      expect(covered.exitCode).toBe(1);
    });
  });

  it('maps malformed saved searches to exit 1 instead of throwing', async () => {
    await withEmptyDataRoot(async (dir) => {
      await writeFile(join(dir, 'savedSearches.json'), '{not valid json', 'utf8');
      const result = await runDigestCommand({});
      expect(result.exitCode).toBe(1);
    });
  });

  it('formats fatal errors as messages without stack traces', () => {
    expect(formatFatalError(new Error('boom'))).toBe('boom');
    expect(formatFatalError('plain failure')).toBe('plain failure');
    expect(formatFatalError(new Error('boom'))).not.toContain(' at ');
  });

  it('falls back to String(error) for empty-message Errors and non-Error throwables', () => {
    expect(formatFatalError(new Error(''))).toBe('Error');
    expect(formatFatalError(null)).toBe('null');
    expect(formatFatalError(42)).toBe('42');
    expect(formatFatalError({ code: 'X1' })).toBe('[object Object]');
  });

  it('formatFatalError redacts the home prefix at the CLI boundary (R-H2-2)', () => {
    const homeFile = join(homedir(), 'Documents', 'weJobSearch', 'tester', 'jobPreferences.yaml');
    const redacted = formatFatalError(new Error(`Malformed prefs at ${homeFile}: not valid JSON`));
    expect(redacted).toContain('<dataRoot>');
    expect(redacted).not.toContain(homedir());
    expect(redacted).toContain('Malformed prefs at');
  });

  it('formatFatalError redacts home paths in non-Error throwables (R-H2-2)', () => {
    const homeFile = join(homedir(), 'backups', 'weJobSearch-backup.tar.gz');
    expect(formatFatalError(homeFile)).toBe(redactHomePrefix(homeFile));
    expect(formatFatalError(homeFile)).not.toContain(homedir());
  });

  it('formatImportDataSuccessLines redacts home-prefixed roots (R-H2-1)', () => {
    const rootPath = join(homedir(), 'Documents', 'weJobSearch', 'tester');
    const archivePath = join(homedir(), 'backups', 'weJobSearch-backup.tar.gz');
    const lines = formatImportDataSuccessLines({
      archivePath,
      rootPath,
      entryCount: 7,
      restoredFiles: ['masterProfile.md', 'jobPreferences.yaml'],
    });
    const text = lines.join('\n');
    expect(text).toContain('<dataRoot>');
    expect(text).not.toContain(homedir());
    expect(text).toContain('Imported 7 archive entries');
    expect(text).toContain('Restored files: 2');
  });
});

describe('numeric flag validation surfaces through dispatch (U19)', () => {
  it('propagates a usage error for non-numeric search numerics (main maps it to exit 1)', async () => {
    await expect(dispatchCli(['search', '--keywords', 'engineer', '--minFit', 'bogus'])).rejects.toThrow(
      "Invalid --minFit value 'bogus'",
    );
  });
});

describe('runValidateCommand (U22)', () => {
  const validVariantsYaml = `variants:
  usStandardResume:
    template: templates/usStandardResume.typ
    triggers: {}
`;

  it('passes valid configs and fails missing or malformed ones', async () => {
    await withSandbox(async ({ preferencesPath }) => {
      const dir = preferencesPath.split('/jobPreferences.yaml')[0];
      await writeFile(join(dir, 'resumeVariants.yaml'), validVariantsYaml, 'utf8');
      const pass = await runValidateCommand({ dataRoot: dir });
      expect(pass.exitCode).toBe(0);
      expect(pass.printedLines.join('\n')).toContain('jobPreferences.yaml: OK');
      expect(pass.printedLines.join('\n')).toContain('resumeVariants.yaml: OK');

      await writeFile(join(dir, 'resumeVariants.yaml'), 'variants: [unclosed\n', 'utf8');
      const malformed = await runValidateCommand({ dataRoot: dir });
      expect(malformed.exitCode).toBe(1);
      expect(malformed.printedLines.join('\n')).toContain('resumeVariants.yaml: FAIL');
    });
  });

  it('fails clearly when the data root is not initialized', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'weJobSearch-validate-'));
    try {
      const result = await runValidateCommand({ dataRoot: dir });
      expect(result.exitCode).toBe(1);
      expect(result.printedLines.join('\n')).toContain('not found');
      expect(result.printedLines.join('\n')).toContain('init');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('lists validate in the menu', async () => {
    const menu = await dispatchCli([]);
    expect(menu.printedLines.join('\n')).toContain('validate');
  });
});

describe('report/reviewQueue/addContact/digest dataRoot relocation (U43)', () => {
  async function seedRelocatedRoot(): Promise<{ dir: string; historyPath: string }> {
    const dir = await mkdtemp(join(tmpdir(), 'weJobSearch-u43-'));
    const historyPath = join(dir, 'applications', 'applicationHistory.json');
    await logApplication(
      {
        applicationId: generateApplicationId('SampleCorp', 'Staff Engineer'),
        companyName: 'SampleCorp',
        roleTitle: 'Staff Engineer',
        jobUrl: 'https://alpha.test/jobs/8',
        postingHash: computePostingHash('SampleCorp', 'Staff Engineer', 'Remote'),
        sourceAggregators: ['stubAlpha'],
        salaryRange: null,
        fitScore: 3.0,
        fitStatus: 'manualReview',
        referralContact: null,
        status: 'evaluated',
        statusHistory: [{ stage: 'evaluated', timestamp: new Date().toISOString() }],
      },
      historyPath,
      dir,
    );
    await writeFile(join(dir, 'networkingContacts.json'), '{"contacts": []}\n', 'utf8');
    return { dir, historyPath };
  }

  it('report honors an isolated dataRoot', async () => {
    await withSandbox(async () => {
      const { dir } = await seedRelocatedRoot();
      try {
        const result = await runReportCommand({ dataRoot: dir });
        expect(result.exitCode).toBe(0);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  it('reviewQueue honors an isolated dataRoot', async () => {
    await withSandbox(async () => {
      const { dir } = await seedRelocatedRoot();
      try {
        const result = await runReviewQueueCommand({ dataRoot: dir });
        expect(result.exitCode).toBe(0);
        expect(result.printedLines.join('\n')).toContain('awaiting a human decision');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  it('addContact writes into the isolated dataRoot', async () => {
    await withSandbox(async () => {
      const dir = await mkdtemp(join(tmpdir(), 'weJobSearch-u43-'));
      try {
        const result = await runAddContactCommand({
          name: 'Sam Rivera',
          company: 'SampleCorp',
          dataRoot: dir,
        });
        expect(result.exitCode).toBe(0);
        const contacts = JSON.parse(
          await readFile(join(dir, 'networkingContacts.json'), 'utf8'),
        ) as { contacts: { name: string }[] };
        expect(contacts.contacts.map((contact) => contact.name)).toContain('Sam Rivera');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  it('digest honors an isolated dataRoot', async () => {
    await withSandbox(async ({ preferencesPath, profilePath }) => {
      const dir = await mkdtemp(join(tmpdir(), 'weJobSearch-u43-'));
      try {
        await writeFile(
          join(dir, 'jobPreferences.yaml'),
          await readFile(preferencesPath, 'utf8'),
          'utf8',
        );
        await writeFile(join(dir, 'masterProfile.md'), await readFile(profilePath, 'utf8'), 'utf8');
        const savedPath = join(dir, 'savedSearches.json');
        await addSavedSearch({ keywords: 'staff engineer', location: 'Remote' }, savedPath, dir);
        const registry = makeRegistry([{ name: 'stubAlpha', postings: [] }]);
        const result = await runDigestCommand({ registry, dataRoot: dir });
        expect(result.exitCode).toBe(0);
        expect(result.printedLines.join('\n')).toContain('Digest of 1 saved search');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });
});

describe('runReportCommand redaction polarity and output formats (U45)', () => {
  async function withReportSandbox<T>(fn: (dir: string) => Promise<T>): Promise<T> {
    const dir = await mkdtemp(join(tmpdir(), 'weJobSearch-report45-'));
    const previous = process.env.WEJOBSEARCHDATAROOT;
    process.env.WEJOBSEARCHDATAROOT = dir;
    try {
      await mkdir(join(dir, 'applications'), { recursive: true });
      await writeFile(
        join(dir, 'applications', 'applicationHistory.json'),
        JSON.stringify({
          applications: [
            {
              applicationId: 'app2026SampleCorpStaff',
              companyName: 'SampleCorp',
              roleTitle: 'Staff Engineer',
              jobUrl: 'https://example.com/s',
              postingHash: 'h1',
              sourceAggregators: ['test'],
              salaryRange: null,
              fitScore: 4.2,
              fitStatus: 'manualReview',
              referralContact: null,
              status: 'evaluated',
              statusHistory: [{ stage: 'evaluated', timestamp: '2026-08-01T10:00:00Z' }],
            },
          ],
        }),
        'utf8',
      );
      await writeFile(join(dir, 'networkingContacts.json'), JSON.stringify({ contacts: [] }), 'utf8');
      return await fn(dir);
    } finally {
      if (previous === undefined) {
        delete process.env.WEJOBSEARCHDATAROOT;
      } else {
        process.env.WEJOBSEARCHDATAROOT = previous;
      }
      await rm(dir, { recursive: true, force: true });
    }
  }

  async function captureWarn<T>(fn: () => Promise<T>): Promise<{ result: T; warned: string[] }> {
    const warned: string[] = [];
    const originalWarn = console.warn;
    console.warn = (message: string) => {
      warned.push(message);
    };
    try {
      return { result: await fn(), warned };
    } finally {
      console.warn = originalWarn;
    }
  }

  it('stays silent by default (redacted) and warns exactly once with --noRedact (B3)', async () => {
    await withReportSandbox(async () => {
      const silent = await captureWarn(() => runReportCommand({}));
      expect(silent.result.exitCode).toBe(0);
      expect(silent.warned).toEqual([]);
      // Table path: the single NOTE comes from the formatter itself.
      const loudTable = await captureWarn(() => runReportCommand({ noRedact: true }));
      expect(loudTable.result.exitCode).toBe(0);
      expect(loudTable.warned).toHaveLength(1);
      expect(loudTable.warned[0]).toContain('Identities');
      // JSON path: the single NOTE comes from the command (no formatter).
      const loudJson = await captureWarn(() => runReportCommand({ noRedact: true, format: 'json' }));
      expect(loudJson.result.exitCode).toBe(0);
      expect(loudJson.warned).toHaveLength(1);
      expect(loudJson.warned[0]).toContain('Identities');
    });
  });

  it('redacts identities in default table and json stdout', async () => {
    await withReportSandbox(async () => {
      const table = await captureWarn(() => runReportCommand({}));
      expect(table.result.printedLines.join('\n')).not.toContain('SampleCorp');
      const json = await captureWarn(() => runReportCommand({ format: 'json' }));
      expect(json.result.exitCode).toBe(0);
      const parsed = JSON.parse(json.result.printedLines.join('\n')) as {
        awaitingManualReview: { companyName: string; roleTitle: string }[];
      };
      expect(parsed.awaitingManualReview[0].companyName).toBe('<redacted>');
      expect(parsed.awaitingManualReview[0].roleTitle).toBe('<redacted>');
    });
  });

  it('writes table bytes by default and JSON bytes with --format json (O2)', async () => {
    await withReportSandbox(async (dir) => {
      const tableRun = await captureWarn(() => runReportCommand({ output: 'report.txt' }));
      expect(tableRun.result.exitCode).toBe(0);
      expect(tableRun.warned).toEqual([]);
      const tableContent = await readFile(join(dir, 'report.txt'), 'utf8');
      expect(tableContent).toContain('Funnel report');
      expect(tableContent).not.toContain('SampleCorp');
      const jsonRun = await captureWarn(() =>
        runReportCommand({ output: 'report.json', format: 'json' }),
      );
      expect(jsonRun.result.exitCode).toBe(0);
      const parsed = JSON.parse(await readFile(join(dir, 'report.json'), 'utf8')) as {
        totalApplications: number;
      };
      expect(parsed.totalApplications).toBe(1);
    });
  });
});
