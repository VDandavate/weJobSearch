import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseNodeMajorVersion, runSetupCheck } from './setupCheck';

describe('parseNodeMajorVersion', () => {
  it('extracts the major version from a semver string', () => {
    expect(parseNodeMajorVersion('26.5.0')).toBe(26);
    expect(parseNodeMajorVersion('24.0.0')).toBe(24);
    expect(parseNodeMajorVersion('20.12.2')).toBe(20);
  });

  it('returns 0 for an unparseable version string', () => {
    expect(parseNodeMajorVersion('')).toBe(0);
    expect(parseNodeMajorVersion('abc')).toBe(0);
  });
});

describe('runSetupCheck', () => {
  describe('Node version check', () => {
    it('passes when Node version is >= 24', async () => {
      const result = await runSetupCheck({ nodeVersion: '26.5.0' });
      expect(result.nodeOk).toBe(true);
      expect(result.nodeVersion).toBe('26.5.0');
      expect(result.exitCode).toBe(0);
      expect(result.lines.join('\n')).toContain('OK');
    });

    it('fails with a clear upgrade message and non-zero exit when Node < 24', async () => {
      const result = await runSetupCheck({ nodeVersion: '20.0.0' });
      expect(result.nodeOk).toBe(false);
      expect(result.exitCode).toBe(1);
      const text = result.lines.join('\n');
      expect(text).toContain('FAIL');
      expect(text).toContain('Upgrade');
    });
  });

  describe('Typst detection', () => {
    it('reports binary when typst is found on PATH', async () => {
      const result = await runSetupCheck({
        nodeVersion: '26.5.0',
        typstChecker: async () => true,
      });
      expect(result.typstStatus).toBe('binary');
      expect(result.exitCode).toBe(0);
      expect(result.lines.join('\n')).toContain('typst binary was found on PATH');
    });

    it('reports wasmFallback when typst is absent (informational, not fatal)', async () => {
      const result = await runSetupCheck({
        nodeVersion: '26.5.0',
        typstChecker: async () => false,
      });
      expect(result.typstStatus).toBe('wasmFallback');
      expect(result.exitCode).toBe(0);
      expect(result.lines.join('\n')).toContain('WASM fallback');
    });

    it('reports unknown when the typst checker throws', async () => {
      const result = await runSetupCheck({
        nodeVersion: '26.5.0',
        typstChecker: async () => {
          throw new Error('boom');
        },
      });
      expect(result.typstStatus).toBe('unknown');
      expect(result.exitCode).toBe(0);
    });
  });

  describe('MCP registration instructions', () => {
    it('contains the exact MCP registration command for non-OpenCode hosts', async () => {
      const result = await runSetupCheck({
        nodeVersion: '26.5.0',
        typstChecker: async () => false,
      });
      const text = result.lines.join('\n');
      expect(text).toContain('node dist/mcp/jobSearchServer.js');
    });

    it('mentions OpenCode auto-wiring via opencode.json', async () => {
      const result = await runSetupCheck({
        nodeVersion: '26.5.0',
        typstChecker: async () => false,
      });
      const text = result.lines.join('\n');
      expect(text).toContain('opencode.json');
      expect(text).toContain('OpenCode');
    });
  });

  describe('No side effects', () => {
    it('writes no files to the filesystem', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'weJobSearch-setup-'));
      const originalCwd = process.cwd();
      try {
        process.chdir(dir);
        const before = await readdir(dir);
        await runSetupCheck({
          nodeVersion: '26.5.0',
          typstChecker: async () => false,
        });
        const after = await readdir(dir);
        expect(after).toEqual(before);
      } finally {
        process.chdir(originalCwd);
        await rm(dir, { recursive: true, force: true });
      }
    });
  });
});

describe('configuration validation wiring (U22)', () => {
  const validVariantsYaml = `variants:
  usStandardResume:
    template: templates/usStandardResume.typ
    triggers: {}
`;

  it('fails fast with file-specific errors on malformed configs', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'weJobSearch-setupcfg-'));
    try {
      const prefsPath = join(dir, 'jobPreferences.yaml');
      const variantsPath = join(dir, 'resumeVariants.yaml');
      await writeFile(prefsPath, 'compensation: [unclosed\n', 'utf8');
      await writeFile(variantsPath, validVariantsYaml, 'utf8');
      const result = await runSetupCheck({
        nodeVersion: '26.5.0',
        typstChecker: async () => false,
        configPaths: { jobPreferencesPath: prefsPath, resumeVariantsPath: variantsPath },
      });
      expect(result.exitCode).toBe(1);
      const text = result.lines.join('\n');
      expect(text).toContain('jobPreferences.yaml: FAIL');
      expect(text).toContain('resumeVariants.yaml: OK');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('reports uninitialized configs without failing the setup', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'weJobSearch-setupcfg-'));
    try {
      const result = await runSetupCheck({
        nodeVersion: '26.5.0',
        typstChecker: async () => false,
        configPaths: {
          jobPreferencesPath: join(dir, 'jobPreferences.yaml'),
          resumeVariantsPath: join(dir, 'resumeVariants.yaml'),
        },
      });
      expect(result.exitCode).toBe(0);
      expect(result.lines.join('\n')).toContain('not initialized yet');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('env-aware config paths (U43)', () => {
  const validPrefsYaml = [
    'compensation:',
    '  currency: USD',
    '  minAcceptableBase: 100000',
    '  targetBase: 150000',
    '  countsBonusTowardMin: false',
    '  countsEquityTowardMin: false',
    'clearance:',
    '  currentStatus: none',
    '  currentLevel: null',
    '  eligibleToObtain: false',
    '  requiresSponsorshipForVisa: false',
    'nonNegotiables: []',
    'preferredLocations:',
    '  - Remote',
    '',
  ].join('\n');
  const validVariantsYaml = `variants:
  usStandardResume:
    template: templates/usStandardResume.typ
    triggers: {}
`;

  it('validates the env data-root files when WEJOBSEARCHDATAROOT is set', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'weJobSearch-setupenv-'));
    const previous = process.env.WEJOBSEARCHDATAROOT;
    process.env.WEJOBSEARCHDATAROOT = dir;
    try {
      await writeFile(join(dir, 'jobPreferences.yaml'), validPrefsYaml, 'utf8');
      await writeFile(join(dir, 'resumeVariants.yaml'), validVariantsYaml, 'utf8');
      const result = await runSetupCheck({
        nodeVersion: '26.5.0',
        typstChecker: async () => false,
      });
      const text = result.lines.join('\n');
      expect(text).toContain('jobPreferences.yaml: OK');
      expect(text).toContain('resumeVariants.yaml: OK');
    } finally {
      if (previous === undefined) {
        delete process.env.WEJOBSEARCHDATAROOT;
      } else {
        process.env.WEJOBSEARCHDATAROOT = previous;
      }
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('setupCheck runner wrapper', () => {
  it('resolves the compiled dist entry and never imports the .ts source directly', () => {
    // Regression: scripts/setupCheck.mjs fell back to importing
    // src/cli/setupCheck.ts on a fresh clone, whose extensionless relative
    // imports Node ESM type stripping cannot resolve
    // (ERR_MODULE_NOT_FOUND). The wrapper must build-then-use-dist instead.
    const repoRoot = resolve(__dirname, '..', '..');
    const wrapper = readFileSync(join(repoRoot, 'scripts', 'setupCheck.mjs'), 'utf8');
    expect(wrapper).not.toContain(`setupCheck.ts')`);
    expect(wrapper).toContain('dist');
    expect(wrapper).toContain('setupCheck.js');
    expect(wrapper).toContain('npm');
    expect(wrapper).toContain('build');
  });
});
