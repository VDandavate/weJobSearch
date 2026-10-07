import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { assertConfinedToRoot, redactHomePrefix, resolveDataRoot } from './canonicalDataRoot';
import { assertNotReadOnly } from './readOnlyGuard';
import { writeFileAtomically } from './atomicWrite';

// Shared JSON-store helpers (Phase F): the five persistence modules
// (jobFunnelTracker, networkingContacts, savedSearches, searchHistory,
// searchCache) carried copy-pasted filepath fallback ternaries plus
// validate-before-write read/write sequences. One helper owns the shape;
// each module parameterizes only its default file name, schema, empty
// default, store noun (for error text), and confinement labels, so every
// persisted error message is unchanged.

// First non-blank root wins; blank/whitespace-only values count as unset and
// fall back to the effective data root.
export function resolveStoreRoot(rootDir: string | null | undefined): string {
  return rootDir !== undefined && rootDir !== null && rootDir.trim().length > 0
    ? rootDir
    : resolveDataRoot();
}

// First non-blank file path wins; blank/whitespace-only values count as unset
// and fall back to the caller-computed default path.
export function resolveStoreFilePath(
  filePath: string | null | undefined,
  defaultPath: string,
): string {
  return filePath !== undefined && filePath !== null && filePath.trim().length > 0
    ? filePath
    : defaultPath;
}

export interface JsonStoreReadOptions<T> {
  resolvedPath: string;
  root: string;
  label: string;
  noun: string;
  schema: z.ZodType<T>;
  missing: () => T;
}

// Confined, schema-validated read: missing file yields the module's empty
// default, malformed content surfaces a "Malformed <noun>" error, and any
// other read failure rethrows untouched.
export async function readJsonStoreFile<T>(options: JsonStoreReadOptions<T>): Promise<T> {
  assertConfinedToRoot(options.root, options.resolvedPath, options.label);
  let raw: string;
  try {
    raw = await readFile(options.resolvedPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return options.missing();
    }
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `Malformed ${options.noun} at ${redactHomePrefix(options.resolvedPath)}: not valid JSON (${(error as Error).message})`,
    );
  }
  const result = options.schema.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `Malformed ${options.noun} at ${redactHomePrefix(options.resolvedPath)}: ${result.error.message}`,
    );
  }
  return result.data;
}

export interface JsonStoreWriteOptions<T> {
  data: T;
  resolvedPath: string;
  noun: string;
  schema: z.ZodType<T>;
  verifyExisting: () => Promise<unknown>;
  confine?: { root: string; label: string };
}

// Validate-before-write sequence: refuse to overwrite a malformed existing
// file (via the module's own read), refuse structurally invalid content, then
// write atomically (temp file + rename). Modules that confined on write keep
// their label; modules whose private writer relied on already-resolved paths
// pass no confine step, exactly as before.
export async function writeJsonStoreFile<T>(options: JsonStoreWriteOptions<T>): Promise<void> {
  if (options.confine !== undefined) {
    assertConfinedToRoot(options.confine.root, options.resolvedPath, options.confine.label);
  }
  await options.verifyExisting();
  const result = options.schema.safeParse(options.data);
  if (!result.success) {
    throw new Error(
      `Refusing to write invalid ${options.noun} to ${redactHomePrefix(options.resolvedPath)}: ${result.error.message}`,
    );
  }
  assertNotReadOnly(options.resolvedPath);
  await writeFileAtomically(options.resolvedPath, `${JSON.stringify(result.data, null, 2)}\n`);
}
