import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { homedir, userInfo } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

// ---------------------------------------------------------------------------
// PII hygiene (H4): redactHomePrefix replaces the OS home directory prefix
// in a path with the literal token "<dataRoot>". This keeps user-facing
// error messages and file-output paths free of absolute home-directory
// segments (e.g. "<home>/Documents/weJobSearch/..." becomes
// "<dataRoot>/Documents/weJobSearch/..."). Fit scores and other numeric
// fields are kept as-is; only identity-bearing path segments are redacted.
// ---------------------------------------------------------------------------

const homePrefix = homedir();

// Canonical, project-local data root (consolidation decision): every piece of
// user data (profile config, source documents, generated documents, evaluated
// job + application tracking, networking contacts) lives beneath ONE gitignored
// root, never scattered across the repo tree. By default the root is
// <documents>/weJobSearch/<username>, where <documents> is the platform
// documents directory (Windows known-folder with OneDrive awareness,
// XDG_DATA_HOME when set, otherwise ~/Documents), computed from the OS home
// directory and the sanitized effective user name, so it is deterministic on
// every machine and lives entirely outside the git work tree - a file under
// this root can never be committed, no matter what a future session does with
// .gitignore. An explicit --dataRoot flag or WEJOBSEARCHDATAROOT always wins
// over this default (CLI-plus-env-only relocation).
//
// Backwards compatibility: callers may keep passing explicit path overrides
// (profilePath/historyPath/...); those still win. This module
// only changes the *defaults* that previously pointed at in-repo paths
// ('profile/masterProfile.md', 'applications/applicationHistory.json', ...).

export const canonicalRootFolderName = 'weJobSearch';
export const documentsDirectoryName = 'documents';
export const applicationsDirectoryName = 'applications';
export const masterProfileFileName = 'masterProfile.md';
export const networkingContactsFileName = 'networkingContacts.json';
export const applicationHistoryFileName = 'applicationHistory.json';
export const resumeVariantsFileName = 'resumeVariants.yaml';
export const savedSearchesFileName = 'savedSearches.json';
export const searchCacheFileName = 'searchCache.json';
export const searchHistoryFileName = 'searchHistory.json';
export const setupStateFileName = 'setupState.json';
export const previewsDirectoryName = 'previews';

function effectiveUserName(): string {
  try {
    const info = userInfo();
    if (info.username.length > 0) {
      return sanitizeUserName(info.username);
    }
  } catch {
    // userInfo() can throw when there is no passwd/shadow entry for the uid
    // (common in sandboxes). Fall back to the home directory name.
  }
  return sanitizeUserName(basename(homedir()));
}

// Sanitize a raw OS user name into a path-safe directory segment (F1):
// strip a Windows domain prefix (DOMAIN\user), then drop all whitespace.
// Empty results fall back to 'user' so the root is always defined.
export function sanitizeUserName(rawUserName: string): string {
  const withoutDomain = rawUserName.split(/[\\/]/).pop() ?? '';
  const withoutWhitespace = withoutDomain.replace(/\s+/g, '');
  return withoutWhitespace.length > 0 ? withoutWhitespace : 'user';
}

// Platform documents directory (F1): Windows uses the known-folder Documents
// directory with OneDrive awareness (OneDrive\Documents wins when present,
// else %USERPROFILE%\Documents); other platforms honor XDG_DATA_HOME when
// set; everything else falls back to the legacy ~/Documents. Callers needing
// the full data root append the project folder and user name themselves,
// which keeps XDG (a data dir, not a documents dir) compositional.
export function platformDocumentsDirectory(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  homeDirectory: string,
  directoryExists: (path: string) => boolean = existsSync,
): string {
  if (platform === 'win32') {
    const oneDrive = env.OneDrive;
    if (
      oneDrive !== undefined &&
      oneDrive.trim().length > 0 &&
      directoryExists(join(oneDrive, 'Documents'))
    ) {
      return join(oneDrive, 'Documents');
    }
    const userProfile = env.USERPROFILE;
    if (userProfile !== undefined && userProfile.trim().length > 0) {
      return join(userProfile, 'Documents');
    }
    return join(homeDirectory, 'Documents');
  }
  const xdgDataHome = env['XDG_DATA_HOME'];
  if (xdgDataHome !== undefined && xdgDataHome.trim().length > 0) {
    return xdgDataHome;
  }
  return join(homeDirectory, 'Documents');
}

export function canonicalDataRoot(): string {
  const base = platformDocumentsDirectory(process.platform, process.env, homedir());
  return join(base, canonicalRootFolderName, effectiveUserName());
}

export function canonicalMasterProfilePath(): string {
  return join(canonicalDataRoot(), masterProfileFileName);
}

export function canonicalContactsPath(): string {
  return join(canonicalDataRoot(), networkingContactsFileName);
}

// Session-resumption checkpoint for profile setup (setupState.ts, EUO-15).
// Records the in-progress profile-setup step so an interrupted setup can be
// resumed; created lazily by the setup workflow and cleared on completion;
// never committed.
export function canonicalSetupStatePath(): string {
  return join(canonicalDataRoot(), setupStateFileName);
}

export function canonicalResumeVariantsPath(): string {
  return join(canonicalDataRoot(), resumeVariantsFileName);
}

// Create the canonical root plus the required subdirectories. mkdir recursive
// is idempotent, so this is safe to call on every profile workflow entry. It
// creates only the canonical tree (never a stray folder inside the repo).
export async function ensureCanonicalDataDirectories(
  rootDir: string = canonicalDataRoot(),
): Promise<string> {
  await mkdir(rootDir, { recursive: true });
  await mkdir(join(rootDir, documentsDirectoryName), { recursive: true });
  await mkdir(join(rootDir, applicationsDirectoryName), { recursive: true });
  return rootDir;
}

// Directory that holds the bare profile files (masterProfile.md and friends).
// Mirrors the old in-repo 'profile' dir: our canonical root.
export function profileDirectoryOf(profileFilePath: string): string {
  return dirname(profileFilePath);
}

// True when candidatePath is inside parentDir (or equals it). Used to decide
// whether a resolved data path would land inside the git work tree.
// Phase D: a relative result that is itself absolute is outside by
// definition. That covers the Windows cross-drive case (win32
// relative('C:\a', 'D:\b') yields the absolute 'D:\b', which the old
// startsWith('..')-only check mistook for inside) via the platform absolute
// check, plus an explicit drive-letter check so the guard also fails closed
// on non-Windows runtimes where a drive-prefixed remainder is never a
// same-drive relative result. Failing closed is the safe direction for a
// confinement guard.
export function isContainedRelativePath(rel: string): boolean {
  if (rel.length === 0) {
    return true;
  }
  if (rel.startsWith('..')) {
    return false;
  }
  return !isAbsolute(rel) && !/^[A-Za-z]:[\\/]/.test(rel);
}

export function isPathInside(parentDir: string, candidatePath: string): boolean {
  return isContainedRelativePath(relative(parentDir, candidatePath));
}

// H1a confinement enforcement: resolve() both sides and throw loudly
// if candidatePath is not inside rootDir. Returns the resolved absolute
// candidate path on success. No warn-only mode; every violation is
// a hard Error with name, candidate, and label.
export function assertConfinedToRoot(
  rootDir: string,
  candidatePath: string,
  label = 'path',
): string {
  const resolvedRoot = resolve(rootDir);
  const resolvedCandidate = resolve(candidatePath);
  if (!isPathInside(resolvedRoot, resolvedCandidate)) {
    throw new Error(
      `H1a confinement violation: ${label} "${redactHomePrefix(candidatePath)}" (resolved: ${redactHomePrefix(resolvedCandidate)}) is outside root "${redactHomePrefix(rootDir)}" (resolved: ${redactHomePrefix(resolvedRoot)})`,
    );
  }
  return resolvedCandidate;
}

// H4 PII hygiene: replace the OS home directory prefix with
// "<dataRoot>" so user-facing errors and file paths never expose
// absolute home-directory segments. Numeric fields (fit scores,
// counts) are left untouched; only identity-bearing path segments
// are redacted. Safe to call on any string; returns unchanged if
// the string contains no home prefix. Substring replacement (not just
// a leading-prefix check): CLI-boundary messages embed absolute paths
// mid-sentence, so every occurrence is redacted. Pure home-prefixed paths
// produce byte-identical output to the old prefix behavior.
export function redactHomePrefix(path: string): string {
  if (homePrefix.length === 0 || !path.includes(homePrefix)) {
    return path;
  }
  return path.split(homePrefix).join('<dataRoot>');
}

// Stable folder segment for the per-role output, shared with the generators.

// ---------------------------------------------------------------------------
// Path resolution precedence (CLI-plus-env-only, SDD Section 10.2): an
// explicit CLI value wins, then the WEJOBSEARCHDATAROOT environment value,
// then the canonicalDataRoot() default. The jobPreferences.yaml `directories`
// block no longer relocates the data root (config-declared roots cannot
// bootstrap the root they live in): directories.dataRoot is rejected loudly
// by the preferences schema and by resolveDataRoot below, never silently
// ignored. The environment is read ONLY in this module (readDataRootEnv);
// every other module resolves through the helpers below so the precedence
// lives in one place. Blank/whitespace-only values are treated as unset at
// every level.
// ---------------------------------------------------------------------------

// Environment override for the data root. The key is intentionally a single
// camelCase token (no underscores) so it passes the naming linter like every
// other identifier in this repo.
export const dataRootEnvKey = 'WEJOBSEARCHDATAROOT';

// Structural view of the directories block. Declared here (rather than
// imported from the evaluator) so this module stays dependency-free: the
// zod-inferred DirectoriesPreferences in fitEvaluator.ts is assignable to it.
export interface DirectoryOverrides {
  dataRoot?: string | null;
  outputRoot?: string | null;
  resumeVariantsFile?: string | null;
}

export function readDataRootEnv(): string | null {
  const raw = process.env[dataRootEnvKey];
  if (raw === undefined) {
    return null;
  }
  const trimmed = raw.trim();
  return trimmed.length > 0 ? expandLeadingTilde(raw) : null;
}

function expandLeadingTilde(value: string): string {
  // Tilde expansion (F5/U43): a leading ~/ means the operator's home
  // directory. Without this, '--dataRoot ~/x' resolves to '<cwd>/~/x'
  // and passes the trivially-true self-confinement check.
  const trimmed = value.trim();
  if (trimmed === '~' || trimmed.startsWith('~/')) {
    return join(homedir(), trimmed.slice(trimmed.startsWith('~/') ? 2 : 1));
  }
  return value;
}

function firstConfiguredPath(values: ReadonlyArray<string | null | undefined>): string | null {
  for (const value of values) {
    if (value !== undefined && value !== null && value.trim().length > 0) {
      return expandLeadingTilde(value);
    }
  }
  return null;
}

export function resolveDataRoot(
  cliDataRoot?: string | null,
  directories?: DirectoryOverrides | null,
): string {
  // The caller-passed directories branch is deleted (CLI-plus-env-only):
  // a set directories.dataRoot is rejected loudly here and by the
  // preferences schema, never silently honored or ignored. The parameter is
  // retained so stale callers fail at this explicit guard instead of
  // silently resolving elsewhere.
  const configured = directories?.dataRoot ?? null;
  if (configured !== null && configured.trim().length > 0) {
    throw new Error(
      'directories.dataRoot is no longer supported for relocation (CLI-plus-env-only): ' +
      'use an explicit --dataRoot flag or WEJOBSEARCHDATAROOT instead, then remove the key.',
    );
  }
  // Phase D: the old self-confinement check (root confined to itself) was
  // vacuously true and accepted a --dataRoot inside the git work tree, where
  // real user data could be committed by accident. An explicitly relocated
  // root (CLI flag or env) must live outside the work tree; the canonical
  // default already does by construction and is exempt.
  const explicit = firstConfiguredPath([cliDataRoot ?? null]) ?? readDataRootEnv();
  const root = explicit ?? canonicalDataRoot();
  if (explicit !== null) {
    assertDataRootOutsideWorkTree(root);
  }
  assertConfinedToRoot(root, root, 'dataRoot');
  return root;
}

// Rejects a data root that resolves inside the git work tree (the repo root
// located from this module). Real user data under the work tree could be
// committed; AGENTS.md requires it to live outside.
export function assertDataRootOutsideWorkTree(root: string): string {
  const resolved = resolve(root);
  const repoRoot = resolve(repoRootFromModule());
  if (isPathInside(repoRoot, resolved)) {
    throw new Error(
      `dataRoot "${redactHomePrefix(root)}" must live outside the git work tree ` +
        `(${redactHomePrefix(repoRoot)}): real user data is never stored inside the repo.`,
    );
  }
  return resolved;
}

export function resolveOutputRoot(
  cliOutputRoot?: string | null,
  directories?: DirectoryOverrides | null,
  dataRoot?: string | null,
): string {
  const direct = firstConfiguredPath([cliOutputRoot ?? null, directories?.outputRoot ?? null]);
  if (direct !== null) {
    const root = firstConfiguredPath([dataRoot ?? null]) ?? resolveDataRoot(undefined, directories);
    assertConfinedToRoot(root, direct, 'outputRoot');
    return direct;
  }
  const root = firstConfiguredPath([dataRoot ?? null]) ?? resolveDataRoot(undefined, directories);
  const outputPath = join(root, applicationsDirectoryName);
  assertConfinedToRoot(root, outputPath, 'outputRoot');
  return outputPath;
}

// H1b template-root allowlist. Typst templates resolve against exactly two
// fixed roots - never process.cwd() and never a user override - so a variant
// file cannot escape into an arbitrary directory:
//
// - Primary: the shipped templates/ directory, located from this module's own
//   location on disk (the CommonJS __dirname equivalent of import.meta.url,
//   independent of the caller's working directory) and asserted inside the
//   repo root with isPathInside. This is why the directories.templateRoot
//   config key and the CLI --templateRoot flag were deleted: per-template
//   escape hatches made the allowlist unenforceable.
// - Secondary: <dataRoot>/templates/, confined with assertConfinedToRoot, for
//   user-supplied variant templates. Created lazily by callers, never by this
//   module.
//
// Stale directories.templateRoot keys in existing jobPreferences.yaml files
// are ignored (the zod schema strips unknown keys), not rejected.
export const templatesDirectoryName = 'templates';

export function repoRootFromModule(): string {
  return resolve(__dirname, '..', '..');
}

export function shippedTemplatesRoot(): string {
  return resolveShippedTemplatesRoot(repoRootFromModule());
}

// Layout-coupling guard (F5): the shipped templates/ directory must sit next
// to the built dist/ tree. A missing directory fails loudly here instead of
// surfacing later as a confusing template-resolution error.
export function resolveShippedTemplatesRoot(repoRoot: string): string {
  const shipped = join(repoRoot, templatesDirectoryName);
  if (!isPathInside(resolve(repoRoot), resolve(shipped))) {
    throw new Error(
      `Template root escape: shipped templates '${shipped}' is outside the repo root '${repoRoot}'.`,
    );
  }
  if (!existsSync(shipped)) {
    throw new Error(
      `Shipped templates root is missing at '${shipped}': keep the templates/ directory beside the built dist/ tree (see repoRootFromModule).`,
    );
  }
  return shipped;
}

export function userTemplatesRoot(dataRoot?: string | null): string {
  const root =
    dataRoot !== undefined && dataRoot !== null && dataRoot.trim().length > 0
      ? dataRoot
      : resolveDataRoot();
  const userTemplates = join(root, templatesDirectoryName);
  return assertConfinedToRoot(root, userTemplates, 'userTemplates');
}

export interface TemplateRoots {
  shipped: string;
  user: string;
}

export function resolveTemplateRoots(dataRoot?: string | null): TemplateRoots {
  return { shipped: shippedTemplatesRoot(), user: userTemplatesRoot(dataRoot) };
}

export function resolveTemplateRoot(dataRoot?: string | null): string {
  return resolveTemplateRoots(dataRoot).shipped;
}

// Maps a variant template reference to an allowlisted file path. Absolute
// references must already sit inside the shipped templates/ root or inside
// <dataRoot>/templates/ (anything else throws). Relative references (with an
// optional leading templates/ or ./ segment, the historical variants-seed
// shape) resolve to the shipped file when it exists, else to the same name
// under <dataRoot>/templates/, confined by construction. Shipped wins ties so
// a user override can never shadow a built-in template name silently.
export function resolveTemplatePath(template: string, dataRoot?: string | null): string {
  const shipped = shippedTemplatesRoot();
  if (isAbsolute(template)) {
    const resolved = resolve(template);
    if (isPathInside(resolve(shipped), resolved)) {
      return resolved;
    }
    return assertConfinedToRoot(userTemplatesRoot(dataRoot), resolved, 'templatePath');
  }
  const stripped = template.replace(/^\.\//, '').replace(/^templates\//, '');
  // A relative reference is still user-controlled, so confine it before the
  // existence check: ../../etc/passwd must throw here, not be returned just
  // because the file exists outside the shipped root.
  const shippedCandidate = assertConfinedToRoot(shipped, join(shipped, stripped), 'templatePath');
  if (existsSync(shippedCandidate)) {
    return shippedCandidate;
  }
  const userDir = userTemplatesRoot(dataRoot);
  return assertConfinedToRoot(userDir, join(userDir, stripped), 'templatePath');
}

export function resolveResumeVariantsPath(
  cliVariantsPath?: string | null,
  directories?: DirectoryOverrides | null,
  dataRoot?: string | null,
): string {
  const direct = firstConfiguredPath([
    cliVariantsPath ?? null,
    directories?.resumeVariantsFile ?? null,
  ]);
  if (direct !== null) {
    const root = firstConfiguredPath([dataRoot ?? null]) ?? resolveDataRoot(undefined, directories);
    assertConfinedToRoot(root, direct, 'resumeVariantsPath');
    return direct;
  }
  const root = firstConfiguredPath([dataRoot ?? null]) ?? resolveDataRoot(undefined, directories);
  const variantsPath = join(root, resumeVariantsFileName);
  assertConfinedToRoot(root, variantsPath, 'resumeVariantsPath');
  return variantsPath;
}