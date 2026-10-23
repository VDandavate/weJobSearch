import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ingestDocuments, type IngestedDocumentSummary } from './documentIngestor';

// ---------------------------------------------------------------------------
// Helpers (all data is synthetic, written to OS temp dirs only)
// ---------------------------------------------------------------------------

// Minimal single-page PDF with one text line, valid enough for pdf-parse to
// extract the text and report pageCount = 1.
function makeMinimalPdf(text: string): Buffer {
  const escaped = text.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  const stream = `BT /F1 12 Tf 72 720 Td (${escaped}) Tj ET`;
  const body = [
    '1 0 obj',
    '<< /Type /Catalog /Pages 2 0 R >>',
    'endobj',
    '2 0 obj',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    'endobj',
    '3 0 obj',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    'endobj',
    '4 0 obj',
    `<< /Length ${Buffer.byteLength(stream)} >>`,
    'stream',
    stream,
    'endstream',
    'endobj',
    '5 0 obj',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    'endobj',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (const line of body) {
    offsets.push(pdf.length);
    pdf += `${line}\n`;
  }
  const xrefStart = pdf.length;
  pdf += `xref\n0 ${offsets.length + 1}\n`;
  pdf += '0000000000 65535 f \n';
  for (const offset of offsets) {
    pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${offsets.length + 1} /Root 1 0 R >>\n`;
  pdf += `startxref\n${xrefStart}\n%%EOF`;
  return Buffer.from(pdf, 'latin1');
}

function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

async function makeDocumentDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'weJobSearch-ingest-'));
  process.env.WEJOBSEARCHDATAROOT = dir;
  return dir;
}

afterEach(() => {
  delete process.env.WEJOBSEARCHDATAROOT;
});

function samplePdfBytes(): Buffer {
  return makeMinimalPdf('Jane Sample resume summary content');
}

// Committed synthetic .docx fixture (EUO-12), copied into the temp dir for
// each test — the fixtures/ directory itself is never ingested (N10).
const sampleDocxPath = resolve(__dirname, '..', '..', 'fixtures', 'sampleResume.docx');

async function copySampleDocx(dirPath: string, name = 'resume.docx'): Promise<void> {
  await copyFile(sampleDocxPath, join(dirPath, name));
}

async function listFileHashes(dirPath: string): Promise<Map<string, string>> {
  const hashes = new Map<string, string>();
  for (const name of (await readdir(dirPath)).sort()) {
    const fullPath = join(dirPath, name);
    const info = await readFile(fullPath);
    hashes.set(name, sha256(info));
  }
  return hashes;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('documentIngestor', () => {
  it('discovers pdf, markdown, text, and docx files; skips hidden files, unsupported extensions, and subdirectories', async () => {
    const dir = await makeDocumentDir();
    try {
      await writeFile(join(dir, 'resume.pdf'), samplePdfBytes());
      await writeFile(join(dir, 'notes.md'), '# Notes\n\nSome markdown notes.\n', 'utf8');
      await writeFile(join(dir, 'postings.txt'), 'Saved posting text.\n', 'utf8');
      await copySampleDocx(dir);
      await writeFile(join(dir, '.hidden.md'), 'secret notes\n', 'utf8');
      await writeFile(join(dir, 'readme.rtf'), Buffer.from('not supported'));
      await writeFile(join(dir, 'image.png'), Buffer.from('not supported'));
      await mkdir(join(dir, 'nested'));
      await writeFile(join(dir, 'nested', 'inner.txt'), 'ignored\n', 'utf8');

      const summaries = await ingestDocuments(dir);

      expect(summaries.map((summary) => summary.fileName)).toEqual([
        'notes.md',
        'postings.txt',
        'resume.docx',
        'resume.pdf',
      ]);
      expect(summaries.map((summary) => summary.fileType)).toEqual(['markdown', 'text', 'docx', 'pdf']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('routes each file type to the correct parser and returns per-file summaries', async () => {
    const dir = await makeDocumentDir();
    try {
      await writeFile(join(dir, 'resume.pdf'), samplePdfBytes());
      await writeFile(join(dir, 'notes.md'), '# Notes\n\nSome markdown notes.\n', 'utf8');
      await writeFile(join(dir, 'postings.txt'), 'Saved posting text.\n', 'utf8');
      await copySampleDocx(dir);

      const summaries = await ingestDocuments(dir);
      const byName = new Map<string, IngestedDocumentSummary>(
        summaries.map((summary) => [summary.fileName, summary]),
      );

      const pdf = byName.get('resume.pdf');
      expect(pdf).toBeDefined();
      expect(pdf?.fileType).toBe('pdf');
      expect(pdf?.pageCount).toBe(1);
      expect(pdf?.charCount).toBeUndefined();
      expect(pdf?.byteSize).toBeGreaterThan(0);
      expect(pdf?.filePath).toBe('resume.pdf');
      expect(pdf?.text).toContain('Jane Sample');

      const docx = byName.get('resume.docx');
      expect(docx).toBeDefined();
      expect(docx?.fileType).toBe('docx');
      expect(docx?.pageCount).toBeUndefined();
      expect(docx?.charCount).toBe(docx?.text.length ?? -1);
      expect(docx?.byteSize).toBeGreaterThan(0);
      expect(docx?.filePath).toBe('resume.docx');
      expect(docx?.text).toContain('Jane Sample');
      expect(docx?.text).toContain('Senior Platform Engineer');

      const markdown = byName.get('notes.md');
      expect(markdown).toBeDefined();
      expect(markdown?.fileType).toBe('markdown');
      expect(markdown?.pageCount).toBeUndefined();
      expect(markdown?.charCount).toBe(markdown?.text.length ?? -1);
      expect(markdown?.text).toContain('Some markdown notes');
      expect(markdown?.text).toContain('# Notes');

      const text = byName.get('postings.txt');
      expect(text).toBeDefined();
      expect(text?.fileType).toBe('text');
      expect(text?.charCount).toBe(text?.text.length ?? -1);
      expect(text?.text).toContain('Saved posting text');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('is read-only: file hashes and the directory listing are unchanged after ingestion', async () => {
    const dir = await makeDocumentDir();
    try {
      await writeFile(join(dir, 'resume.pdf'), samplePdfBytes());
      await writeFile(join(dir, 'notes.md'), '# Notes\n\nSome markdown notes.\n', 'utf8');
      await writeFile(join(dir, 'postings.txt'), 'Saved posting text.\n', 'utf8');
      await copySampleDocx(dir);

      const before = await listFileHashes(dir);
      const listingBefore = (await readdir(dir)).sort();

      const summaries = await ingestDocuments(dir);
      expect(summaries).toHaveLength(4);

      const after = await listFileHashes(dir);
      const listingAfter = (await readdir(dir)).sort();

      expect(after.size).toBe(before.size);
      for (const [name, hash] of before) {
        expect(after.get(name)).toBe(hash);
      }
      expect(listingAfter).toEqual(listingBefore);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('matches supported extensions case-insensitively', async () => {
    const dir = await makeDocumentDir();
    try {
      await writeFile(join(dir, 'RESUME.PDF'), samplePdfBytes());
      await writeFile(join(dir, 'Notes.MD'), '# Case notes\n', 'utf8');
      await writeFile(join(dir, 'posting.TXT'), 'Case posting\n', 'utf8');
      await copySampleDocx(dir, 'Resume.DOCX');
      await writeFile(join(dir, '.SECRET.TXT'), 'hidden\n', 'utf8');

      const summaries = await ingestDocuments(dir);

      expect(summaries.map((summary) => summary.fileName)).toEqual([
        'Notes.MD',
        'RESUME.PDF',
        'Resume.DOCX',
        'posting.TXT',
      ]);
      expect(summaries.map((summary) => summary.fileType)).toEqual(['markdown', 'pdf', 'docx', 'text']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('returns an empty result for an empty directory', async () => {
    const dir = await makeDocumentDir();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const summaries = await ingestDocuments(dir);
      expect(summaries).toEqual([]);
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('returns the same empty result with a friendly note for a not-yet-created directory', async () => {
    const root = await makeDocumentDir();
    const missing = join(root, 'documents');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await expect(ingestDocuments(missing)).resolves.toEqual([]);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('does not exist yet'));
      // Ingestion must not create the directory as a side effect.
      await expect(readdir(missing)).rejects.toThrow(/ENOENT/);
    } finally {
      warnSpy.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('redacts the home path in the missing-directory note', async () => {
    const home = homedir();
    const missing = join(home, `weJobSearch-ingest-missing-${randomUUID()}`);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await expect(ingestDocuments(missing, home)).resolves.toEqual([]);
      const note = warnSpy.mock.calls.map((call) => String(call[0])).join('\n');
      expect(note).toContain('<dataRoot>');
      expect(note).not.toContain(home);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('still throws for non-ENOENT scan failures', async () => {
    const root = await makeDocumentDir();
    const notADirectory = join(root, 'documents.txt');
    try {
      await writeFile(notADirectory, 'not a directory\n', 'utf8');
      await expect(ingestDocuments(notADirectory)).rejects.toThrow('Unable to read documents directory');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('honors an explicitly injected rootDir over the environment data root', async () => {
    const injectedRoot = await mkdtemp(join(tmpdir(), 'weJobSearch-ingest-injected-'));
    const envRoot = await mkdtemp(join(tmpdir(), 'weJobSearch-ingest-env-'));
    process.env.WEJOBSEARCHDATAROOT = envRoot;
    try {
      await writeFile(join(injectedRoot, 'resume.pdf'), samplePdfBytes());

      const summaries = await ingestDocuments(injectedRoot, injectedRoot);

      expect(summaries.map((summary) => summary.fileName)).toEqual(['resume.pdf']);
    } finally {
      await rm(injectedRoot, { recursive: true, force: true });
      await rm(envRoot, { recursive: true, force: true });
    }
  });

  it('skips a single corrupt file with a warning instead of failing the whole directory (Phase D)', async () => {
    const dir = await makeDocumentDir();
    try {
      await writeFile(join(dir, 'corrupt.pdf'), Buffer.from('this is not a pdf at all'));
      await writeFile(join(dir, 'postings.txt'), 'Saved posting text.\n', 'utf8');

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const summaries = await ingestDocuments(dir);
        expect(summaries.map((summary) => summary.fileName)).toEqual(['postings.txt']);
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('corrupt.pdf'));
      } finally {
        warnSpy.mockRestore();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
