import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ecosystemFileNameExemptions,
  formatNamingViolations,
  isExternalIdentifier,
  isExternalKey,
  lintJsonObjectKeys,
  lintPathNames,
  lintTypeScriptIdentifiers,
  lintYamlKeys,
  runNamingLinter,
  scanRepository,
} from './namingLinter';

async function withTempDir(fileTree: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'weJobSearch-lint-'));
  try {
    for (const [relativePath, content] of Object.entries(fileTree)) {
      const absolutePath = join(dir, relativePath);
      await mkdir(resolve(absolutePath, '..'), { recursive: true });
      await writeFile(absolutePath, content, 'utf8');
    }
    return dir;
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
}

function repoRootOf(): string {
  return resolve(__dirname, '..', '..');
}

describe('namingLinter', () => {
  it('accepts a clean camelCase and PascalCase TypeScript source sample', () => {
    const source = [
      'export interface JobPosting {',
      '  companyName: string;',
      '  roleTitle: string;',
      '}',
      '',
      'export class FitAssessor {',
      '  assessFit(posting: JobPosting): number {',
      '    return posting.companyName.length;',
      '  }',
      '}',
    ].join('\n');
    expect(lintTypeScriptIdentifiers(source, 'src/evaluators/sample.ts')).toEqual([]);
  });

  it('rejects an underscore-containing declared TypeScript identifier', () => {
    const source = 'const user_id = 1;\nexport function my_func(): number { return user_id; }\n';
    const violations = lintTypeScriptIdentifiers(source, 'src/bad.ts');

    expect(violations.length).toBeGreaterThan(0);
    expect(violations.every((violation) => violation.category === 'typescriptIdentifier')).toBe(true);
    expect(violations.some((violation) => violation.message.includes('user_id'))).toBe(true);
    expect(violations.some((violation) => violation.message.includes('my_func'))).toBe(true);
  });

  it('rejects an underscore-containing project-owned JSON key, with line and path', async () => {
    const dir = await withTempDir({
      'files.json': '{\n  "company_name": "Acme",\n  "nested": { "min_value": 1 }\n}\n',
    });
    try {
      const violations = await scanRepository(dir);
      const jsonViolations = violations.filter((violation) => violation.category === 'jsonKey');
      expect(jsonViolations.length).toBe(2);
      expect(jsonViolations.some((violation) => violation.message.includes('company_name'))).toBe(true);
      expect(jsonViolations.some((violation) => violation.message.includes('nested.min_value'))).toBe(true);
      expect(jsonViolations[0].file).toBe('files.json');
      expect(formatNamingViolations(jsonViolations).length).toBeGreaterThan(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects an underscore in a file and in a directory name', () => {
    expect(lintPathNames('src/accounts/main_table.ts', 'file')).toHaveLength(1);
    expect(lintPathNames('src/accounts/main_table.ts', 'file')[0].category).toBe('filePath');
    expect(lintPathNames('src/archives/mail_archive/', 'dir')).toHaveLength(1);
  });

  it('accepts external query, payload, DOM, and Node literals in their documented exposed context', () => {
    const source = [
      "import { execFile } from 'node:child_process';",
      'export function buildLiQuery(windowHours: number): string {',
      "  const params = new URLSearchParams();",
      "  params.set('f_TPR', String(windowHours));",
      "  params.set('f_WT', '2');",
      "  return params.toString();",
      '}',
      'export function extractNextData(html: string): string {',
      '  const htmlRe = /class="base-card__full-link[^"]*"/i;',
      "  return html.match(htmlRe)?.[0] ?? '__NEXT_DATA__';",
      '}',
      'export function extractSalary(raw: Record<string, unknown>): number | undefined {',
      "  return typeof raw['salary_currency'] === 'string' ? raw['salary_currency'].length : undefined;",
      '}',
      'export interface GraphNode {',
      '  __ref?: unknown;',
      '  __typename?: unknown;',
      '  name: string;',
      '}',
    ].join('\n');
    expect(lintTypeScriptIdentifiers(source, 'src/external.ts')).toEqual([]);
  });

  it('reports the expected file and line for a TypeScript violation', () => {
    const source = 'const okValue = 1;\nconst bad_value = 2;\n';
    const violations = lintTypeScriptIdentifiers(source, 'src/report.ts');
    const violation = violations.find((item) => item.message.includes('bad_value'));

    expect(violation).toBeDefined();
    expect(violation?.file).toBe('src/report.ts');
    expect(violation?.line).toBe(2);
    expect(violation?.column).toBeGreaterThan(0);
  });

  it('rejects an underscore-containing YAML key', () => {
    const violations = lintYamlKeys('compensation:\n  minAcceptableBase: 0\n  min_acceptable_base: 1\n', 'profile/p.yaml');
    expect(violations).toHaveLength(1);
    expect(violations[0].message).toContain('min_acceptable_base');
    expect(violations[0].line).toBe(3);
  });

  it('allows the documented external key prefixes in JSON and JS/TS identifiers', () => {
    expect(lintJsonObjectKeys({ $schema: 'x', __NEXT_DATA__: {} }, 'a.json')).toEqual([]);
    expect(isExternalKey('$schema')).toBe(true);
    expect(isExternalKey('__typename')).toBe(true);
    expect(isExternalIdentifier('__dirname')).toBe(true);
    expect(isExternalIdentifier('base_search_card_title')).toBe(false);
  });

  it('flags an underscore JSON key through lintJsonObjectKeys with a clear message', () => {
    const body = JSON.parse('{"salary_range": {"min_value": 1}}') as Record<string, unknown>;
    const violations = lintJsonObjectKeys(body, 'inline.json');
    expect(violations.map((violation) => violation.message)).toEqual(
      expect.arrayContaining([expect.stringContaining('salary_range'), expect.stringContaining('min_value')]),
    );
  });

  it('couples a failing filename/TS/JSON tree to a nonzero exit code', async () => {
    const dir = await withTempDir({
      'src/bad_module.ts': 'const employee_count = 3;\n',
      'src/meta_table.json': '{"user_id": 1}\n',
    });
    try {
      const result = await runNamingLinter({ repoRoot: dir });
      expect(result.exitCode).toBe(1);
      expect(formatNamingViolations(result.violations)).toContain('user_id');
      expect(formatNamingViolations(result.violations)).toContain('employee_count');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('passes the current repository after the legitimate violations are corrected', async () => {
    const repoRoot = repoRootOf();
    const result = await runNamingLinter({ repoRoot });
    expect(result.exitCode).toBe(0);
    expect(result).toHaveProperty('violations');
    expect(result.violations).toEqual([]);
  });
});
describe('namingLinter hardening (U25a D1-D4)', () => {
  it('D1 keeps only reachable ecosystem filename exemptions', () => {
    for (const dead of ['.env.example', '.nvmrc', '.windsurfrules', '.gitignore', '.DS_Store', 'pre-commit']) {
      expect(ecosystemFileNameExemptions.has(dead)).toBe(false);
    }
    for (const live of ['package.json', 'AGENTS.md', 'opencode.json']) {
      expect(ecosystemFileNameExemptions.has(live)).toBe(true);
    }
    expect(lintPathNames('.env.example', 'file')).toEqual([]);
  });

  it('D2 scans owned .mjs automation for identifier violations', async () => {
    const dir = await withTempDir({
      'scripts/probe.mjs': 'const bad_name = 1;\nexport default bad_name;\n',
    });
    try {
      const violations = await scanRepository(dir);
      expect(
        violations.some(
          (violation) =>
            violation.category === 'typescriptIdentifier' && violation.message.includes('bad_name'),
        ),
      ).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('D3 allowlists only real machine/protocol identifiers and schema keys', () => {
    for (const name of [
      '__dirname',
      '__NEXT_DATA__',
      '__ref',
      '__typename',
      '__INITIAL_DATA__',
      '__globalThis',
      '__filename',
      '__esModule',
      '__TRAILER__',
    ]) {
      expect(isExternalIdentifier(name)).toBe(true);
    }
    expect(isExternalIdentifier('__something_else')).toBe(false);
    expect(isExternalIdentifier('base_search_card_title')).toBe(false);
    for (const key of ['$schema', '$ref', '$defs', '$id']) {
      expect(isExternalKey(key)).toBe(true);
    }
    expect(isExternalKey('$bogus')).toBe(false);
    expect(isExternalKey('__bogus')).toBe(false);
  });

  it('D3 narrows the workflow exemption to GitHub schema keys', async () => {
    const dir = await withTempDir({
      '.github/workflows/ci.yml': [
        'name: CI',
        'on:',
        '  push:',
        'jobs:',
        '  lint-build-test:',
        '    runs-on: ubuntu-latest',
        '    steps:',
        '      - run: npm test',
        '  custom_job:',
        '    runs-on: ubuntu-latest',
        '',
      ].join('\n'),
    });
    try {
      const violations = await scanRepository(dir);
      const yamlViolations = violations.filter((violation) => violation.category === 'yamlKey');
      expect(yamlViolations).toHaveLength(1);
      expect(yamlViolations[0].message).toContain('custom_job');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('D4 temp-name exclusion only ever affects path collection, never content checks', async () => {
    const dir = await withTempDir({
      'scratch.tmp': '{"bad_key": 1}\n',
    });
    try {
      // .tmp has no scannable extension: temp names cannot smuggle content
      // past the key checks, so excluding them from path collection is safe.
      expect(await scanRepository(dir)).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
