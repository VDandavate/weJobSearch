import { readFileSync, promises as fs } from 'node:fs';
import { join, posix, relative, resolve, sep } from 'node:path';
import {
  createSourceFile,
  forEachChild,
  getLineAndCharacterOfPosition,
  isIdentifier,
  ScriptKind,
  ScriptTarget,
} from 'typescript';
import { parse } from 'yaml';

// Deterministic naming linter for the whole project (SDD Sections 2.1 and 7,
// AGENTS.md Step 8). Turns the "zero underscores, camelCase / PascalCase only"
// naming convention into a mechanical check that every pre-commit run
// enforces, instead of a convention the agent might forget.
//
// Scope of each validator:
//   - filePath: file and directory names across the repository tree. An
//     underscore in any path segment is always a violation. camelCase is
//     additionally enforced (only) inside project-owned subtrees: src/,
//     templates/, profile/, fixtures/, scripts/, .githooks/, .claude/,
//     .cursor/. Everything else (package.json, docs/, hidden dot-directories)
//     is exemption-documented below and only underscore-checked.
//   - typescriptIdentifier: identifiers (declarations and references) in .ts
//     files, parsed with the installed TypeScript compiler - not a regex.
//     Only real Identifier AST nodes are inspected, so string literals,
//     regexes, import specifiers, HTML/CSS class names, and query-parameter
//     values are never mistaken for identifiers.
//   - jsonKey / yamlKey: keys in project-owned JSON and YAML files.
//
// External-literal exclusions (narrow, deliberate, documented - NOT a "ignore
// all strings" rule, so real JSON-key or identifier violations can never hide
// behind it):
//
//   1. Machine/protocol identifiers: a closed allowlist (__dirname,
//      __NEXT_DATA__, __ref, __typename, __INITIAL_DATA__, __globalThis,
//      __filename, __esModule, plus the justified test-only __TRAILER__).
//      Anything else containing an underscore is a project naming violation.
//      This covers both string literals and the third-party payload
//      shapes (e.g. Wellfound's __typename/__ref and JetBrains' __INITIAL_DATA__)
//      that surface as property names in interfaces.
//   2. f_TPR / f_WT (LinkedIn query params), HTML/CSS class selectors such as
//      base-search-card__title and description__job-criteria-subheader, and
//      Welcome to the Jungle's salary_currency / salary_min / salary_minimum /
//      country_code payload keys are all accessed via string literals
//      (params.set, bracket access, regex source). The identifier scanner
//      ignores the contents of string literals by construction, so these
//      external spellings are preserved exactly and no blanket string
//      exclusion is needed.
//   3. Node built-in module specifiers such as node:child_process are String
//      Literal nodes, never identifiers.
//   4. JSON/YAML keys from closed allowlists: standard JSON Schema
//      vocabulary ($schema, $ref, $defs, $id) and dunder payload keys
//      (__NEXT_DATA__, __INITIAL_DATA__, __ref, __typename). Anything else
//      starting with "$" or "__" is a violation, never silently allowed.
//   5. Ecosystem filename conventions (package.json, package-lock.json,
//      tsconfig.json, vitest.config.ts, LICENSE, AGENTS.md, README.md,
//      opencode.json, HANDOFF.md) and the docs/ tree
//      (which legitimately uses a mandated hyphen-only name, weJobSearch-SDD.md)
//      keep their external spelling; they are underscore-checked but not
//      forced to camelCase. Dot-prefixed names need no listing (the walker
//      skips them before the underscore check) and pre-commit is covered by
//      the .githooks special case.
//   6. MCP protocol/tool names registered by jobSearchServer.ts are already
//      camelCase (parsePdfDocument, evaluateJobPosting, confirmApplicationSubmission),
//      so no additional exclusion is required for any of them.

export type NamingViolationCategory = 'filePath' | 'jsonKey' | 'yamlKey' | 'typescriptIdentifier';

export interface NamingViolation {
  file: string;
  line: number;
  column: number;
  category: NamingViolationCategory;
  message: string;
}

export interface NamingLinterOptions {
  /** Repository root to scan (Default - process.cwd()). */
  repoRoot?: string;
}

export interface NamingLintResult {
  violations: NamingViolation[];
  exitCode: number;
}

// ---------------------------------------------------------------------------
// Repository path collection
// ---------------------------------------------------------------------------

// Roots that are never scanned: version control, the gitignored reference
// clone, published/build output, the per-role runtime output (outside the repo
// under the canonical data root; its schema is already enforced at write time
// by jobFunnelTracker), and coverage.
export const excludedRootNames = new Set([
  '.git',
  '.reference',
  'node_modules',
  'dist',
  'coverage',
  'applications',
]);

export const temporaryNamePatterns = [/\.swp$/, /\.tmp$/, /~$/, /\.orig$/, /^#.*#$/, /\._Store/];
// Note (D4): this exclusion applies ONLY in collectCandidatePaths (path
// collection). Content scanning below is extension-driven (.ts/.mjs/.json/
// .yaml), so a temp-suffixed name can never smuggle file content past the
// key/identifier checks — the exclusion only keeps editor backups out of the
// path-name checks. /\._Store/ covers AppleDouble files, which are distinct
// from the '.DS_Store' early skip in the walker.

// Names that follow an ecosystem (not this-project) naming convention
// (hyphens, dots, lowercase, or ALL.CAPS). Their ownership is external, so
// camelCase is not enforced on them - the zero-underscore rule still is via
// lintPathNames. Dot-prefixed names (.env.example, .nvmrc, .windsurfrules,
// .gitignore, .DS_Store) are intentionally NOT listed: the path walker skips
// dot-prefixed segments before the underscore check, and root-level files
// are unowned anyway, so those entries were unreachable belt-and-braces.
// Likewise 'pre-commit' is covered by the .githooks special case below.
export const ecosystemFileNameExemptions = new Set([
  'AGENTS.md',
  'README.md',
  'LICENSE',
  'HANDOFF.md',
  'package.json',
  'package-lock.json',
  'tsconfig.json',
  'vitest.config.ts',
  'opencode.json',
]);

// Subtrees whose file and directory names must be camelCase. Everything else
// is exempt from the camelCase rule (hidden or ecosystem names) but still must
// not contain underscore characters.
export const camelCaseOwnedTrees = new Set([
  'src',
  'templates',
  'profile',
  'fixtures',
  'scripts',
  '.githooks',
  '.claude',
  '.cursor',
]);

export interface LintablePath {
  kind: 'dir' | 'file';
  absolutePath: string;
  relativePath: string;
}

function isTemporaryName(name: string): boolean {
  return temporaryNamePatterns.some((pattern) => pattern.test(name));
}

function toPosix(p: string): string {
  return p.split(sep).join(posix.sep);
}

function relativePosix(from: string, p: string): string {
  const rel = relative(from, p);
  return rel === '' ? '.' : toPosix(rel);
}

export async function collectCandidatePaths(repoRoot: string): Promise<LintablePath[]> {
  const found: LintablePath[] = [];

  async function walk(directory: string): Promise<void> {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (entry.name === '.DS_Store' || isTemporaryName(entry.name)) {
        continue;
      }
      const absolutePath = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (excludedRootNames.has(entry.name)) {
          continue;
        }
        found.push({ kind: 'dir', absolutePath, relativePath: relativePosix(repoRoot, absolutePath) });
        await walk(absolutePath);
        continue;
      }
      found.push({ kind: 'file', absolutePath, relativePath: relativePosix(repoRoot, absolutePath) });
    }
  }

  await walk(repoRoot);
  return found;
}

// ---------------------------------------------------------------------------
// Name (path segment) validation
// ---------------------------------------------------------------------------

export function camelSuggestion(name: string): string {
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[^A-Za-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) {
    return name;
  }
  const joined = words
    .map((word) => (word.length === 0 ? '' : word[0].toUpperCase() + word.slice(1).toLowerCase()))
    .join('');
  return joined[0].toLowerCase() + joined.slice(1);
}

export function lintPathNames(relativePath: string, kind: 'dir' | 'file'): NamingViolation[] {
  const violations: NamingViolation[] = [];
  const segments = relativePath.split(posix.sep);

  const isCamelSegments = (segment: string): boolean => {
    if (kind === 'dir') {
      return /^[a-z][a-zA-Z0-9]*$/.test(segment);
    }
    // A filename like "jobSearchCore.test.ts" has multiple dot-separated parts
    // (stem + optional specifiers + final extension). Every part except the
    // final extension must be camelCase; the extension itself is external.
    const parts = segment.split('.');
    const meaningfulParts = parts.slice(0, -1);
    return meaningfulParts.every((part) => /^[a-z][a-zA-Z0-9]*$/.test(part));
  };

  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (segment.length === 0 || segment.startsWith('.')) {
      continue;
    }
    if (segment.includes('_')) {
      violations.push({
        file: relativePath,
        line: 0,
        column: 0,
        category: 'filePath',
        message: `name segment \`${segment}\` contains an underscore; use camelCase (a suggestion: \`${camelSuggestion(segment)}\`).`,
      });
      continue;
    }

    const rootTree = segments[0];
    const isOwnedTree = camelCaseOwnedTrees.has(rootTree);
    const isEcosystemFile =
      kind === 'file' && index === segments.length - 1 && ecosystemFileNameExemptions.has(segment);
    if (!isOwnedTree || isEcosystemFile) {
      continue;
    }
    // docs/* uses a mandated hyphenated filename (weJobSearch-SDD.md) and the
    // git hook file must be named exactly "pre-commit"; both are exempt from
    // the camelCase test but keep the zero-underscore test above.
    if (rootTree === 'docs' || (rootTree === '.githooks' && kind === 'file')) {
      continue;
    }
    if (!isCamelSegments(segment)) {
      violations.push({
        file: relativePath,
        line: 0,
        column: 0,
        category: 'filePath',
        message: `name segment \`${segment}\` is not camelCase; use a camelCase artifact name (e.g. \`${camelSuggestion(segment)}\`).`,
      });
    }
  }
  return violations;
}

// ---------------------------------------------------------------------------
// TypeScript identifier scan (TypeScript compiler API)
// ---------------------------------------------------------------------------

// External machine/protocol identifiers: a closed allowlist, not a prefix
// rule. Anything else containing an underscore is a project naming violation,
// including test-only sentinels unless explicitly listed here with rationale.
const externalIdentifierAllowlist = new Set([
  '__dirname',
  '__NEXT_DATA__',
  '__ref',
  '__typename',
  '__INITIAL_DATA__',
  '__globalThis',
  '__filename',
  '__esModule',
  // Test-only sentinel (step13Pipeline.test.ts): retained and justified rather
  // than renamed, so the fixture keeps its protocol shape.
  '__TRAILER__',
]);

export function isExternalIdentifier(name: string): boolean {
  return externalIdentifierAllowlist.has(name);
}

export function lintTypeScriptIdentifiers(
  sourceText: string,
  fileName: string,
  scriptKind: ScriptKind = ScriptKind.TS,
): NamingViolation[] {
  const violations: NamingViolation[] = [];
  const sourceFile = createSourceFile(fileName, sourceText, ScriptTarget.Latest, true, scriptKind);

  const visit = (node: Parameters<typeof forEachChild>[0]): void => {
    if (isIdentifier(node)) {
      const name = node.text;
      if (name.includes('_') && !isExternalIdentifier(name)) {
        const position = getLineAndCharacterOfPosition(sourceFile, node.getStart(sourceFile));
        violations.push({
          file: fileName,
          line: position.line + 1,
          column: position.character + 1,
          category: 'typescriptIdentifier',
          message: `identifier \`${name}\` contains an underscore; use camelCase (\`${camelSuggestion(name)}\`) or, only for genuine external payload keys, read them via bracket/string access which the linter leaves alone.`,
        });
      }
    }
    forEachChild(node, visit);
  };
  visit(sourceFile);
  return violations;
}

// ---------------------------------------------------------------------------
// JSON and YAML key validation
// ---------------------------------------------------------------------------

export function isExternalKey(key: string): boolean {
  return externalJsonSchemaKeys.has(key) || externalDunderKeys.has(key);
}

// Standard JSON Schema vocabulary ($-prefixed) plus dunder payload/globals
// keys. Closed allowlists: any other $ or __ key is a project naming
// violation, not an assumed external.
const externalJsonSchemaKeys = new Set(['$schema', '$ref', '$defs', '$id']);
const externalDunderKeys = new Set(['__NEXT_DATA__', '__INITIAL_DATA__', '__ref', '__typename']);

// In package.json, the immediate children of these section keys are npm package
// names (e.g. "@types/node", "pdf-parse", "@myriaddreamin/typst.ts"), whose
// official spelling is mandated by the npm registry and cannot be renamed. The
// camelCase check is skipped for those specific children only.
export const npmPackageSectionNames = new Set([
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
]);

export function lintJsonObjectKeys(value: Record<string, unknown>, fileLabel: string): NamingViolation[] {
  const violations: NamingViolation[] = [];

  const visit = (nodeValue: unknown, keyPath: string): void => {
    if (nodeValue === null || typeof nodeValue !== 'object') {
      return;
    }
    if (Array.isArray(nodeValue)) {
      for (const item of nodeValue) {
        visit(item, keyPath);
      }
      return;
    }
    for (const [key, child] of Object.entries(nodeValue)) {
      const path = keyPath === '' ? key : `${keyPath}.${key}`;
      const isNpmPackageNameKey = npmPackageSectionNames.has(keyPath);
      if (!isNpmPackageNameKey && !isExternalKey(key) && !/^[a-z][a-zA-Z0-9]*$/.test(key)) {
        violations.push({
          file: fileLabel,
          line: 0,
          column: 0,
          category: 'jsonKey',
          message: `JSON key \`${path}\` is not camelCase; use \`${camelSuggestion(key)}\`, unless it is an official external key (one starting with "$" or "__").`,
        });
      }
      visit(child, path);
    }
  };

  visit(value, '');
  return violations;
}

function locateKeyLine(yamlText: string, key: string): { line: number; column: number } {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`${escaped}\\s*:`);
  const match = pattern.exec(yamlText);
  if (match === null) {
    return { line: 1, column: 1 };
  }
  const keyIndex = match.index;
  const upToKey = yamlText.slice(0, keyIndex);
  const lastNewline = upToKey.lastIndexOf('\n');
  return { line: upToKey.split('\n').length, column: keyIndex - lastNewline };
}

export function lintYamlKeys(yamlText: string, filePath: string): NamingViolation[] {
  let data: unknown;
  try {
    data = parse(yamlText);
  } catch {
    return [];
  }
  const violations: NamingViolation[] = [];

  const visit = (nodeValue: unknown, keyPath: string): void => {
    if (nodeValue === null || typeof nodeValue !== 'object') {
      return;
    }
    if (Array.isArray(nodeValue)) {
      for (const item of nodeValue) {
        visit(item, keyPath);
      }
      return;
    }
    for (const [key, child] of Object.entries(nodeValue)) {
      const path = keyPath === '' ? key : `${keyPath}.${key}`;
      if (!isExternalKey(key) && !/^[a-z][a-zA-Z0-9]*$/.test(key)) {
        const location = locateKeyLine(yamlText, key);
        violations.push({
          file: filePath,
          line: location.line,
          column: location.column,
          category: 'yamlKey',
          message: `YAML key \`${path}\` is not camelCase; rename to \`${camelSuggestion(key)}\`, unless it is an official external key (starting with "$" or "__").`,
        });
      }
      visit(child, path);
    }
  };

  visit(data, '');
  return violations;
}

// ---------------------------------------------------------------------------
// Repository-wide scan
// ---------------------------------------------------------------------------

export async function scanRepository(repoRoot: string): Promise<NamingViolation[]> {
  const violationSet: NamingViolation[] = [];

  const paths = await collectCandidatePaths(repoRoot);
  for (const entry of paths) {
    violationSet.push(...lintPathNames(entry.relativePath, entry.kind));
  }
  for (const entry of paths) {
    if (entry.kind !== 'file') {
      continue;
    }
    const extension = entry.absolutePath.split('.').pop()?.toLowerCase() ?? '';
    if (extension === 'ts') {
      const text = readText(entry.absolutePath);
      violationSet.push(...lintTypeScriptIdentifiers(text, entry.relativePath, ScriptKind.TS));
      continue;
    }
    if (extension === 'mjs') {
      // Owned scripts/ automation is JavaScript: parse as JS so modern syntax
      // does not misparse, and apply the same identifier rule as .ts files.
      const text = readText(entry.absolutePath);
      violationSet.push(...lintTypeScriptIdentifiers(text, entry.relativePath, ScriptKind.JS));
      continue;
    }
    if (extension === 'json') {
      if (basename(entry.absolutePath) === 'package-lock.json') {
        // npm-managed lockfile whose keys/etc are dependency package paths.
        continue;
      }
      const text = readText(entry.absolutePath);
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        continue;
      }
      violationSet.push(...lintJsonObjectKeys(parsed as Record<string, unknown>, entry.relativePath));
      continue;
    }
    if (extension === 'yaml' || extension === 'yml') {
      if (isGitHubWorkflowPath(entry.relativePath)) {
        // Workflow files use GitHub-mandated schema keys: check every other
        // key (job ids hyphen-tolerant, rest camelCase) instead of skipping
        // the file entirely.
        const text = readText(entry.absolutePath);
        violationSet.push(...lintWorkflowKeys(text, entry.relativePath));
        continue;
      }
      const text = readText(entry.absolutePath);
      violationSet.push(...lintYamlKeys(text, entry.relativePath));
    }
  }

  return violationSet.sort((a, b) => {
    if (a.file !== b.file) {
      return a.file < b.file ? -1 : 1;
    }
    if (a.line !== b.line) {
      return a.line - b.line;
    }
    return a.column - b.column;
  });
}

function basename(p: string): string {
  return p.split(sep).pop() ?? p;
}

// GitHub Actions workflow files use GitHub's mandated schema keys (events,
// job/step/schema keywords, action inputs), whose spelling cannot be renamed.
// Everything else in a workflow file — notably job ids — follows the normal
// camelCase rule, except that hyphenated job ids match GitHub's own
// documentation convention and are tolerated (underscores are still rejected).
const gitHubWorkflowSchemaKeys = new Set([
  'on',
  'push',
  'pull_request',
  'pull_request_target',
  'workflow_dispatch',
  'workflow_call',
  'schedule',
  'jobs',
  'name',
  'runs-on',
  'steps',
  'uses',
  'with',
  'run',
  'needs',
  'if',
  'strategy',
  'matrix',
  'fail-fast',
  'max-parallel',
  'env',
  'permissions',
  'defaults',
  'concurrency',
  'container',
  'services',
  'outputs',
  'secrets',
  'inputs',
  'shell',
  'working-directory',
  'node-version-file',
  'cache',
  'cache-dependency-path',
]);

function isGitHubJobIdPath(keyPath: string): boolean {
  const segments = keyPath.split('.');
  return segments.length === 2 && segments[0] === 'jobs';
}

function lintWorkflowKeys(yamlText: string, filePath: string): NamingViolation[] {
  let data: unknown;
  try {
    data = parse(yamlText);
  } catch {
    return [];
  }
  const violations: NamingViolation[] = [];

  const visit = (nodeValue: unknown, keyPath: string): void => {
    if (nodeValue === null || typeof nodeValue !== 'object') {
      return;
    }
    if (Array.isArray(nodeValue)) {
      for (const item of nodeValue) {
        visit(item, keyPath);
      }
      return;
    }
    for (const [key, child] of Object.entries(nodeValue)) {
      const path = keyPath === '' ? key : `${keyPath}.${key}`;
      if (!gitHubWorkflowSchemaKeys.has(key) && !isExternalKey(key)) {
        // Job ids follow GitHub's hyphenated documentation convention
        // (underscores still rejected); every other non-schema key must be
        // camelCase (hyphens tolerated for action-input spellings).
        const allowed = isGitHubJobIdPath(path)
          ? !key.includes('_')
          : /^[a-z][a-zA-Z0-9-]*$/.test(key);
        if (!allowed) {
          const location = locateKeyLine(yamlText, key);
          violations.push({
            file: filePath,
            line: location.line,
            column: location.column,
            category: 'yamlKey',
            message: `YAML key \`${path}\` is not camelCase; rename to \`${camelSuggestion(key)}\`.`,
          });
        }
      }
      visit(child, path);
    }
  };

  visit(data, '');
  return violations;
}

function isGitHubWorkflowPath(relativePath: string): boolean {
  const segments = relativePath.split(posix.sep);
  return segments.includes('.github') && segments[segments.indexOf('.github') + 1] === 'workflows';
}

function readText(filePath: string): string {
  return readFileSync(filePath, 'utf8');
}

export function formatNamingViolations(violations: NamingViolation[]): string {
  return violations
    .map((violation) => {
      const at = violation.line > 0 ? `${violation.file}:${violation.line}:${violation.column}` : violation.file;
      return `${at} [${violation.category}] ${violation.message}`;
    })
    .join('\n');
}

export async function runNamingLinter(options: NamingLinterOptions = {}): Promise<NamingLintResult> {
  const repoRoot = resolve(options.repoRoot ?? process.cwd());
  const violations = await scanRepository(repoRoot);
  return { violations, exitCode: violations.length > 0 ? 1 : 0 };
}

const isMain = typeof require !== 'undefined' && require.main === module;

if (isMain) {
  void (async () => {
    const result = await runNamingLinter();
    if (result.violations.length > 0) {
      process.stdout.write(`${formatNamingViolations(result.violations)}\n`);
      process.stdout.write(`Naming linter: ${result.violations.length} violation(s) found.\n`);
    } else {
      process.stdout.write('Naming linter: clean (0 violations).\n');
    }
    process.exitCode = result.exitCode;
  })();
}