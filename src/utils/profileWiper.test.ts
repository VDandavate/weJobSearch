import { chmod, mkdir, mkdtemp, readdir, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { list } from 'tar';
import { describe, expect, it } from 'vitest';
import { inventoryDataRoot, wipeDataRoot } from './profileWiper';

// Synthetic temp roots only: nothing here touches profile/ or a real
// canonical data root.

async function makePopulatedRoot(): Promise<{ parent: string; root: string }> {
  const parent = await mkdtemp(join(tmpdir(), 'weJobSearch-wipe-'));
  const root = join(parent, 'syntheticUser');
  await mkdir(join(root, 'applications', 'samplecorpDataEngineer'), { recursive: true });
  await writeFile(join(root, 'masterProfile.md'), 'synthetic profile\n');
  await writeFile(join(root, 'applications', 'applicationHistory.json'), '{ "applications": [] }\n');
  await writeFile(join(root, 'applications', 'samplecorpDataEngineer', 'coverLetter.md'), 'synthetic\n');
  return { parent, root };
}

async function archiveEntryNames(archivePath: string): Promise<string[]> {
  const names: string[] = [];
  await list({
    file: archivePath,
    onentry: (entry) => {
      names.push(entry.path.replace(/^\.\//, ''));
    },
  });
  return names;
}

describe('inventoryDataRoot', () => {
  it('counts files, directories and bytes without deleting anything', async () => {
    const { root } = await makePopulatedRoot();
    const inventory = await inventoryDataRoot(root);
    expect(inventory).not.toBeNull();
    expect(inventory?.fileCount).toBe(3);
    expect(inventory?.dirCount).toBe(2);
    expect(inventory?.totalBytes).toBeGreaterThan(0);
    expect(existsSync(root)).toBe(true);
  });

  it('returns null for a missing root', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'weJobSearch-wipe-'));
    expect(await inventoryDataRoot(join(parent, 'absent'))).toBeNull();
  });
});

describe('wipeDataRoot', () => {
  it('backs up the root and then deletes it', async () => {
    const { parent, root } = await makePopulatedRoot();
    const result = await wipeDataRoot({
      rootPath: root,
      now: new Date(2026, 0, 2, 3, 4, 5),
    });

    expect(result.wiped).toBe(true);
    expect(result.inventory.fileCount).toBe(3);
    expect(result.backupPath).toBe(join(parent, 'syntheticUser-backup-20260102-030405.tar.gz'));
    await expect(stat(root)).rejects.toThrow();
    expect(existsSync(result.backupPath ?? '')).toBe(true);

    const entries = await archiveEntryNames(result.backupPath ?? '');
    expect(entries).toContain('masterProfile.md');
    expect(entries).toContain('applications/applicationHistory.json');
    expect(entries).toContain('applications/samplecorpDataEngineer/coverLetter.md');
  });

  it('skips the archive when noBackup is true', async () => {
    const { parent, root } = await makePopulatedRoot();
    const result = await wipeDataRoot({ rootPath: root, noBackup: true });

    expect(result.wiped).toBe(true);
    expect(result.backupPath).toBeNull();
    await expect(stat(root)).rejects.toThrow();
    const siblings = await readdir(parent);
    expect(siblings.filter((name) => name.includes('-backup-'))).toEqual([]);
  });

  it('is a clean no-op for a missing root', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'weJobSearch-wipe-'));
    const result = await wipeDataRoot({ rootPath: join(parent, 'absent') });

    expect(result.wiped).toBe(false);
    expect(result.backupPath).toBeNull();
    expect(result.inventory).toEqual({ fileCount: 0, dirCount: 0, totalBytes: 0 });
  });

  it('aborts without deleting when the backup cannot be written', async () => {
    const { parent, root } = await makePopulatedRoot();
    // A read-only parent makes the archive write fail. Tests never run as
    // root here; if they ever do, this test is a no-op pass rather than a
    // false failure, and the abort path is still covered by the CLI/MCP tests.
    await chmod(parent, 0o500);
    try {
      await expect(wipeDataRoot({ rootPath: root })).rejects.toThrow();
      expect(existsSync(root)).toBe(true);
    } finally {
      await chmod(parent, 0o700);
    }
  });
});
