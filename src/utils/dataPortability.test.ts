import { lstat, mkdir, mkdtemp, readFile, readlink, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { create } from 'tar';
import { describe, expect, it } from 'vitest';
import { exportDataRoot, importDataRoot } from './dataPortability';

// EUO-10: canonical-root export/import. Every test runs in OS temp dirs only
// (N10) - the real canonical data root (~/Documents/weJobSearch/<user>/) and
// the git work tree are never touched. Synthetic data only.

// Files that must round-trip: the real profile files, the networking contacts,
// and the application history (the seed used by every test here).
const profileFiles: readonly string[] = [
  'masterProfile.md',
  'jobPreferences.yaml',
  'screeningAnswers.json',
  'networkingContacts.json',
];
const historyFiles: readonly string[] = [join('applications', 'applicationHistory.json')];
const roundTripFiles: readonly string[] = [...profileFiles, ...historyFiles];

function tarHeaderBlock(entryName: string, typeflag: string, linkTarget: string): Buffer {
  const header = Buffer.alloc(512, 0);
  header.write(entryName, 0, 100, 'utf8');
  header.write('0000644\0', 100, 8, 'ascii');
  header.write('0000000\0', 108, 8, 'ascii');
  header.write('0000000\0', 116, 8, 'ascii');
  header.write('00000000000\0', 124, 12, 'ascii');
  header.write('00000000000\0', 136, 12, 'ascii');
  header.write('        ', 148, 8, 'ascii');
  header.write(typeflag, 156, 1, 'ascii');
  header.write(linkTarget, 157, 100, 'utf8');
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');

  let checksum = 0;
  for (const byte of header) {
    checksum += byte;
  }
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  return header;
}

function hardlinkArchiveBytes(entryName: string, linkTarget: string): Buffer {
  return Buffer.concat([tarHeaderBlock(entryName, '1', linkTarget), Buffer.alloc(1024, 0)]);
}

async function seedCanonicalRoot(rootPath: string): Promise<void> {
  await mkdir(join(rootPath, 'applications'), { recursive: true });
  await mkdir(join(rootPath, 'documents'), { recursive: true });
  await writeFile(join(rootPath, 'masterProfile.md'), '# Jane Sample\n\nSenior software engineer.\n', 'utf8');
  await writeFile(
    join(rootPath, 'jobPreferences.yaml'),
    [
      'compensation:',
      '  currency: USD',
      '  minAcceptableBase: 150000',
      '  targetBase: 180000',
      '  countsBonusTowardMin: false',
      '  countsEquityTowardMin: false',
      'clearance:',
      '  currentStatus: none',
      '  currentLevel: null',
      '  eligibleToObtain: true',
      '  requiresSponsorshipForVisa: false',
      'nonNegotiables: []',
      'preferredLocations: []',
      '',
    ].join('\n'),
    'utf8',
  );
  await writeFile(
    join(rootPath, 'screeningAnswers.json'),
    JSON.stringify({ workAuthorization: { usCitizen: false, requiresSponsorship: true } }, null, 2),
    'utf8',
  );
  await writeFile(
    join(rootPath, 'networkingContacts.json'),
    JSON.stringify(
      {
        contacts: [
          {
            contactId: 'contact001',
            name: 'Jane Sample',
            company: 'SampleCorp',
            relationship: 'formerColleague',
            lastContactDate: '2026-07-15',
            linkedApplicationIds: ['app2026SampleCorpStrongEngineer'],
            followUpDue: '2026-08-20',
          },
        ],
      },
      null,
      2,
    ),
    'utf8',
  );
  await writeFile(
    join(rootPath, 'applications', 'applicationHistory.json'),
    JSON.stringify(
      {
        applications: [
          {
            applicationId: 'app2026SampleCorpStrongEngineer',
            companyName: 'SampleCorp',
            roleTitle: 'Strong Engineer',
            jobUrl: 'https://example.com/jobs/strong',
            postingHash: 'syntheticHashForPortabilitySeed',
            sourceAggregators: ['stubAlpha'],
            fitScore: 4.2,
            fitStatus: 'strongFit',
            status: 'evaluated',
            statusHistory: [{ stage: 'evaluated', timestamp: '2026-08-08T10:00:00Z' }],
          },
        ],
      },
      null,
      2,
    ),
    'utf8',
  );
  await writeFile(join(rootPath, 'documents', 'resume.md'), 'Synthetic resume body.\n', 'utf8');
}

async function withTempDirs<T>(fn: (dirs: string[]) => Promise<T>, count = 3): Promise<T> {
  const dirs: string[] = [];
  for (let index = 0; index < count; index += 1) {
    dirs.push(await mkdtemp(join(tmpdir(), `weJobSearch-portability-${index}-`)));
  }
  try {
    return await fn(dirs);
  } finally {
    for (const dir of dirs) {
      await rm(dir, { recursive: true, force: true });
    }
  }
}

describe('exportDataRoot', () => {
  it('tarballs the canonical root into archivePath as a gzip archive with entries', async () => {
    await withTempDirs(async ([rootDir, backupDir]) => {
      const rootPath = join(rootDir, 'dataRoot');
      await seedCanonicalRoot(rootPath);
      const archivePath = join(backupDir, 'weJobSearch-backup.tar.gz');

      const result = await exportDataRoot({ rootPath, archivePath });

      expect(result.archivePath).toBe(archivePath);
      expect(result.sourceRoot).toBe(rootPath);
      expect(result.entryCount).toBeGreaterThan(0);
      expect(result.byteCount).toBeGreaterThan(0);
      const archiveStat = await stat(archivePath);
      expect(archiveStat.isFile()).toBe(true);
      // gzip magic bytes (1f 8b) prove the archive is a real gzip tarball.
      const header = await readFile(archivePath);
      expect(header[0]).toBe(0x1f);
      expect(header[1]).toBe(0x8b);
    });
  });

  it('errors clearly when the source root does not exist', async () => {
    await withTempDirs(async ([rootDir, backupDir]) => {
      await expect(
        exportDataRoot({ rootPath: join(rootDir, 'missing'), archivePath: join(backupDir, 'x.tar.gz') }),
      ).rejects.toThrow(/not a directory/);
    });
  });

  it('refuses to write the archive inside the root being archived (self-capture guard)', async () => {
    await withTempDirs(async ([rootDir]) => {
      const rootPath = join(rootDir, 'dataRoot');
      await seedCanonicalRoot(rootPath);
      await expect(
        exportDataRoot({ rootPath, archivePath: join(rootPath, 'backup.tar.gz') }),
      ).rejects.toThrow(/inside the data root/);
    });
  });
});

describe('importDataRoot', () => {
  it('round-trips profile, history, and contacts byte-identically into a fresh root', async () => {
    await withTempDirs(async ([rootDir, backupDir, restoreDir]) => {
      const sourceRoot = join(rootDir, 'source');
      await seedCanonicalRoot(sourceRoot);
      const archivePath = join(backupDir, 'weJobSearch-backup.tar.gz');
      await exportDataRoot({ rootPath: sourceRoot, archivePath });

      const targetRoot = join(restoreDir, 'restored');
      const result = await importDataRoot({ archivePath, rootPath: targetRoot });

      expect(result.rootPath).toBe(targetRoot);
      expect(result.entryCount).toBeGreaterThan(0);
      for (const relativePath of roundTripFiles) {
        expect(await readFile(join(targetRoot, relativePath), 'utf8')).toBe(
          await readFile(join(sourceRoot, relativePath), 'utf8'),
        );
      }
      // The whole tree is restored, including subdirectories beyond the four
      // guarded profile files (documents/ belongs to the canonical root too).
      expect(await readFile(join(targetRoot, 'documents', 'resume.md'), 'utf8')).toBe('Synthetic resume body.\n');
      expect(result.restoredFiles.length).toBeGreaterThan(0);
    });
  });

  it('refuses to overwrite an existing profile file and names the blocking file', async () => {
    await withTempDirs(async ([rootDir, backupDir, restoreDir]) => {
      const sourceRoot = join(rootDir, 'source');
      await seedCanonicalRoot(sourceRoot);
      const archivePath = join(backupDir, 'weJobSearch-backup.tar.gz');
      await exportDataRoot({ rootPath: sourceRoot, archivePath });

      const targetRoot = join(restoreDir, 'restored');
      await mkdir(targetRoot, { recursive: true });
      const existing = 'pre-existing real profile content';
      await writeFile(join(targetRoot, 'masterProfile.md'), existing, 'utf8');

      await expect(importDataRoot({ archivePath, rootPath: targetRoot })).rejects.toThrow(/masterProfile\.md/);
      // The blocker is untouched - no-overwrite is absolute.
      expect(await readFile(join(targetRoot, 'masterProfile.md'), 'utf8')).toBe(existing);
    });
  });

  it('names every profile file that blocks an import, not just the first', async () => {
    await withTempDirs(async ([rootDir, backupDir, restoreDir]) => {
      const sourceRoot = join(rootDir, 'source');
      await seedCanonicalRoot(sourceRoot);
      const archivePath = join(backupDir, 'weJobSearch-backup.tar.gz');
      await exportDataRoot({ rootPath: sourceRoot, archivePath });

      const targetRoot = join(restoreDir, 'restored');
      await mkdir(targetRoot, { recursive: true });
      for (const relativePath of profileFiles) {
        await writeFile(join(targetRoot, relativePath), 'existing', 'utf8');
      }

      await expect(importDataRoot({ archivePath, rootPath: targetRoot })).rejects.toThrow(
        /masterProfile\.md, jobPreferences\.yaml, screeningAnswers\.json, networkingContacts\.json/,
      );
    });
  });

  it('errors clearly when the archive does not exist', async () => {
    await withTempDirs(async ([rootDir]) => {
      await expect(
        importDataRoot({ archivePath: join(rootDir, 'missing.tar.gz'), rootPath: join(rootDir, 'restored') }),
      ).rejects.toThrow(/not found/);
    });
  });

  it('refuses an archive with an absolute-path entry before writing anything (tar-slip guard)', async () => {
    await withTempDirs(async ([rootDir, backupDir, restoreDir]) => {
      const payloadDir = join(rootDir, 'payload');
      await mkdir(payloadDir, { recursive: true });
      await writeFile(join(payloadDir, 'evil.txt'), 'evil', 'utf8');
      const archivePath = join(backupDir, 'slip.tar.gz');
      await create(
        { gzip: true, file: archivePath, cwd: payloadDir, preservePaths: true },
        [join(payloadDir, 'evil.txt')],
      );

      const targetRoot = join(restoreDir, 'restored');
      await expect(importDataRoot({ archivePath, rootPath: targetRoot })).rejects.toThrow(
        /escapes the destination root/,
      );
      // Nothing was written: the guard fires before extraction.
      expect(await stat(targetRoot).catch(() => null)).toBeNull();
    });
  });

  it('refuses an archive with a parent-traversal entry (tar-slip guard)', async () => {
    await withTempDirs(async ([rootDir, backupDir, restoreDir]) => {
      const payloadDir = join(rootDir, 'payload');
      const subDir = join(payloadDir, 'sub');
      await mkdir(subDir, { recursive: true });
      await writeFile(join(payloadDir, 'outside.txt'), 'outside', 'utf8');
      const archivePath = join(backupDir, 'slip2.tar.gz');
      await create(
        { gzip: true, file: archivePath, cwd: subDir, preservePaths: true },
        ['../outside.txt'],
      );

      await expect(
        importDataRoot({ archivePath, rootPath: join(restoreDir, 'restored') }),
      ).rejects.toThrow(/escapes the destination root/);
    });
  });

  it('refuses an archive with an escaping symlink target before writing anything (tar-slip guard)', async () => {
    await withTempDirs(async ([rootDir, backupDir, restoreDir]) => {
      const payloadDir = join(rootDir, 'payload');
      await mkdir(payloadDir, { recursive: true });
      await writeFile(join(payloadDir, 'outside.txt'), 'outside', 'utf8');
      await symlink(join('..', '..', 'outside.txt'), join(payloadDir, 'evil-link'));
      const archivePath = join(backupDir, 'symlink-slip.tar.gz');
      await create(
        { gzip: true, file: archivePath, cwd: payloadDir, preservePaths: true },
        ['evil-link'],
      );

      const targetRoot = join(restoreDir, 'restored');
      await expect(importDataRoot({ archivePath, rootPath: targetRoot })).rejects.toThrow(
        /escapes the destination root/,
      );
      // Nothing was written: the guard fires before extraction.
      expect(await stat(targetRoot).catch(() => null)).toBeNull();
    });
  });

  it('refuses an archive with an escaping hardlink target before writing anything (tar-slip guard)', async () => {
    await withTempDirs(async ([rootDir, backupDir, restoreDir]) => {
      const archivePath = join(backupDir, 'hardlink-slip.tar');
      await writeFile(
        archivePath,
        hardlinkArchiveBytes('evil-hard', join('..', '..', 'outside.txt')),
      );

      const targetRoot = join(restoreDir, 'restored');
      await expect(importDataRoot({ archivePath, rootPath: targetRoot })).rejects.toThrow(
        /escapes the destination root/,
      );
      // Nothing was written: the guard fires before extraction.
      expect(await stat(targetRoot).catch(() => null)).toBeNull();
    });
  });

  it('imports an in-root symlink when its target stays inside the destination root', async () => {
    await withTempDirs(async ([rootDir, backupDir, restoreDir]) => {
      const payloadDir = join(rootDir, 'payload');
      const subDir = join(payloadDir, 'sub');
      const siblingDir = join(payloadDir, 'sibling');
      await mkdir(subDir, { recursive: true });
      await mkdir(siblingDir, { recursive: true });
      await writeFile(join(siblingDir, 'file'), 'sibling file\n', 'utf8');
      await symlink(join('sibling', 'file'), join(subDir, 'link'));
      const archivePath = join(backupDir, 'in-root-symlink.tar.gz');
      await create(
        { gzip: true, file: archivePath, cwd: payloadDir, preservePaths: true },
        [join('sibling', 'file'), join('sub', 'link')],
      );

      const targetRoot = join(restoreDir, 'restored');
      const result = await importDataRoot({ archivePath, rootPath: targetRoot });

      expect(result.rootPath).toBe(targetRoot);
      expect(await readFile(join(targetRoot, 'sibling', 'file'), 'utf8')).toBe('sibling file\n');
      expect((await lstat(join(targetRoot, 'sub', 'link'))).isSymbolicLink()).toBe(true);
      expect(await readlink(join(targetRoot, 'sub', 'link'))).toBe(join('sibling', 'file'));
    });
  });

  it('refuses an archive whose restored history fails schema validation', async () => {
    await withTempDirs(async ([rootDir, backupDir, restoreDir]) => {
      const sourceRoot = join(rootDir, 'source');
      await seedCanonicalRoot(sourceRoot);
      await writeFile(
        join(sourceRoot, 'applications', 'applicationHistory.json'),
        JSON.stringify({ applications: [{ nope: true }] }),
        'utf8',
      );
      const archivePath = join(backupDir, 'bad-history.tar.gz');
      await exportDataRoot({ rootPath: sourceRoot, archivePath });

      await expect(
        importDataRoot({ archivePath, rootPath: join(restoreDir, 'restored') }),
      ).rejects.toThrow(/fails schema validation/);
    });
  });

  it('refuses malformed job preferences before touching the destination', async () => {
    await withTempDirs(async ([rootDir, backupDir, restoreDir]) => {
      const sourceRoot = join(rootDir, 'source');
      await seedCanonicalRoot(sourceRoot);
      // Valid YAML, invalid preferences schema: the old mapping-only check
      // accepted this and the failure surfaced on the next command instead.
      await writeFile(
        join(sourceRoot, 'jobPreferences.yaml'),
        'compensation:\n  currency: USD\n  minAcceptableBase: lots\n',
        'utf8',
      );
      const archivePath = join(backupDir, 'bad-preferences.tar.gz');
      await exportDataRoot({ rootPath: sourceRoot, archivePath });

      const targetRoot = join(restoreDir, 'restored');
      await expect(importDataRoot({ archivePath, rootPath: targetRoot })).rejects.toThrow(
        /jobPreferences\.yaml.*schema validation/i,
      );
      // The destination was never created: validation runs before extraction.
      expect(await stat(targetRoot).catch(() => null)).toBeNull();
    });
  });

  it('stays byte-identical across a second export/import cycle (stable round-trip)', async () => {
    await withTempDirs(
      async ([rootDir, firstBackupDir, firstRestoreDir, secondBackupDir, secondRestoreDir]) => {
        const sourceRoot = join(rootDir, 'source');
        await seedCanonicalRoot(sourceRoot);
        const firstArchive = join(firstBackupDir, 'first.tar.gz');
        await exportDataRoot({ rootPath: sourceRoot, archivePath: firstArchive });

        const firstRestored = join(firstRestoreDir, 'restored');
        await importDataRoot({ archivePath: firstArchive, rootPath: firstRestored });

        const secondArchive = join(secondBackupDir, 'second.tar.gz');
        await exportDataRoot({ rootPath: firstRestored, archivePath: secondArchive });
        const secondRestored = join(secondRestoreDir, 'restored');
        await importDataRoot({ archivePath: secondArchive, rootPath: secondRestored });

        for (const relativePath of roundTripFiles) {
          expect(await readFile(join(secondRestored, relativePath), 'utf8')).toBe(
            await readFile(join(sourceRoot, relativePath), 'utf8'),
          );
        }
      },
      5,
    );
  });
});
