import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import {
  createSourceFile,
  isCallExpression,
  isExportDeclaration,
  isExternalModuleReference,
  isIdentifier,
  isImportDeclaration,
  isImportEqualsDeclaration,
  isStringLiteral,
  ScriptTarget,
  SyntaxKind,
  type Node,
} from 'typescript';
import { describe, expect, it } from 'vitest';
import { createIsolatedDataRootFromFixtures, assertSandboxTarget } from './isolatedRoot';
import { dataRootEnvKey } from '../utils/canonicalDataRoot';

// H1b harness tests: the isolated-root helper seeds a throwaway canonical
// root from synthetic fixtures, and the import-graph guard keeps the harness
// internal (no non-test source file outside src/testUtils/ may import it,
// and it is never part of any CLI/MCP schema).

async function collectSourceFiles(dir: string, collected: string[] = []): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      await collectSourceFiles(full, collected);
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      collected.push(full);
    }
  }
  return collected;
}

describe('createIsolatedDataRootFromFixtures', () => {
  it('seeds a tmpdir root from fixtures and sets WEJOBSEARCHDATAROOT', async () => {
    const previousRoot = process.env[dataRootEnvKey];
    const isolated = await createIsolatedDataRootFromFixtures();
    try {
      expect(isolated.root.startsWith(resolve(tmpdir()))).toBe(true);
      expect(process.env[dataRootEnvKey]).toBe(isolated.root);
      const topEntries = await readdir(isolated.root);
      expect(topEntries).toContain('masterProfile.md');
      expect(topEntries).toContain('jobPreferences.yaml');
      expect(topEntries).toContain('applications');
      expect(topEntries).toContain('documents');
      const profile = await readFile(join(isolated.root, 'masterProfile.md'), 'utf8');
      expect(profile).toContain('Jane Sample');
    } finally {
      await isolated.restore();
    }
    if (previousRoot === undefined) {
      expect(process.env[dataRootEnvKey]).toBeUndefined();
    } else {
      expect(process.env[dataRootEnvKey]).toBe(previousRoot);
    }
  });

  it('restore is idempotent and safe to call twice', async () => {
    const previousRoot = process.env[dataRootEnvKey];
    const isolated = await createIsolatedDataRootFromFixtures();
    const createdRoot = isolated.root;
    try {
      await isolated.restore();
      if (previousRoot === undefined) {
        expect(process.env[dataRootEnvKey]).toBeUndefined();
      } else {
        expect(process.env[dataRootEnvKey]).toBe(previousRoot);
      }
      expect(existsSync(createdRoot)).toBe(false);
      await isolated.restore();
      if (previousRoot === undefined) {
        expect(process.env[dataRootEnvKey]).toBeUndefined();
      } else {
        expect(process.env[dataRootEnvKey]).toBe(previousRoot);
      }
      expect(existsSync(createdRoot)).toBe(false);
    } finally {
      if (previousRoot === undefined) {
        delete process.env[dataRootEnvKey];
      } else {
        process.env[dataRootEnvKey] = previousRoot;
      }
      await isolated.restore();
    }
  });

  it('refuses sandbox targets outside os.tmpdir, inside the repo, or inside home', () => {
    const systemTmp = resolve(tmpdir());
    const candidate = join(systemTmp, 'weJobSearch-guardrail-probe');
    expect(() => assertSandboxTarget(join(systemTmp, '..', 'elsewhere'), systemTmp, systemTmp)).toThrow(
      /outside os\.tmpdir/,
    );
    expect(() => assertSandboxTarget(candidate, systemTmp, join(systemTmp, 'home'))).toThrow(
      /repo work tree/,
    );
    expect(
      () =>
        assertSandboxTarget(join(systemTmp, 'home', 'probe'), join(systemTmp, 'repo'), join(systemTmp, 'home')),
    ).toThrow(/home directory/);
    expect(assertSandboxTarget(candidate, join(systemTmp, 'repo'), join(systemTmp, 'home'))).toBe(
      resolve(candidate),
    );
  });
});

describe('testUtils import-graph guard', () => {
  it('no non-test source file outside src/testUtils/ imports testUtils', async () => {
    const srcRoot = resolve(__dirname, '..');
    const testUtilsRoot = resolve(__dirname);
    const offenders: string[] = [];
    for (const file of await collectSourceFiles(srcRoot)) {
      const rel = relative(srcRoot, file);
      if (rel.startsWith('testUtils')) {
        continue;
      }
      if (file.endsWith('.test.ts')) {
        continue;
      }
      const content = await readFile(file, 'utf8');
      if (specifierReachesDirectory(content, file, 'testUtils', testUtilsRoot)) {
        offenders.push(rel);
      }
    }
    expect(offenders).toEqual([]);
  });
});

// Compiler-API import scan: parses the file with the TypeScript compiler so
// bare side-effect imports (import '../x';) are seen while comments and
// string literals mentioning the guarded directory are ignored. A specifier
// reaches the guarded directory when a relative specifier resolves inside it,
// or when a non-relative specifier carries the guarded directory name as a
// path segment.
function specifierReachesDirectory(
  content: string,
  file: string,
  dirName: string,
  dirRoot: string,
): boolean {
  return collectModuleSpecifiers(content, file).some((spec) =>
    resolvedSpecifierInsideDir(spec, file, dirName, dirRoot),
  );
}

function collectModuleSpecifiers(content: string, file: string): string[] {
  const source = createSourceFile(file, content, ScriptTarget.Latest, true);
  const found: string[] = [];
  visitImportNodes(source, found);
  return found;
}

function visitImportNodes(node: Node, found: string[]): void {
  if (isImportDeclaration(node) || isExportDeclaration(node)) {
    const spec = node.moduleSpecifier;
    if (spec !== undefined && isStringLiteral(spec)) {
      found.push(spec.text);
    }
  } else if (isImportEqualsDeclaration(node)) {
    const ref = node.moduleReference;
    if (isExternalModuleReference(ref) && isStringLiteral(ref.expression)) {
      found.push(ref.expression.text);
    }
  } else if (
    isCallExpression(node) &&
    (node.expression.kind === SyntaxKind.ImportKeyword ||
      (isIdentifier(node.expression) && node.expression.text === 'require')) &&
    node.arguments.length > 0 &&
    isStringLiteral(node.arguments[0])
  ) {
    found.push(node.arguments[0].text);
  }
  node.forEachChild((child) => visitImportNodes(child, found));
}

function resolvedSpecifierInsideDir(spec: string, file: string, dirName: string, dirRoot: string): boolean {
  if (spec.startsWith('.')) {
    const resolved = resolve(dirname(file), spec);
    return resolved === dirRoot || !relative(dirRoot, resolved).startsWith('..');
  }
  return spec.split('/').includes(dirName);
}
