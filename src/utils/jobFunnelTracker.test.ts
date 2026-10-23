import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DuplicateApplicationError,
  appendApplicationHistory,
  applicationHistorySchema,
  applicationRecordSchema,
  computePostingHash,
  generateApplicationId,
  logApplication,
  markResumeGenerated,
  readApplicationHistory,
  resolveApplicationHistoryPath,
  updateApplicationStatus,
  writeApplicationHistory,
  type ApplicationRecord,
} from './jobFunnelTracker';
import { writeFileAtomically } from './atomicWrite';

// Count atomic writes instead of touching internals: every rewrite of the
// history file goes through writeFileAtomically, so a per-posting rewrite
// shows up as N calls. Wrapped around the real implementation.
vi.mock('./atomicWrite', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./atomicWrite')>();
  return { ...actual, writeFileAtomically: vi.fn(actual.writeFileAtomically) };
});

function historyWriteCount(): number {
  return vi
    .mocked(writeFileAtomically)
    .mock.calls.filter(([targetPath]) => targetPath.endsWith('applicationHistory.json')).length;
}

async function withTempFile<T>(fn: (filePath: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'weJobSearch-funnel-test-'));
  const previousRoot = process.env.WEJOBSEARCHDATAROOT;
  process.env.WEJOBSEARCHDATAROOT = dir;
  const filePath = join(dir, 'applicationHistory.json');
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

function baseRecord(overrides: Partial<ApplicationRecord> = {}): ApplicationRecord {
  return {
    applicationId: 'app2026SampleCorpStaffEngineer',
    companyName: 'SampleCorp',
    roleTitle: 'Staff Engineer',
    jobUrl: 'https://alpha.test/jobs/1',
    postingHash: 'a5c98a2b0b660d22a6940b5105468d5e13aebb1c5b5606a12827ed1dc0ac008c',
    sourceAggregators: ['stubAlpha'],
    salaryRange: 'USD 140000 - 180000/yr',
    fitScore: 4.2,
    fitStatus: 'strongFit',
    referralContact: null,
    status: 'evaluated',
    statusHistory: [{ stage: 'evaluated', timestamp: '2026-08-08T10:00:00Z' }],
    ...overrides,
  };
}

describe('applicationRecordSchema (SRA-02 extension)', () => {
  it('parses legacy records that predate the postingDescription/postingFacts fields', () => {
    const legacy = baseRecord();
    delete (legacy as Partial<ApplicationRecord>).postingDescription;
    const result = applicationRecordSchema.safeParse(legacy);
    expect(result.success).toBe(true);
    expect(result.success && result.data.postingDescription).toBeUndefined();
    expect(result.success && result.data.postingFacts).toBeUndefined();
  });

  it('parses new records carrying postingDescription and postingFacts', () => {
    const record = baseRecord({
      postingDescription: 'Senior distributed systems role using TypeScript and Rust.',
      postingFacts: {
        locationType: 'remote',
        employerType: 'unknown',
        requiredClearanceLevel: 'none',
      },
    });
    const result = applicationRecordSchema.safeParse(record);
    expect(result.success).toBe(true);
    expect(result.success && result.data.postingDescription).toBe(
      'Senior distributed systems role using TypeScript and Rust.',
    );
    expect(result.success && result.data.postingFacts).toEqual({
      locationType: 'remote',
      employerType: 'unknown',
      requiredClearanceLevel: 'none',
    });
  });

  it('accepts a partially-populated postingFacts object', () => {
    const record = baseRecord({
      postingFacts: { locationType: 'onsite' },
    });
    const result = applicationRecordSchema.safeParse(record);
    expect(result.success).toBe(true);
    expect(result.success && result.data.postingFacts?.employerType).toBeUndefined();
  });

  it('round-trips new records through the full history schema', () => {
    const history = {
      applications: [
        baseRecord({
          postingDescription: 'Reliability role in our New York office.',
          postingFacts: {
            locationType: 'onsite',
            employerType: 'staffingAgency',
            requiredClearanceLevel: 'unknown',
          },
        }),
      ],
    };
    expect(applicationHistorySchema.safeParse(history).success).toBe(true);
  });

  it('parses records carrying resumeVariant and legacy records without it (EUO-16)', () => {
    const withVariant = baseRecord({ resumeVariant: 'usStandardResume' });
    const withVariantResult = applicationRecordSchema.safeParse(withVariant);
    expect(withVariantResult.success).toBe(true);
    expect(withVariantResult.success && withVariantResult.data.resumeVariant).toBe('usStandardResume');

    const legacy = baseRecord();
    delete (legacy as Partial<ApplicationRecord>).resumeVariant;
    const legacyResult = applicationRecordSchema.safeParse(legacy);
    expect(legacyResult.success).toBe(true);
    expect(legacyResult.success && legacyResult.data.resumeVariant).toBeUndefined();
  });
});

describe('readApplicationHistory with the extended schema', () => {
  it('reads a file written with postingDescription + postingFacts', async () => {
    await withTempFile(async (filePath) => {
      await writeFile(
        filePath,
        JSON.stringify({
          applications: [
            baseRecord({
              postingDescription: 'Senior distributed systems role using TypeScript and Rust.',
              postingFacts: {
                locationType: 'remote',
                employerType: 'unknown',
                requiredClearanceLevel: 'none',
              },
            }),
          ],
        }),
        'utf8',
      );
      const history = await readApplicationHistory(filePath);
      expect(history.applications[0].postingDescription).toBe(
        'Senior distributed systems role using TypeScript and Rust.',
      );
      expect(history.applications[0].postingFacts?.locationType).toBe('remote');
    });
  });
});

describe('resolveApplicationHistoryPath (config-driven directories)', () => {
  const envKey = 'WEJOBSEARCHDATAROOT';
  let savedEnv: string | undefined;

  beforeEach(() => {
    savedEnv = process.env[envKey];
    delete process.env[envKey];
  });

  afterEach(() => {
    if (savedEnv === undefined) {
      delete process.env[envKey];
    } else {
      process.env[envKey] = savedEnv;
    }
    savedEnv = undefined;
  });

  it('prefers the CLI path, then the data root, then the canonical default', async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), 'weJobSearch-funnel-env-'));
    try {
      process.env[envKey] = dataRoot;
      expect(resolveApplicationHistoryPath(join(dataRoot, 'cliHistory.json'))).toBe(
        join(dataRoot, 'cliHistory.json'),
      );
      expect(resolveApplicationHistoryPath(undefined, join(tmpdir(), 'explicitRoot'))).toBe(
        join(join(tmpdir(), 'explicitRoot'), 'applications', 'applicationHistory.json'),
      );
      expect(resolveApplicationHistoryPath()).toBe(
        join(dataRoot, 'applications', 'applicationHistory.json'),
      );
    } finally {
      await rm(dataRoot, { recursive: true, force: true });
    }
  });
});

describe('updateApplicationStatus (SRA-03)', () => {
  it('transitions a record and appends to statusHistory', async () => {
    await withTempFile(async (filePath) => {
      await writeFile(filePath, JSON.stringify({ applications: [baseRecord()] }), 'utf8');
      const updated = await updateApplicationStatus(
        'app2026SampleCorpStaffEngineer',
        'interviewing',
        'Phone screen scheduled',
        filePath,
      );
      expect(updated.status).toBe('interviewing');
      expect(updated.statusHistory).toHaveLength(2);
      expect(updated.statusHistory[1].stage).toBe('interviewing');
      expect(updated.statusHistory[1].notes).toBe('Phone screen scheduled');
      const history = await readApplicationHistory(filePath);
      expect(history.applications[0].status).toBe('interviewing');
      expect(history.applications[0].statusHistory).toHaveLength(2);
    });
  });

  it('throws when the application id is unknown', async () => {
    await withTempFile(async (filePath) => {
      await writeFile(filePath, JSON.stringify({ applications: [baseRecord()] }), 'utf8');
      await expect(
        updateApplicationStatus('app2026NoSuchRole', 'offer', undefined, filePath),
      ).rejects.toThrow(/No application found with id/);
    });
  });

  it('appends a history entry on every repeat of an identical transition', async () => {
    await withTempFile(async (filePath) => {
      await writeFile(filePath, JSON.stringify({ applications: [baseRecord()] }), 'utf8');
      await updateApplicationStatus(
        'app2026SampleCorpStaffEngineer',
        'interviewing',
        'Phone screen scheduled',
        filePath,
      );
      const repeated = await updateApplicationStatus(
        'app2026SampleCorpStaffEngineer',
        'interviewing',
        'Phone screen scheduled',
        filePath,
      );
      expect(repeated.status).toBe('interviewing');
      expect(repeated.statusHistory).toHaveLength(3);
      expect(repeated.statusHistory[1].stage).toBe('interviewing');
      expect(repeated.statusHistory[2].stage).toBe('interviewing');
      const history = await readApplicationHistory(filePath);
      expect(history.applications[0].statusHistory).toHaveLength(3);
    });
  });
});

describe('markResumeGenerated (EUO-16)', () => {
  it('records the generated stage and the resume variant used', async () => {
    await withTempFile(async (filePath) => {
      await writeFile(filePath, JSON.stringify({ applications: [baseRecord()] }), 'utf8');
      const updated = await markResumeGenerated('app2026SampleCorpStaffEngineer', 'usStandardResume', filePath);
      expect(updated.status).toBe('generated');
      expect(updated.resumeVariant).toBe('usStandardResume');
      expect(updated.statusHistory).toHaveLength(2);
      expect(updated.statusHistory[1].stage).toBe('generated');
      const history = await readApplicationHistory(filePath);
      expect(history.applications[0].status).toBe('generated');
      expect(history.applications[0].resumeVariant).toBe('usStandardResume');
    });
  });

  it('is idempotent on re-generation: updates the variant without duplicating the statusHistory entry', async () => {
    await withTempFile(async (filePath) => {
      await writeFile(filePath, JSON.stringify({ applications: [baseRecord()] }), 'utf8');
      await markResumeGenerated('app2026SampleCorpStaffEngineer', 'usStandardResume', filePath);
      const regenerated = await markResumeGenerated(
        'app2026SampleCorpStaffEngineer',
        'usDetailedResume',
        filePath,
      );
      expect(regenerated.status).toBe('generated');
      expect(regenerated.resumeVariant).toBe('usDetailedResume');
      expect(regenerated.statusHistory).toHaveLength(2);
      expect(regenerated.statusHistory[1].stage).toBe('generated');
    });
  });

  it('throws when the application id is unknown', async () => {
    await withTempFile(async (filePath) => {
      await writeFile(filePath, JSON.stringify({ applications: [baseRecord()] }), 'utf8');
      await expect(
        markResumeGenerated('app2026NoSuchRole', 'usStandardResume', filePath),
      ).rejects.toThrow(/No application found with id/);
    });
  });
});
describe('appendApplicationHistory (one atomic write per batch)', () => {
  it('writes a batch once and does not fork a within-batch duplicate', async () => {
    await withTempFile(async (filePath) => {
      const records = [
        baseRecord({ postingHash: 'hash-a' }),
        baseRecord({ postingHash: 'hash-b', jobUrl: 'https://alpha.test/jobs/2' }),
        baseRecord({ postingHash: 'hash-a', jobUrl: 'https://alpha.test/jobs/3' }),
      ];
      vi.mocked(writeFileAtomically).mockClear();
      const result = await appendApplicationHistory(records, filePath);
      expect(result.added.map((record) => record.postingHash)).toEqual(['hash-a', 'hash-b']);
      expect(result.duplicates).toHaveLength(1);
      expect(historyWriteCount()).toBe(1);
      const history = await readApplicationHistory(filePath);
      expect(history.applications.map((record) => record.postingHash)).toEqual(['hash-a', 'hash-b']);
    });
  });

  it('reports an existing hash as a duplicate and still writes only once', async () => {
    await withTempFile(async (filePath) => {
      await appendApplicationHistory([baseRecord({ postingHash: 'hash-a' })], filePath);
      vi.mocked(writeFileAtomically).mockClear();
      const result = await appendApplicationHistory(
        [
          baseRecord({ postingHash: 'hash-a' }),
          baseRecord({ postingHash: 'hash-c', jobUrl: 'https://alpha.test/jobs/4' }),
        ],
        filePath,
      );
      expect(result.added.map((record) => record.postingHash)).toEqual(['hash-c']);
      expect(result.duplicates.map((record) => record.postingHash)).toEqual(['hash-a']);
      expect(historyWriteCount()).toBe(1);
      const history = await readApplicationHistory(filePath);
      expect(history.applications.map((record) => record.postingHash)).toEqual(['hash-a', 'hash-c']);
    });
  });

  it('skips the write entirely when every record is already present', async () => {
    await withTempFile(async (filePath) => {
      await appendApplicationHistory([baseRecord({ postingHash: 'hash-a' })], filePath);
      vi.mocked(writeFileAtomically).mockClear();
      const result = await appendApplicationHistory([baseRecord({ postingHash: 'hash-a' })], filePath);
      expect(result.added).toHaveLength(0);
      expect(result.duplicates).toHaveLength(1);
      expect(historyWriteCount()).toBe(0);
    });
  });

  it('refuses a malformed existing history and writes nothing', async () => {
    await withTempFile(async (filePath) => {
      await writeFile(filePath, '{ not json', 'utf8');
      vi.mocked(writeFileAtomically).mockClear();
      await expect(
        appendApplicationHistory([baseRecord({ postingHash: 'hash-x' })], filePath),
      ).rejects.toThrow(/Malformed application history/);
      expect(historyWriteCount()).toBe(0);
      expect(await readFile(filePath, 'utf8')).toBe('{ not json');
    });
  });
});

describe('logApplication location-aware identity (U09)', () => {
  it('writes a distinct record for the same role in a new city', async () => {
    await withTempFile(async (filePath) => {
      const remote = baseRecord({
        postingHash: computePostingHash('SampleCorp', 'Staff Engineer', 'Remote'),
      });
      const boston = baseRecord({
        jobUrl: 'https://alpha.test/jobs/2',
        postingHash: computePostingHash('SampleCorp', 'Staff Engineer', 'Boston, MA'),
      });
      expect(boston.applicationId).toBe(remote.applicationId);
      expect(boston.postingHash).not.toBe(remote.postingHash);
      await logApplication(remote, filePath);
      await logApplication(boston, filePath);
      const history = await readApplicationHistory(filePath);
      expect(history.applications).toHaveLength(2);
    });
  });

  it('still rejects an exact duplicate of the same posting', async () => {
    await withTempFile(async (filePath) => {
      await logApplication(baseRecord(), filePath);
      await expect(logApplication(baseRecord(), filePath)).rejects.toThrow(/already exists/);
      const history = await readApplicationHistory(filePath);
      expect(history.applications).toHaveLength(1);
    });
  });

  it('rejects duplicates with a typed DuplicateApplicationError (Phase D, matched by class not message)', async () => {
    await withTempFile(async (filePath) => {
      await logApplication(baseRecord(), filePath);
      const error = await logApplication(baseRecord(), filePath).then(
        () => null,
        (failure: unknown) => failure,
      );
      expect(error).toBeInstanceOf(DuplicateApplicationError);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).name).toBe('DuplicateApplicationError');
    });
  });

  it('refuses history entries whose status timestamps are not datetimes (Phase D)', async () => {
    await withTempFile(async (filePath) => {
      await logApplication(baseRecord(), filePath);
      const history = await readApplicationHistory(filePath);
      history.applications[0].statusHistory.push({
        stage: 'generated',
        timestamp: 'not-a-datetime',
      });
      await expect(writeApplicationHistory(history, filePath)).rejects.toThrow();
      // A datetime string still validates.
      history.applications[0].statusHistory.pop();
      history.applications[0].statusHistory.push({
        stage: 'generated',
        timestamp: '2026-08-19T12:00:00.000Z',
      });
      await writeApplicationHistory(history, filePath);
      expect((await readApplicationHistory(filePath)).applications[0].statusHistory).toHaveLength(2);
    });
  });
});

describe('computePostingHash normalized identity (U10)', () => {
  it('hashes legal-suffix and seniority variants equally', () => {
    expect(computePostingHash('Acme Inc', 'Sr Engineer', 'Remote')).toBe(
      computePostingHash('Acme', 'Senior Engineer', 'Remote'),
    );
    expect(computePostingHash('Globex LLC', 'Jr Dev', 'Remote')).toBe(
      computePostingHash('Globex', 'Junior Developer', 'Remote'),
    );
  });

  it('still separates distinct postings', () => {
    expect(computePostingHash('Acme', 'Senior Engineer', 'Remote')).not.toBe(
      computePostingHash('Acme', 'Staff Engineer', 'Remote'),
    );
    expect(computePostingHash('Acme', 'Senior Engineer', 'Remote')).not.toBe(
      computePostingHash('Acme', 'Senior Engineer', 'Boston, MA'),
    );
  });
});

describe('logApplication hash-primary identity (Phase A)', () => {
  it('rejects a same-posting record even when the application id spelling differs', async () => {
    await withTempFile(async (filePath) => {
      const incSpelling = baseRecord({
        companyName: 'Acme Inc',
        roleTitle: 'Senior Engineer',
        applicationId: generateApplicationId('Acme Inc', 'Senior Engineer'),
        postingHash: computePostingHash('Acme Inc', 'Senior Engineer', 'Remote'),
      });
      const bareSpelling = baseRecord({
        companyName: 'Acme',
        roleTitle: 'Senior Engineer',
        applicationId: generateApplicationId('Acme', 'Senior Engineer'),
        postingHash: computePostingHash('Acme', 'Senior Engineer', 'Remote'),
      });
      expect(bareSpelling.applicationId).not.toBe(incSpelling.applicationId);
      expect(bareSpelling.postingHash).toBe(incSpelling.postingHash);
      await logApplication(incSpelling, filePath);
      await expect(logApplication(bareSpelling, filePath)).rejects.toThrow(/already exists/);
      const history = await readApplicationHistory(filePath);
      expect(history.applications).toHaveLength(1);
    });
  });
});

describe('markResumeGenerated posting-hash targeting (Phase A)', () => {
  it('targets only the matching record when two cities share the application id', async () => {
    await withTempFile(async (filePath) => {
      const applicationId = generateApplicationId('SampleCorp', 'Staff Engineer');
      const remoteHash = computePostingHash('SampleCorp', 'Staff Engineer', 'Remote');
      const bostonHash = computePostingHash('SampleCorp', 'Staff Engineer', 'Boston, MA');
      await writeFile(
        filePath,
        JSON.stringify({
          applications: [
            baseRecord({ applicationId, postingHash: remoteHash }),
            baseRecord({ applicationId, postingHash: bostonHash, jobUrl: 'https://alpha.test/jobs/2' }),
          ],
        }),
        'utf8',
      );
      // Without the hash the shared id is ambiguous instead of a silent first-match pick.
      await expect(markResumeGenerated(applicationId, 'usStandardResume', filePath)).rejects.toThrow(
        /ambiguous/,
      );
      const remote = await markResumeGenerated(applicationId, 'usStandardResume', filePath, undefined, remoteHash);
      expect(remote.status).toBe('generated');
      expect(remote.resumeVariant).toBe('usStandardResume');
      const boston = await markResumeGenerated(applicationId, 'usDetailedResume', filePath, undefined, bostonHash);
      expect(boston.status).toBe('generated');
      expect(boston.resumeVariant).toBe('usDetailedResume');
      const history = await readApplicationHistory(filePath);
      expect(history.applications).toHaveLength(2);
      expect(history.applications[0].status).toBe('generated');
      expect(history.applications[0].resumeVariant).toBe('usStandardResume');
      expect(history.applications[0].statusHistory).toHaveLength(2);
      expect(history.applications[1].status).toBe('generated');
      expect(history.applications[1].resumeVariant).toBe('usDetailedResume');
      expect(history.applications[1].statusHistory).toHaveLength(2);
    });
  });
});

describe('markResumeGenerated forward-only gate (Phase A)', () => {
  it('refuses to regress records that are past generation', async () => {
    await withTempFile(async (filePath) => {
      const pastGeneration = ['appliedConfirmed', 'interviewing', 'offer', 'rejected'] as const;
      for (const status of pastGeneration) {
        const record = baseRecord({
          applicationId: `app2026SampleCorpPast${status}`,
          status,
          statusHistory: [
            { stage: 'evaluated' as const, timestamp: '2026-08-08T10:00:00Z' },
            { stage: status, timestamp: '2026-08-08T11:00:00Z' },
          ],
        });
        await writeFile(filePath, JSON.stringify({ applications: [record] }), 'utf8');
        await expect(markResumeGenerated(record.applicationId, 'usStandardResume', filePath)).rejects.toThrow(
          /only evaluated or generated applications can be marked as generated/,
        );
        const history = await readApplicationHistory(filePath);
        expect(history.applications).toHaveLength(1);
        expect(history.applications[0].status).toBe(status);
        expect(history.applications[0].statusHistory).toHaveLength(2);
        expect(history.applications[0].resumeVariant).toBeUndefined();
      }
    });
  });
});
