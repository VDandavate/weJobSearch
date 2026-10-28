import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { repoRootFromModule, resumeVariantsFileName } from '../utils/canonicalDataRoot';
import { parseJobPreferences } from '../evaluators/fitEvaluator';
import {
  InitCancelledError,
  runInitWizard,
  screeningAnswersSchema,
  screeningDefaultsFromPreferences,
  SetupValidationError,
  assessProfileProtections,
  parseConfiguredDirectoryPaths,
} from './initWizard';
import {
  dispatchCli,
  parseInitArgs,
  runGenerate,
  runInitCommand,
  runPreviewResumeCommand,
  runValidateCommand,
} from './jobSearchCore';
import { runNamingLinter } from '../utils/namingLinter';
import type { PromptContext } from './initWizard';
import type { ProfileGitStatus } from './initWizard';

// Scripted PromptContext that returns answers in strict order and throws when
// the script runs out — a prompt-flow mismatch fails loudly, never hangs.
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

const realFileNames = [
  'jobPreferences.yaml',
  'screeningAnswers.json',
  'masterProfile.md',
  'networkingContacts.json',
];

async function freshProfileTmp(): Promise<{ dir: string; profileDir: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'weJobSearch-init-'));
  const profileDir = join(dir, 'profile');
  await mkdir(profileDir, { recursive: true });
  return { dir, profileDir };
}

// Script for a completely fresh setup, in exact question order of the wizard:
// compensation (5) -> clearance (4) -> nonNegotiables ("no" + acknowledgment
// answers) -> preferred locations (parametrized entries) -> targetRoles
// (comma-separated) -> directories (2, blank for default) -> screening
// planning (5) -> master profile contact (5) -> work authorization (3).
// Count matches the flow.
function buildFreshAnswers(
  locationEntries: readonly string[],
  directoryEntries: readonly string[] = ['', ''],
  ackAfterNo: readonly string[] = ['accept empty'],
): string[] {
  return [
    'USD', // compensation.currency
    '120000', // compensation.minAcceptableBase
    '150000', // compensation.targetBase
    'n', // countsBonusTowardMin
    'n', // countsEquityTowardMin
    'none', // clearance.currentStatus
    'none', // clearance.currentLevel -> null
    'yes', // eligibleToObtain
    'n', // requiresSponsorshipForVisa
    'n', // add nonNegotiable
    ...ackAfterNo,
    ...locationEntries,
    'Senior Software Engineer, Staff Engineer', // targetRoles
    ...directoryEntries,
    'y', // workAuthorization.usCitizen
    'n', // workAuthorization.requiresSponsorship
    '', // sponsorshipType (default null)
    '110000', // screening compensation.minBaseSalary
    '140000', // screening compensation.targetBaseSalary
    'USD', // screening compensation.currency
    '6', // yearsOfExperience.softwareEngineering
    '4', // yearsOfExperience.typescript
    '5', // yearsOfExperience.python
    'Remote / Hybrid East Coast', // preferredWorkLocation
    '2 weeks', // noticePeriod
     'Jane Example', // contact.name
     'jane@example.com', // contact.email
     '+1 555 0100', // contact.phone
     'Austin, TX', // contact.cityState
     'https://www.linkedin.com/in/jane-example', // contact.linkedIn
     'https://jane.example.dev', // contact.portfolio
     'yes', // masterProfile usCitizen
     'no', // masterProfile requiresSponsorship
     'none', // masterProfile clearance
   ];
 }

const freshAnswers = buildFreshAnswers(['Remote', 'n']);

describe('runInitWizard - fresh setup', () => {
  it('creates all four gitignored profile files and touches nothing else', async () => {
    const { dir, profileDir } = await freshProfileTmp();
    try {
      const result = await runInitWizard({
        prompt: scriptedPrompt(freshAnswers),
        profileDirectory: profileDir,
        repoRoot: dir,
      });
      expect(result.exitCode).toBe(0);
      const createdNames = result.created.map((path) => path.split('/').pop());
      expect([...createdNames].sort()).toEqual([...realFileNames].sort());

      const written = (await readdir(profileDir)).sort();
      expect(written).toEqual([...realFileNames].sort());
      expect(written.some((name) => name.includes('.example'))).toBe(false);
      expect(written).not.toContain('resumeVariants.yaml');

      const preferences = parseJobPreferences(
        await readFile(join(profileDir, 'jobPreferences.yaml'), 'utf8'),
      );
      expect(preferences.compensation.minAcceptableBase).toBe(120000);
      expect(preferences.clearance.currentLevel).toBeNull();
      expect(preferences.preferredLocations).toEqual(['Remote']);
      expect(preferences.targetRoles).toEqual(['Senior Software Engineer', 'Staff Engineer']);
      expect(preferences.nonNegotiables).toEqual([]);
      expect(preferences.directories).toEqual({
        dataRoot: null,
        outputRoot: null,
        resumeVariantsFile: null,
      });

      const screening = JSON.parse(
        await readFile(join(profileDir, 'screeningAnswers.json'), 'utf8'),
      );
      expect(screeningAnswersSchema.safeParse(screening).success).toBe(true);
      expect(screening.workAuthorization.requiresSponsorship).toBe(false);

      const master = await readFile(join(profileDir, 'masterProfile.md'), 'utf8');
      for (const heading of [
        '## Contact',
        '## Work Authorization',
        '## Summary',
        '## Skills',
        '## Experience',
        '## Education',
        '## Certifications',
      ]) {
        expect(master).toContain(heading);
      }
      expect(master).toContain('Jane Example');

      const contacts = JSON.parse(
        await readFile(join(profileDir, 'networkingContacts.json'), 'utf8'),
      );
      expect(contacts.contacts).toEqual([]);

      const text = result.printedLines.join('\n');
      expect(text).toContain('Setup complete.');
      expect(text).toContain('Naming linter:');
      // The profile of a temp dir is not a git repository; definitely note it
      // and only then finish, but never issue a normal exit here.
      expect(text).toContain('Not inside a git repository');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('accepts blank preferred locations as neutral defaults (no location penalty)', async () => {
    const { dir, profileDir } = await freshProfileTmp();
    try {
      const result = await runInitWizard({
        prompt: scriptedPrompt(buildFreshAnswers([''])),
        profileDirectory: profileDir,
        repoRoot: dir,
      });
      expect(result.exitCode).toBe(0);
      const preferences = parseJobPreferences(
        await readFile(join(profileDir, 'jobPreferences.yaml'), 'utf8'),
      );
      expect(preferences.preferredLocations).toEqual([]);
      expect(preferences.nonNegotiables).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('records custom directories when the user provides them (blank stays null)', async () => {
    const { dir, profileDir } = await freshProfileTmp();
    try {
      const result = await runInitWizard({
        prompt: scriptedPrompt(
          buildFreshAnswers(['Remote', 'n'], [join(dir, 'customOut'), '']),
        ),
        profileDirectory: profileDir,
        repoRoot: dir,
      });
      expect(result.exitCode).toBe(0);
      const preferences = parseJobPreferences(
        await readFile(join(profileDir, 'jobPreferences.yaml'), 'utf8'),
      );
      expect(preferences.directories).toEqual({
        dataRoot: null,
        outputRoot: join(dir, 'customOut'),
        resumeVariantsFile: null,
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('runInitWizard - explicitly empty nonNegotiables acknowledgment', () => {
  it('saves [] after the user types accept empty', async () => {
    const { dir, profileDir } = await freshProfileTmp();
    try {
      const result = await runInitWizard({
        prompt: scriptedPrompt(buildFreshAnswers(['Remote', 'n'], undefined, ['accept empty'])),
        profileDirectory: profileDir,
        repoRoot: dir,
      });
      expect(result.exitCode).toBe(0);
      const preferences = parseJobPreferences(
        await readFile(join(profileDir, 'jobPreferences.yaml'), 'utf8'),
      );
      expect(preferences.nonNegotiables).toEqual([]);
      // Script alignment proves the acknowledgment prompt consumed exactly one
      // answer: every later answer landed in its intended question (the
      // harness does not expose prompt prints, so alignment plus the saved
      // [] is the observable proof). Without the prompt, 'accept empty'
      // would land in preferredLocations and these assertions would fail.
      expect(preferences.preferredLocations).toEqual(['Remote']);
      expect(preferences.targetRoles).toEqual(['Senior Software Engineer', 'Staff Engineer']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('returns to rule entry when the user presses Enter instead of accepting', async () => {
    const { dir, profileDir } = await freshProfileTmp();
    try {
      const result = await runInitWizard({
        prompt: scriptedPrompt(
          buildFreshAnswers(
            ['Remote', 'n'],
            undefined,
            [
              '', // decline the acknowledgment -> back to rule entry
              'y', // add a non-negotiable after all
              'noRelocation',
              'location',
              'reject if posting requires relocation outside preferredLocations',
              'n', // done adding rules
            ],
          ),
        ),
        profileDirectory: profileDir,
        repoRoot: dir,
      });
      expect(result.exitCode).toBe(0);
      const preferences = parseJobPreferences(
        await readFile(join(profileDir, 'jobPreferences.yaml'), 'utf8'),
      );
      expect(preferences.nonNegotiables).toHaveLength(1);
      expect(preferences.nonNegotiables[0]).toMatchObject({
        id: 'noRelocation',
        category: 'location',
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('complete wizard reuses existing files', () => {
  const existingPreferences = `
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

  const existingScreening = `{
  "workAuthorization": {
    "usCitizen": false,
    "requiresSponsorship": true,
    "sponsorshipType": "H-1B"
  },
  "compensation": {
    "minBaseSalary": 100000,
    "targetBaseSalary": 150000,
    "currency": "USD"
  },
  "standardQuestions": {
    "yearsOfExperience": {
      "softwareEngineering": 6,
      "typescript": 4,
      "python": 5
    },
    "preferredWorkLocation": "Remote / Hybrid East Coast",
    "noticePeriod": "2 weeks"
  }
}
`;

  const existingMaster = `# Existing Master Profile

## Contact
- Name: REPLACE_ME
- Email: existing@example.com

## Work Authorization
- US Citizen: yes
- Requires Visa Sponsorship: no
- Current Clearance: none

## Summary
Existing summary.

## Skills
- Languages: TypeScript, Python

## Experience
### Senior Engineer | ExistingCorp | Remote
- Start: 2020
- End: 2026
- Bullet.

## Education
### BS | University
- Start: 2009
- End: 2013

## Certifications
- None
`;

  const existingContacts = `{
  "contacts": []
}
`;

  async function seedAllFour(profileDir: string): Promise<void> {
    await writeFile(join(profileDir, 'jobPreferences.yaml'), existingPreferences, 'utf8');
    await writeFile(join(profileDir, 'screeningAnswers.json'), existingScreening, 'utf8');
    await writeFile(join(profileDir, 'masterProfile.md'), existingMaster, 'utf8');
    await writeFile(join(profileDir, 'networkingContacts.json'), existingContacts, 'utf8');
  }

  it('keeps existing files untouched when the user chooses keep', async () => {
    const { dir, profileDir } = await freshProfileTmp();
    try {
      await seedAllFour(profileDir);
      const expectedContents = new Map<string, string>();
      for (const name of realFileNames) {
        expectedContents.set(name, await readFile(join(profileDir, name), 'utf8'));
      }

      const answers = scriptedPrompt(['keep', 'keep', 'keep', 'keep']);
      const result = await runInitWizard({
        prompt: answers,
        profileDirectory: profileDir,
        repoRoot: dir,
      });
      expect(result.exitCode).toBe(0);
      expect(result.unchanged.length).toBe(4);
      expect(result.created).toEqual([]);
      expect(result.updated).toEqual([]);
      for (const name of realFileNames) {
        expect(await readFile(join(profileDir, name), 'utf8')).toBe(expectedContents.get(name));
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('updates only the chosen section and preserves the rest', async () => {
    const { dir, profileDir } = await freshProfileTmp();
    try {
      await seedAllFour(profileDir);
      // The user updates only jobPreferences compensation (section 1). The
      // flow answers, in order: jobPreferences decision 'update', section
      // number '1', screening 'keep', master 'keep', contacts 'keep', then the
      // compensation section questions (currency, min, target, bonus, equity).
      const script = scriptedPrompt([
        'update', // jobPreferences decision
        '1', // section: compensation
        'keep', // screeningAnswers
        'keep', // masterProfile
        'keep', // networkingContacts
        'USD', // compensation.currency
        '50000', // minAcceptableBase
        '75000', // targetBase
        'y', // countsBonusTowardMin
        'n', // countsEquityTowardMin
      ]);
      const result = await runInitWizard({
        prompt: script,
        profileDirectory: profileDir,
        repoRoot: dir,
      });
      expect(result.exitCode).toBe(0);
      const updated = parseJobPreferences(
        await readFile(join(profileDir, 'jobPreferences.yaml'), 'utf8'),
      );
      // compensation section replaced by the user's new values...
      expect(updated.compensation.minAcceptableBase).toBe(50000);
      expect(updated.compensation.targetBase).toBe(75000);
      // ...and the untouched sections preserved exactly.
      expect(updated.clearance.eligibleToObtain).toBe(false);
      expect(updated.nonNegotiables.length).toBe(2);
      expect(updated.preferredLocations).toEqual(['Remote']);
      // Only one file was written.
      expect(result.updated).toEqual([
        join(profileDir, 'jobPreferences.yaml'),
      ]);
      // The other three were neither created nor rewritten.
      expect(result.created).toEqual([]);
      const untouched = result.unchanged.map((path) => path.split('/').pop());
      expect(untouched).toEqual(['screeningAnswers.json', 'masterProfile.md', 'networkingContacts.json']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('updates only the targetRoles section and preserves the rest', async () => {
    const { dir, profileDir } = await freshProfileTmp();
    try {
      await seedAllFour(profileDir);
      // The user updates only jobPreferences targetRoles (section 5). The
      // flow answers, in order: jobPreferences decision 'update', section
      // number '5', screening 'keep', master 'keep', contacts 'keep', then the
      // comma-separated targetRoles input.
      const script = scriptedPrompt([
        'update', // jobPreferences decision
        '5', // section: targetRoles
        'keep', // screeningAnswers
        'keep', // masterProfile
        'keep', // networkingContacts
        'Senior Software Engineer, Staff Engineer', // targetRoles
      ]);
      const result = await runInitWizard({
        prompt: script,
        profileDirectory: profileDir,
        repoRoot: dir,
      });
      expect(result.exitCode).toBe(0);
      const updated = parseJobPreferences(
        await readFile(join(profileDir, 'jobPreferences.yaml'), 'utf8'),
      );
      expect(updated.targetRoles).toEqual(['Senior Software Engineer', 'Staff Engineer']);
      // Untouched sections preserved exactly.
      expect(updated.compensation.minAcceptableBase).toBe(100000);
      expect(updated.clearance.eligibleToObtain).toBe(false);
      expect(updated.nonNegotiables.length).toBe(2);
      expect(updated.preferredLocations).toEqual(['Remote']);
      // Only one file was written.
      expect(result.updated).toEqual([join(profileDir, 'jobPreferences.yaml')]);
      expect(result.created).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('writes targetRoles: [] when the user provides none', async () => {
    const { dir, profileDir } = await freshProfileTmp();
    try {
      await seedAllFour(profileDir);
      const script = scriptedPrompt([
        'update', // jobPreferences decision
        '5', // section: targetRoles
        'keep', // screeningAnswers
        'keep', // masterProfile
        'keep', // networkingContacts
        '', // no target roles provided
      ]);
      const result = await runInitWizard({
        prompt: script,
        profileDirectory: profileDir,
        repoRoot: dir,
      });
      expect(result.exitCode).toBe(0);
      const updated = parseJobPreferences(
        await readFile(join(profileDir, 'jobPreferences.yaml'), 'utf8'),
      );
      expect(updated.targetRoles).toEqual([]);
      expect(updated.preferredLocations).toEqual(['Remote']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('refuses to alter anything when an existing preferences file is malformed', async () => {
    const { dir, profileDir } = await freshProfileTmp();
    try {
      const malformed = 'compensation: {\n';
      await seedAllFour(profileDir);
      // Overwrite jobPreferences after seeding so the malformed content sticks.
      await writeFile(join(profileDir, 'jobPreferences.yaml'), malformed, 'utf8');
      // User tries to update jobPreferences compensation; the existing file
      // is malformed so prepare must throw before any write.
      const script = scriptedPrompt([
        'update', // jobPreferences decision
        '1', // section: compensation
        'keep', // screeningAnswers
        'keep', // masterProfile
        'keep', // networkingContacts
        'USD', // compensation.currency
        '50000', // minAcceptableBase
        '75000', // targetBase
        'y', // countsBonusTowardMin
        'n', // countsEquityTowardMin
      ]);
      await expect(
        runInitWizard({
          prompt: script,
          profileDirectory: profileDir,
          repoRoot: dir,
        }),
      ).rejects.toThrow(SetupValidationError);
      // The malformed file was left byte-for-byte untouched.
      expect(await readFile(join(profileDir, 'jobPreferences.yaml'), 'utf8')).toBe(malformed);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('complete wizard allows cancelling', () => {
  it('cancels cleanly and leaves existing files untouched', async () => {
    const { dir, profileDir } = await freshProfileTmp();
    try {
      const path = join(profileDir, 'jobPreferences.yaml');
      await writeFile(path, 'compensation: {}\n', 'utf8');
      await expect(
        runInitWizard({
          prompt: scriptedPrompt(['q']),
          profileDirectory: profileDir,
          repoRoot: dir,
        }),
      ).rejects.toThrow(InitCancelledError);
      expect(await readFile(path, 'utf8')).toBe('compensation: {}\n');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('git profile protection', () => {
  it('flags a tracked real profile file as blocking', () => {
    const statuses: ProfileGitStatus[] = [
      { path: 'profile/jobPreferences.yaml', inRepo: true, ignored: true, tracked: true },
      { path: 'profile/masterProfile.md', inRepo: true, ignored: true, tracked: false },
    ];
    const report = assessProfileProtections(statuses);
    expect(report.blocked).toBe(true);
    expect(report.reasons.join('\n')).toContain('tracked by git');
  });

  it('declares an unignored untracked file as blocking', () => {
    const statuses: ProfileGitStatus[] = [
      { path: 'profile/jobPreferences.yaml', inRepo: true, ignored: false, tracked: false },
    ];
    const report = assessProfileProtections(statuses);
    expect(report.blocked).toBe(true);
    expect(report.reasons.join('\n')).toContain('not ignored');
  });

  it('passes when every profile file is gitignored and untracked', () => {
    const statuses: ProfileGitStatus[] = [
      { path: 'profile/jobPreferences.yaml', inRepo: true, ignored: true, tracked: false },
      { path: 'profile/masterProfile.md', inRepo: true, ignored: true, tracked: false },
    ];
    expect(assessProfileProtections(statuses).blocked).toBe(false);
  });
});

describe('init CLI wiring', () => {
  it('--help for init is available without running the wizard', async () => {
    const result = await dispatchCli(['init', '--help']);
    expect(result.exitCode).toBe(0);
    const text = result.printedLines.join('\n');
    expect(text).toContain('init - interactive guided setup wizard');
  });

  it('a bare `init` is routed to its run handler without erroring', async () => {
    const parsed = parseInitArgs([]);
    expect(parsed.help).toBeUndefined();
  });

  it('the no-arg menu lists init but never auto-runs it', async () => {
    const result = await dispatchCli([]);
    expect(result.exitCode).toBe(0);
    const text = result.printedLines.join('\n');
    expect(text).toContain('Run the setup wizard');
    expect(text).not.toContain('Setup complete.');
  });
});

describe('init --repoRoot checkout default', () => {
  it('prints a --repoRoot default resolving to the checkout when run from /tmp', async () => {
    const checkoutRoot = repoRootFromModule();
    // Source-level contract first: green with or without a build.
    const help = await dispatchCli(['init', '--help']);
    expect(help.exitCode).toBe(0);
    const helpText = help.printedLines.join('\n');
    expect(helpText).toContain('--repoRoot');
    expect(helpText).toContain(checkoutRoot);
    expect(helpText).not.toContain('default: CWD');
    const variantsSeed = join(checkoutRoot, 'profile', resumeVariantsFileName);
    expect(existsSync(variantsSeed)).toBe(true);
    // Built-CLI invocation only when dist/ exists; a fresh clone without
    // `npm run build` skips it instead of failing on gitignored output.
    const cliEntry = join(checkoutRoot, 'dist', 'cli', 'jobSearchCore.js');
    if (!existsSync(cliEntry)) {
      return;
    }
    const output = execFileSync('node', [cliEntry, 'init', '--help'], {
      cwd: '/tmp',
      encoding: 'utf8',
    });
    expect(output).toContain('--repoRoot');
    expect(output).toContain(checkoutRoot);
    expect(output).not.toContain('default: CWD');
  });

  it('fresh clone without dist still resolves init --repoRoot help from source (no build required)', async () => {
    const checkoutRoot = repoRootFromModule();
    // Source entry ships on a fresh clone; dist/ is gitignored and may not
    // exist until `npm run build` runs, so this case must not require it.
    expect(existsSync(join(checkoutRoot, 'src', 'cli', 'jobSearchCore.ts'))).toBe(true);
    const result = await dispatchCli(['init', '--help']);
    expect(result.exitCode).toBe(0);
    const text = result.printedLines.join('\n');
    expect(text).toContain('--repoRoot');
    expect(text).toContain(checkoutRoot);
    expect(text).not.toContain('default: CWD');
    const variantsSeed = join(checkoutRoot, 'profile', resumeVariantsFileName);
    expect(existsSync(variantsSeed)).toBe(true);
  });

  it('runs the full wizard against a real /tmp git checkout covering seed plus linter plus git-check', async () => {
    const checkoutRoot = repoRootFromModule();
    const tmpRoot = await mkdtemp('/tmp/weJobSearch-initU34-');
    try {
      execFileSync('git', ['init', '-q', tmpRoot], { stdio: 'pipe' });
      // Defensive backstop mirroring the checkout .gitignore so the four
      // real profile files are ignored (never tracked) inside the tmp repo.
      await writeFile(
        join(tmpRoot, '.gitignore'),
        [
          'profile/masterProfile.md',
          'profile/jobPreferences.yaml',
          'profile/screeningAnswers.json',
          'profile/networkingContacts.json',
          'dataHome/',
          '',
        ].join('\n'),
        'utf8',
      );
      // Seed resolution: the committed structure template must resolve under
      // the arbitrary --repoRoot, exactly as the wizard reads it.
      const checkoutSeed = await readFile(
        join(checkoutRoot, 'profile', resumeVariantsFileName),
        'utf8',
      );
      const tmpProfileDir = join(tmpRoot, 'profile');
      await mkdir(tmpProfileDir, { recursive: true });
      await writeFile(join(tmpProfileDir, resumeVariantsFileName), checkoutSeed, 'utf8');
      const dataDir = join(tmpRoot, 'dataHome');
      const dataProfileDir = join(dataDir, 'profile');
      await mkdir(dataProfileDir, { recursive: true });

      const result = await runInitWizard({
        prompt: scriptedPrompt(freshAnswers),
        profileDirectory: dataProfileDir,
        repoRoot: tmpRoot,
      });
      expect(result.exitCode).toBe(0);
      // Seed: the committed template copied under the tmp --repoRoot is left
      // byte-for-byte intact (the wizard never rewrites the seed source).
      expect(await readFile(join(tmpProfileDir, resumeVariantsFileName), 'utf8')).toBe(
        checkoutSeed,
      );
      // Linter: the wizard ran the naming linter against the tmp --repoRoot.
      const text = result.printedLines.join('\n');
      expect(text).toContain('Naming linter:');
      // Git-check: inside a real git work tree the protection check runs for
      // real instead of printing the not-a-repository skip notice.
      expect(text).toContain('Git profile enforcement:');
      expect(text).not.toContain('Not inside a git repository');
      expect(text).toContain('Setup complete.');
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it('defaults repoRoot to the checkout when omitted with CWD at /tmp (U04 default path)', async () => {    const checkoutRoot = repoRootFromModule();
    // A configured path inside the checkout (gitignored dist/, so never
    // blocked) forces the git protection check to report inRepo results only
    // when the omitted repoRoot actually falls back to repoRootFromModule().
    // With the old process.cwd() default, CWD=/tmp is not a repo and the
    // wizard prints 'Not inside a git repository' instead.
    const repoProbePath = join(checkoutRoot, 'dist', 'initRepoRootProbe');
    const previousCwd = process.cwd();
    const { dir, profileDir } = await freshProfileTmp();
    try {
      process.chdir('/tmp');
      const result = await runInitWizard({
        prompt: scriptedPrompt(
          buildFreshAnswers(['Remote', 'n'], [repoProbePath, '']),
        ),
        profileDirectory: profileDir,
      });
      const expectedLinter = await runNamingLinter({ repoRoot: checkoutRoot });
      // B4: onboarding no longer depends on the repo lint gate — profile
      // creation succeeds whenever gitignore protection passes, even with
      // pre-existing naming violations in the checkout.
      expect(result.exitCode).toBe(0);
      const text = result.printedLines.join('\n');
      // Linter ran against the checkout: same violation count as a direct
      // checkout scan (a CWD-rooted scan of /tmp could never match this).
      expect(text).toContain(
        `Naming linter: ${expectedLinter.violations.length} violation(s) found.`,
      );
      // Git protection check ran against the checkout repo, not /tmp.
      expect(text).toContain('Git profile enforcement:');
      expect(text).toContain('ignored=yes');
      expect(text).not.toContain('Not inside a git repository');
      expect(text).not.toContain('FATAL: real profile data');
      // Seed source the wizard reads resolves to the checkout structure
      // template...
      expect(existsSync(join(checkoutRoot, 'profile', resumeVariantsFileName))).toBe(true);
      // ...while an explicit profileDirectory override is never seeded.
      expect(await readdir(profileDir)).not.toContain(resumeVariantsFileName);
    } finally {
      process.chdir(previousCwd);
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('init --dataRoot relocation (U05)', () => {
  it('seeds variants under a relocated data root and writes only there', async () => {
    const checkoutRoot = repoRootFromModule();
    const dir = await mkdtemp(join(tmpdir(), 'weJobSearch-initU05-'));
    try {
      const relocatedRoot = join(dir, 'relocated');
      const result = await runInitWizard({
        prompt: scriptedPrompt(freshAnswers),
        profileDirectory: relocatedRoot,
        repoRoot: checkoutRoot,
        seedVariants: true,
      });
      expect(result.exitCode).toBe(0);
      const seed = await readFile(join(checkoutRoot, 'profile', resumeVariantsFileName), 'utf8');
      expect(await readFile(join(relocatedRoot, resumeVariantsFileName), 'utf8')).toBe(seed);
      const touched = [...result.created, ...result.updated];
      expect(touched.length).toBeGreaterThan(0);
      for (const target of touched) {
        expect(target.startsWith(relocatedRoot)).toBe(true);
        expect(target).not.toContain('.example');
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('never seeds variants for a direct profileDirectory override without the flag', async () => {
    const { dir, profileDir } = await freshProfileTmp();
    try {
      const result = await runInitWizard({
        prompt: scriptedPrompt(freshAnswers),
        profileDirectory: profileDir,
        repoRoot: repoRootFromModule(),
      });
      expect(await readdir(profileDir)).not.toContain(resumeVariantsFileName);
      expect(result.created.length).toBeGreaterThan(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('init protection pre-write gate (U06)', () => {
  it('writes nothing and exits 1 when profile files are unprotected inside a git repo', async () => {
    const repoDir = await mkdtemp(join(tmpdir(), 'weJobSearch-initU06-'));
    try {
      execFileSync('git', ['init', '-q', repoDir], { stdio: 'pipe' });
      const profileDir = join(repoDir, 'data');
      const result = await runInitWizard({
        prompt: scriptedPrompt(freshAnswers),
        profileDirectory: profileDir,
        repoRoot: repoDir,
      });
      expect(result.exitCode).toBe(1);
      const text = result.printedLines.join('\n');
      expect(text).toContain('FATAL');
      expect(text).toContain('No files were written.');
      expect(text).not.toContain('Setup complete.');
      expect(result.created).toEqual([]);
      expect(result.updated).toEqual([]);
      expect(existsSync(profileDir)).toBe(false);
    } finally {
      await rm(repoDir, { recursive: true, force: true });
    }
  });

  it('fails loudly instead of skipping the check on malformed prefs', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'weJobSearch-initU06yaml-'));
    try {
      const badPrefs = join(dir, 'jobPreferences.yaml');
      await writeFile(badPrefs, 'compensation: [unclosed\n', 'utf8');
      const content = await readFile(badPrefs, 'utf8');
      expect(() => parseConfiguredDirectoryPaths(content)).toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('aborts a keep-mode run without writing when on-disk prefs are malformed', async () => {
    const { dir, profileDir } = await freshProfileTmp();
    try {
      const corrupt = 'compensation: [unclosed\n';
      await writeFile(join(profileDir, 'jobPreferences.yaml'), corrupt, 'utf8');
      await writeFile(join(profileDir, 'screeningAnswers.json'), '{}', 'utf8');
      await writeFile(join(profileDir, 'masterProfile.md'), '# keeps\n', 'utf8');
      await writeFile(join(profileDir, 'networkingContacts.json'), '{}', 'utf8');
      await expect(
        runInitWizard({
          prompt: scriptedPrompt(['keep', 'keep', 'keep', 'keep']),
          profileDirectory: profileDir,
          repoRoot: dir,
        }),
      ).rejects.toThrow(SetupValidationError);
      expect(await readFile(join(profileDir, 'jobPreferences.yaml'), 'utf8')).toBe(corrupt);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('never blocks paths outside the git work tree (explicit allow policy)', () => {
    const report = assessProfileProtections([
      { path: 'profile/jobPreferences.yaml', inRepo: false, ignored: false, tracked: false },
    ]);
    expect(report.blocked).toBe(false);
    expect(report.reasons).toEqual([]);
  });
});
describe('init contacts replace and placeholder boundary (U20)', () => {
  const cleanMaster = `# Existing Master Profile

## Contact
- Name: Jane Example
- Email: existing@example.com

## Work Authorization
- US Citizen: yes
- Requires Visa Sponsorship: no
- Current Clearance: none

## Summary
Existing summary.

## Skills
- Languages: TypeScript, Python

## Experience
### Senior Engineer | ExistingCorp | Remote
- Start: 2020
- End: 2026
- Bullet.

## Education
### BS | University
- Start: 2009
- End: 2013

## Certifications
- None
`;

  const storedContacts = `{
  "contacts": [
    {
      "contactId": "contact001",
      "name": "Jane Sample",
      "company": "SampleCorp",
      "relationship": "formerColleague",
      "lastContactDate": "2026-07-15",
      "linkedApplicationIds": [],
      "followUpDue": "2026-08-20"
    }
  ]
}
`;

  it('preserves existing contacts when a replace wipe is declined', async () => {
    const { dir, profileDir } = await freshProfileTmp();
    try {
      await writeFile(join(profileDir, 'networkingContacts.json'), storedContacts, 'utf8');
      const script = scriptedPrompt(['replace', 'replace', ...freshAnswers, 'keep']);
      const result = await runInitWizard({
        prompt: script,
        profileDirectory: profileDir,
        repoRoot: dir,
      });
      expect(result.exitCode).toBe(0);
      expect(await readFile(join(profileDir, 'networkingContacts.json'), 'utf8')).toBe(storedContacts);
      expect(result.unchanged).toContain(join(profileDir, 'networkingContacts.json'));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('wipes contacts only on explicit wipe confirmation', async () => {
    const { dir, profileDir } = await freshProfileTmp();
    try {
      await writeFile(join(profileDir, 'networkingContacts.json'), storedContacts, 'utf8');
      const script = scriptedPrompt(['replace', 'replace', ...freshAnswers, 'wipe']);
      const result = await runInitWizard({
        prompt: script,
        profileDirectory: profileDir,
        repoRoot: dir,
      });
      expect(result.exitCode).toBe(0);
      expect(await readFile(join(profileDir, 'networkingContacts.json'), 'utf8')).toBe(
        `${JSON.stringify({ contacts: [] }, null, 2)}\n`,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('refuses an update that would introduce a new placeholder', async () => {
    const { dir, profileDir } = await freshProfileTmp();
    try {
      await writeFile(join(profileDir, 'jobPreferences.yaml'), 'compensation: {}\n', 'utf8');
      await writeFile(join(profileDir, 'screeningAnswers.json'), '{}', 'utf8');
      await writeFile(join(profileDir, 'masterProfile.md'), cleanMaster, 'utf8');
      await writeFile(join(profileDir, 'networkingContacts.json'), '{"contacts": []}\n', 'utf8');
      const script = scriptedPrompt([
        'keep',
        'keep',
        'update',
        '1',
        'keep',
        '',
        'jane@example.com',
        '+1 555 0100',
        'Austin, TX',
        'https://www.linkedin.com/in/jane-example',
        'https://jane.example.dev',
      ]);
      await expect(
        runInitWizard({ prompt: script, profileDirectory: profileDir, repoRoot: dir }),
      ).rejects.toThrow(SetupValidationError);
      expect(await readFile(join(profileDir, 'masterProfile.md'), 'utf8')).toBe(cleanMaster);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('screeningDefaultsFromPreferences malformed prefs warning (U23g)', () => {
  it('surfaces a warning with fallback defaults when existing prefs do not parse', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'weJobSearch-u23g-'));
    try {
      const prefsPath = join(dir, 'jobPreferences.yaml');
      await writeFile(prefsPath, 'compensation: [unclosed\n', 'utf8');
      const result = await screeningDefaultsFromPreferences(undefined, prefsPath);
      expect(result.defaults).toEqual({ currency: 'USD', minBaseSalary: 0, targetBaseSalary: 0 });
      expect(result.warning).toContain('does not parse');
      expect(result.warning).toContain(prefsPath);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('returns no warning for collected compensation or a missing file', async () => {
    const collected = await screeningDefaultsFromPreferences(
      {
        currency: 'USD',
        minAcceptableBase: 120000,
        targetBase: 150000,
        countsBonusTowardMin: false,
        countsEquityTowardMin: false,
      },
      join(tmpdir(), 'weJobSearch-u23g-missing.yaml'),
    );
    expect(collected.warning).toBeNull();
    expect(collected.defaults.minBaseSalary).toBe(120000);
    const missing = await screeningDefaultsFromPreferences(
      undefined,
      join(tmpdir(), 'weJobSearch-u23g-absent.yaml'),
    );
    expect(missing.warning).toBeNull();
    expect(missing.defaults).toEqual({ currency: 'USD', minBaseSalary: 0, targetBaseSalary: 0 });
  });
});

describe('legacy directories.dataRoot migration warning (U43)', () => {
  // F12 as specified (a soft warning) is superseded: the U40 schema guard
  // rejects directories.dataRoot loudly at the pre-write gate, and its
  // message already carries the migration instruction. This locks in that
  // a legacy key fails loudly instead of being silently honored or ignored.
  it('fails loudly with migration guidance when preferences carry a legacy dataRoot key', async () => {
    const { dir, profileDir } = await freshProfileTmp();
    try {
      const legacyPreferences = [
        'compensation:',
        '  currency: USD',
        '  minAcceptableBase: 100000',
        '  targetBase: 150000',
        '  countsBonusTowardMin: false',
        '  countsEquityTowardMin: false',
        'clearance:',
        '  currentStatus: none',
        '  currentLevel: null',
        '  eligibleToObtain: false',
        '  requiresSponsorshipForVisa: false',
        'nonNegotiables: []',
        'preferredLocations:',
        '  - Remote',
        'directories:',
        `  dataRoot: '${join(dir, 'legacyRoot')}'`,
        '',
      ].join('\n');
      await writeFile(join(profileDir, 'jobPreferences.yaml'), legacyPreferences, 'utf8');
      await writeFile(
        join(profileDir, 'screeningAnswers.json'),
        '{"workAuthorization":{"usCitizen":true,"requiresSponsorship":false,"sponsorshipType":null},"compensation":{"minBaseSalary":100000,"targetBaseSalary":150000,"currency":"USD"},"standardQuestions":{"yearsOfExperience":{"softwareEngineering":6},"preferredWorkLocation":"Remote","noticePeriod":"2 weeks"}}\n',
        'utf8',
      );
      await writeFile(join(profileDir, 'masterProfile.md'), '# Existing\n', 'utf8');
      await writeFile(
        join(profileDir, 'networkingContacts.json'),
        '{"contacts": []}\n',
        'utf8',
      );
      const printed: string[] = [];
      const prompt: PromptContext = {
        ask: async () => 'keep',
        print: (lines: readonly string[]) => {
          printed.push(...lines);
        },
        close: () => {},
      };
      await expect(
        runInitWizard({
          prompt,
          profileDirectory: profileDir,
          repoRoot: dir,
        }),
      ).rejects.toThrow(/directories\.dataRoot is no longer supported/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('init Phase B correctness (B1-B4, isolated roots only)', () => {
  it('refuses a non-interactive stdin with a usable message instead of "readline was closed"', async () => {
    // Regression: inside an agent shell stdin is not a TTY, so the first
    // question threw a bare readline error and setup could not start at all.
    const stdin = process.stdin as { isTTY?: boolean };
    const originalIsTTY = stdin.isTTY;
    stdin.isTTY = undefined;
    try {
      const result = await runInitCommand({});
      expect(result.exitCode).toBe(1);
      const text = result.printedLines.join('\n');
      expect(text).toContain('interactive terminal');
      expect(text).toContain('initializeUserProfile');
      expect(text).not.toContain('readline was closed');
    } finally {
      stdin.isTTY = originalIsTTY;
    }
  });

  it('B1: runInitCommand seeds variants so validate passes and preview/generate reach the profile guard', async () => {
    const checkoutRoot = repoRootFromModule();
    const dir = await mkdtemp(join(tmpdir(), 'weJobSearch-initB1-'));
    try {
      const dataRoot = join(dir, 'dataRoot');
      const initResult = await runInitCommand({ dataRoot }, scriptedPrompt(freshAnswers));
      expect(initResult.exitCode).toBe(0);
      // The working resumeVariants.yaml is seeded from the committed
      // structure template (previously skipped unless --dataRoot was passed
      // through a different flag path; plain canonical-root init never seeded).
      const seed = await readFile(join(checkoutRoot, 'profile', resumeVariantsFileName), 'utf8');
      expect(await readFile(join(dataRoot, resumeVariantsFileName), 'utf8')).toBe(seed);
      const validateResult = await runValidateCommand({ dataRoot });
      expect(validateResult.exitCode).toBe(0);
      expect(validateResult.printedLines.join('\n')).toContain('resumeVariants.yaml: OK');
      // Preview and generate resolve variants past the seed (the regression:
      // previously they died on "resumeVariants.yaml not found"). They stop
      // at the intended placeholder guard instead: a fresh master still
      // carries structural REPLACE_ME the user must fill (the init report
      // says so explicitly), so exit 1 with the placeholder message — never
      // the variants-missing message — is the correct post-init behavior.
      const previewResult = await runPreviewResumeCommand({ dataRoot });
      expect(previewResult.exitCode).toBe(1);
      const previewText = previewResult.printedLines.join('\n');
      expect(previewText).toContain('REPLACE_ME placeholders');
      expect(previewText).not.toContain('resumeVariants.yaml not found');
      const generateResult = await runGenerate({
        company: 'SampleCorp',
        role: 'SampleEngineer',
        dataRoot,
      });
      expect(generateResult.exitCode).toBe(1);
      const generateText = generateResult.printedLines.join('\n');
      expect(generateText).toContain('REPLACE_ME placeholders');
      expect(generateText).not.toContain('resumeVariants.yaml not found');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('B2: replace recovers from corrupt prefs and invalid screening JSON instead of throwing', async () => {
    const { dir, profileDir } = await freshProfileTmp();
    try {
      const corruptPrefs = 'compensation: {\n';
      const corruptScreening = '{"workAuthorization": \n';
      await writeFile(join(profileDir, 'jobPreferences.yaml'), corruptPrefs, 'utf8');
      await writeFile(join(profileDir, 'screeningAnswers.json'), corruptScreening, 'utf8');
      // Only the two corrupt files exist, so only they prompt for a
      // decision; master and screening-contact sections are created fresh.
      const script = scriptedPrompt(['replace', 'replace', 'replace', 'replace', ...freshAnswers]);
      const result = await runInitWizard({
        prompt: script,
        profileDirectory: profileDir,
        repoRoot: dir,
      });
      expect(result.exitCode).toBe(0);
      // Both files were fully replaced with valid content: the corrupt
      // bytes are gone and the result parses against its schema.
      const preferences = parseJobPreferences(
        await readFile(join(profileDir, 'jobPreferences.yaml'), 'utf8'),
      );
      expect(preferences.compensation.minAcceptableBase).toBe(120000);
      const screening = JSON.parse(
        await readFile(join(profileDir, 'screeningAnswers.json'), 'utf8'),
      );
      expect(screeningAnswersSchema.safeParse(screening).success).toBe(true);
      const text = result.printedLines.join('\n');
      expect(text).toContain('replaced');
      expect(text).not.toContain('does not conform');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('B3: master replace is a true full replace and the report says replaced', async () => {
    const { dir, profileDir } = await freshProfileTmp();
    try {
      const distinctiveMaster = [
        '# Existing Master Profile',
        '',
        '## Contact',
        '- Name: Jane Example',
        '',
        '## Work Authorization',
        '- US Citizen: yes',
        '',
        '## Summary',
        'Distinctive existing summary that must not survive.',
        '',
        '## Skills',
        '- Languages: CobolOnly',
        '',
        '## Experience',
        '### Senior Engineer | ExistingCorp | Remote',
        '- Start: 2020',
        '',
        '## Education',
        '### BS | University',
        '',
        '## Certifications',
        '- None',
        '',
      ].join('\n');
      await writeFile(join(profileDir, 'masterProfile.md'), distinctiveMaster, 'utf8');
      const script = scriptedPrompt(['replace', 'replace', ...freshAnswers]);
      const result = await runInitWizard({
        prompt: script,
        profileDirectory: profileDir,
        repoRoot: dir,
      });
      expect(result.exitCode).toBe(0);
      const master = await readFile(join(profileDir, 'masterProfile.md'), 'utf8');
      // No section of the previous file survives a replace.
      expect(master).not.toContain('ExistingCorp');
      expect(master).not.toContain('CobolOnly');
      expect(master).not.toContain('Distinctive existing summary');
      // The fresh template carries the newly collected contact instead.
      expect(master).toContain('Jane Example');
      for (const heading of ['## Contact', '## Summary', '## Skills', '## Experience']) {
        expect(master).toContain(heading);
      }
      // Honest wording: an overwrite is reported as replaced, never written.
      const reportLine = result.printedLines.find((line) =>
        line.includes(join(profileDir, 'masterProfile.md')),
      );
      expect(reportLine).toContain('replaced');
      expect(reportLine).not.toContain('written');
      expect(result.updated).toContain(join(profileDir, 'masterProfile.md'));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('B3: contacts replace lands in updated (never created) and reports replaced', async () => {
    const { dir, profileDir } = await freshProfileTmp();
    try {
      const storedContacts = [
        '{"contacts": [{"contactId": "contact001", "name": "Jane Sample",',
        '"company": "SampleCorp", "relationship": "formerColleague",',
        '"lastContactDate": "2026-07-15", "linkedApplicationIds": [],',
        '"followUpDue": "2026-08-20"}]}',
        '',
      ].join('\n');
      await writeFile(join(profileDir, 'networkingContacts.json'), storedContacts, 'utf8');
      const script = scriptedPrompt(['replace', 'replace', ...freshAnswers, 'wipe']);
      const result = await runInitWizard({
        prompt: script,
        profileDirectory: profileDir,
        repoRoot: dir,
      });
      expect(result.exitCode).toBe(0);
      expect(await readFile(join(profileDir, 'networkingContacts.json'), 'utf8')).toBe(
        `${JSON.stringify({ contacts: [] }, null, 2)}\n`,
      );
      const contactsPath = join(profileDir, 'networkingContacts.json');
      expect(result.updated).toContain(contactsPath);
      expect(result.created).not.toContain(contactsPath);
      const reportLine = result.printedLines.find((line) => line.includes(contactsPath));
      expect(reportLine).toContain('replaced');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('B4: profile creation succeeds with an unrelated repo naming violation present', async () => {
    const repoDir = await mkdtemp(join(tmpdir(), 'weJobSearch-initB4-'));
    try {
      execFileSync('git', ['init', '-q', repoDir], { stdio: 'pipe' });
      await writeFile(join(repoDir, '.gitignore'), ['data/', ''].join('\n'), 'utf8');
      // Unrelated pre-existing violation: an underscore file name plus an
      // underscore identifier, far from the data/ profile tree.
      await writeFile(join(repoDir, 'bad_name.ts'), 'export const bad_name = 1;\n', 'utf8');
      const fixtureLinter = await runNamingLinter({ repoRoot: repoDir });
      expect(fixtureLinter.violations.length).toBeGreaterThan(0);
      const profileDir = join(repoDir, 'data');
      await mkdir(profileDir, { recursive: true });
      const result = await runInitWizard({
        prompt: scriptedPrompt(freshAnswers),
        profileDirectory: profileDir,
        repoRoot: repoDir,
      });
      expect(result.exitCode).toBe(0);
      const createdNames = result.created.map((path) => path.split('/').pop()).sort();
      expect(createdNames).toEqual(
        ['jobPreferences.yaml', 'masterProfile.md', 'networkingContacts.json', 'screeningAnswers.json'].sort(),
      );
      // The linter still runs and reports (informational), it just never blocks.
      const text = result.printedLines.join('\n');
      expect(text).toContain('Naming linter:');
      expect(text).toContain('Setup complete.');
    } finally {
      await rm(repoDir, { recursive: true, force: true });
    }
  });
});
