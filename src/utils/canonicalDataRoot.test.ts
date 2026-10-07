import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  applicationsDirectoryName,
  canonicalContactsPath,
  canonicalDataRoot,
  canonicalMasterProfilePath,
  canonicalResumeVariantsPath,
  documentsDirectoryName,
  ensureCanonicalDataDirectories,
  isPathInside,
  platformDocumentsDirectory,
  profileDirectoryOf,
  resolveDataRoot,
  resolveOutputRoot,
  resolveResumeVariantsPath,
  resolveShippedTemplatesRoot,
  resolveTemplatePath,
  resolveTemplateRoot,
  resumeVariantsFileName,
  sanitizeUserName,
  shippedTemplatesRoot,
  userTemplatesRoot,
} from './canonicalDataRoot';

describe('canonicalDataRoot: location', () => {
  it('derives the root under the OS Documents dir from home + username', () => {
    const root = canonicalDataRoot();
    expect(root).toContain(`Documents${sep}weJobSearch${sep}`);
    expect(canonicalMasterProfilePath()).toBe(join(root, 'masterProfile.md'));
    expect(canonicalContactsPath()).toBe(join(root, 'networkingContacts.json'));
    expect(canonicalResumeVariantsPath()).toBe(join(root, 'resumeVariants.yaml'));
  });

  it('places documents and applications as canonical subdirectories', () => {
    const root = canonicalDataRoot();
    expect(documentsDirectoryName).toBe('documents');
    expect(applicationsDirectoryName).toBe('applications');
    expect(resolveOutputRoot()).toBe(join(root, applicationsDirectoryName));
  });

  it('profileDirectoryOf returns the parent of a profile file', () => {
    expect(profileDirectoryOf(join(canonicalDataRoot(), 'masterProfile.md'))).toBe(
      canonicalDataRoot(),
    );
  });

  it('isPathInside distinguishes inside, equal, and outside', () => {
    const inside = isPathInside(canonicalDataRoot(), canonicalMasterProfilePath());
    expect(inside).toBe(true);
    expect(isPathInside(canonicalDataRoot(), canonicalDataRoot())).toBe(true);
    const sibling = join(canonicalDataRoot(), '..', 'unrelated', 'masterProfile.md');
    expect(isPathInside(canonicalDataRoot(), sibling)).toBe(false);
  });
});

describe('canonicalDataRoot: directory provisioning', () => {
  it('creates root, documents, and applications idempotently', async () => {
    const root = await mkdtemp(join(tmpdir(), 'weJobSearch-canonical-'));
    try {
      const created = await ensureCanonicalDataDirectories(root);
      expect(created).toBe(root);
      const again = await ensureCanonicalDataDirectories(root);
      expect(again).toBe(root);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('config-driven directory resolution (CLI flag > env > canonical default)', () => {
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
  });

  it('resolveDataRoot prefers CLI over env and the canonical default', () => {
    process.env[envKey] = join(tmpdir(), 'envDataRoot');
    expect(resolveDataRoot(join(tmpdir(), 'cliDataRoot'))).toBe(join(tmpdir(), 'cliDataRoot'));
    expect(resolveDataRoot()).toBe(join(tmpdir(), 'envDataRoot'));
  });

  it('resolveDataRoot rejects a set directories.dataRoot loudly instead of honoring it', () => {
    expect(() => resolveDataRoot(undefined, { dataRoot: join(tmpdir(), 'cfgDataRoot') })).toThrow(
      /directories\.dataRoot is no longer supported/,
    );
  });

  it('resolveDataRoot falls back to the canonical default when nothing overrides', () => {
    expect(resolveDataRoot()).toBe(canonicalDataRoot());
  });

  it('resolveDataRoot ignores blank CLI, config, and env values', () => {
    process.env[envKey] = '   ';
    expect(resolveDataRoot('  ', { dataRoot: '' })).toBe(canonicalDataRoot());
  });

  it('resolveOutputRoot prefers CLI over directories and defaults to applications under the data root', () => {
    const dataRoot = join(tmpdir(), 'customDataRoot');
    expect(
      resolveOutputRoot(join(dataRoot, 'cliOut'), { outputRoot: join(dataRoot, 'cfgOut') }, dataRoot),
    ).toBe(join(dataRoot, 'cliOut'));
    expect(resolveOutputRoot(undefined, { outputRoot: join(dataRoot, 'cfgOut') }, dataRoot)).toBe(
      join(dataRoot, 'cfgOut'),
    );
    expect(resolveOutputRoot(undefined, undefined, dataRoot)).toBe(
      join(dataRoot, applicationsDirectoryName),
    );
  });

  it('resolveTemplateRoot returns the shipped templates dir (no overrides)', () => {
    expect(resolveTemplateRoot()).toBe(shippedTemplatesRoot());
    expect(shippedTemplatesRoot()).toBe(join(resolve(__dirname, '..', '..'), 'templates'));
  });

  it('resolveTemplatePath allowlists shipped-first, user-templates second, rejects escapes', async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), 'weJobSearch-tmpl-'));
    try {
      // Shipped template by bare name and by historical templates/ prefix.
      expect(resolveTemplatePath('usStandardResume.typ', dataRoot)).toBe(
        join(shippedTemplatesRoot(), 'usStandardResume.typ'),
      );
      expect(resolveTemplatePath('templates/usStandardResume.typ', dataRoot)).toBe(
        join(shippedTemplatesRoot(), 'usStandardResume.typ'),
      );
      // Unknown name falls through to the confined user root.
      expect(resolveTemplatePath('customStandard.typ', dataRoot)).toBe(
        join(userTemplatesRoot(dataRoot), 'customStandard.typ'),
      );
      // Absolute paths inside either root pass; anything else throws.
      expect(resolveTemplatePath(join(shippedTemplatesRoot(), 'usStandardResume.typ'), dataRoot)).toBe(
        join(shippedTemplatesRoot(), 'usStandardResume.typ'),
      );
      expect(resolveTemplatePath(join(userTemplatesRoot(dataRoot), 'custom.typ'), dataRoot)).toBe(
        join(userTemplatesRoot(dataRoot), 'custom.typ'),
      );
      expect(() => resolveTemplatePath(join(tmpdir(), 'escape.typ'), dataRoot)).toThrow(
        /outside|confinement/i,
      );
      expect(() => resolveTemplatePath('/etc/passwd', dataRoot)).toThrow(/outside|confinement/i);
    } finally {
      await rm(dataRoot, { recursive: true, force: true });
    }
  });

  it('resolveResumeVariantsPath prefers CLI over directories and defaults under the data root', () => {
    const dataRoot = join(tmpdir(), 'customDataRoot');
    const cliPath = join(dataRoot, 'cliVariants.yaml');
    const cfgPath = join(dataRoot, 'cfgVariants.yaml');
    expect(resolveResumeVariantsPath(cliPath, { resumeVariantsFile: cfgPath }, dataRoot)).toBe(cliPath);
    expect(resolveResumeVariantsPath(undefined, { resumeVariantsFile: cfgPath }, dataRoot)).toBe(cfgPath);
    expect(resolveResumeVariantsPath(undefined, undefined, dataRoot)).toBe(
      join(dataRoot, resumeVariantsFileName),
    );
  });
});
describe('platform home-shape matrix (U26)', () => {
  const home = '/home/tester';

  it('resolves macOS/Linux legacy Documents when XDG is unset', () => {
    expect(platformDocumentsDirectory('darwin', {}, home)).toBe(join(home, 'Documents'));
    expect(platformDocumentsDirectory('linux', {}, home)).toBe(join(home, 'Documents'));
  });

  it('honors XDG_DATA_HOME on non-Windows platforms', () => {
    expect(
      platformDocumentsDirectory('linux', { ['XDG_DATA_HOME']: '/data/xdg' }, home),
    ).toBe('/data/xdg');
    expect(platformDocumentsDirectory('darwin', { ['XDG_DATA_HOME']: '   ' }, home)).toBe(
      join(home, 'Documents'),
    );
  });

  it('prefers an existing OneDrive Documents folder on Windows', () => {
    const env = { OneDrive: 'C:\\OneDrive', USERPROFILE: 'C:\\Users\\tester' };
    expect(
      platformDocumentsDirectory('win32', env, home, (path) => path === join('C:\\OneDrive', 'Documents')),
    ).toBe(join('C:\\OneDrive', 'Documents'));
  });

  it('falls back to USERPROFILE Documents when OneDrive is missing on Windows', () => {
    const env = { OneDrive: 'C:\\OneDrive', USERPROFILE: 'C:\\Users\\tester' };
    expect(platformDocumentsDirectory('win32', env, home, () => false)).toBe(
      join('C:\\Users\\tester', 'Documents'),
    );
    expect(platformDocumentsDirectory('win32', {}, home)).toBe(join(home, 'Documents'));
  });

  it('sanitizes Windows domain prefixes and whitespace from user names', () => {
    expect(sanitizeUserName('CORP\\jdoe')).toBe('jdoe');
    expect(sanitizeUserName('John Doe')).toBe('JohnDoe');
    expect(sanitizeUserName('jdoe')).toBe('jdoe');
    expect(sanitizeUserName('   ')).toBe('user');
    expect(sanitizeUserName('')).toBe('user');
  });
});

describe('shipped templates layout coupling (U29/F5)', () => {
  it('fails loudly when the shipped templates directory is missing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'weJobSearch-tmpl-'));
    try {
      expect(() => resolveShippedTemplatesRoot(dir)).toThrow(/Shipped templates root is missing/);
      await mkdir(join(dir, 'templates'), { recursive: true });
      expect(resolveShippedTemplatesRoot(dir)).toBe(join(dir, 'templates'));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('tilde expansion (U43)', () => {
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
  });

  it('resolveDataRoot expands a leading ~/ in CLI and env values', async () => {
    const { homedir } = await import('node:os');
    expect(resolveDataRoot('~/wejs-data')).toBe(join(homedir(), 'wejs-data'));
    process.env[envKey] = '~/wejs-env';
    expect(resolveDataRoot()).toBe(join(homedir(), 'wejs-env'));
  });
});

describe('canonicalDataRoot Phase D: containment and work-tree guards', () => {
  it('isContainedRelativePath rejects absolute remainders (Windows cross-drive relative)', async () => {
    const { isContainedRelativePath } = await import('./canonicalDataRoot');
    expect(isContainedRelativePath('')).toBe(true);
    expect(isContainedRelativePath(join('sub', 'file.txt'))).toBe(true);
    expect(isContainedRelativePath(join('..', 'outside.txt'))).toBe(false);
    expect(isContainedRelativePath('..')).toBe(false);
    // path.win32.relative('C:\\a', 'D:\\b') yields the absolute 'D:\\b' — the
    // old startsWith('..')-only check mistook it for inside. The drive-letter
    // check fails closed on every platform, not just win32 runtimes.
    const { win32 } = await import('node:path');
    const crossDriveRemainder = win32.relative('C:\\a', 'D:\\b');
    expect(win32.isAbsolute(crossDriveRemainder)).toBe(true);
    expect(isContainedRelativePath(crossDriveRemainder)).toBe(false);
    expect(isContainedRelativePath('/absolutely/elsewhere')).toBe(false);
  });

  it('assertDataRootOutsideWorkTree rejects a root inside the repo', async () => {
    const { assertDataRootOutsideWorkTree, repoRootFromModule } = await import('./canonicalDataRoot');
    const repoRoot = repoRootFromModule();
    expect(() => assertDataRootOutsideWorkTree(join(repoRoot, 'tmp-data'))).toThrow(
      /outside the git work tree/,
    );
    const outside = await mkdtemp(join(tmpdir(), 'weJobSearch-outside-'));
    try {
      expect(assertDataRootOutsideWorkTree(outside)).toBe(resolve(outside));
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('resolveDataRoot rejects an explicit --dataRoot inside the repo', async () => {
    const { repoRootFromModule } = await import('./canonicalDataRoot');
    expect(() => resolveDataRoot(join(repoRootFromModule(), 'tmp-data'))).toThrow(
      /outside the git work tree/,
    );
  });
});
