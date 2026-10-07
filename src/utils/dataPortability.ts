import { mkdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { create, extract, list } from 'tar';
import { parse as parseYaml } from 'yaml';
import { canonicalDataRoot, isPathInside } from './canonicalDataRoot';
import { applicationHistorySchema } from './jobFunnelTracker';
import { networkingContactsSchema } from './networkingContacts';

// Canonical-root export/import (EUO-10, portability for G1/G2 continuity).
// exportDataRoot tarballs the canonical data root
// (~/Documents/weJobSearch/<user>/) into a gzip archive; importDataRoot
// restores it into a (fresh) canonical root with a no-overwrite guard on the
// real profile files. The archive contains ONLY the canonical root contents -
// the git work tree is never touched (N5). Both operations are deterministic
// (portable tar metadata, no network, no LLM - N7) and never write outside the
// paths the caller names.

// The real profile files that must never be silently overwritten by an import
// (N5, N9). If any of these already exists at the destination root, the import
// refuses and names every blocker. Single owner: the CLI init wizard imports
// this list instead of keeping its own copy.
export const realProfileFileNames: readonly string[] = [
  'masterProfile.md',
  'jobPreferences.yaml',
  'screeningAnswers.json',
  'networkingContacts.json',
];

export interface ExportDataRootOptions {
  // Canonical root to archive; defaults to the real canonical data root.
  // Tests pass an OS temp dir override (N10).
  rootPath?: string;
  // Destination archive file (e.g. /path/to/weJobSearch-backup.tar.gz).
  archivePath: string;
}

export interface ExportResult {
  archivePath: string;
  sourceRoot: string;
  entryCount: number;
  byteCount: number;
}

export interface ImportDataRootOptions {
  // Archive produced by exportDataRoot.
  archivePath: string;
  // Destination canonical root; defaults to the real canonical data root.
  // Tests pass an OS temp dir override (N10).
  rootPath?: string;
}

export interface ImportResult {
  archivePath: string;
  rootPath: string;
  entryCount: number;
  restoredFiles: string[];
}

interface ListedEntry {
  path: string;
  type: string;
  linkpath?: string;
}

// Tarballs the canonical root (or the overridden rootPath) into archivePath.
// The archive is a gzip tar with portable metadata (normalized mtime/uid/gid),
// so identical roots produce identical archives (N7). The archive is written
// with a temp file + rename so an interrupted export never leaves a partial
// archive at the destination path.
export async function exportDataRoot(options: ExportDataRootOptions): Promise<ExportResult> {
  const rootPath = resolve(options.rootPath ?? canonicalDataRoot());
  const archivePath = resolve(options.archivePath);

  const rootStat = await stat(rootPath).catch(() => {
    throw new Error(`Cannot export data root: '${rootPath}' is not a directory (or does not exist).`);
  });
  if (!rootStat.isDirectory()) {
    throw new Error(`Cannot export data root: '${rootPath}' is not a directory.`);
  }
  if (isPathInside(rootPath, archivePath)) {
    throw new Error(
      `Refusing to write archive '${archivePath}' inside the data root '${rootPath}': the archive would capture itself. ` +
        'Choose an archive path outside the canonical data root.',
    );
  }

  await mkdir(dirname(archivePath), { recursive: true });
  const tempArchivePath = `${archivePath}.tmp-${process.pid}`;
  let entryCount = 0;
  try {
    await create(
      {
        gzip: true,
        file: tempArchivePath,
        cwd: rootPath,
        portable: true,
        onWriteEntry: () => {
          entryCount += 1;
        },
      },
      ['.'],
    );
    await rename(tempArchivePath, archivePath);
  } catch (error) {
    await rm(tempArchivePath, { force: true }).catch(() => undefined);
    throw error;
  }

  const archiveStat = await stat(archivePath);
  const exported = { archivePath, sourceRoot: rootPath, entryCount, byteCount: archiveStat.size };
  // Loud sanctioned-path log: import/export are the single sanctioned
  // outside-root paths (H1b), so every crossing names the outside path and
  // the entry count where operators will see it.
  console.warn(
    `Sanctioned outside-root write: archive '${archivePath}' holds ${entryCount} entries from data root '${rootPath}'.`,
  );
  return exported;
}

// Restores the archive into the canonical root (or the overridden rootPath).
// No-overwrite guard: if any real profile file (masterProfile.md,
// jobPreferences.yaml, screeningAnswers.json, networkingContacts.json) already
// exists at the destination, the import refuses and names every blocking file
// - existing profile data is never overwritten (N5, N9). Extraction is
// confined to the destination root: every entry is pre-listed and any
// absolute path or `..` traversal refuses the whole archive before anything
// is written (tar-slip guard, H1b). Restored tracking files are then schema
// validated (applicationHistory, networkingContacts, jobPreferences) so a
// corrupt archive fails loudly instead of poisoning reporting.
export async function importDataRoot(options: ImportDataRootOptions): Promise<ImportResult> {
  const archivePath = resolve(options.archivePath);
  const rootPath = resolve(options.rootPath ?? canonicalDataRoot());

  let archiveStat;
  try {
    archiveStat = await stat(archivePath);
  } catch {
    throw new Error(`Cannot import data root: archive not found at '${archivePath}'.`);
  }
  if (!archiveStat.isFile()) {
    throw new Error(`Cannot import data root: '${archivePath}' is not a file.`);
  }

  const blockers: string[] = [];
  for (const fileName of realProfileFileNames) {
    const candidate = join(rootPath, fileName);
    try {
      const candidateStat = await stat(candidate);
      if (candidateStat.isFile()) {
        blockers.push(fileName);
      }
    } catch {
      // File does not exist at the destination - safe to restore.
    }
  }
  if (blockers.length > 0) {
    throw new Error(
      `Refusing to import data root: destination '${rootPath}' already has profile file(s): ${blockers.join(', ')}. ` +
        'Import never overwrites existing profile data; move the existing root aside or import into an empty root.',
    );
  }

  // Tar-slip guard (H1b): list every entry BEFORE creating the destination
  // and refuse the whole archive when any entry path is absolute or escapes
  // the destination root via .. segments. Symlink and hardlink targets are
  // checked with the same refusal-first discipline: node-tar would otherwise
  // strip an absolute linkpath with only a warning during extraction.
  // node-tar's default preservePaths:false strips some of these, but
  // stripping silently rewrites paths - this project refuses loudly instead,
  // before a single byte is written.
  const listedEntries: ListedEntry[] = [];
  await list({
    file: archivePath,
    onentry: (entry) => {
      listedEntries.push({ path: entry.path, type: entry.type, linkpath: entry.linkpath });
    },
  });
  for (const listedEntry of listedEntries) {
    const entryPath = listedEntry.path;
    const stripped = entryPath.replace(/^\.\//, '');
    const segments = stripped.split(sep);
    if (
      isAbsolute(entryPath) ||
      isAbsolute(stripped) ||
      segments.some((segment) => segment === '..')
    ) {
      throw new Error(
        `Refusing to import data root: archive '${archivePath}' contains an entry that escapes the destination root: '${entryPath}'. ` +
          'Import only archives produced by exportDataRoot.',
      );
    }
    const linkTarget = listedEntry.linkpath;
    const isLinkEntry = listedEntry.type === 'SymbolicLink' || listedEntry.type === 'Link';
    if (isLinkEntry && linkTarget !== undefined) {
      const targetBase = listedEntry.type === 'Link' ? rootPath : join(rootPath, dirname(entryPath));
      const linkSegments = linkTarget.split('/');
      const resolvedTarget = resolve(targetBase, linkTarget);
      if (
        isAbsolute(linkTarget) ||
        linkSegments.some((segment) => segment === '..') ||
        !isPathInside(rootPath, resolvedTarget)
      ) {
        throw new Error(
          `Refusing to import data root: archive '${archivePath}' contains a link entry '${entryPath}' whose target '${linkTarget}' escapes the destination root. ` +
            'Import only archives produced by exportDataRoot.',
        );
      }
    }
  }

  const restoredFiles: string[] = [];
  let entryCount = 0;
  await mkdir(rootPath, { recursive: true });
  await extract({
    file: archivePath,
    cwd: rootPath,
    onentry: (entry) => {
      entryCount += 1;
      if (entry.type === 'File') {
        restoredFiles.push(entry.path.replace(/^\.\//, ''));
      }
    },
  });

  // Schema validation (H1b): a restored tracking database that fails its
  // schema is refused loudly instead of silently poisoning reporting. Only
  // files the archive actually restored are checked; absent files are skipped.
  await validateRestoredFile(rootPath, join('applications', 'applicationHistory.json'), (raw) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new Error(
        `Refusing to import data root: restored 'applications/applicationHistory.json' is not valid JSON (${(error as Error).message}).`,
      );
    }
    const result = applicationHistorySchema.safeParse(parsed);
    if (!result.success) {
      throw new Error(
        `Refusing to import data root: restored 'applications/applicationHistory.json' fails schema validation (${result.error.message}).`,
      );
    }
  });
  await validateRestoredFile(rootPath, 'networkingContacts.json', (raw) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new Error(
        `Refusing to import data root: restored 'networkingContacts.json' is not valid JSON (${(error as Error).message}).`,
      );
    }
    const result = networkingContactsSchema.safeParse(parsed);
    if (!result.success) {
      throw new Error(
        `Refusing to import data root: restored 'networkingContacts.json' fails schema validation (${result.error.message}).`,
      );
    }
  });
  await validateRestoredFile(rootPath, 'jobPreferences.yaml', (raw) => {
    let parsed: unknown;
    try {
      parsed = parseYaml(raw);
    } catch (error) {
      throw new Error(
        `Refusing to import data root: restored 'jobPreferences.yaml' is not valid YAML (${(error as Error).message}).`,
      );
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(
        `Refusing to import data root: restored 'jobPreferences.yaml' must be a YAML mapping of preference sections.`,
      );
    }
  });

  // Loud sanctioned-path log: import/export are the single sanctioned
  // outside-root paths (H1b), so every crossing names the outside path and
  // the entry count where operators will see it.
  console.warn(
    `Sanctioned outside-root read: archive '${archivePath}' supplied ${entryCount} entries into data root '${rootPath}'.`,
  );
  return { archivePath, rootPath, entryCount, restoredFiles };
}

// Runs check(raw) when relativePath was restored under rootPath; absent files
// are skipped so partial archives (profile-only, history-only) still import.
async function validateRestoredFile(
  rootPath: string,
  relativePath: string,
  check: (raw: string) => void,
): Promise<void> {
  let raw: string;
  try {
    raw = await readFile(join(rootPath, relativePath), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return;
    }
    throw error;
  }
  check(raw);
}