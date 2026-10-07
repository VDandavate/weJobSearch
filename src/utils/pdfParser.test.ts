import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cleanExtractedText, parsePdfDocument } from './pdfParser';
import { redactHomePrefix } from './canonicalDataRoot';

// U24/C8: direct unit tests for every cleanExtractedText regex branch,
// including the hyphen-continuation joins. parsePdfDocument itself needs real
// PDF bytes and stays covered by fixture/error-path tests.

describe('cleanExtractedText', () => {
  it('normalizes carriage returns to newlines', () => {
    expect(cleanExtractedText('line one\r\nline two\rline three')).toBe('line one\nline two\nline three');
  });

  it('joins hyphenated line continuations', () => {
    expect(cleanExtractedText('contin-\nuation of thought')).toBe('continuation of thought');
  });

  it('drops a hyphen followed by space and newline', () => {
    expect(cleanExtractedText('well- \nknown fact')).toBe('well known fact');
  });

  it('collapses runs of spaces, tabs, and non-breaking spaces', () => {
    expect(cleanExtractedText('a  b\tc\u00A0d')).toBe('a b c d');
  });

  it('folds triple-plus newlines to a blank line and trims', () => {
    expect(cleanExtractedText('\n\nPara one.\n\n\n\nPara two.\n\n')).toBe('Para one.\n\nPara two.');
  });
});

describe('parsePdfDocument Phase D: redacted error paths', () => {
  it('routes read errors through the redacted path form', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'weJobSearch-pdf-'));
    try {
      const missing = join(dir, 'missing.pdf');
      const message = await parsePdfDocument(missing, dir).then(
        () => 'no error',
        (error: Error) => error.message,
      );
      expect(message).toContain('Unable to read PDF file');
      // Pinned to the redacted form: under a home-rooted path this renders
      // '<dataRoot>/...', never the absolute home segment (the redaction
      // itself is unit-covered in canonicalDataRoot tests).
      expect(message).toContain(redactHomePrefix(missing));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
