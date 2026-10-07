import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  redactFunnelReport,
  formatFunnelReportTable,
  writeFunnelReportToFile,
  buildFunnelReport,
} from './funnelReporter';
import { redactHomePrefix } from '../utils/canonicalDataRoot';
import { createIsolatedDataRootFromFixtures } from '../testUtils/isolatedRoot';
import type { ApplicationRecord } from '../utils/jobFunnelTracker';
import type { NetworkingContact } from '../utils/networkingContacts';

// H4 PII hygiene tests (SDD Requirement H4).
// All tests use synthetic fixtures (example.com/555/SampleCorp family).
// No real personal data is used anywhere.
// No absolute home path appears in any test snapshot.

const referenceDate = new Date('2026-08-08T12:00:00Z');

function stubApplication(overrides: Partial<ApplicationRecord> = {}): ApplicationRecord {
  return {
    applicationId: 'app2026SampleCorpStaffEngineer',
    companyName: 'SampleCorp',
    roleTitle: 'Staff Engineer',
    jobUrl: 'https://example.com/job1',
    postingHash: 'abc123',
    sourceAggregators: ['test'],
    salaryRange: 'USD 160,000 - 190,000',
    fitScore: 4.2,
    fitStatus: 'strongFit',
    referralContact: null,
    status: 'evaluated',
    statusHistory: [{ stage: 'evaluated', timestamp: '2026-08-01T10:00:00Z' }],
    ...overrides,
  };
}

function stubContact(overrides: Partial<NetworkingContact> = {}): NetworkingContact {
  return {
    contactId: 'contact001',
    name: 'Jane Sample',
    company: 'SampleCorp',
    relationship: 'formerColleague',
    lastContactDate: '2026-07-15',
    linkedApplicationIds: [],
    followUpDue: '2026-08-20',
    ...overrides,
  };
}

function makeReport(overrides: Partial<ApplicationRecord> = {}): ReturnType<typeof buildFunnelReport> {
  const history = { applications: [stubApplication(overrides)] };
  const contacts = { contacts: [stubContact()] };
  return buildFunnelReport(history, contacts, { referenceDate });
}

describe('redactHomePrefix', () => {
  it('replaces the home directory prefix with <dataRoot>', () => {
    const home = require('node:os').homedir();
    const path = join(home, 'Documents', 'weJobSearch', 'user', 'applications', 'history.json');
    const redacted = redactHomePrefix(path);
    expect(redacted.startsWith('<dataRoot>')).toBe(true);
    expect(redacted).not.toContain(home);
  });

  it('leaves non-home paths unchanged', () => {
    const path = '/tmp/some/path';
    expect(redactHomePrefix(path)).toBe(path);
  });

  it('returns <dataRoot> when path is exactly the home directory', () => {
    const home = require('node:os').homedir();
    expect(redactHomePrefix(home).startsWith('<dataRoot>')).toBe(true);
  });

  it('never exposes an absolute home path in the returned string', () => {
    const home = require('node:os').homedir();
    const paths = [
      join(home, 'Documents', 'weJobSearch', 'user', 'masterProfile.md'),
      join(home, 'Documents', 'weJobSearch', 'user', 'applications', 'applicationHistory.json'),
      '/some/other/path',
    ];
    for (const p of paths) {
      const result = redactHomePrefix(p);
      expect(result).not.toContain(home);
      expect(result).not.toMatch(/\/Users\//);
      expect(result).not.toMatch(/\/home\//);
    }
  });
});

describe('redactFunnelReport', () => {
  it('redacts companyName in awaitingManualReview entries', () => {
    const report = makeReport({ fitStatus: 'manualReview' });
    const redacted = redactFunnelReport(report);
    for (const entry of redacted.awaitingManualReview) {
      expect(entry.companyName).toBe('<redacted>');
    }
  });

  it('redacts identity fields in overdueFollowUps', () => {
    const report = makeReport();
    const redacted = redactFunnelReport(report);
    for (const entry of redacted.overdueFollowUps) {
      expect(entry.contactId).toBe('<redacted>');
      expect(entry.name).toBe('<redacted>');
      expect(entry.company).toBe('<redacted>');
      expect(entry.relationship).toBe('<redacted>');
    }
  });

  it('redacts companyName in nextActionHints', () => {
    const report = makeReport();
    const redacted = redactFunnelReport(report);
    for (const entry of redacted.nextActionHints) {
      expect(entry.companyName).toBe('<redacted>');
    }
  });

  it('keeps numeric fit scores unchanged', () => {
    const report = makeReport({ fitStatus: 'manualReview' });
    const redacted = redactFunnelReport(report);
    expect(redacted.awaitingManualReview.length).toBe(1);
    expect(typeof redacted.awaitingManualReview[0].fitScore).toBe('number');
    expect(redacted.awaitingManualReview[0].fitScore).toBe(4.2);
  });

  it('redacts companyName, roleTitle, applicationId, and jobUrl in awaitingManualReview (B4/U45)', () => {
    const report = makeReport({ fitStatus: 'manualReview' });
    const redacted = redactFunnelReport(report);
    expect(redacted.awaitingManualReview[0].companyName).toBe('<redacted>');
    expect(redacted.awaitingManualReview[0].roleTitle).toBe('<redacted>');
    // applicationId encodes company+role (app<year><Company><Role>) and
    // jobUrl may carry employer slugs — both are identity-bearing.
    expect(redacted.awaitingManualReview[0].applicationId).toBe('<redacted>');
    expect(redacted.awaitingManualReview[0].jobUrl).toBe('<redacted>');
  });

  it('redacts applicationId and roleTitle in nextActionHints (B4/U45)', () => {
    const report = makeReport();
    const redacted = redactFunnelReport(report);
    for (const entry of redacted.nextActionHints) {
      expect(entry.applicationId).toBe('<redacted>');
      expect(entry.roleTitle).toBe('<redacted>');
    }
  });

  it('returns a structurally identical report with only identity fields replaced', () => {
    const report = makeReport();
    const redacted = redactFunnelReport(report);
    expect(redacted.totalApplications).toBe(report.totalApplications);
    expect(redacted.fitStatusCounts).toEqual(report.fitStatusCounts);
    expect(redacted.statusCounts).toEqual(report.statusCounts);
    expect(redacted.generatedAt).toBe(report.generatedAt);
  });
});

describe('formatFunnelReportTable with redaction', () => {
  it('shows redacted company names when redact=true', () => {
    const report = makeReport({ fitStatus: 'manualReview' });
    const lines = formatFunnelReportTable(report, true);
    const table = lines.join('\n');
    expect(table).toContain('<redacted>');
    // B4/U45: company, role, applicationId, and job link are all redacted —
    // no SampleCorp surface remains in the redacted table.
    expect(table).not.toContain('SampleCorp');
    expect(table).not.toContain('Staff Engineer');
    expect(table).not.toContain('https://example.com/job1');
  });

  it('shows real company names when redact=false', () => {
    const report = makeReport({ fitStatus: 'manualReview' });
    const lines = formatFunnelReportTable(report, false);
    const table = lines.join('\n');
    expect(table).toContain('SampleCorp');
  });

  it('keeps fit scores visible in both modes', () => {
    const report = makeReport({ fitStatus: 'manualReview', fitScore: 3.8 });
    const redactedLines = formatFunnelReportTable(report, true);
    const redactedTable = redactedLines.join('\n');
    expect(redactedTable).toContain('3.8');
  });

  it('redacts contact identity fields in the overdue section', () => {
    const report = makeReport();
    const lines = formatFunnelReportTable(report, true);
    const table = lines.join('\n');
    expect(table).toContain('<redacted>');
    expect(table).not.toContain('Jane Sample');
    expect(table).not.toContain('contact001');
  });

  it('default (redact=false) shows real identities', () => {
    const report = makeReport();
    const lines = formatFunnelReportTable(report);
    const table = lines.join('\n');
    expect(table).toContain('SampleCorp');
  });
});

describe('writeFunnelReportToFile: H4 redaction', () => {
  it('writes redacted content by default', async () => {
    const { root, restore } = await createIsolatedDataRootFromFixtures();
    try {
      const report = makeReport({ fitStatus: 'manualReview' });
      const outputPath = join(root, 'report.txt');
      const writtenPath = await writeFunnelReportToFile(report, outputPath, { redact: true });
      const content = await readFile(writtenPath, 'utf8');
      expect(content).toContain('<redacted>');
      // B4/U45: no SampleCorp surface (company, role, id, or link) remains.
      expect(content).not.toContain('SampleCorp');
    } finally {
      await restore();
    }
  });

  it('writes unredacted content when redact=false', async () => {
    const { root, restore } = await createIsolatedDataRootFromFixtures();
    try {
      const report = makeReport({ fitStatus: 'manualReview' });
      const outputPath = join(root, 'report.txt');
      const writtenPath = await writeFunnelReportToFile(report, outputPath, { redact: false });
      const content = await readFile(writtenPath, 'utf8');
      expect(content).toContain('SampleCorp');
    } finally {
      await restore();
    }
  });

  it('confined to data root — only basename is used', async () => {
    const { root, restore } = await createIsolatedDataRootFromFixtures();
    try {
      const report = makeReport();
      // Only the basename is used inside the data root; /etc/passwd becomes <dataRoot>/passwd
      const writtenPath = await writeFunnelReportToFile(report, '/etc/passwd', { redact: true });
      expect(writtenPath).toContain('passwd');
      expect(writtenPath).toContain(root);
    } finally {
      await restore();
    }
  });

  it('uses basename only — resolves through assertConfinedToRoot', async () => {
    const { root, restore } = await createIsolatedDataRootFromFixtures();
    try {
      const report = makeReport();
      const outputPath = join(root, 'subdir', 'report.txt');
      const writtenPath = await writeFunnelReportToFile(report, outputPath, { redact: true });
      expect(writtenPath).toContain('report.txt');
    } finally {
      await restore();
    }
  });
});

describe('H4 terminal warning and no absolute home paths', () => {
  it('terminal output prints a warning that identities are shown', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const report = makeReport();
      formatFunnelReportTable(report, false);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Identities'),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('no warning when redact=true', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const report = makeReport({ fitStatus: 'manualReview' });
      formatFunnelReportTable(report, true);
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('no absolute home path appears in any formatted output', () => {
    const report = makeReport();
    const lines = formatFunnelReportTable(report);
    const table = lines.join('\n');
    const home = require('node:os').homedir();
    expect(table).not.toContain(home);
    expect(table).not.toMatch(/\/Users\//);
    expect(table).not.toMatch(/\/home\//);
  });

  it('no absolute home path appears in redacted file output', async () => {
    const { root, restore } = await createIsolatedDataRootFromFixtures();
    try {
      const report = makeReport();
      const outputPath = join(root, 'report.txt');
      const writtenPath = await writeFunnelReportToFile(report, outputPath, { redact: true });
      const content = await readFile(writtenPath, 'utf8');
      const home = require('node:os').homedir();
      expect(content).not.toContain(home);
      expect(content).not.toMatch(/\/Users\//);
      expect(content).not.toMatch(/\/home\//);
    } finally {
      await restore();
    }
  });

  it('redacted file output contains <redacted> tokens for company names', async () => {
    const { root, restore } = await createIsolatedDataRootFromFixtures();
    try {
      const report = makeReport({ fitStatus: 'manualReview' });
      const outputPath = join(root, 'report.txt');
      await writeFunnelReportToFile(report, outputPath, { redact: true });
      const content = await readFile(outputPath, 'utf8');
      expect(content).toContain('<redacted>');
      // B4/U45: no SampleCorp surface (company, role, id, or link) remains.
      expect(content).not.toContain('SampleCorp');
    } finally {
      await restore();
    }
  });
});

describe('H4 --noRedact opt-out', () => {
  it('file output is not redacted when --noRedact is used', async () => {
    const { root, restore } = await createIsolatedDataRootFromFixtures();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const report = makeReport({ fitStatus: 'manualReview' });
      const outputPath = join(root, 'report.txt');
      const writtenPath = await writeFunnelReportToFile(report, outputPath, { redact: false });
      const content = await readFile(writtenPath, 'utf8');
      expect(content).toContain('SampleCorp');
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('NOT redacted'),
      );
    } finally {
      warnSpy.mockRestore();
      await restore();
    }
  });
});

describe('single-sourced warning strings (R3/U45)', () => {
  it('exports the exact identities-shown NOTE used by every surface', async () => {
    const { identitiesShownNote, fileNotRedactedWarning } = await import('./funnelReporter');
    expect(identitiesShownNote).toContain('Identities');
    expect(identitiesShownNote).toContain('--output');
    expect(fileNotRedactedWarning).toContain('NOT redacted');
  });

  it('emits the single-sourced NOTE (not a copy) when identities are shown', async () => {
    const { identitiesShownNote } = await import('./funnelReporter');
    const warned: string[] = [];
    const originalWarn = console.warn;
    console.warn = (message: string) => {
      warned.push(message);
    };
    try {
      formatFunnelReportTable(makeReport(), false);
    } finally {
      console.warn = originalWarn;
    }
    expect(warned).toEqual([identitiesShownNote]);
  });
});

describe('writeFunnelReportToFile format and warn polarity (O2/B3/U45)', () => {
  it('writes JSON bytes when format json is requested', async () => {
    const { root, restore } = await createIsolatedDataRootFromFixtures();
    try {
      const report = makeReport({ fitStatus: 'manualReview' });
      const outputPath = join(root, 'report.json');
      const writtenPath = await writeFunnelReportToFile(report, outputPath, { redact: true, format: 'json' });
      const parsed = JSON.parse(await readFile(writtenPath, 'utf8')) as { totalApplications: number };
      expect(parsed.totalApplications).toBe(report.totalApplications);
    } finally {
      await restore();
    }
  });

  it('stays silent when writing a redacted file (no false identities-shown NOTE)', async () => {
    const { root, restore } = await createIsolatedDataRootFromFixtures();
    try {
      const warned: string[] = [];
      const originalWarn = console.warn;
      console.warn = (message: string) => {
        warned.push(message);
      };
      try {
        await writeFunnelReportToFile(makeReport(), join(root, 'report.txt'), { redact: true });
      } finally {
        console.warn = originalWarn;
      }
      expect(warned).toEqual([]);
    } finally {
      await restore();
    }
  });
});
