import { randomUUID } from 'node:crypto';
import { chmod, mkdir, open, rename, rm, stat } from 'node:fs/promises';
import { dirname } from 'node:path';

// Shared atomic-write primitive (Phase 7a seam): every persistence util
// previously duplicated this temp-file + rename pattern with its own local
// copy (jobFunnelTracker, searchCache, searchHistory, savedSearches,
// setupState) and the staged multi-file variant lived in two more places
// (profileService, initWizard). One owner now. Behavior across the five
// originals: create parent dirs, write to a uniquely-named temp file, rename
// over the target. Read-only enforcement stays with the callers
// (assertNotReadOnly) so guarded and unguarded writers keep their exact
// current behavior.
//
// Durability (Phase D): the temp file content is fsynced before the rename so
// a crash cannot leave a zero-length target, and the parent directory is
// fsynced after the rename so the rename itself survives a crash (directory
// fsync is best-effort: ignored where the OS does not support opening a
// directory for syncing). An existing target's file mode is preserved across
// the rename, so PII files written with restrictive bits (for example
// screeningAnswers.json at 0600) keep those bits after an atomic rewrite;
// brand-new files inherit the process default via the umask.
//
// Concurrency model (single process, per Section 0A — no file lock): a lock
// is over-engineering for a local CLI. Atomic temp-plus-rename already
// prevents corruption: concurrent writers use unique temp names, so one
// rename can never clobber another writer's temp content, and readers always
// observe either the old or the new target, never a half-written file.
// Last-writer-wins applies when two writers race the same target, and a
// read-modify-write cycle (read, mutate in memory, atomic rewrite) can lose
// a concurrent process's update. That is accepted: this engine runs as a
// single local process per invocation. The six read-modify-write stores that
// share this contract are jobFunnelTracker (applicationHistory.json),
// networkingContacts, savedSearches, searchHistory, searchCache, and the
// postingDeduplicator persist path (which writes through
// writeApplicationHistory).

export interface AtomicFileWrite {
  targetPath: string;
  content: string;
}

// Writes content to a uniquely-named temp file next to the target, fsyncs it,
// adopts the existing target's mode when one exists, and renames it over the
// target. A killed process may leave a `<target>.<uuid>.tmp` orphan behind;
// orphans are never read and are safe to delete, while the target itself is
// only ever replaced by a rename.
async function stageTempFile(targetPath: string, content: string): Promise<string> {
  await mkdir(dirname(targetPath), { recursive: true });
  // Unique staging name per write (B11): concurrent writers to the same
  // target must never share a temp file, or one rename can clobber the
  // other's content.
  const tempPath = `${targetPath}.${randomUUID()}.tmp`;
  const handle = await open(tempPath, 'w');
  try {
    await handle.writeFile(content, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await preserveExistingMode(targetPath, tempPath);
  return tempPath;
}

// Adopt the existing target's permission bits onto the staged temp file so an
// atomic rewrite never widens a restrictive mode (PII files keep 0600-style
// bits). A missing target (first write) keeps the process-default mode.
async function preserveExistingMode(targetPath: string, tempPath: string): Promise<void> {
  let existingMode: number;
  try {
    existingMode = (await stat(targetPath)).mode & 0o777;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return;
    }
    await rm(tempPath, { force: true });
    throw error;
  }
  await chmod(tempPath, existingMode);
}

// Best-effort parent-directory fsync so the rename entry itself is durable.
// Ignored where the OS refuses to sync a directory handle; the rename is
// still atomic without it.
async function fsyncParentDirectory(targetPath: string): Promise<void> {
  try {
    const handle = await open(dirname(targetPath), 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // Directory sync unsupported on this platform; rename atomicity holds.
  }
}

export async function writeFileAtomically(targetPath: string, content: string): Promise<void> {
  const tempPath = await stageTempFile(targetPath, content);
  await rename(tempPath, targetPath);
  await fsyncParentDirectory(targetPath);
}

// Staged multi-file variant: every temp file is written first, then all are
// renamed into place. On any failure, staged temps are removed and no target
// is left half-written. Matches the original profileService/initWizard
// semantics exactly.
export async function writeFilesAtomically(writes: readonly AtomicFileWrite[]): Promise<void> {
  const staged: { tempPath: string; targetPath: string }[] = [];
  try {
    for (const write of writes) {
      const tempPath = await stageTempFile(write.targetPath, write.content);
      staged.push({ tempPath, targetPath: write.targetPath });
    }
    for (const stagedWrite of staged) {
      await rename(stagedWrite.tempPath, stagedWrite.targetPath);
    }
    for (const stagedWrite of staged) {
      await fsyncParentDirectory(stagedWrite.targetPath);
    }
  } catch (error) {
    for (const stagedWrite of staged) {
      await rm(stagedWrite.tempPath, { force: true });
    }
    throw error;
  }
}
