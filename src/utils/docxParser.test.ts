import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { extractDocxText } from './docxParser';

// ---------------------------------------------------------------------------
// EUO-12: .docx parser support. All data is synthetic: the committed fixture
// fixtures/sampleResume.docx (Jane Sample / AcmeCorp / SampleCorp, never a
// real person) and OS temp dirs only (N10). Read-only proof (N6): the fixture
// file hash is asserted unchanged after extraction.
// ---------------------------------------------------------------------------

const fixturePath = resolve(__dirname, '..', '..', 'fixtures', 'sampleResume.docx');

function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

describe('docxParser', () => {
  it('extracts plain text from a docx file', async () => {
    const text = await extractDocxText(fixturePath);

    expect(text).toContain('Jane Sample');
    expect(text).toContain('Senior Platform Engineer');
    expect(text).toContain('Led the migration of 200+ microservices to Kubernetes');
    expect(text).toContain('TypeScript, Rust, SQL, Python');
  });

  it('applies the shared line-break-artifact cleanup convention', async () => {
    const text = await extractDocxText(fixturePath);

    // Paragraphs are separated by at most one blank line (no 3+ newline runs).
    expect(text).not.toMatch(/\n{3,}/);
    // No carriage returns survive the cleanup.
    expect(text).not.toContain('\r');
    // The result is trimmed of leading/trailing whitespace.
    expect(text).toBe(text.trim());
  });

  it('is read-only: the fixture file hash is unchanged after extraction', async () => {
    const before = sha256(await readFile(fixturePath));

    await extractDocxText(fixturePath);

    const after = sha256(await readFile(fixturePath));
    expect(after).toBe(before);
  });

  it('throws a clear error naming the path for a missing file', async () => {
    const missing = resolve(__dirname, '..', '..', 'fixtures', 'doesNotExist.docx');
    await expect(extractDocxText(missing)).rejects.toThrow(missing);
  });

  it('throws a clear error for a file that is not a valid docx', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'weJobSearch-docx-'));
    try {
      const garbagePath = join(dir, 'garbage.docx');
      await writeFile(garbagePath, Buffer.from('this is not a zip archive'));

      await expect(extractDocxText(garbagePath)).rejects.toThrow(garbagePath);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('routes docx errors through the redacted path form (Phase D)', async () => {
    const { redactHomePrefix } = await import('./canonicalDataRoot');
    const dir = await mkdtemp(join(tmpdir(), 'weJobSearch-docx-'));
    try {
      const missing = join(dir, 'missing.docx');
      const message = await extractDocxText(missing).then(
        () => 'no error',
        (error: Error) => error.message,
      );
      expect(message).toContain('Unable to read docx file');
      expect(message).toContain(redactHomePrefix(missing));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});