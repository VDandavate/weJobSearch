import { chmod, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { writeFileAtomically, writeFilesAtomically } from './atomicWrite';

describe('writeFileAtomically', () => {
  it('writes content to the target and creates missing parent dirs', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'weJobSearch-atomic-'));
    try {
      const target = join(dir, 'nested', 'output.json');
      await writeFileAtomically(target, '{"ok":true}\n');
      expect(await readFile(target, 'utf8')).toBe('{"ok":true}\n');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('overwrites an existing target and leaves no temp file behind', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'weJobSearch-atomic-'));
    try {
      const target = join(dir, 'output.json');
      await writeFileAtomically(target, 'first\n');
      await writeFileAtomically(target, 'second\n');
      expect(await readFile(target, 'utf8')).toBe('second\n');
      const leftovers = (await readdir(dir)).filter((name) => name.endsWith('.tmp'));
      expect(leftovers).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('does not clobber concurrent writes to the same target', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'weJobSearch-atomic-'));
    try {
      const target = join(dir, 'output.json');
      const bodies = Array.from({ length: 8 }, (unusedElement, index) => `body-${index}\n`);
      await Promise.all(bodies.map((body) => writeFileAtomically(target, body)));
      const final = await readFile(target, 'utf8');
      expect(bodies).toContain(final);
      expect(final.endsWith('\n')).toBe(true);
      const leftovers = (await readdir(dir)).filter((name) => name.endsWith('.tmp'));
      expect(leftovers).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('preserves restrictive file mode across a rewrite (PII files keep 0600-style bits)', async () => {
    // Phase D: an atomic rewrite must not widen the mode of an existing
    // target — screeningAnswers-style restrictive bits survive the rename.
    const dir = await mkdtemp(join(tmpdir(), 'weJobSearch-atomic-'));
    try {
      const target = join(dir, 'screening.json');
      await writeFileAtomically(target, 'first\n');
      await chmod(target, 0o600);
      await writeFileAtomically(target, 'second\n');
      expect(await readFile(target, 'utf8')).toBe('second\n');
      expect((await stat(target)).mode & 0o777).toBe(0o600);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('writeFilesAtomically', () => {
  it('stages every file before renaming any into place', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'weJobSearch-atomic-'));
    try {
      await writeFilesAtomically([
        { targetPath: join(dir, 'first.txt'), content: 'one\n' },
        { targetPath: join(dir, 'second.txt'), content: 'two\n' },
      ]);
      expect(await readFile(join(dir, 'first.txt'), 'utf8')).toBe('one\n');
      expect(await readFile(join(dir, 'second.txt'), 'utf8')).toBe('two\n');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('writes nothing observable when a later write fails', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'weJobSearch-atomic-'));
    try {
      // A regular file where a directory is expected: mkdir fails with
      // ENOTDIR on the second write, so the staged first write must roll back.
      const blocker = join(dir, 'blocker.txt');
      await writeFileAtomically(blocker, 'blocker\n');
      await expect(
        writeFilesAtomically([
          { targetPath: join(dir, 'good.txt'), content: 'good\n' },
          { targetPath: join(blocker, 'child.txt'), content: 'bad\n' },
        ]),
      ).rejects.toThrow();
      await expect(readFile(join(dir, 'good.txt'), 'utf8')).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
