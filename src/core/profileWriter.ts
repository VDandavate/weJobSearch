import { writeFilesAtomically, type AtomicFileWrite } from '../utils/atomicWrite';
import { assertNotReadOnly, defaultReadOnlyDirectories } from '../utils/readOnlyGuard';

// Single profile writer (Phase 7a seam): profileService and initWizard both
// wrote the same four canonical profile files through separate atomic
// writers plus separate yaml/json builders. This module owns the write seam;
// both entry points delegate here with zero behavior change.
//
// Guard behavior is preserved per caller via enforceReadOnlyGuard:
// profileService always guarded its writes, initWizard never did, so each
// passes the flag matching its original path.

export interface ProfileFileWrite extends AtomicFileWrite {}

export interface ProfileWriterOptions {
  enforceReadOnlyGuard?: boolean;
  readOnlyDirs?: readonly string[];
}

export async function writeProfileFilesAtomically(
  writes: readonly ProfileFileWrite[],
  options: ProfileWriterOptions = {},
): Promise<void> {
  if (options.enforceReadOnlyGuard === true) {
    for (const write of writes) {
      assertNotReadOnly(write.targetPath, options.readOnlyDirs ?? defaultReadOnlyDirectories());
    }
  }
  await writeFilesAtomically(writes);
}
