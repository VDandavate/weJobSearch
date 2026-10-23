import { describe, expect, it } from 'vitest';
import {
  parseAddContactArgs,
  parseConfirmAppArgs,
  parseCoverLetterArgs,
  parseDigestArgs,
  parseEvaluateArgs,
  parseExportDataArgs,
  parseGenerateArgs,
  parseImportDataArgs,
  parseInitArgs,
  parseOutreachArgs,
  parsePdfArgs,
  parsePreviewResumeArgs,
  parseReportArgs,
  parseReviewArgs,
  parseReviewQueueArgs,
  parseSearchArgs,
  parseShowArgs,
  parseUpdateStatusArgs,
  parseValidateArgs,
  scanCliTokens,
} from './argsParser';

// Phase 7a characterization: the parsers moved verbatim from jobSearchCore.ts
// onto one shared scanner. These pin the exact legacy semantics (including
// quirks) so the extraction cannot drift CLI behavior.

describe('scanCliTokens', () => {
  it('reports --help, skips bare tokens, and never consumes the next token', () => {
    const seen: string[] = [];
    let helped = false;
    scanCliTokens(['pos', '--help', '--company', 'AcmeCorp'], {
      onHelp: () => {
        helped = true;
      },
      onOption: (name, value) => seen.push(`${name}=${value}`),
    });
    expect(helped).toBe(true);
    expect(seen).toEqual(['company=AcmeCorp']);
  });

  it('supports --name=value and ignores values starting with --', () => {
    const seen: string[] = [];
    scanCliTokens(['--company=AcmeCorp', '--role', '--profile', 'me.md'], {
      onOption: (name, value) => seen.push(`${name}=${value}`),
    });
    expect(seen).toEqual(['company=AcmeCorp', 'profile=me.md']);
  });

  it('checks bare flags before value lookup, even in --flag=value form', () => {
    const flags: string[] = [];
    scanCliTokens(['--save=x'], {
      onFlag: (name) => {
        flags.push(name);
        return true;
      },
      onOption: () => {
        throw new Error('must not reach onOption for a consumed flag');
      },
    });
    expect(flags).toEqual(['save']);
  });
});

describe('extracted parsers preserve legacy behavior', () => {
  it('parses generate args in both space and equals form', () => {
    expect(parseGenerateArgs(['--company', 'AcmeCorp', '--role=SeniorEngineer'])).toEqual({
      company: 'AcmeCorp',
      role: 'SeniorEngineer',
    });
    expect(parseGenerateArgs(['--help'])).toEqual({ help: true });
    expect(parseGenerateArgs(['--unknown', 'x'])).toEqual({});
  });

  it('splits comma-separated postingRequirements for cover letters', () => {
    const parsed = parseCoverLetterArgs([
      '--company',
      'AcmeCorp',
      '--role',
      'SeniorEngineer',
      '--postingRequirements',
      'TypeScript, Rust ,',
    ]);
    expect(parsed.postingRequirements).toEqual(['TypeScript', 'Rust']);
  });

  it('parses search flags, numerics, and location', () => {
    const parsed = parseSearchArgs([
      '--keywords',
      'senior engineer',
      '--save',
      '--remoteOnly',
      '--minFit',
      '3.5',
      '--maxAgeDays=30',
    ]);
    expect(parsed.keywords).toBe('senior engineer');
    expect(parsed.save).toBe(true);
    expect(parsed.remoteOnly).toBe(true);
    expect(parsed.minFit).toBe(3.5);
    expect(parsed.minSalary).toBeUndefined();
    expect(parsed.maxAgeDays).toBe(30);
  });

  it('rejects non-numeric search numerics instead of silently dropping them', () => {
    expect(() => parseSearchArgs(['--keywords', 'e', '--minFit', 'notanumber'])).toThrow(
      "Invalid --minFit value 'notanumber'",
    );
    expect(() => parseSearchArgs(['--keywords', 'e', '--minSalary', 'lots'])).toThrow(
      'Invalid --minSalary',
    );
    expect(() => parseSearchArgs(['--keywords', 'e', '--maxAgeDays', 'Infinity'])).toThrow(
      'Invalid --maxAgeDays',
    );
  });

  it('handles a bare --noRedact flag like the other boolean flags', () => {
    expect(parseReportArgs(['--noRedact']).noRedact).toBe(true);
    expect(parseReportArgs(['--format', 'json']).noRedact).toBeUndefined();
  });

  it('parses validate dataRoot and help', () => {
    expect(parseValidateArgs(['--dataRoot', '/tmp/data'])).toEqual({ dataRoot: '/tmp/data' });
    expect(parseValidateArgs(['--help'])).toEqual({ help: true });
    expect(parseValidateArgs([])).toEqual({});
  });

  it('parses --dataRoot for path-bearing commands (config-driven directories)', () => {
    expect(parseGenerateArgs(['--dataRoot', '/tmp/data']).dataRoot).toBe('/tmp/data');
    expect(parseGenerateArgs(['--dataRoot=/tmp/data']).dataRoot).toBe('/tmp/data');
    expect(parsePreviewResumeArgs(['--dataRoot', '/tmp/data']).dataRoot).toBe('/tmp/data');
    expect(
      parseCoverLetterArgs(['--company', 'A', '--role', 'R', '--dataRoot', '/tmp/data']).dataRoot,
    ).toBe('/tmp/data');
    expect(
      parseOutreachArgs(['--contactId', 'c1', '--dataRoot', '/tmp/data']).dataRoot,
    ).toBe('/tmp/data');
    expect(parseEvaluateArgs(['--jobUrl', 'https://example.com/job', '--dataRoot', '/tmp/data']).dataRoot).toBe(
      '/tmp/data',
    );
    expect(parseSearchArgs(['--keywords', 'engineer', '--dataRoot', '/tmp/data']).dataRoot).toBe(
      '/tmp/data',
    );
    expect(parseInitArgs(['--dataRoot', '/tmp/data']).dataRoot).toBe('/tmp/data');
    expect(parseShowArgs(['--company', 'A', '--role', 'R', '--dataRoot', '/tmp/data']).dataRoot).toBe(
      '/tmp/data',
    );
    expect(parseReviewArgs(['--company', 'A', '--role', 'R', '--dataRoot', '/tmp/data']).dataRoot).toBe(
      '/tmp/data',
    );
    expect(
      parseUpdateStatusArgs(['--company', 'A', '--role', 'R', '--status', 'offer', '--dataRoot', '/tmp/data'])
        .dataRoot,
    ).toBe('/tmp/data');
    expect(
      parseConfirmAppArgs(['--company', 'A', '--role', 'R', '--dataRoot', '/tmp/data']).dataRoot,
    ).toBe('/tmp/data');
    expect(parseGenerateArgs(['--company', 'AcmeCorp']).dataRoot).toBeUndefined();
  });

  it('parses every remaining command shape', () => {
    expect(parseEvaluateArgs(['--jobUrl', 'https://example.com/job'])).toEqual({
      jobUrl: 'https://example.com/job',
    });
    expect(parseOutreachArgs(['--contactId', 'c1', '--company', 'A', '--role', 'R'])).toEqual({
      contactId: 'c1',
      company: 'A',
      role: 'R',
    });
    expect(parseAddContactArgs(['--name', 'Jane', '--company', 'A'])).toEqual({
      name: 'Jane',
      company: 'A',
    });
    expect(parseReportArgs(['--format', 'json'])).toEqual({ format: 'json' });
    expect(parseReviewQueueArgs(['--historyPath', 'h.json'])).toEqual({});
    expect(parseInitArgs(['--profileDirectory', 'p'])).toEqual({});
    expect(parseExportDataArgs(['--archivePath', 'a.tgz'])).toEqual({ archivePath: 'a.tgz' });
    expect(parseImportDataArgs(['--archivePath', 'a.tgz', '--rootPath', 'r'])).toEqual({
      archivePath: 'a.tgz',
      rootPath: 'r',
    });
    expect(parsePreviewResumeArgs(['--variant', 'v'])).toEqual({ variant: 'v' });
    expect(parseDigestArgs(['--profile', 'p.md'])).toEqual({});
    expect(parseShowArgs(['--company', 'A', '--role', 'R'])).toEqual({
      companyName: 'A',
      roleTitle: 'R',
    });
    expect(parseReviewArgs(['--company', 'A', '--role', 'R'])).toEqual({
      companyName: 'A',
      roleTitle: 'R',
    });
    expect(
      parseUpdateStatusArgs(['--company', 'A', '--role', 'R', '--status', 'offer']),
    ).toEqual({ companyName: 'A', roleTitle: 'R', status: 'offer' });
    expect(parsePdfArgs(['--filePath', 'f.pdf'])).toEqual({ filePath: 'f.pdf' });
    expect(parseConfirmAppArgs(['--company', 'A', '--role', 'R', '--notes', 'n'])).toEqual({
      company: 'A',
      role: 'R',
      notes: 'n',
    });
  });
});

describe('report/reviewQueue/addContact/digest dataRoot flags (U43)', () => {
  it('report accepts --dataRoot', () => {
    expect(parseReportArgs(['--dataRoot', '/tmp/roota']).dataRoot).toBe('/tmp/roota');
  });
  it('reviewQueue accepts --dataRoot', () => {
    expect(parseReviewQueueArgs(['--dataRoot', '/tmp/rootb']).dataRoot).toBe('/tmp/rootb');
  });
  it('addContact accepts --dataRoot', () => {
    expect(
      parseAddContactArgs(['--name', 'Sam', '--company', 'Acme', '--dataRoot', '/tmp/rootc']).dataRoot,
    ).toBe('/tmp/rootc');
  });
  it('digest accepts --dataRoot', () => {
    expect(parseDigestArgs(['--dataRoot', '/tmp/rootd']).dataRoot).toBe('/tmp/rootd');
  });
});

  it('parses --radiusMiles for search', () => {
    expect(parseSearchArgs(['--keywords', 'engineer', '--radiusMiles', '25'])).toEqual({
      keywords: 'engineer',
      radiusMiles: 25,
    });
    expect(parseSearchArgs(['--keywords', 'engineer', '--radiusMiles=25'])).toEqual({
      keywords: 'engineer',
      radiusMiles: 25,
    });
  });

  it('rejects non-numeric --radiusMiles', () => {
    expect(() => parseSearchArgs(['--keywords', 'e', '--radiusMiles', 'notanumber'])).toThrow(
      "Invalid --radiusMiles value 'notanumber': expected a finite number.",
    );
    expect(() => parseSearchArgs(['--keywords', 'e', '--radiusMiles', '0'])).toThrow(
      "Invalid --radiusMiles value '0': must be a positive integer.",
    );
    expect(() => parseSearchArgs(['--keywords', 'e', '--radiusMiles', '-5'])).toThrow(
      "Invalid --radiusMiles value '-5': must be a positive integer.",
    );
  });
