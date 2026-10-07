import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { parseJobPreferences } from '../evaluators/fitEvaluator';
import { parseMasterProfile } from '../generators/resumeGenerator';
import {
  ProfileAlreadyInitializedError,
  ProfileConfirmationRequiredError,
  ProfileValidationError,
  initializeUserProfile,
  readUserProfile,
  resolveProfilePaths,
  updateUserProfile,
  validateProfileCompletion,
  type ProfilePathOverrides,
  type ProfileInitializationInput,
} from './profileService';

// Synthetic fixture only (SDD Section 6.2) — never real personal data.
const syntheticProfile: ProfileInitializationInput = {
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
      email: 'jane.sample@example.com',
      phone: '+1 555 0100',
      cityState: 'Austin, TX',
      linkedIn: 'https://linkedin.com/in/janesample',
      portfolio: 'https://janesample.dev',
    },
    workAuthorization: { usCitizen: 'Yes', requiresSponsorship: 'No', clearance: 'None' },
    summary: 'Senior platform engineer with 8+ years building distributed systems.',
    skills: [
      { category: 'Languages', items: ['TypeScript', 'Rust'] },
      { category: 'Infrastructure', items: ['AWS', 'Kubernetes'] },
    ],
    experience: [
      {
        roleTitle: 'Senior Platform Engineer',
        employer: 'AcmeCorp',
        location: 'San Francisco, CA',
        startDate: '2021-03',
        endDate: 'Present',
        bullets: ['Led the migration of 200+ microservices to Kubernetes.'],
      },
    ],
    education: [
      { degree: 'BSc Computer Science', institution: 'University of Texas', startYear: '2016', endYear: '2020' },
    ],
    certifications: ['AWS Certified Solutions Architect'],
  },
};

function overridesFor(root: string): ProfilePathOverrides {
  return {
    dataRoot: root,
    profilePath: join(root, 'profile', 'masterProfile.md'),
    preferencesPath: join(root, 'profile', 'jobPreferences.yaml'),
    screeningAnswersPath: join(root, 'profile', 'screeningAnswers.json'),
    contactsPath: join(root, 'profile', 'networkingContacts.json'),
    setupStatePath: join(root, 'setupState.json'),
  };
}

function joinedPaths(root: string): { masterProfile: string; jobPreferences: string; screeningAnswers: string; contacts: string } {
  const o = overridesFor(root);
  return {
    masterProfile: o.profilePath!,
    jobPreferences: o.preferencesPath!,
    screeningAnswers: o.screeningAnswersPath!,
    contacts: o.contactsPath!,
  };
}

async function withEmptyProfileDir<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'weJobSearch-profile-'));
  process.env.WEJOBSEARCHDATAROOT = root;
  try {
    return await fn(root);
  } finally {
    delete process.env.WEJOBSEARCHDATAROOT;
    await rm(root, { recursive: true, force: true });
  }
}

describe('readUserProfile', () => {
  it('reports an explicit unconfigured state when no profile files exist', async () => {
    await withEmptyProfileDir(async (root) => {
      const state = await readUserProfile(overridesFor(root));
      expect(state.configured).toBe(false);
      expect(state.incompleteReasons).toHaveLength(4);
      expect(state.masterProfile).toBeUndefined();
      expect(state.jobPreferences).toBeUndefined();
      expect(state.screeningAnswers).toBeUndefined();
      expect(state.networkingContacts).toBeUndefined();
    });
  });

  it('flags a placeholder masterProfile as unconfigured without throwing', async () => {
    await withEmptyProfileDir(async (root) => {
      const path = join(root, 'profile', 'masterProfile.md');
      await mkdir(join(root, 'profile'), { recursive: true });
      await writeFile(path, '# T\n\n## Contact\n- Name: REPLACE_ME\n', 'utf8');
      const state = await readUserProfile({ profilePath: path });
      expect(state.configured).toBe(false);
      expect(state.incompleteReasons.some((reason) => reason.includes('placeholder'))).toBe(true);
      expect(state.incompleteReasons.some((reason) => reason.includes('missing'))).toBe(true);
    });
  });

  it('reports a malformed jobPreferences.yaml as unconfigured with a clear reason, without throwing', async () => {
    await withEmptyProfileDir(async (root) => {
      const path = join(root, 'profile', 'jobPreferences.yaml');
      await mkdir(join(root, 'profile'), { recursive: true });
      await writeFile(path, 'compensation: {\n', 'utf8');
      const state = await readUserProfile({ preferencesPath: path });
      expect(state.configured).toBe(false);
      expect(state.files.jobPreferences.exists).toBe(true);
      expect(state.files.jobPreferences.configured).toBe(false);
      expect(state.files.jobPreferences.reason).toContain('does not conform to the schema');
      expect(state.incompleteReasons.some((reason) => reason.includes('jobPreferences.yaml'))).toBe(true);
      expect(state.jobPreferences).toBeUndefined();
    });
  });

  it('returns structured onboarding steps when the profile is entirely absent (EUO-11)', async () => {
    await withEmptyProfileDir(async (root) => {
      const state = await readUserProfile(overridesFor(root));
      const steps = state.onboardingSteps;
      expect(steps).toBeDefined();
      expect(steps).toHaveLength(4);
      expect(steps![0]).toContain('documents');
      expect(steps![0]).toContain(join(root, 'profile', 'documents'));
      expect(steps![1]).toContain('ingestDocuments');
      expect(steps![2].toLowerCase()).toContain('review');
      expect(steps![3].toLowerCase()).toContain('confirm');
      expect(steps![3]).toContain('initializeUserProfile');
    });
  });

  it('returns no onboarding steps when only some profile files exist (EUO-11)', async () => {
    await withEmptyProfileDir(async (root) => {
      const masterPath = join(root, 'profile', 'masterProfile.md');
      await mkdir(join(root, 'profile'), { recursive: true });
      await writeFile(masterPath, '# T\n\n## Contact\n- Name: Jane Sample\n', 'utf8');
      const state = await readUserProfile(overridesFor(root));
      expect(state.onboardingSteps).toBeUndefined();
      expect(state.files.masterProfile.configured).toBe(true);
      expect(state.incompleteReasons).toHaveLength(3);
      expect(state.incompleteReasons.every((reason) => reason.includes('missing'))).toBe(true);
    });
  });
});

describe('initializeUserProfile', () => {
  it('refuses to write anything without confirmed: true', async () => {
    await withEmptyProfileDir(async (root) => {
      await expect(initializeUserProfile(syntheticProfile, { paths: overridesFor(root) })).rejects.toThrow(
        ProfileConfirmationRequiredError,
      );
      const { masterProfile, jobPreferences, screeningAnswers, contacts } = joinedPaths(root);
      for (const file of [masterProfile, jobPreferences, screeningAnswers, contacts]) {
        await expect(stat(file)).rejects.toThrow();
      }
    });
  });

  it('writes all four profile files atomically and rejects payloads failing the schema', async () => {
    await withEmptyProfileDir(async (root) => {
      const result = await initializeUserProfile(syntheticProfile, {
        confirmed: true,
        paths: overridesFor(root),
      });
      expect(result.filesWritten).toHaveLength(4);
      expect(result.filesUpdated).toEqual([]);

      const { masterProfile, jobPreferences, screeningAnswers, contacts } = joinedPaths(root);
      const preferences = parseJobPreferences(await readFile(jobPreferences, 'utf8'));
      expect(preferences.compensation.minAcceptableBase).toBe(110000);
      expect(preferences.nonNegotiables).toHaveLength(1);

      const parsedScreening = JSON.parse(await readFile(screeningAnswers, 'utf8'));
      expect(parsedScreening.workAuthorization.usCitizen).toBe(true);

      const parsedMaster = parseMasterProfile(await readFile(masterProfile, 'utf8'));
      expect(parsedMaster.name).toBe('Jane Sample');
      expect(parsedMaster.experience).toHaveLength(1);

      const parsedContacts = JSON.parse(await readFile(contacts, 'utf8'));
      expect(parsedContacts.contacts).toEqual([]);

      await expect(
        initializeUserProfile(
          {
            ...syntheticProfile,
            jobPreferences: {
              ...syntheticProfile.jobPreferences,
              compensation: { ...syntheticProfile.jobPreferences.compensation, minAcceptableBase: -1 },
            },
          },
          { confirmed: true, paths: overridesFor(root) },
        ),
      ).rejects.toThrow(ProfileValidationError);
    });
  });

  it('rejects a malformed jobPreferences payload with ProfileValidationError and writes nothing', async () => {
    await withEmptyProfileDir(async (root) => {
      const malformed = {
        ...syntheticProfile,
        jobPreferences: {
          compensation: 'nope',
        } as unknown as ProfileInitializationInput['jobPreferences'],
      };
      await expect(
        initializeUserProfile(malformed, { confirmed: true, paths: overridesFor(root) }),
      ).rejects.toThrow(ProfileValidationError);
      const { masterProfile, jobPreferences, screeningAnswers, contacts } = joinedPaths(root);
      for (const file of [masterProfile, jobPreferences, screeningAnswers, contacts]) {
        await expect(stat(file)).rejects.toThrow();
      }
    });
  });

  it('writes targetRoles: [] when the payload omits them', async () => {
    await withEmptyProfileDir(async (root) => {
      await initializeUserProfile(syntheticProfile, { confirmed: true, paths: overridesFor(root) });
      const preferences = parseJobPreferences(
        await readFile(join(root, 'profile', 'jobPreferences.yaml'), 'utf8'),
      );
      expect(preferences.targetRoles).toEqual([]);
    });
  });

  it('writes provided targetRoles on init', async () => {
    await withEmptyProfileDir(async (root) => {
      await initializeUserProfile(
        {
          ...syntheticProfile,
          jobPreferences: {
            ...syntheticProfile.jobPreferences,
            targetRoles: ['Senior Engineer'],
          },
        },
        { confirmed: true, paths: overridesFor(root) },
      );
      const preferences = parseJobPreferences(
        await readFile(join(root, 'profile', 'jobPreferences.yaml'), 'utf8'),
      );
      expect(preferences.targetRoles).toEqual(['Senior Engineer']);
    });
  });

  it('refuses to overwrite an already-initialized profile', async () => {
    await withEmptyProfileDir(async (root) => {
      await initializeUserProfile(syntheticProfile, { confirmed: true, paths: overridesFor(root) });
      await expect(
        initializeUserProfile(syntheticProfile, { confirmed: true, paths: overridesFor(root) }),
      ).rejects.toThrow(ProfileAlreadyInitializedError);
    });
  });
});

describe('updateUserProfile', () => {
  async function seededDir(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'weJobSearch-update-'));
    await initializeUserProfile(syntheticProfile, { confirmed: true, paths: overridesFor(root) });
    return root;
  }

  it('refuses to update anything without confirmed: true', async () => {
    const root = await seededDir();
    try {
      await expect(
        updateUserProfile({ masterProfile: { summary: 'X' } }, { paths: overridesFor(root) }),
      ).rejects.toThrow(ProfileConfirmationRequiredError);
      const parsedMaster = parseMasterProfile(
        await readFile(join(root, 'profile', 'masterProfile.md'), 'utf8'),
      );
      expect(parsedMaster.name).toBe('Jane Sample');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects a payload with no section updates', async () => {
    await withEmptyProfileDir(async (root) => {
      await expect(updateUserProfile({}, { confirmed: true, paths: overridesFor(root) })).rejects.toThrow(
        ProfileValidationError,
      );
    });
  });

  it('applies only the supplied section and preserves every other field and file', async () => {
    const root = await seededDir();
    try {
      const result = await updateUserProfile(
        { masterProfile: { summary: 'A revised summary.' } },
        { confirmed: true, paths: overridesFor(root) },
      );
      expect(result.filesUpdated).toEqual([join(root, 'profile', 'masterProfile.md')]);
      expect(result.filesWritten).toEqual([]);

      const parsedMaster = parseMasterProfile(await readFile(join(root, 'profile', 'masterProfile.md'), 'utf8'));
      expect(parsedMaster.summary).toBe('A revised summary.');
      expect(parsedMaster.name).toBe('Jane Sample');
      expect(parsedMaster.experience).toHaveLength(1);

      const preferences = parseJobPreferences(await readFile(join(root, 'profile', 'jobPreferences.yaml'), 'utf8'));
      expect(preferences.compensation.minAcceptableBase).toBe(110000);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('merges partial jobPreferences into the existing values', async () => {
    const root = await seededDir();
    try {
      await updateUserProfile(
        { jobPreferences: { preferredLocations: ['Remote', 'Hybrid'] } },
        { confirmed: true, paths: overridesFor(root) },
      );
      const preferences = parseJobPreferences(await readFile(join(root, 'profile', 'jobPreferences.yaml'), 'utf8'));
      expect(preferences.preferredLocations).toEqual(['Remote', 'Hybrid']);
      expect(preferences.compensation.minAcceptableBase).toBe(110000);
      expect(preferences.nonNegotiables).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('preserves the directories block when updating an unrelated section', async () => {
    const root = await seededDir();
    try {
      await updateUserProfile(
        { jobPreferences: { directories: { dataRoot: null, outputRoot: '/tmp/seedOut', resumeVariantsFile: null } } },
        { confirmed: true, paths: overridesFor(root) },
      );
      await updateUserProfile(
        { jobPreferences: { preferredLocations: ['Remote', 'Hybrid'] } },
        { confirmed: true, paths: overridesFor(root) },
      );
      const preferences = parseJobPreferences(await readFile(join(root, 'profile', 'jobPreferences.yaml'), 'utf8'));
      expect(preferences.preferredLocations).toEqual(['Remote', 'Hybrid']);
      expect(preferences.directories).toEqual({
        dataRoot: null,
        outputRoot: '/tmp/seedOut',
        resumeVariantsFile: null,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('writes the directories block when the update supplies it', async () => {
    const root = await seededDir();
    try {
      await updateUserProfile(
        { jobPreferences: { directories: { dataRoot: null, outputRoot: '/tmp/customOut', resumeVariantsFile: null } } },
        { confirmed: true, paths: overridesFor(root) },
      );
      const preferences = parseJobPreferences(await readFile(join(root, 'profile', 'jobPreferences.yaml'), 'utf8'));
      expect(preferences.directories).toEqual({
        dataRoot: null,
        outputRoot: '/tmp/customOut',
        resumeVariantsFile: null,
      });
      expect(preferences.compensation.minAcceptableBase).toBe(110000);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects a directories.dataRoot update loudly instead of storing it', async () => {
    const root = await seededDir();
    try {
      await expect(
        updateUserProfile(
          { jobPreferences: { directories: { dataRoot: '/tmp/customData', outputRoot: null, resumeVariantsFile: null } } },
          { confirmed: true, paths: overridesFor(root) },
        ),
      ).rejects.toThrow(/directories\.dataRoot is no longer supported/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('merges targetRoles without touching other sections', async () => {
    const root = await seededDir();
    try {
      await updateUserProfile(
        { jobPreferences: { targetRoles: ['Senior Engineer', 'Staff Engineer'] } },
        { confirmed: true, paths: overridesFor(root) },
      );
      const preferences = parseJobPreferences(await readFile(join(root, 'profile', 'jobPreferences.yaml'), 'utf8'));
      expect(preferences.targetRoles).toEqual(['Senior Engineer', 'Staff Engineer']);
      expect(preferences.compensation.minAcceptableBase).toBe(110000);
      expect(preferences.clearance.currentStatus).toBe('none');
      expect(preferences.nonNegotiables).toHaveLength(1);
      expect(preferences.preferredLocations).toEqual(['Remote']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('preserves existing targetRoles when the update omits them', async () => {
    const root = await seededDir();
    try {
      await updateUserProfile(
        { jobPreferences: { targetRoles: ['Senior Engineer'] } },
        { confirmed: true, paths: overridesFor(root) },
      );
      await updateUserProfile(
        { jobPreferences: { preferredLocations: ['Remote', 'Hybrid'] } },
        { confirmed: true, paths: overridesFor(root) },
      );
      const preferences = parseJobPreferences(await readFile(join(root, 'profile', 'jobPreferences.yaml'), 'utf8'));
      expect(preferences.targetRoles).toEqual(['Senior Engineer']);
      expect(preferences.preferredLocations).toEqual(['Remote', 'Hybrid']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

   it('builds defaulted content for a missing file on first partial update', async () => {
     await withEmptyProfileDir(async (root) => {
       const result = await updateUserProfile(
         { jobPreferences: { preferredLocations: ['Remote'], compensation: { minAcceptableBase: 80000, targetBase: 100000, currency: 'USD', countsBonusTowardMin: false, countsEquityTowardMin: false } } },
         { confirmed: true, paths: overridesFor(root) },
       );
       expect(result.filesUpdated).toEqual([join(root, 'profile', 'jobPreferences.yaml')]);
       const preferences = parseJobPreferences(await readFile(join(root, 'profile', 'jobPreferences.yaml'), 'utf8'));
       expect(preferences.compensation.minAcceptableBase).toBe(80000);
       expect(preferences.preferredLocations).toEqual(['Remote']);
     });
   });

  it('refuses to write over a malformed existing preferences file', async () => {
    const root = await seededDir();
    try {
      await writeFile(join(root, 'profile', 'jobPreferences.yaml'), 'compensation: {\n', 'utf8');
      await expect(
        updateUserProfile(
          { jobPreferences: { preferredLocations: ['Remote'] } },
          { confirmed: true, paths: overridesFor(root) },
        ),
      ).rejects.toThrow(ProfileValidationError);
      expect(await readFile(join(root, 'profile', 'jobPreferences.yaml'), 'utf8')).toBe('compensation: {\n');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('refuses to update screeningAnswers over a corrupt existing file and changes nothing', async () => {
    const root = await seededDir();
    try {
      const screeningPath = join(root, 'profile', 'screeningAnswers.json');
      const corrupt = '{not valid json';
      await writeFile(screeningPath, corrupt, 'utf8');
      let failure: unknown;
      try {
        await updateUserProfile(
          {
            screeningAnswers: {
              compensation: { minBaseSalary: 120000, targetBaseSalary: 150000, currency: 'USD' },
            },
          },
          { confirmed: true, paths: overridesFor(root) },
        );
      } catch (error) {
        failure = error;
      }
      // Not silent: the failure names the blocking file and states nothing changed.
      expect(failure).toBeInstanceOf(ProfileValidationError);
      expect((failure as Error).message).toMatch(/No file was changed/);
      expect(await readFile(screeningPath, 'utf8')).toBe(corrupt);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('readUserProfile setup checkpoint (EUO-15)', () => {
  // Frozen clock: every fixture date below is relative to frozenNow and the
  // frozen clock is injected into readUserProfile, so these tests never rot as
  // the real clock advances (regression: absolute 2026-08-18 fixtures went
  // stale once the real date passed the 7-day window).
  const frozenNow = new Date('2026-08-20T10:00:00.000Z');
  function daysBeforeFrozenNow(days: number): string {
    return new Date(frozenNow.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
  }

  async function withSetupStateFile(
    content: string,
    fn: (root: string, setupStatePath: string) => Promise<void>,
  ): Promise<void> {
    await withEmptyProfileDir(async (root) => {
      const setupStatePath = join(root, 'profile', 'setupState.json');
      await mkdir(join(root, 'profile'), { recursive: true });
      await writeFile(setupStatePath, content, 'utf8');
      await fn(root, setupStatePath);
    });
  }

  it('surfaces an in-progress setup step when the profile is unconfigured', async () => {
    const updatedAt = daysBeforeFrozenNow(2);
    await withSetupStateFile(
      JSON.stringify({ step: 'documentsIngested', updatedAt }),
      async (root, setupStatePath) => {
        const state = await readUserProfile({ ...overridesFor(root), setupStatePath }, frozenNow);
        expect(state.configured).toBe(false);
        expect(state.setupState).toEqual({
          step: 'documentsIngested',
          updatedAt,
        });
      },
    );
  });

  it('surfaces the notes of an in-progress setup step', async () => {
    const updatedAt = daysBeforeFrozenNow(2);
    await withSetupStateFile(
      JSON.stringify({
        step: 'profileProposed',
        updatedAt,
        notes: 'proposed from resume.pdf and cover-letter.pdf',
      }),
      async (root, setupStatePath) => {
        const state = await readUserProfile({ ...overridesFor(root), setupStatePath }, frozenNow);
        expect(state.setupState).toEqual({
          step: 'profileProposed',
          updatedAt,
          notes: 'proposed from resume.pdf and cover-letter.pdf',
        });
      },
    );
  });

  it('regression: an absolute August fixture is fresh inside the window and stale past it', async () => {
    const fixture = JSON.stringify({ step: 'documentsIngested', updatedAt: '2026-08-18T10:00:00.000Z' });
    await withSetupStateFile(fixture, async (root, setupStatePath) => {
      const fresh = await readUserProfile(
        { ...overridesFor(root), setupStatePath },
        new Date('2026-08-20T10:00:00.000Z'),
      );
      expect(fresh.setupState).toEqual({
        step: 'documentsIngested',
        updatedAt: '2026-08-18T10:00:00.000Z',
      });
      const stale = await readUserProfile(
        { ...overridesFor(root), setupStatePath },
        new Date('2026-08-26T10:00:00.001Z'),
      );
      expect(stale.setupState).toBeUndefined();
    });
  });

  it('ignores a stale setup checkpoint (older than the staleness window)', async () => {
    await withSetupStateFile(
      JSON.stringify({ step: 'profileProposed', updatedAt: daysBeforeFrozenNow(8) }),
      async (root, setupStatePath) => {
        const state = await readUserProfile({ ...overridesFor(root), setupStatePath }, frozenNow);
        expect(state.setupState).toBeUndefined();
        expect(state.onboardingSteps).toBeDefined();
      },
    );
  });

  it('ignores a completed (confirmed) setup checkpoint', async () => {
    await withSetupStateFile(
      JSON.stringify({ step: 'confirmed', updatedAt: daysBeforeFrozenNow(2) }),
      async (root, setupStatePath) => {
        const state = await readUserProfile({ ...overridesFor(root), setupStatePath }, frozenNow);
        expect(state.setupState).toBeUndefined();
      },
    );
  });

  it('does not surface a setup checkpoint when the profile is configured', async () => {
    await withEmptyProfileDir(async (root) => {
      await initializeUserProfile(syntheticProfile, { confirmed: true, paths: overridesFor(root) });
      const setupStatePath = join(root, 'profile', 'setupState.json');
      await writeFile(
        setupStatePath,
        JSON.stringify({ step: 'documentsIngested', updatedAt: daysBeforeFrozenNow(2) }),
        'utf8',
      );
      const state = await readUserProfile({ ...overridesFor(root), setupStatePath }, frozenNow);
      expect(state.configured).toBe(true);
      expect(state.setupState).toBeUndefined();
    });
  });

  it('tolerates a malformed setup checkpoint without breaking inspection', async () => {
    await withSetupStateFile('{not json', async (root, setupStatePath) => {
      const state = await readUserProfile({ ...overridesFor(root), setupStatePath });
      expect(state.configured).toBe(false);
      expect(state.setupState).toBeUndefined();
      expect(state.onboardingSteps).toBeDefined();
    });
  });

  it('surfaces a malformed setup checkpoint via setupStateError instead of swallowing it (Phase D)', async () => {
    await withSetupStateFile('{not json', async (root, setupStatePath) => {
      const state = await readUserProfile({ ...overridesFor(root), setupStatePath });
      expect(state.setupState).toBeUndefined();
      expect(state.setupStateError).toContain('not valid JSON');
    });
  });
});

describe('resolveProfilePaths (config-driven directories)', () => {
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

  it('prefers CLI dataRoot over env and the canonical default, and rejects directories.dataRoot', () => {
    process.env[envKey] = join(tmpdir(), 'envDataRoot');
    const cliRoot = join(tmpdir(), 'cliDataRoot');
    const fromCli = resolveProfilePaths({
      dataRoot: cliRoot,
      profilePath: join(cliRoot, 'profile', 'masterProfile.md'),
      preferencesPath: join(cliRoot, 'profile', 'jobPreferences.yaml'),
      screeningAnswersPath: join(cliRoot, 'profile', 'screeningAnswers.json'),
      contactsPath: join(cliRoot, 'profile', 'networkingContacts.json'),
      setupStatePath: join(cliRoot, 'setupState.json'),
    });
    expect(fromCli.dataRoot).toBe(join(tmpdir(), 'cliDataRoot'));
    expect(fromCli.outputRoot).toBe(join(join(tmpdir(), 'cliDataRoot'), 'applications'));

    expect(() =>
      resolveProfilePaths({ directories: { dataRoot: join(tmpdir(), 'cfgDataRoot') } }),
    ).toThrow(/directories\.dataRoot is no longer supported/);

    const envRoot = join(tmpdir(), 'envDataRoot');
    const fromEnv = resolveProfilePaths({
      profilePath: join(envRoot, 'profile', 'masterProfile.md'),
      preferencesPath: join(envRoot, 'profile', 'jobPreferences.yaml'),
      screeningAnswersPath: join(envRoot, 'profile', 'screeningAnswers.json'),
      contactsPath: join(envRoot, 'profile', 'networkingContacts.json'),
      setupStatePath: join(envRoot, 'setupState.json'),
    });
    expect(fromEnv.dataRoot).toBe(join(tmpdir(), 'envDataRoot'));
  });

  it('resolves outputRoot and resumeVariants from the same precedence chain', () => {
    delete process.env[envKey];
    const cfgData = join(tmpdir(), 'cfgData');
    const resolved = resolveProfilePaths({
      outputRoot: join(cfgData, 'cliOut'),
      resumeVariantsPath: join(cfgData, 'cliVariants.yaml'),
      dataRoot: cfgData,
      profilePath: join(cfgData, 'profile', 'masterProfile.md'),
      preferencesPath: join(cfgData, 'profile', 'jobPreferences.yaml'),
      screeningAnswersPath: join(cfgData, 'profile', 'screeningAnswers.json'),
      contactsPath: join(cfgData, 'profile', 'networkingContacts.json'),
      setupStatePath: join(cfgData, 'setupState.json'),
      directories: {
        outputRoot: join(cfgData, 'cfgOut'),
        resumeVariantsFile: join(cfgData, 'cfgVariants.yaml'),
      },
    });
    expect(resolved.dataRoot).toBe(join(tmpdir(), 'cfgData'));
    expect(resolved.outputRoot).toBe(join(cfgData, 'cliOut'));
    expect(resolved.resumeVariants).toBe(join(cfgData, 'cliVariants.yaml'));

    const fromConfig = resolveProfilePaths({
      dataRoot: cfgData,
      directories: {
        outputRoot: join(cfgData, 'cfgOut'),
        resumeVariantsFile: join(cfgData, 'cfgVariants.yaml'),
      },
      profilePath: join(join(tmpdir(), 'cfgData'), 'profile', 'masterProfile.md'),
      preferencesPath: join(join(tmpdir(), 'cfgData'), 'profile', 'jobPreferences.yaml'),
      screeningAnswersPath: join(join(tmpdir(), 'cfgData'), 'profile', 'screeningAnswers.json'),
      contactsPath: join(join(tmpdir(), 'cfgData'), 'profile', 'networkingContacts.json'),
      setupStatePath: join(join(tmpdir(), 'cfgData'), 'setupState.json'),
    });
    expect(fromConfig.outputRoot).toBe(join(cfgData, 'cfgOut'));
    expect(fromConfig.resumeVariants).toBe(join(cfgData, 'cfgVariants.yaml'));
  });
});

describe('validateProfileCompletion (H2)', () => {
  it('returns empty array for a complete payload', () => {
    const issues = validateProfileCompletion(syntheticProfile);
    expect(issues).toEqual([]);
  });

  it('blocks completion when required contact fields have placeholders', () => {
    const incomplete = {
      ...syntheticProfile,
      masterProfile: {
        ...syntheticProfile.masterProfile,
        contact: {
          name: 'REPLACE_ME',
          email: '',
          phone: 'Lorem ipsum',
          cityState: 'Austin, TX',
          linkedIn: 'https://linkedin.com/in/janesample',
          portfolio: 'https://janesample.dev',
        },
      },
    };
    const issues = validateProfileCompletion(incomplete);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.some((i) => i.includes('contact.name'))).toBe(true);
    expect(issues.some((i) => i.includes('contact.email'))).toBe(true);
    expect(issues.some((i) => i.includes('contact.phone'))).toBe(true);
  });

  it('blocks completion when experience is empty', () => {
    const incomplete = {
      ...syntheticProfile,
      masterProfile: {
        ...syntheticProfile.masterProfile,
        experience: [],
      },
    };
    const issues = validateProfileCompletion(incomplete);
    expect(issues.some((i) => i.includes('experience'))).toBe(true);
  });

  it('blocks completion when compensation minAcceptableBase is 0', () => {
    const incomplete = {
      ...syntheticProfile,
      jobPreferences: {
        ...syntheticProfile.jobPreferences,
        compensation: {
          ...syntheticProfile.jobPreferences.compensation,
          minAcceptableBase: 0,
        },
      },
    };
    const issues = validateProfileCompletion(incomplete);
    expect(issues.some((i) => i.includes('minAcceptableBase'))).toBe(true);
  });

  it('blocks completion when clearance.currentStatus is empty string', () => {
    const incomplete = {
      ...syntheticProfile,
      jobPreferences: {
        ...syntheticProfile.jobPreferences,
        clearance: {
          ...syntheticProfile.jobPreferences.clearance,
          currentStatus: '',
        },
      },
    };
    const issues = validateProfileCompletion(incomplete);
    expect(issues.some((i) => i.includes('currentStatus'))).toBe(true);
  });

  it('allows "none" as a legitimate clearance.currentStatus', () => {
    const complete = {
      ...syntheticProfile,
      jobPreferences: {
        ...syntheticProfile.jobPreferences,
        clearance: {
          ...syntheticProfile.jobPreferences.clearance,
          currentStatus: 'none',
        },
      },
    };
    const issues = validateProfileCompletion(complete);
    expect(issues.filter((i) => i.includes('currentStatus'))).toHaveLength(0);
  });
});

describe('initializeUserProfile lands inside resolved root (H2)', () => {
  it('writes files inside the resolved data root', async () => {
    await withEmptyProfileDir(async (root) => {
      const result = await initializeUserProfile(syntheticProfile, {
        confirmed: true,
        paths: overridesFor(root),
      });
      for (const file of result.filesWritten) {
        expect(file).toContain(root);
      }
    });
  });
});