import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assertNotReadOnly, defaultReadOnlyDirectories } from './readOnlyGuard';

// EUO-09: structural read-only enforcement. Read-only must be an enforced
// invariant, not a convention: a write target that resolves inside a
// registered read-only directory throws, and `..` segments cannot bypass the
// containment check. All tests use OS temp dirs only — never the canonical
// data root or any real profile file.

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'weJobSearch-readOnly-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function expectThrowsNamingTarget(target: string, readOnlyDir: string): void {
  try {
    assertNotReadOnly(target, [readOnlyDir]);
    expect.unreachable(`expected assertNotReadOnly to throw for '${target}'`);
  } catch (error) {
    const message = (error as Error).message;
    expect(message).toContain(target);
    expect(message).toContain(readOnlyDir);
  }
}

describe('assertNotReadOnly', () => {
  it('throws when the write target is inside a read-only directory', async () => {
    await withTempDir(async (readOnlyDir) => {
      expectThrowsNamingTarget(join(readOnlyDir, 'file.txt'), readOnlyDir);
      expectThrowsNamingTarget(join(readOnlyDir, 'sub', 'nested.txt'), readOnlyDir);
    });
  });

  it('throws when the write target equals the read-only directory itself', async () => {
    await withTempDir(async (readOnlyDir) => {
      expectThrowsNamingTarget(readOnlyDir, readOnlyDir);
    });
  });

  it('passes when the write target is outside the read-only directory', async () => {
    await withTempDir(async (readOnlyDir) => {
      await withTempDir(async (writableDir) => {
        expect(() => assertNotReadOnly(join(writableDir, 'file.txt'), [readOnlyDir])).not.toThrow();
      });
    });
  });

  it('passes when no read-only directories are registered', async () => {
    await withTempDir(async (dir) => {
      expect(() => assertNotReadOnly(join(dir, 'file.txt'), [])).not.toThrow();
    });
  });

  it('path traversal cannot escape the guard: a target resolving inside via .. still throws', async () => {
    await withTempDir(async (readOnlyDir) => {
      // sub/../file.txt resolves back into the read-only directory.
      expectThrowsNamingTarget(join(readOnlyDir, 'sub', '..', 'file.txt'), readOnlyDir);
      // A round-trip through the parent that lands back inside still throws.
      const roundTrip = join(readOnlyDir, '..', basename(readOnlyDir), 'file.txt');
      expectThrowsNamingTarget(roundTrip, readOnlyDir);
    });
  });

  it('path traversal: a target that genuinely resolves outside passes', async () => {
    await withTempDir(async (readOnlyDir) => {
      // sub/../../file.txt resolves to the parent of the read-only directory.
      const outside = join(readOnlyDir, 'sub', '..', '..', 'file.txt');
      expect(() => assertNotReadOnly(outside, [readOnlyDir])).not.toThrow();
    });
  });

  it('defaults to the canonical documents directory', () => {
    const dirs = defaultReadOnlyDirectories();
    expect(dirs).toHaveLength(1);
    expect(dirs[0]).toContain('documents');
  });

  it('the default registration does not block temp-dir writes', async () => {
    await withTempDir(async (dir) => {
      expect(() => assertNotReadOnly(join(dir, 'file.txt'))).not.toThrow();
    });
  });
});

// B5 regression: the default read-only registration must derive from the
// EFFECTIVE data root (resolveDataRoot: CLI flag > WEJOBSEARCHDATAROOT >
// canonical default), not the canonical default. Under --dataRoot/relocation
// the relocated <root>/documents/ must be guarded while the abandoned
// canonical dir is not.
describe('defaultReadOnlyDirectories under data-root relocation (B5)', () => {
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

  it('guards the relocated documents dir, not the canonical default', async () => {
    await withTempDir(async (envDir) => {
      process.env[envKey] = envDir;
      const dirs = defaultReadOnlyDirectories();
      expect(dirs).toEqual([join(envDir, 'documents')]);
      // A write inside the relocated documents/ dir throws.
      expect(() => assertNotReadOnly(join(envDir, 'documents', 'f.txt'))).toThrow(
        /read-only source directory/,
      );
      // A write outside the relocated root passes.
      await withTempDir(async (writableDir) => {
        expect(() => assertNotReadOnly(join(writableDir, 'f.txt'))).not.toThrow();
      });
    });
  });
});