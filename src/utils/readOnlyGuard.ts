import { join, relative, resolve } from 'node:path';
import { documentsDirectoryName, redactHomePrefix, resolveDataRoot } from './canonicalDataRoot';

// Structural read-only enforcement (EUO-09, G3). Read-only is an enforced
// invariant, not a convention: every write path in the engine calls
// assertNotReadOnly before touching the filesystem, and the user's source
// document directory (the canonical documents/ dir) is registered read-only
// by default. Generated output (applications/, previews/, history, profile
// files) lives outside that directory, so normal operation is unaffected; a
// write that resolves inside a read-only directory fails loudly instead of
// silently mutating source documents.

// The registered-by-default read-only source directory: the documents/ dir
// under the EFFECTIVE data root (resolveDataRoot: CLI --dataRoot flag, then
// WEJOBSEARCHDATAROOT, then the canonical default). Deriving from the
// effective root — not the canonical default — keeps the guard correct under
// --dataRoot/WEJOBSEARCHDATAROOT relocation: the relocated <root>/documents/
// is guarded while the abandoned canonical dir is not. There is no separate
// user-source-dir config; this is the default source location (EUO-04).
export function defaultReadOnlyDirectories(): string[] {
  return [join(resolveDataRoot(), documentsDirectoryName)];
}

// Throws when targetPath resolves inside any registered read-only directory;
// returns silently otherwise. Both the target and each read-only dir are
// resolved (absolute + `..`-normalized) before the containment check, so
// traversal segments cannot bypass the guard: a target like
// <readOnlyDir>/sub/../../<readOnlyDir>/file.txt still resolves inside and
// throws, while a target that genuinely resolves outside passes.
export function assertNotReadOnly(
  targetPath: string,
  readOnlyDirs: readonly string[] = defaultReadOnlyDirectories(),
): void {
  const resolvedTarget = resolve(targetPath);
  for (const dir of readOnlyDirs) {
    const resolvedDir = resolve(dir);
    const rel = relative(resolvedDir, resolvedTarget);
    if (rel.length === 0 || !rel.startsWith('..')) {
      throw new Error(
        `Refusing to write '${redactHomePrefix(targetPath)}': it resolves inside the read-only source directory '${redactHomePrefix(dir)}'. ` +
          'Source documents are read-only; generated output must be written elsewhere.',
      );
    }
  }
}