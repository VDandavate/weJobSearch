import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it, vi } from 'vitest';
import { createMcpServer, serverInfo, type McpServerDependencies } from './jobSearchServer';
import { runGenerate, runSearchCommand } from '../cli/jobSearchCore';
import { JobSpyAdapterRegistry, type RawPosting, type SourceAdapter } from '../scrapers/jobSpyAdapter';
import { RateLimiter } from '../scrapers/rateLimiter';
import { computePostingHash, generateApplicationId, readApplicationHistory } from '../utils/jobFunnelTracker';
import { readNetworkingContacts } from '../utils/networkingContacts';
import { addSavedSearch } from '../utils/savedSearches';
import { readSearchHistory } from '../utils/searchHistory';
import type { ApplicationHistory, ApplicationRecord } from '../utils/jobFunnelTracker';
import type { PatternSuggestion } from '../reporting/patternAnalyzer';

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

const profileMarkdown = `# Jane Sample

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

const contactsJson = {
  contacts: [
    {
      contactId: 'contact001',
      name: 'Jane Sample',
      company: 'SampleCorp',
      relationship: 'formerColleague',
      lastContactDate: '2026-07-01',
      linkedApplicationIds: [],
      followUpDue: '2026-08-01',
    },
  ],
};

const expectedToolNames = [
  'getUserProfile',
  'suggestRoles',
  'initializeUserProfile',
  'updateUserProfile',
  'parsePdfDocument',
  'ingestDocuments',
  'evaluateJobPosting',
  'searchJobPostings',
  'searchByProfile',
  'runSavedSearches',
  'getPostingDetail',
  'generateTailoredApplication',
  'confirmApplicationSubmission',
  'getReviewQueue',
  'getFunnelReport',
  'analyzeApplicationPatterns',
  'logNetworkingContact',
  'draftOutreachMessage',
  'draftCoverLetter',
];

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

// EUO-07 fixture: 2 interviewed/offer frontend roles + 3 rejected roles, all
// remote, with role titles clustering on the "frontend engineer" stem.
function patternFixtureApplications(): ApplicationRecord[] {
  const base = {
    jobUrl: 'https://example.com/job',
    sourceAggregators: ['test'],
    salaryRange: 'USD 140,000 - 180,000',
    fitScore: 4.0,
    fitStatus: 'strongFit' as const,
    referralContact: null,
    statusHistory: [{ stage: 'evaluated' as const, timestamp: '2026-08-08T10:00:00Z' }],
  };
  return [
    {
      ...base,
      applicationId: 'app2026AcmeFrontendEngineer',
      companyName: 'AcmeCorp',
      roleTitle: 'Senior Frontend Engineer',
      postingHash: 'hash2',
      status: 'interviewing',
      postingDescription: 'TypeScript and React role building customer-facing web applications.',
      postingFacts: { locationType: 'remote' },
    },
    {
      ...base,
      applicationId: 'app2026GlobexFrontendEngineer',
      companyName: 'GlobexCorp',
      roleTitle: 'Frontend Engineer',
      postingHash: 'hash3',
      status: 'offer',
      postingDescription: 'React and TypeScript frontend role on the design system team.',
      postingFacts: { locationType: 'remote' },
    },
    {
      ...base,
      applicationId: 'app2026InitechDataEngineer',
      companyName: 'Initech',
      roleTitle: 'Data Engineer',
      postingHash: 'hash4',
      status: 'rejected',
      postingDescription: 'Python and Spark data pipeline role.',
      postingFacts: { locationType: 'remote' },
    },
    {
      ...base,
      applicationId: 'app2026UmbrellaBackendEngineer',
      companyName: 'UmbrellaCorp',
      roleTitle: 'Backend Engineer',
      postingHash: 'hash5',
      status: 'rejected',
      postingDescription: 'Java and Spring backend services role.',
      postingFacts: { locationType: 'remote' },
    },
    {
      ...base,
      applicationId: 'app2026HooliDevOpsEngineer',
      companyName: 'Hooli',
      roleTitle: 'DevOps Engineer',
      postingHash: 'hash6',
      status: 'rejected',
      postingDescription: 'AWS and Kubernetes infrastructure role.',
      postingFacts: { locationType: 'remote' },
    },
  ];
}

// Minimal single-page PDF with one text line, valid enough for pdf-parse.
function makeMinimalPdf(text: string): Buffer {
  const escaped = text.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  const stream = `BT /F1 12 Tf 72 720 Td (${escaped}) Tj ET`;
  const body = [
    '1 0 obj',
    '<< /Type /Catalog /Pages 2 0 R >>',
    'endobj',
    '2 0 obj',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    'endobj',
    '3 0 obj',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    'endobj',
    '4 0 obj',
    `<< /Length ${Buffer.byteLength(stream)} >>`,
    'stream',
    stream,
    'endstream',
    'endobj',
    '5 0 obj',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    'endobj',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (const line of body) {
    offsets.push(pdf.length);
    pdf += `${line}\n`;
  }
  const xrefStart = pdf.length;
  pdf += `xref\n0 ${offsets.length + 1}\n`;
  pdf += '0000000000 65535 f \n';
  for (const offset of offsets) {
    pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${offsets.length + 1} /Root 1 0 R >>\n`;
  pdf += `startxref\n${xrefStart}\n%%EOF`;
  return Buffer.from(pdf, 'latin1');
}

function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

interface SandboxPaths {
  dir: string;
  historyPath: string;
  preferencesPath: string;
  profilePath: string;
  contactsPath: string;
  savedSearchesPath: string;
  searchHistoryPath: string;
}

async function withSandbox<T>(fn: (paths: SandboxPaths) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'weJobSearch-mcp-'));
  const previousRoot = process.env.WEJOBSEARCHDATAROOT;
  process.env.WEJOBSEARCHDATAROOT = dir;
  const paths: SandboxPaths = {
    dir,
    historyPath: join(dir, 'applications', 'applicationHistory.json'),
    preferencesPath: join(dir, 'jobPreferences.yaml'),
    profilePath: join(dir, 'masterProfile.md'),
    contactsPath: join(dir, 'networkingContacts.json'),
    savedSearchesPath: join(dir, 'savedSearches.json'),
    searchHistoryPath: join(dir, 'searchHistory.json'),
  };
  await writeFile(paths.preferencesPath, preferencesYaml, 'utf8');
  await writeFile(paths.profilePath, profileMarkdown, 'utf8');
  await writeFile(paths.contactsPath, JSON.stringify(contactsJson, null, 2), 'utf8');
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

interface ConnectedClient {
  client: Client;
  close: () => Promise<void>;
}

async function connectToServer(
  paths: SandboxPaths,
  registry: JobSpyAdapterRegistry,
  extraDeps: Partial<McpServerDependencies> = {},
): Promise<ConnectedClient> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer({
    profilePath: paths.profilePath,
    preferencesPath: paths.preferencesPath,
    historyPath: paths.historyPath,
    contactsPath: paths.contactsPath,
    savedSearchesPath: paths.savedSearchesPath,
    searchHistoryPath: paths.searchHistoryPath,
    dataRoot: paths.dir,
    registry,
    ...extraDeps,
  });
  await server.connect(serverTransport);
  const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });
  await client.connect(clientTransport);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

async function callTool(
  connected: ConnectedClient,
  name: string,
  args: Record<string, unknown>,
): Promise<{ isError: boolean; text: string; structuredContent?: Record<string, unknown> }> {
  const result = await connected.client.callTool({ name, arguments: args });
  const text = extractText(result.content as unknown as readonly { type: string; text?: string }[]);
  return {
    isError: result.isError === true,
    text,
    structuredContent: result.structuredContent as Record<string, unknown> | undefined,
  };
}

function extractText(content: readonly { type: string; text?: string }[]): string {
  return content
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text as string)
    .join('\n');
}

describe('jobSearchServer (MCP)', () => {
  it('reports the package.json version as the server version (single source)', async () => {
    const pkg = JSON.parse(
      await readFile(join(__dirname, '..', '..', 'package.json'), 'utf8'),
    ) as { version: string };
    expect(serverInfo.name).toBe('wejobsearch-mcp');
    expect(serverInfo.version).toBe(pkg.version);
  });

  it('registers exactly the required tool names', async () => {
    await withSandbox(async (paths) => {
      const connected = await connectToServer(paths, makeRegistry([]));
      try {
        const listed = await connected.client.listTools();
        const names = listed.tools.map((tool) => tool.name).sort();
        expect(names).toEqual([...expectedToolNames].sort());
      } finally {
        await connected.close();
      }
    });
  });

  it('describes the fixed result tables with the correct 7/6 column counts', async () => {
    await withSandbox(async (paths) => {
      const connected = await connectToServer(paths, makeRegistry([]));
      try {
        const listed = await connected.client.listTools();
        const descriptions = new Map(
          listed.tools.map((tool) => [tool.name, tool.description as string]),
        );
        for (const name of ['searchJobPostings', 'searchByProfile', 'runSavedSearches']) {
          const description = descriptions.get(name) ?? '';
          expect(description).toContain('7-column');
          expect(description).toContain('6-column');
          expect(description).not.toContain('8-column');
          expect(description).not.toContain('Excluded Results (7-column');
        }
      } finally {
        await connected.close();
      }
    });
  });

  it('searchJobPostings returns BOTH fixed requirement 2a tables and persists evaluated records', async () => {
    await withSandbox(async (paths) => {
      const strong = posting({
        roleTitle: 'Staff Engineer',
        jobUrl: 'https://alpha.test/jobs/1',
      });
      const weak = posting({
        roleTitle: 'Ruby Automation Engineer',
        jobUrl: 'https://alpha.test/jobs/3',
        description: 'Automation role requiring Ruby and Python. 4+ years of experience. Healthcare domain focus.',
        rawSalaryText: 'USD 120,000 - 140,000 per year',
      });
      const registry = makeRegistry([{ name: 'stubAlpha', postings: [strong, weak] }]);
      const connected = await connectToServer(paths, registry);
      try {
        const result = await callTool(connected, 'searchJobPostings', {
          keywords: 'staff engineer',
          location: 'Remote',
        });
        expect(result.isError).toBe(false);
        const payload = JSON.parse(result.text);
        expect([...payload.activeResults.columns]).toEqual([
          'Sr. No.',
          'Job Title',
          'Organization',
          'Brief',
          'Fit Score',
          'Justification',
          'Link',
        ]);
        const activeRow = payload.activeResults.rows[0];
        expect(activeRow).toMatchObject({
          jobTitle: 'Staff Engineer',
          organization: 'SampleCorp',
        });
        expect([...payload.excludedResults.columns]).toEqual([
          'Sr. No.',
          'Job Title',
          'Organization',
          'Fit Score',
          'Justification',
          'Link',
        ]);
        expect(payload.excludedResults.rows.length).toBe(1);
        expect(result.structuredContent?.activeResults).toBeDefined();
        expect(result.structuredContent?.excludedResults).toBeDefined();

        const history = await readApplicationHistory(paths.historyPath);
        expect(history.applications).toHaveLength(2);
        expect(history.applications.every((record) => record.status === 'evaluated')).toBe(true);
      } finally {
        await connected.close();
      }
    });
  });

  it('searchByProfile searches from the saved profile and returns BOTH fixed tables without generating anything', async () => {
    await withSandbox(async (paths) => {
      await writeFile(paths.preferencesPath, preferencesWithTargetRolesYaml, 'utf8');
      const strong = posting({
        roleTitle: 'Staff Engineer',
        jobUrl: 'https://alpha.test/jobs/1',
      });
      const registry = makeRegistry([{ name: 'stubAlpha', postings: [strong] }]);
      const connected = await connectToServer(paths, registry);
      try {
        const result = await callTool(connected, 'searchByProfile', {});
        expect(result.isError).toBe(false);
        const payload = JSON.parse(result.text);
        expect([...payload.activeResults.columns]).toEqual([
          'Sr. No.',
          'Job Title',
          'Organization',
          'Brief',
          'Fit Score',
          'Justification',
          'Link',
        ]);
        expect([...payload.excludedResults.columns]).toEqual([
          'Sr. No.',
          'Job Title',
          'Organization',
          'Fit Score',
          'Justification',
          'Link',
        ]);
        expect(payload.evaluatedCount).toBe(1);
        expect(payload.queries).toHaveLength(2);
        expect(result.structuredContent?.activeResults).toBeDefined();
        expect(result.structuredContent?.excludedResults).toBeDefined();

        const history = await readApplicationHistory(paths.historyPath);
        expect(history.applications).toHaveLength(1);
        expect(history.applications[0].status).toBe('evaluated');

        // No resume/cover-letter/outreach output was generated.
        const applicationsDir = join(paths.dir, 'applications');
        expect(await readdir(applicationsDir)).toEqual(['applicationHistory.json']);
      } finally {
        await connected.close();
      }
    });
  });

  it('getPostingDetail returns the stored detail for an evaluated posting', async () => {
    await withSandbox(async (paths) => {
      const strong = posting({
        roleTitle: 'Staff Engineer',
        jobUrl: 'https://alpha.test/jobs/1',
      });
      const registry = makeRegistry([{ name: 'stubAlpha', postings: [strong] }]);
      const connected = await connectToServer(paths, registry);
      try {
        const searched = await callTool(connected, 'searchJobPostings', {
          keywords: 'staff engineer',
          location: 'Remote',
        });
        expect(searched.isError).toBe(false);

        const detail = await callTool(connected, 'getPostingDetail', {
          companyName: 'SampleCorp',
          roleTitle: 'Staff Engineer',
        });
        expect(detail.isError).toBe(false);
        const payload = JSON.parse(detail.text);
        expect(payload.companyName).toBe('SampleCorp');
        expect(payload.roleTitle).toBe('Staff Engineer');
        expect(payload.fitStatus).toBe('strongFit');
        expect(payload.postingDescription).toContain('TypeScript and Rust');
        expect(payload.postingFacts.locationType).toBe('remote');
        expect(payload.statusHistory[0].stage).toBe('evaluated');
      } finally {
        await connected.close();
      }
    });
  });

  it('runSavedSearches runs every saved search and returns BOTH fixed tables', async () => {
    await withSandbox(async (paths) => {
      await addSavedSearch({ keywords: 'staff engineer', location: 'Remote' }, paths.savedSearchesPath);
      await addSavedSearch({ keywords: 'platform', location: 'Remote' }, paths.savedSearchesPath);
      const strong = posting({
        roleTitle: 'Staff Engineer',
        jobUrl: 'https://alpha.test/jobs/1',
      });
      const weak = posting({
        roleTitle: 'Ruby Automation Engineer',
        jobUrl: 'https://alpha.test/jobs/3',
        description:
          'Automation role requiring Ruby and Python. 4+ years of experience. Healthcare domain focus.',
        rawSalaryText: 'USD 120,000 - 140,000 per year',
      });
      const registry = makeRegistry([{ name: 'stubAlpha', postings: [strong, weak] }]);
      const connected = await connectToServer(paths, registry);
      try {
        const result = await callTool(connected, 'runSavedSearches', {});
        expect(result.isError).toBe(false);
        const payload = JSON.parse(result.text);
        expect([...payload.activeResults.columns]).toEqual([
          'Sr. No.',
          'Job Title',
          'Organization',
          'Brief',
          'Fit Score',
          'Justification',
          'Link',
        ]);
        const activeRow = payload.activeResults.rows[0];
        expect(activeRow).toMatchObject({
          jobTitle: 'Staff Engineer',
          organization: 'SampleCorp',
        });
        expect([...payload.excludedResults.columns]).toEqual([
          'Sr. No.',
          'Job Title',
          'Organization',
          'Fit Score',
          'Justification',
          'Link',
        ]);
        expect(payload.excludedResults.rows.length).toBe(1);
        expect(payload.evaluatedCount).toBe(2);
        expect(payload.newRecords).toBe(2);
        expect(payload.alreadyRecorded).toBe(2);

        const history = await readApplicationHistory(paths.historyPath);
        expect(history.applications).toHaveLength(2);
        expect(history.applications.every((record) => record.status === 'evaluated')).toBe(true);
      } finally {
        await connected.close();
      }
    });
  });

  it('analyzeApplicationPatterns returns suggestions from history and writes nothing', async () => {
    await withSandbox(async (paths) => {
      const applicationsDir = join(paths.dir, 'applications');
      await mkdir(applicationsDir, { recursive: true });
      const history: ApplicationHistory = { applications: patternFixtureApplications() };
      await writeFile(paths.historyPath, JSON.stringify(history, null, 2), 'utf8');
      const connected = await connectToServer(paths, makeRegistry([]));
      try {
        const result = await callTool(connected, 'analyzeApplicationPatterns', {});
        expect(result.isError).toBe(false);
        const suggestions = JSON.parse(result.text) as PatternSuggestion[];
        expect(suggestions.length).toBeGreaterThan(0);
        expect(suggestions.some((suggestion) => suggestion.kind === 'skillDomain')).toBe(true);
        expect(suggestions.some((suggestion) => suggestion.kind === 'location')).toBe(true);
        expect(suggestions.some((suggestion) => suggestion.kind === 'roleTitle')).toBe(true);
        expect(result.structuredContent?.suggestionCount).toBe(suggestions.length);
        expect(result.structuredContent?.suggestions).toEqual(suggestions);

        // Read-only: the seeded history file is unchanged.
        const persisted = await readApplicationHistory(paths.historyPath);
        expect(persisted.applications).toHaveLength(5);
      } finally {
        await connected.close();
      }
    });
  });

  it('analyzeApplicationPatterns returns empty suggestions for empty history without error', async () => {
    await withSandbox(async (paths) => {
      const connected = await connectToServer(paths, makeRegistry([]));
      try {
        const result = await callTool(connected, 'analyzeApplicationPatterns', {});
        expect(result.isError).toBe(false);
        const suggestions = JSON.parse(result.text) as PatternSuggestion[];
        expect(suggestions).toEqual([]);
        expect(result.structuredContent?.suggestionCount).toBe(0);
      } finally {
        await connected.close();
      }
    });
  });

  it('analyzeApplicationPatterns surfaces preference drift against saved preferences (EUO-17)', async () => {
    await withSandbox(async (paths) => {
      await writeFile(paths.preferencesPath, preferencesWithTargetRolesYaml, 'utf8');
      const applicationsDir = join(paths.dir, 'applications');
      await mkdir(applicationsDir, { recursive: true });
      const history: ApplicationHistory = { applications: patternFixtureApplications() };
      await writeFile(paths.historyPath, JSON.stringify(history, null, 2), 'utf8');
      const connected = await connectToServer(paths, makeRegistry([]));
      try {
        const result = await callTool(connected, 'analyzeApplicationPatterns', {});
        expect(result.isError).toBe(false);
        const suggestions = JSON.parse(result.text) as PatternSuggestion[];
        // Sandbox preferences target Senior Engineer / Staff Engineer and Remote;
        // every fixture role (Frontend/Data/Backend/DevOps Engineer) is outside
        // targetRoles, so roleTitleDrift must be present; all fixture locations
        // are remote, matching preferredLocations, so locationDrift must not be.
        expect(suggestions.some((suggestion) => suggestion.kind === 'roleTitleDrift')).toBe(true);
        expect(suggestions.some((suggestion) => suggestion.kind === 'locationDrift')).toBe(false);
      } finally {
        await connected.close();
      }
    });
  });

  it('evaluateJobPosting persists idempotently (no duplicate on rerun)', async () => {
    await withSandbox(async (paths) => {
      const target = posting({ jobUrl: 'https://alpha.test/jobs/9' });
      const registry = makeRegistry([
        { name: 'stubAlpha', fetcher: (url) => (url === target.jobUrl ? target : null) },
      ]);
      const connected = await connectToServer(paths, registry);
      try {
        const first = await callTool(connected, 'evaluateJobPosting', { jobUrl: target.jobUrl });
        expect(first.isError).toBe(false);
        const parsed = JSON.parse(first.text);
        expect(parsed.alreadyRecorded).toBe(false);
        expect(parsed.fitStatus).toBe('strongFit');

        const second = await callTool(connected, 'evaluateJobPosting', { jobUrl: target.jobUrl });
        const parsedSecond = JSON.parse(second.text);
        expect(parsedSecond.alreadyRecorded).toBe(true);

        const history = await readApplicationHistory(paths.historyPath);
        expect(history.applications).toHaveLength(1);
      } finally {
        await connected.close();
      }
    });
  });

  it('evaluateJobPosting rejects unsupported URLs and malformed input with a clear error', async () => {
    await withSandbox(async (paths) => {
      const registry = makeRegistry([]);
      const connected = await connectToServer(paths, registry);
      try {
        const unsupported = await callTool(connected, 'evaluateJobPosting', {
          jobUrl: 'https://totally-unknown-site.example/jobs/1',
        });
        expect(unsupported.isError).toBe(true);
        expect(unsupported.text).toContain('No registered adapter can fetch a single posting');

        const notUrl = await callTool(connected, 'evaluateJobPosting', { jobUrl: 'not a url' });
        expect(notUrl.isError).toBe(true);
        expect(notUrl.text).toContain('Not a valid URL');
      } finally {
        await connected.close();
      }
    });
  });

  it('rejects a missing required argument for evaluateJobPosting', async () => {
    await withSandbox(async (paths) => {
      const connected = await connectToServer(paths, makeRegistry([]));
      try {
        const result = await callTool(connected, 'evaluateJobPosting', {});
        expect(result.isError).toBe(true);
        expect(result.text.length).toBeGreaterThan(0);
      } finally {
        await connected.close();
      }
    });
  });

  it('confirmApplicationSubmission is local-only: unknown app errors, evaluated app confirms', async () => {
    await withSandbox(async (paths) => {
      const target = posting({ jobUrl: 'https://alpha.test/jobs/9' });
      const registry = makeRegistry([
        { name: 'stubAlpha', fetcher: (url) => (url === target.jobUrl ? target : null) },
      ]);
      const connected = await connectToServer(paths, registry);
      try {
        await callTool(connected, 'evaluateJobPosting', { jobUrl: target.jobUrl });

        const unknown = await callTool(connected, 'confirmApplicationSubmission', {
          companyName: 'NoSuchCorp',
          roleTitle: 'Nope',
          notes: '',
        });
        expect(unknown.isError).toBe(true);

        const confirmed = await callTool(connected, 'confirmApplicationSubmission', {
          companyName: 'SampleCorp',
          roleTitle: 'Staff Engineer',
          notes: 'submitted on website',
        });
        expect(confirmed.isError).toBe(false);
        expect(JSON.parse(confirmed.text).status).toBe('appliedConfirmed');

        const again = await callTool(connected, 'confirmApplicationSubmission', {
          companyName: 'SampleCorp',
          roleTitle: 'Staff Engineer',
          notes: '',
        });
        expect(JSON.parse(again.text).alreadyConfirmed).toBe(true);

        const history = await readApplicationHistory(paths.historyPath);
        expect(history.applications).toHaveLength(1);
        expect(history.applications[0].status).toBe('appliedConfirmed');
        expect(history.applications[0].statusHistory.at(-1)?.stage).toBe('appliedConfirmed');
        expect(
          history.applications[0].statusHistory.filter((entry) => entry.stage === 'appliedConfirmed'),
        ).toHaveLength(1);
      } finally {
        await connected.close();
      }
    });
  });

  it('draftOutreachMessage writes only a local markdown draft and never sends', async () => {
    await withSandbox(async (paths) => {
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const server = createMcpServer({
        profilePath: paths.profilePath,
        contactsPath: paths.contactsPath,
        dataRoot: paths.dir,
        historyPath: paths.historyPath,
      });
      await server.connect(serverTransport);
      const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });
      await client.connect(clientTransport);
      try {
        const result = await client.callTool({
          name: 'draftOutreachMessage',
          arguments: {
            contactId: 'contact001',
            companyName: 'SampleCorp',
            roleTitle: 'Staff Engineer',
            platform: 'linkedin',
          },
        });
        const text = extractText(result.content as unknown as readonly { type: string; text?: string }[]);
        expect(result.isError, `outreach failed with text: ${text}`).toBeUndefined();
        const parsed = JSON.parse(text);
        expect(parsed.markdownPath).toContain('outreachMessage.md');
        const draft = await readFile(parsed.markdownPath, 'utf8');
        expect(draft.length).toBeGreaterThan(0);
        expect(draft).toContain('SampleCorp');
      } finally {
        await client.close();
        await server.close();
      }
    });
  });

  it('draftOutreachMessage rejects unknown contacts', async () => {
    await withSandbox(async (paths) => {
      const connected = await connectToServer(paths, makeRegistry([]));
      try {
        const result = await callTool(connected, 'draftOutreachMessage', {
          contactId: 'contact999',
          companyName: 'SampleCorp',
          roleTitle: 'Staff Engineer',
        });
        expect(result.isError).toBe(true);
        expect(result.text.length).toBeGreaterThan(0);
      } finally {
        await connected.close();
      }
    });
  });

  it('draftCoverLetter writes only a local markdown draft and never triggers resume or outreach', async () => {
    await withSandbox(async (paths) => {
      const outputDirectory = join(paths.dir, 'applications');
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const server = createMcpServer({
        profilePath: paths.profilePath,
        dataRoot: paths.dir,
        historyPath: paths.historyPath,
        contactsPath: paths.contactsPath,
      });
      await server.connect(serverTransport);
      const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });
      await client.connect(clientTransport);
      try {
        const result = await client.callTool({
          name: 'draftCoverLetter',
          arguments: {
            companyName: 'SampleCorp',
            roleTitle: 'Staff Engineer',
          },
        });
        const text = extractText(result.content as unknown as readonly { type: string; text?: string }[]);
        expect(result.isError, `cover letter failed with text: ${text}`).toBeUndefined();
        const parsed = JSON.parse(text);
        expect(parsed.markdownPath).toContain('coverLetter.md');
        const draft = await readFile(parsed.markdownPath, 'utf8');
        expect(draft.length).toBeGreaterThan(0);
        expect(draft).toContain('SampleCorp');

        // Assert no other output file was created (no resume or outreach draft)
        const outputFolder = join(outputDirectory, 'SampleCorp-StaffEngineer');
        const files = await readdir(outputFolder);
        expect(files).toEqual(['coverLetter.md']);
      } finally {
        await client.close();
        await server.close();
      }
    });
  });

  it('draftCoverLetter rejects when profile is missing and writes nothing', async () => {
    await withEmptySandbox(async (paths) => {
      const outputDirectory = join(paths.dir, 'applications');
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const server = createMcpServer({
        profilePath: paths.profilePath,
        dataRoot: paths.dir,
        historyPath: paths.historyPath,
        contactsPath: paths.contactsPath,
      });
      await server.connect(serverTransport);
      const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });
      await client.connect(clientTransport);
      try {
        const result = await client.callTool({
          name: 'draftCoverLetter',
          arguments: {
            companyName: 'SampleCorp',
            roleTitle: 'Staff Engineer',
          },
        });
        expect(result.isError).toBe(true);
        const errorText = extractText(result.content as unknown as readonly { type: string; text?: string }[]);
        expect(errorText.length).toBeGreaterThan(0);

        // Assert nothing was written to the output directory
        const outputFolder = join(outputDirectory, 'SampleCorp-StaffEngineer');
        let folderExists = true;
        try {
          await readdir(outputFolder);
        } catch {
          folderExists = false;
        }
        expect(folderExists).toBe(false);
      } finally {
        await client.close();
        await server.close();
      }
    });
  });

  it('parsePdfDocument surfaces a clear error for a missing file', async () => {
    await withSandbox(async (paths) => {
      const connected = await connectToServer(paths, makeRegistry([]));
      try {
        const result = await callTool(connected, 'parsePdfDocument', {
          filePath: join(paths.dir, 'does-not-exist.pdf'),
        });
        expect(result.isError).toBe(true);
        expect(result.text).toContain('Unable to read PDF file');
      } finally {
        await connected.close();
      }
    });
  });

  it('ingestDocuments returns per-file summaries and never modifies the source directory', async () => {
    await withSandbox(async (paths) => {
      const docsDir = join(paths.dir, 'docs');
      await mkdir(docsDir);
      await writeFile(join(docsDir, 'resume.pdf'), makeMinimalPdf('Jane Sample resume summary content'));
      await writeFile(join(docsDir, 'notes.md'), '# Notes\n\nSome markdown notes.\n', 'utf8');
      await writeFile(join(docsDir, 'postings.txt'), 'Saved posting text.\n', 'utf8');
      await writeFile(join(docsDir, '.hidden.md'), 'secret\n', 'utf8');

      const before = new Map<string, string>();
      const listingBefore = (await readdir(docsDir)).sort();
      for (const name of listingBefore) {
        before.set(name, sha256(await readFile(join(docsDir, name))));
      }

      const connected = await connectToServer(paths, makeRegistry([]));
      try {
        const result = await callTool(connected, 'ingestDocuments', { dirPath: docsDir });
        expect(result.isError).toBe(false);
        const payload = JSON.parse(result.text);
        expect(payload).toHaveLength(3);
        expect(payload.map((summary: { fileName: string }) => summary.fileName)).toEqual([
          'notes.md',
          'postings.txt',
          'resume.pdf',
        ]);
        const byName = new Map<string, { fileType: string }>(
          payload.map((summary: { fileName: string; fileType: string }) => [summary.fileName, summary]),
        );
        expect(byName.get('resume.pdf')?.fileType).toBe('pdf');
        expect(byName.get('notes.md')?.fileType).toBe('markdown');
        expect(byName.get('postings.txt')?.fileType).toBe('text');
        expect(result.structuredContent?.documentCount).toBe(3);
        expect(result.structuredContent?.summaries).toBeDefined();
      } finally {
        await connected.close();
      }

      const after = new Map<string, string>();
      const listingAfter = (await readdir(docsDir)).sort();
      for (const name of listingAfter) {
        after.set(name, sha256(await readFile(join(docsDir, name))));
      }
      expect(listingAfter).toEqual(listingBefore);
      expect(after.size).toBe(before.size);
      for (const [name, hash] of before) {
        expect(after.get(name)).toBe(hash);
      }
    });
  });

  it('ingestDocuments returns an empty result for a not-yet-created directory', async () => {
    await withSandbox(async (paths) => {
      const connected = await connectToServer(paths, makeRegistry([]));
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const result = await callTool(connected, 'ingestDocuments', {
          dirPath: join(paths.dir, 'no-such-dir'),
        });
        expect(result.isError).toBe(false);
        expect(result.text).toContain('No supported documents found');
        expect(result.structuredContent?.documentCount).toBe(0);
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('does not exist yet'));
      } finally {
        warnSpy.mockRestore();
        await connected.close();
      }
    });
  });

  it('suggestRoles derives role suggestions from the saved profile and runs no search', async () => {
    await withSandbox(async (paths) => {
      const connected = await connectToServer(paths, makeRegistry([]));
      try {
        const result = await callTool(connected, 'suggestRoles', {});
        expect(result.isError).toBe(false);
        const suggestions = JSON.parse(result.text) as string[];
        expect(Array.isArray(suggestions)).toBe(true);
        expect(suggestions.length).toBeGreaterThan(0);
        expect(suggestions).toContain('Staff Frontend Engineer');
        expect(result.structuredContent?.suggestionCount).toBe(suggestions.length);
        expect(result.structuredContent?.suggestions).toEqual(suggestions);

        // No search/evaluate/generate was triggered: history stays empty.
        const history = await readApplicationHistory(paths.historyPath);
        expect(history.applications).toHaveLength(0);
      } finally {
        await connected.close();
      }
    });
  });

  it('suggestRoles reports a clear error for a missing profile and writes nothing', async () => {
    await withEmptySandbox(async (paths) => {
      const connected = await connectToEmptyServer(paths);
      try {
        const result = await callTool(connected, 'suggestRoles', {});
        expect(result.isError).toBe(true);
        expect(result.text).toContain('No master profile found');
        expect(await readdir(paths.dir)).toEqual([]);
      } finally {
        await connected.close();
      }
    });
  });
});

const initializationPayload = {
  jobPreferences: {
    compensation: {
      currency: 'USD',
      minAcceptableBase: 110000,
      targetBase: 140000,
      countsBonusTowardMin: false,
      countsEquityTowardMin: false,
    },
    clearance: {
      currentStatus: 'none',
      currentLevel: null,
      eligibleToObtain: true,
      requiresSponsorshipForVisa: false,
    },
    nonNegotiables: [
      { id: 'noRelocation', category: 'location', rule: 'reject if the posting requires relocation' },
    ],
    preferredLocations: ['Remote'],
  },
  screeningAnswers: {
    workAuthorization: { usCitizen: true, requiresSponsorship: false, sponsorshipType: null },
    compensation: { minBaseSalary: 110000, targetBaseSalary: 140000, currency: 'USD' },
    standardQuestions: {
      yearsOfExperience: { softwareEngineering: 8, typescript: 5, python: 3 },
      preferredWorkLocation: 'Remote',
      noticePeriod: '2 weeks',
    },
  },
  masterProfile: {
    contact: {
      name: 'Jane Sample',
      email: 'jane@sample.example',
      phone: '555-0100',
      cityState: 'Austin, TX',
      linkedIn: 'https://www.linkedin.com/in/jane-sample',
      portfolio: 'https://jane.example',
    },
    workAuthorization: { usCitizen: 'yes', requiresSponsorship: 'no', clearance: 'none' },
    summary: 'Senior platform engineer with 8+ years building distributed systems.',
    skills: [
      { category: 'Languages', items: ['TypeScript', 'Rust'] },
      { category: 'Infrastructure', items: ['AWS', 'Kubernetes'] },
    ],
    experience: [
      {
        roleTitle: 'Senior Engineer',
        employer: 'SampleCorp',
        location: 'Remote',
        startDate: '2020',
        endDate: '2026',
        bullets: ['Built event-driven pipelines with Kafka.'],
      },
    ],
    education: [
      { degree: 'BS Computer Science', institution: 'SampleState University', startYear: '2010', endYear: '2014' },
    ],
    certifications: ['AWS Certified Developer'],
  },
} as const;

interface EmptySandboxPaths {
  dir: string;
  historyPath: string;
  preferencesPath: string;
  profilePath: string;
  screeningAnswersPath: string;
  contactsPath: string;
}

async function withEmptySandbox<T>(fn: (paths: EmptySandboxPaths) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'weJobSearch-profileMCP-'));
  const previousRoot = process.env.WEJOBSEARCHDATAROOT;
  process.env.WEJOBSEARCHDATAROOT = dir;
  const paths: EmptySandboxPaths = {
    dir,
    historyPath: join(dir, 'applications', 'applicationHistory.json'),
    preferencesPath: join(dir, 'jobPreferences.yaml'),
    profilePath: join(dir, 'masterProfile.md'),
    screeningAnswersPath: join(dir, 'screeningAnswers.json'),
    contactsPath: join(dir, 'networkingContacts.json'),
  };
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

async function connectToEmptyServer(paths: EmptySandboxPaths): Promise<ConnectedClient> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer({
    profilePath: paths.profilePath,
    preferencesPath: paths.preferencesPath,
    screeningAnswersPath: paths.screeningAnswersPath,
    historyPath: paths.historyPath,
    contactsPath: paths.contactsPath,
  });
  await server.connect(serverTransport);
  const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });
  await client.connect(clientTransport);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

describe('jobSearchServer profile tools', () => {
  it('getUserProfile reports an unconfigured profile for a fresh directory', async () => {
    await withEmptySandbox(async (paths) => {
      const connected = await connectToEmptyServer(paths);
      try {
        const result = await callTool(connected, 'getUserProfile', {});
        expect(result.isError).toBe(false);
        const payload = JSON.parse(result.text);
        expect(payload.configured).toBe(false);
        expect(payload.incompleteReasons.length).toBe(4);
        expect(payload.onboardingSteps).toHaveLength(4);
        expect(payload.onboardingSteps[0]).toContain('documents');
        expect(payload.onboardingSteps[1]).toContain('ingestDocuments');
        expect(result.structuredContent?.files).toBeDefined();
        expect(result.structuredContent?.onboardingSteps).toHaveLength(4);
      } finally {
        await connected.close();
      }
    });
  });

  it('initializeUserProfile writes nothing without explicit confirmation', async () => {
    await withEmptySandbox(async (paths) => {
      const connected = await connectToEmptyServer(paths);
      try {
        const result = await callTool(connected, 'initializeUserProfile', {
          ...initializationPayload,
        });
        expect(result.isError).toBe(true);
        const after = await callTool(connected, 'getUserProfile', {});
        const payload = JSON.parse(after.text);
        expect(payload.configured).toBe(false);
      } finally {
        await connected.close();
      }
    });
  });

  it('initializeUserProfile creates the four profile files when confirmed', async () => {
    await withEmptySandbox(async (paths) => {
      const connected = await connectToEmptyServer(paths);
      try {
        const result = await callTool(connected, 'initializeUserProfile', {
          ...initializationPayload,
          confirmed: true,
        });
        expect(result.isError).toBe(false);
        const payload = JSON.parse(result.text);
        expect(payload.filesWritten).toHaveLength(4);

        const state = await callTool(connected, 'getUserProfile', {});
        const statePayload = JSON.parse(state.text);
        expect(statePayload.configured).toBe(true);
        expect(statePayload.incompleteReasons).toEqual([]);
      } finally {
        await connected.close();
      }
    });
  });

  it('initializeUserProfile refuses to overwrite an existing profile', async () => {
    await withEmptySandbox(async (paths) => {
      const connected = await connectToEmptyServer(paths);
      try {
        await callTool(connected, 'initializeUserProfile', {
          ...initializationPayload,
          confirmed: true,
        });
        const second = await callTool(connected, 'initializeUserProfile', {
          ...initializationPayload,
          confirmed: true,
        });
        expect(second.isError).toBe(true);
        expect(second.text).toContain('already exists');
      } finally {
        await connected.close();
      }
    });
  });

  it('updateUserProfile writes nothing without confirmation and updates only supplied sections when confirmed', async () => {
    await withEmptySandbox(async (paths) => {
      const connected = await connectToEmptyServer(paths);
      try {
        await callTool(connected, 'initializeUserProfile', {
          ...initializationPayload,
          confirmed: true,
        });

        const unconfirmed = await callTool(connected, 'updateUserProfile', {
          masterProfile: { summary: 'An updated summary that must not be persisted.' },
        });
        expect(unconfirmed.isError).toBe(true);

        const confirmed = await callTool(connected, 'updateUserProfile', {
          masterProfile: { summary: 'Updated summary persisting only this section.' },
          confirmed: true,
        });
        expect(confirmed.isError).toBe(false);
        const payload = JSON.parse(confirmed.text);
        expect(payload.filesUpdated).toEqual([paths.profilePath]);

        const state = await callTool(connected, 'getUserProfile', {});
        const masterProfile = state.structuredContent?.masterProfile as
          | { summary?: string; name?: string }
          | undefined;
        const jobPreferences = state.structuredContent?.jobPreferences as
          | { compensation?: { minAcceptableBase?: number } }
          | undefined;
        expect(masterProfile?.summary).toBe('Updated summary persisting only this section.');
        expect(masterProfile?.name).toBe('Jane Sample');
        expect(jobPreferences?.compensation?.minAcceptableBase).toBe(110000);
      } finally {
        await connected.close();
      }
    });
  });
});
describe('dataRoot environment honoring per handler (U26)', () => {
  it('resolves history, profile, and contacts from WEJOBSEARCHDATAROOT with no explicit paths', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'weJobSearch-mcpenv-'));
    const previousRoot = process.env.WEJOBSEARCHDATAROOT;
    process.env.WEJOBSEARCHDATAROOT = dir;
    try {
      const historyPath = join(dir, 'applications', 'applicationHistory.json');
      await mkdir(join(dir, 'applications'), { recursive: true });
      await writeFile(
        historyPath,
        JSON.stringify({
          applications: [
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
          ],
        }),
        'utf8',
      );
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const server = createMcpServer({ registry: makeRegistry([]) });
      await server.connect(serverTransport);
      const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });
      await client.connect(clientTransport);
      try {
        const result = await client.callTool({ name: 'getFunnelReport', arguments: {} });
        expect(result.isError).not.toBe(true);
        const payload = JSON.parse((result.content as { text: string }[])[0].text);
        expect(payload.totalApplications).toBe(1);
      } finally {
        await client.close();
      }
    } finally {
      if (previousRoot === undefined) {
        delete process.env.WEJOBSEARCHDATAROOT;
      } else {
        process.env.WEJOBSEARCHDATAROOT = previousRoot;
      }
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('injected dependency paths win over env defaults (U44)', () => {
  function manualReviewRecord(): ApplicationRecord {
    return {
      applicationId: generateApplicationId('AltCorp', 'Staff Engineer'),
      companyName: 'AltCorp',
      roleTitle: 'Staff Engineer',
      jobUrl: 'https://alpha.test/jobs/44',
      postingHash: computePostingHash('AltCorp', 'Staff Engineer', 'Remote'),
      sourceAggregators: ['stubAlpha'],
      salaryRange: null,
      fitScore: 3.0,
      fitStatus: 'manualReview',
      referralContact: null,
      status: 'evaluated',
      statusHistory: [{ stage: 'evaluated', timestamp: '2026-08-08T10:00:00Z' }],
    };
  }

  it('getReviewQueue reads the injected history file, not the env default', async () => {
    await withSandbox(async (paths) => {
      const altHistoryPath = join(paths.dir, 'altHistory.json');
      await writeFile(altHistoryPath, JSON.stringify({ applications: [manualReviewRecord()] }), 'utf8');
      const connected = await connectToServer(paths, makeRegistry([]), { historyPath: altHistoryPath });
      try {
        const result = await callTool(connected, 'getReviewQueue', {});
        expect(result.isError).toBe(false);
        expect(result.text).toContain('AltCorp');
      } finally {
        await connected.close();
      }
    });
  });

  it('logNetworkingContact writes to the injected contacts file, leaving the default untouched', async () => {
    await withSandbox(async (paths) => {
      const altContactsPath = join(paths.dir, 'altContacts.json');
      const connected = await connectToServer(paths, makeRegistry([]), { contactsPath: altContactsPath });
      try {
        const result = await callTool(connected, 'logNetworkingContact', {
          name: 'Sam Rivera',
          company: 'AltCorp',
        });
        expect(result.isError).toBe(false);
        const alt = await readNetworkingContacts(altContactsPath, paths.dir);
        expect(alt.contacts.map((contact) => contact.name)).toContain('Sam Rivera');
        const kept = await readNetworkingContacts(paths.contactsPath, paths.dir);
        expect(kept.contacts.map((contact) => contact.name)).not.toContain('Sam Rivera');
      } finally {
        await connected.close();
      }
    });
  });

  it('getFunnelReport reads the injected history, contacts, and search-history files', async () => {
    await withSandbox(async (paths) => {
      const altHistoryPath = join(paths.dir, 'altHistory.json');
      const altContactsPath = join(paths.dir, 'altContacts.json');
      const altSearchHistoryPath = join(paths.dir, 'altSearchHistory.json');
      await writeFile(altHistoryPath, JSON.stringify({ applications: [manualReviewRecord()] }), 'utf8');
      await writeFile(altContactsPath, JSON.stringify({ contacts: [] }), 'utf8');
      await writeFile(
        altSearchHistoryPath,
        JSON.stringify({
          searches: [
            {
              searchId: 'search2026AltQuery',
              keywords: 'alt query',
              location: 'Remote',
              timestamp: new Date().toISOString(),
              resultCount: 1,
            },
          ],
        }),
        'utf8',
      );
      const connected = await connectToServer(paths, makeRegistry([]), {
        historyPath: altHistoryPath,
        contactsPath: altContactsPath,
        searchHistoryPath: altSearchHistoryPath,
      });
      try {
        const result = await callTool(connected, 'getFunnelReport', {});
        expect(result.isError).toBe(false);
        const report = JSON.parse(result.text) as {
          totalApplications: number;
          recentSearches: { keywords: string }[];
        };
        expect(report.totalApplications).toBe(1);
        // recentSearches is not PII-redacted, so the injected keywords prove
        // the injected search-history file (not the env default) was read.
        expect(report.recentSearches).toHaveLength(1);
        expect(report.recentSearches[0]?.keywords).toBe('alt query');
      } finally {
        await connected.close();
      }
    });
  });

  it('confirmApplicationSubmission writes to the injected history file', async () => {
    await withSandbox(async (paths) => {
      const altHistoryPath = join(paths.dir, 'altHistory.json');
      await writeFile(altHistoryPath, JSON.stringify({ applications: [manualReviewRecord()] }), 'utf8');
      const connected = await connectToServer(paths, makeRegistry([]), { historyPath: altHistoryPath });
      try {
        const result = await callTool(connected, 'confirmApplicationSubmission', {
          companyName: 'AltCorp',
          roleTitle: 'Staff Engineer',
          notes: 'Submitted via portal',
        });
        expect(result.isError).toBe(false);
        const alt = await readApplicationHistory(altHistoryPath, paths.dir);
        expect(alt.applications[0]?.status).toBe('appliedConfirmed');
        expect(existsSync(paths.historyPath)).toBe(false);
      } finally {
        await connected.close();
      }
    });
  });

  it('runSavedSearches reads the injected savedSearches file, not the env default', async () => {
    await withSandbox(async (paths) => {
      await addSavedSearch({ keywords: 'staff engineer', location: 'Remote' }, paths.savedSearchesPath, paths.dir);
      const altSavedPath = join(paths.dir, 'altSavedSearches.json');
      await writeFile(altSavedPath, JSON.stringify({ searches: [] }), 'utf8');
      const registry = makeRegistry([{ name: 'stubAlpha', postings: [posting()] }]);
      const connected = await connectToServer(paths, registry, { savedSearchesPath: altSavedPath });
      try {
        const result = await callTool(connected, 'runSavedSearches', {});
        expect(result.isError).toBe(false);
        // The env-default file holds one saved search (which would evaluate
        // the stub posting); the injected empty file must win instead.
        const payload = JSON.parse(result.text) as { evaluatedCount: number };
        expect(payload.evaluatedCount).toBe(0);
      } finally {
        await connected.close();
      }
    });
  });

  it('searchJobPostings under an isolated dataRoot writes nothing to the env root', async () => {
    await withSandbox(async (paths) => {
      const otherDir = await mkdtemp(join(tmpdir(), 'weJobSearch-mcp-root-'));
      try {
        await writeFile(join(otherDir, 'jobPreferences.yaml'), await readFile(paths.preferencesPath, 'utf8'), 'utf8');
        await writeFile(join(otherDir, 'masterProfile.md'), await readFile(paths.profilePath, 'utf8'), 'utf8');
        const registry = makeRegistry([{ name: 'stubAlpha', postings: [posting()] }]);
        const connected = await connectToServer(paths, registry, { dataRoot: otherDir });
        try {
          const result = await callTool(connected, 'searchJobPostings', {
            keywords: 'staff engineer',
            location: 'Remote',
          });
          expect(result.isError).toBe(false);
          expect(existsSync(join(otherDir, 'applications', 'applicationHistory.json'))).toBe(true);
          expect(existsSync(join(paths.dir, 'applications'))).toBe(false);
        } finally {
          await connected.close();
        }
      } finally {
        await rm(otherDir, { recursive: true, force: true });
      }
    });
  });

  it('evaluateJobPosting under an isolated dataRoot writes nothing to the env root', async () => {
    await withSandbox(async (paths) => {
      const otherDir = await mkdtemp(join(tmpdir(), 'weJobSearch-mcp-root-'));
      try {
        await writeFile(join(otherDir, 'jobPreferences.yaml'), await readFile(paths.preferencesPath, 'utf8'), 'utf8');
        await writeFile(join(otherDir, 'masterProfile.md'), await readFile(paths.profilePath, 'utf8'), 'utf8');
        const target = posting({ jobUrl: 'https://alpha.test/jobs/44' });
        const registry = makeRegistry([
          { name: 'stubAlpha', fetcher: (url) => (url === target.jobUrl ? target : null) },
        ]);
        const connected = await connectToServer(paths, registry, { dataRoot: otherDir });
        try {
          const result = await callTool(connected, 'evaluateJobPosting', { jobUrl: target.jobUrl });
          expect(result.isError).toBe(false);
          expect(JSON.parse(result.text).alreadyRecorded).toBe(false);
          expect(existsSync(join(otherDir, 'applications', 'applicationHistory.json'))).toBe(true);
          expect(existsSync(join(paths.dir, 'applications'))).toBe(false);
        } finally {
          await connected.close();
        }
      } finally {
        await rm(otherDir, { recursive: true, force: true });
      }
    });
  });

  it('searchByProfile under an isolated dataRoot writes nothing to the env root', async () => {
    await withSandbox(async (paths) => {
      const otherDir = await mkdtemp(join(tmpdir(), 'weJobSearch-mcp-root-'));
      try {
        await writeFile(join(otherDir, 'jobPreferences.yaml'), preferencesWithTargetRolesYaml, 'utf8');
        await writeFile(join(otherDir, 'masterProfile.md'), await readFile(paths.profilePath, 'utf8'), 'utf8');
        const registry = makeRegistry([
          { name: 'stubAlpha', postings: [posting({ jobUrl: 'https://alpha.test/jobs/44' })] },
        ]);
        const connected = await connectToServer(paths, registry, { dataRoot: otherDir });
        try {
          const result = await callTool(connected, 'searchByProfile', {});
          expect(result.isError).toBe(false);
          // Two targetRoles queries return the same stub posting; the
          // cross-query merge keeps one entry and one new record.
          expect(JSON.parse(result.text).evaluatedCount).toBe(1);
          const otherHistory = await readApplicationHistory(
            join(otherDir, 'applications', 'applicationHistory.json'),
            otherDir,
          );
          expect(otherHistory.applications).toHaveLength(1);
          expect(existsSync(join(paths.dir, 'applications'))).toBe(false);
        } finally {
          await connected.close();
        }
      } finally {
        await rm(otherDir, { recursive: true, force: true });
      }
    });
  });

  it('runSavedSearches under an isolated dataRoot writes nothing to the env root', async () => {
    await withSandbox(async (paths) => {
      const otherDir = await mkdtemp(join(tmpdir(), 'weJobSearch-mcp-root-'));
      try {
        await writeFile(join(otherDir, 'jobPreferences.yaml'), await readFile(paths.preferencesPath, 'utf8'), 'utf8');
        await writeFile(join(otherDir, 'masterProfile.md'), await readFile(paths.profilePath, 'utf8'), 'utf8');
        const altSavedPath = join(otherDir, 'savedSearches.json');
        await addSavedSearch({ keywords: 'staff engineer', location: 'Remote' }, altSavedPath, otherDir);
        const registry = makeRegistry([
          { name: 'stubAlpha', postings: [posting({ jobUrl: 'https://alpha.test/jobs/44' })] },
        ]);
        const connected = await connectToServer(paths, registry, {
          dataRoot: otherDir,
          savedSearchesPath: altSavedPath,
        });
        try {
          const result = await callTool(connected, 'runSavedSearches', {});
          expect(result.isError).toBe(false);
          expect(JSON.parse(result.text).newRecords).toBe(1);
          const otherHistory = await readApplicationHistory(
            join(otherDir, 'applications', 'applicationHistory.json'),
            otherDir,
          );
          expect(otherHistory.applications).toHaveLength(1);
          const otherSearches = await readSearchHistory(join(otherDir, 'searchHistory.json'), otherDir);
          expect(otherSearches.searches.length).toBeGreaterThan(0);
          expect(existsSync(join(paths.dir, 'applications'))).toBe(false);
        } finally {
          await connected.close();
        }
      } finally {
        await rm(otherDir, { recursive: true, force: true });
      }
    });
  });

  it('getPostingDetail reads the injected history file, not the env default', async () => {
    await withSandbox(async (paths) => {
      const altHistoryPath = join(paths.dir, 'altHistory.json');
      await writeFile(altHistoryPath, JSON.stringify({ applications: [manualReviewRecord()] }), 'utf8');
      const connected = await connectToServer(paths, makeRegistry([]), { historyPath: altHistoryPath });
      try {
        const result = await callTool(connected, 'getPostingDetail', {
          companyName: 'AltCorp',
          roleTitle: 'Staff Engineer',
        });
        expect(result.isError).toBe(false);
        expect(JSON.parse(result.text).postingHash).toBe(
          computePostingHash('AltCorp', 'Staff Engineer', 'Remote'),
        );
      } finally {
        await connected.close();
      }
      // The same lookup against the untouched env default finds nothing.
      const defaultConnected = await connectToServer(paths, makeRegistry([]));
      try {
        const missed = await callTool(defaultConnected, 'getPostingDetail', {
          companyName: 'AltCorp',
          roleTitle: 'Staff Engineer',
        });
        expect(missed.isError).toBe(true);
      } finally {
        await defaultConnected.close();
      }
    });
  });

  it('generateTailoredApplication marks generated on the injected history file', async () => {
    await withSandbox(async (paths) => {
      await writeFile(
        join(paths.dir, 'resumeVariants.yaml'),
        'variants:\n  usStandardResume:\n    template: templates/usStandardResume.typ\n    triggers: {}\n',
        'utf8',
      );
      const altHistoryPath = join(paths.dir, 'altHistory.json');
      await writeFile(altHistoryPath, JSON.stringify({ applications: [manualReviewRecord()] }), 'utf8');
      const connected = await connectToServer(paths, makeRegistry([]), { historyPath: altHistoryPath });
      try {
        const result = await callTool(connected, 'generateTailoredApplication', {
          companyName: 'AltCorp',
          roleTitle: 'Staff Engineer',
        });
        expect(result.isError).toBe(false);
        const alt = await readApplicationHistory(altHistoryPath, paths.dir);
        expect(alt.applications).toHaveLength(1);
        expect(alt.applications[0]?.status).toBe('generated');
        expect(alt.applications[0]?.resumeVariant).toBe('usStandardResume');
        expect(existsSync(paths.historyPath)).toBe(false);
      } finally {
        await connected.close();
      }
    });
  });

  // This test runs two full Typst compiles (CLI plus MCP). On machines
  // without a system typst binary the WASM fallback compiles can exceed the
  // 5s default timeout under full-suite parallel load, so the test carries
  // an explicit budget.
  it('CLI runGenerate and MCP generateTailoredApplication produce identical history mutations (Phase A)', async () => {
    const variantsYaml =
      'variants:\n  usStandardResume:\n    template: templates/usStandardResume.typ\n    triggers: {}\n';
    await withSandbox(async (cliPaths) => {
      await writeFile(join(cliPaths.dir, 'resumeVariants.yaml'), variantsYaml, 'utf8');
      await mkdir(join(cliPaths.dir, 'applications'), { recursive: true });
      await writeFile(cliPaths.historyPath, JSON.stringify({ applications: [manualReviewRecord()] }), 'utf8');
      const cliResult = await runGenerate({
        company: 'AltCorp',
        role: 'Staff Engineer',
        dataRoot: cliPaths.dir,
      });
      expect(cliResult.exitCode).toBe(0);
      const cliHistory = await readApplicationHistory(cliPaths.historyPath, cliPaths.dir);
      expect(cliHistory.applications).toHaveLength(1);
      const cliRecord = cliHistory.applications[0];
      await withSandbox(async (mcpPaths) => {
        await writeFile(join(mcpPaths.dir, 'resumeVariants.yaml'), variantsYaml, 'utf8');
        const altHistoryPath = join(mcpPaths.dir, 'altHistory.json');
        await writeFile(altHistoryPath, JSON.stringify({ applications: [manualReviewRecord()] }), 'utf8');
        const connected = await connectToServer(mcpPaths, makeRegistry([]), { historyPath: altHistoryPath });
        try {
          const mcpResult = await callTool(connected, 'generateTailoredApplication', {
            companyName: 'AltCorp',
            roleTitle: 'Staff Engineer',
          });
          expect(mcpResult.isError).toBe(false);
          const mcpHistory = await readApplicationHistory(altHistoryPath, mcpPaths.dir);
          expect(mcpHistory.applications).toHaveLength(1);
          const mcpRecord = mcpHistory.applications[0];
          expect(mcpRecord.applicationId).toBe(cliRecord.applicationId);
          expect(cliRecord.status).toBe('generated');
          expect(mcpRecord.status).toBe('generated');
          expect(cliRecord.resumeVariant).toBe('usStandardResume');
          expect(mcpRecord.resumeVariant).toBe('usStandardResume');
          expect(cliRecord.statusHistory.map((entry) => entry.stage)).toEqual(['evaluated', 'generated']);
          expect(mcpRecord.statusHistory.map((entry) => entry.stage)).toEqual(['evaluated', 'generated']);
        } finally {
          await connected.close();
        }
      });
    });
  }, 60000);

  // Phase G side-effect parity: the CLI search command and the MCP
  // searchJobPostings tool run the same core pipeline, so a given filter must
  // narrow the rendered tables identically and persist identical history
  // records on both surfaces.
  it('CLI runSearchCommand and MCP searchJobPostings apply identical filters and persist identical records', async () => {
    await withSandbox(async (cliPaths) => {
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
      const cliResult = await runSearchCommand({
        keywords: 'staff engineer',
        remoteOnly: true,
        registry,
        dataRoot: cliPaths.dir,
      });
      expect(cliResult.exitCode).toBe(0);
      const cliText = cliResult.printedLines.join('\n');
      expect(cliText).toContain('Filters: remoteOnly. Shown 1 of 2 evaluated posting(s).');
      expect(cliText).toContain('Staff Engineer');
      expect(cliText).not.toContain('Onsite Reliability Engineer');
      const cliHistory = await readApplicationHistory(cliPaths.historyPath, cliPaths.dir);
      expect(cliHistory.applications).toHaveLength(2);
      expect(cliHistory.applications.every((record) => record.status === 'evaluated')).toBe(true);

      await withSandbox(async (mcpPaths) => {
        const mcpRegistry = makeRegistry([{ name: 'stubAlpha', postings: [strongAlpha, hardPosting] }]);
        const connected = await connectToServer(mcpPaths, mcpRegistry);
        try {
          const mcpResult = await callTool(connected, 'searchJobPostings', {
            keywords: 'staff engineer',
            location: 'Remote',
            remoteOnly: true,
          });
          expect(mcpResult.isError).toBe(false);
          const payload = JSON.parse(mcpResult.text) as {
            activeResults: { rows: Array<{ jobTitle: string }> };
            excludedResults: { rows: Array<{ jobTitle: string }> };
          };
          // Same filtered rendering as the CLI: the onsite posting is filtered
          // out of both tables on both surfaces.
          expect(payload.activeResults.rows.map((row) => row.jobTitle)).toEqual(['Staff Engineer']);
          expect(payload.excludedResults.rows).toEqual([]);
          const mcpHistory = await readApplicationHistory(mcpPaths.historyPath, mcpPaths.dir);
          expect(mcpHistory.applications).toHaveLength(2);
          expect(mcpHistory.applications.every((record) => record.status === 'evaluated')).toBe(true);
          for (const record of mcpHistory.applications) {
            const cliRecord = cliHistory.applications.find((entry) => entry.applicationId === record.applicationId);
            expect(cliRecord, `MCP record ${record.applicationId} missing from the CLI history`).toBeDefined();
            expect(record.status).toBe(cliRecord!.status);
            expect(record.fitScore).toBe(cliRecord!.fitScore);
            expect(record.fitStatus).toBe(cliRecord!.fitStatus);
            expect(record.postingHash).toBe(cliRecord!.postingHash);
          }
        } finally {
          await connected.close();
        }
      });
    });
  });

  it('draftOutreachMessage drafts under the injected dataRoot, not the env default', async () => {
    await withSandbox(async (paths) => {
      const altRoot = join(paths.dir, 'altRoot');
      await mkdir(altRoot, { recursive: true });
      await writeFile(join(altRoot, 'masterProfile.md'), profileMarkdown, 'utf8');
      await writeFile(join(altRoot, 'networkingContacts.json'), JSON.stringify(contactsJson, null, 2), 'utf8');
      const connected = await connectToServer(paths, makeRegistry([]), { dataRoot: altRoot });
      try {
        const result = await callTool(connected, 'draftOutreachMessage', {
          contactId: 'contact001',
          companyName: 'SampleCorp',
          roleTitle: 'Staff Engineer',
          platform: 'linkedin',
        });
        expect(result.isError).toBe(false);
        const parsed = JSON.parse(result.text) as { markdownPath: string };
        expect(parsed.markdownPath.startsWith(join(altRoot, 'applications'))).toBe(true);
        expect((await readFile(parsed.markdownPath, 'utf8')).length).toBeGreaterThan(0);
        expect(existsSync(join(paths.dir, 'applications', 'SampleCorp-StaffEngineer', 'outreachMessage.md'))).toBe(false);
      } finally {
        await connected.close();
      }
    });
  });

  it('draftCoverLetter drafts under the injected dataRoot, not the env default', async () => {
    await withSandbox(async (paths) => {
      const altRoot = join(paths.dir, 'altRoot');
      await mkdir(altRoot, { recursive: true });
      await writeFile(join(altRoot, 'masterProfile.md'), profileMarkdown, 'utf8');
      const connected = await connectToServer(paths, makeRegistry([]), { dataRoot: altRoot });
      try {
        const result = await callTool(connected, 'draftCoverLetter', {
          companyName: 'SampleCorp',
          roleTitle: 'Staff Engineer',
        });
        expect(result.isError).toBe(false);
        const parsed = JSON.parse(result.text) as { markdownPath: string };
        expect(parsed.markdownPath.startsWith(join(altRoot, 'applications'))).toBe(true);
        expect(parsed.markdownPath).toContain('coverLetter.md');
        expect(await readFile(parsed.markdownPath, 'utf8')).toContain('SampleCorp');
        expect(existsSync(join(paths.dir, 'applications', 'SampleCorp-StaffEngineer', 'coverLetter.md'))).toBe(false);
      } finally {
        await connected.close();
      }
    });
  });

  it('analyzeApplicationPatterns reads the injected history and preferences files', async () => {
    await withSandbox(async (paths) => {
      const altHistoryPath = join(paths.dir, 'altHistory.json');
      const altPreferencesPath = join(paths.dir, 'altPreferences.yaml');
      const history: ApplicationHistory = { applications: patternFixtureApplications() };
      await writeFile(altHistoryPath, JSON.stringify(history, null, 2), 'utf8');
      await writeFile(altPreferencesPath, preferencesWithTargetRolesYaml, 'utf8');
      const connected = await connectToServer(paths, makeRegistry([]), {
        historyPath: altHistoryPath,
        preferencesPath: altPreferencesPath,
      });
      try {
        const result = await callTool(connected, 'analyzeApplicationPatterns', {});
        expect(result.isError).toBe(false);
        const suggestions = JSON.parse(result.text) as PatternSuggestion[];
        // The alt preferences target Senior/Staff Engineer while every
        // fixture role is a Frontend/Data/Backend/DevOps Engineer, so drift
        // must fire — proving the injected preferencesPath (not the
        // targetRoles-less env default) was read.
        expect(suggestions.some((suggestion) => suggestion.kind === 'roleTitleDrift')).toBe(true);
        expect(suggestions.some((suggestion) => suggestion.kind === 'locationDrift')).toBe(false);
      } finally {
        await connected.close();
      }
    });
  });
});

describe('searchJobPostings filter forwarding (U44)', () => {
  it('forwards remoteOnly/minFit/minSalary/maxAgeDays to the core search filters', async () => {
    await withSandbox(async (paths) => {
      // One posting passes every filter; each of the other four fails
      // exactly one. Distinct companies keep every postingHash unique so
      // dedup cannot collapse the batch. Filters apply after evaluation and
      // persistence, before display: all five are logged, but only the
      // passing one is shown.
      const passesAll = posting({ companyName: 'PassCorp', jobUrl: 'https://alpha.test/jobs/44' });
      const failsRemoteOnly = posting({
        companyName: 'OnsiteCorp',
        roleTitle: 'Staff Engineer',
        jobUrl: 'https://alpha.test/jobs/45',
        location: 'New York, NY',
      });
      const failsMinFit = posting({
        companyName: 'RubyCorp',
        roleTitle: 'Ruby Automation Engineer',
        jobUrl: 'https://alpha.test/jobs/46',
        description:
          'Automation role requiring Ruby and Python. 4+ years of experience. Healthcare domain focus.',
        rawSalaryText: 'USD 120,000 - 140,000 per year',
      });
      const failsMinSalary = posting({
        companyName: 'LowPayCorp',
        roleTitle: 'Staff Engineer',
        jobUrl: 'https://alpha.test/jobs/47',
        rawSalaryText: 'USD 50,000 - 60,000 per year',
      });
      const failsMaxAge = posting({
        companyName: 'OldCorp',
        roleTitle: 'Staff Engineer',
        jobUrl: 'https://alpha.test/jobs/48',
        postedAt: '2020-01-01T00:00:00Z',
      });
      const registry = makeRegistry([
        {
          name: 'stubAlpha',
          postings: [passesAll, failsRemoteOnly, failsMinFit, failsMinSalary, failsMaxAge],
        },
      ]);
      const connected = await connectToServer(paths, registry);
      try {
        const result = await callTool(connected, 'searchJobPostings', {
          keywords: 'staff engineer',
          location: '',
          remoteOnly: true,
          minFit: 3.5,
          minSalary: 100000,
          maxAgeDays: 30,
        });
        expect(result.isError).toBe(false);
        const payload = JSON.parse(result.text) as {
          evaluatedCount: number;
          newRecords: number;
          activeResults: { rows: { organization: string; link: string }[] };
          excludedResults: { rows: unknown[] };
        };
        expect(payload.evaluatedCount).toBe(5);
        expect(payload.newRecords).toBe(5);
        expect(payload.activeResults.rows).toHaveLength(1);
        expect(payload.activeResults.rows[0]?.organization).toBe('PassCorp');
        expect(payload.activeResults.rows[0]?.link).toBe('https://alpha.test/jobs/44');
        expect(payload.excludedResults.rows).toHaveLength(0);
        const history = await readApplicationHistory(paths.historyPath);
        expect(history.applications).toHaveLength(5);
      } finally {
        await connected.close();
      }
    });
  });

  it('forwards minFit to the core search filters', async () => {
    await withSandbox(async (paths) => {
      const registry = makeRegistry([{ name: 'stubAlpha', postings: [posting()] }]);
      const connected = await connectToServer(paths, registry);
      try {
        const unfiltered = await callTool(connected, 'searchJobPostings', {
          keywords: 'staff engineer',
          location: 'Remote',
        });
        expect(unfiltered.isError).toBe(false);
        const unfilteredPayload = JSON.parse(unfiltered.text) as { evaluatedCount: number };
        expect(unfilteredPayload.evaluatedCount).toBe(1);
        const filtered = await callTool(connected, 'searchJobPostings', {
          keywords: 'staff engineer',
          location: 'Remote',
          minFit: 5.1,
        });
        expect(filtered.isError).toBe(false);
        const filteredPayload = JSON.parse(filtered.text) as {
          evaluatedCount: number;
          activeResults: { rows: unknown[][] };
        };
        // Filters apply post-persist, pre-display: the record is still
        // evaluated and persisted, but nothing is displayed.
        expect(filteredPayload.evaluatedCount).toBe(1);
        expect(filteredPayload.activeResults.rows).toEqual([]);
      } finally {
        await connected.close();
      }
    });
  });

  it('forwards radiusMiles to the core search filters', async () => {
    await withSandbox(async (paths) => {
      const registry = makeRegistry([{ name: 'stubAlpha', postings: [posting()] }]);
      const connected = await connectToServer(paths, registry);
      try {
        const result = await callTool(connected, 'searchJobPostings', {
          keywords: 'staff engineer',
          location: 'Remote',
          radiusMiles: 25,
        });
        expect(result.isError).toBe(false);
        const payload = JSON.parse(result.text) as { evaluatedCount: number };
        expect(payload.evaluatedCount).toBe(1);
      } finally {
        await connected.close();
      }
    });
  });
});
