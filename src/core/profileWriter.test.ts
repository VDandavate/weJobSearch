import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { writeProfileFilesAtomically } from './profileWriter';

describe('writeProfileFilesAtomically', () => {
  it('writes every profile file without the guard (initWizard path)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'weJobSearch-profile-'));
    try {
      await writeProfileFilesAtomically([
        { targetPath: join(dir, 'masterProfile.md'), content: '# Profile\n' },
        { targetPath: join(dir, 'jobPreferences.yaml'), content: 'currency: USD\n' },
      ]);
      expect(await readFile(join(dir, 'masterProfile.md'), 'utf8')).toBe('# Profile\n');
      expect(await readFile(join(dir, 'jobPreferences.yaml'), 'utf8')).toBe('currency: USD\n');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('writes every profile file with the guard (profileService path)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'weJobSearch-profile-'));
    try {
      await writeProfileFilesAtomically(
        [{ targetPath: join(dir, 'screeningAnswers.json'), content: '{}\n' }],
        { enforceReadOnlyGuard: true },
      );
      expect(await readFile(join(dir, 'screeningAnswers.json'), 'utf8')).toBe('{}\n');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('refuses guarded writes inside a read-only directory and writes nothing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'weJobSearch-profile-'));
    try {
      const readOnlyDir = join(dir, 'sources');
      const target = join(readOnlyDir, 'masterProfile.md');
      await expect(
        writeProfileFilesAtomically([{ targetPath: target, content: '# Profile\n' }], {
          enforceReadOnlyGuard: true,
          readOnlyDirs: [readOnlyDir],
        }),
      ).rejects.toThrow('read-only');
      await expect(readFile(target, 'utf8')).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
