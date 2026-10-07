import { readdirSync, readFileSync, statSync } from 'node:fs';
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

// Layering guards. First (Phase 5b): no production module under src/utils may
// import from the CLI layer. Shared profile schemas live in the neutral
// profileSchemas module instead. Second (Phase G thin bridge): no production
// module under src/mcp may import from src/generators, src/evaluators, or
// src/utils directly — the MCP server registers tools and delegates to the
// CLI core and the scrapers, never composing engine layers (SDD Section 4.2).
// Test files are exempt on both guards: cross-layer contract tests must
// import names from the layer under test to assert consistency.
// Compiler-API based, no network, deterministic: bare side-effect imports
// (import '../x';) are seen while comments and string literals mentioning a
// layer are ignored.
const utilsDir = __dirname;
const repoSrc = dirname(utilsDir);
const cliDir = join(repoSrc, 'cli');
const mcpDir = join(repoSrc, 'mcp');
const mcpBannedLayers = ['generators', 'evaluators', 'utils'];

function collectProductionSources(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      found.push(...collectProductionSources(full));
      continue;
    }
    if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) {
      found.push(full);
    }
  }
  return found.sort();
}

describe('utils import graph', () => {
  it('has no imports reaching into the CLI layer', () => {
    const offenders: string[] = [];
    for (const file of collectProductionSources(utilsDir)) {
      const content = readFileSync(file, 'utf8');
      if (specifierReachesCli(content, file)) {
        offenders.push(file.slice(repoSrc.length + 1));
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('mcp import graph', () => {
  it('has no imports reaching the engine layers (generators, evaluators, utils)', () => {
    const offenders: string[] = [];
    for (const file of collectProductionSources(mcpDir)) {
      const content = readFileSync(file, 'utf8');
      const reached = mcpBannedLayers.filter((layer) => specifierReachesLayer(content, file, layer));
      if (reached.length > 0) {
        offenders.push(`${file.slice(repoSrc.length + 1)} -> ${reached.join(', ')}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

// A specifier reaches a layer when a relative specifier resolves inside the
// layer directory, or when a non-relative specifier carries the layer name
// as a path segment.
function specifierReachesLayer(content: string, file: string, layerName: string): boolean {
  const source = createSourceFile(file, content, ScriptTarget.Latest, true);
  const found: string[] = [];
  visitImportNodes(source, found);
  const target = join(repoSrc, layerName);
  return found.some((spec) => {
    if (spec.startsWith('.')) {
      const resolved = resolve(dirname(file), spec);
      return resolved === target || !relative(target, resolved).startsWith('..');
    }
    return spec.split('/').includes(layerName);
  });
}

// A specifier reaches the CLI layer when a relative specifier resolves inside
// src/cli, or when a non-relative specifier carries 'cli' as a path segment.
function specifierReachesCli(content: string, file: string): boolean {
  return specifierReachesLayer(content, file, 'cli');
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
