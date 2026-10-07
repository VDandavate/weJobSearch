import { readdir, readFile, stat } from 'node:fs/promises';
import { extname, join, relative } from 'node:path';
import { extractDocxText } from './docxParser';
import { cleanExtractedText, parsePdfDocument } from './pdfParser';
import { assertConfinedToRoot, redactHomePrefix, resolveDataRoot } from './canonicalDataRoot';

// Directory document ingestion (EUO-04): scans a directory for supported
// source documents (.pdf via pdfParser, .docx via docxParser, .md/.txt via
// the plain-text reader), parses each one, and returns a deterministic,
// structured per-file summary.
//
// Discipline:
//   - Read-only (N6): this module only reads. It never creates, modifies, or
//     deletes anything; the tests prove it by hashing every source file before
//     and after ingestion and asserting the directory listing is unchanged.
//   - Deterministic (N7): pure file reading + parsing, zero LLM calls, no
//     network access.
//   - Silent skipping: hidden files (dot-prefixed), unsupported extensions,
//     and subdirectories are ignored without error. An empty directory yields
//     an empty result; a missing directory throws an error naming the path.
//   - Strict camelCase throughout: no underscores in any identifier or key.
//
// Ownership (Phase 5c): consumed by the ingestDocuments MCP tool path in
// src/mcp/jobSearchServer.ts. Single consumer by design, not dead code.

export type IngestedFileType = 'pdf' | 'docx' | 'markdown' | 'text';

export interface IngestedDocumentSummary {
  /** Base file name, e.g. "resume.pdf". */
  fileName: string;
  /** Path relative to the scanned directory. */
  filePath: string;
  /** Detected document type. */
  fileType: IngestedFileType;
  /** Byte size of the source file on disk. */
  byteSize: number;
  /** Page count, present for PDFs only. */
  pageCount?: number;
  /** Character count of the cleaned extracted text, present for text and docx files. */
  charCount?: number;
  /** Cleaned extracted text (PDF via pdfParser, docx via docxParser, text via the shared cleaner). */
  text: string;
}

const supportedExtensions: Readonly<Record<string, IngestedFileType>> = {
  '.pdf': 'pdf',
  '.docx': 'docx',
  '.md': 'markdown',
  '.txt': 'text',
};

async function readTextFile(filePath: string): Promise<string> {
  try {
    const raw = await readFile(filePath, 'utf8');
    return cleanExtractedText(raw);
  } catch (error) {
    throw new Error(`Unable to read text file at ${redactHomePrefix(filePath)}: ${(error as Error).message}`);
  }
}

export async function ingestDocuments(dirPath: string, rootDir?: string | null): Promise<IngestedDocumentSummary[]> {
  const root = rootDir !== undefined && rootDir !== null && rootDir.trim().length > 0 ? rootDir : resolveDataRoot();
  const resolvedDir = assertConfinedToRoot(root, dirPath, 'ingestDocuments');
  let names: string[];
  try {
    names = await readdir(resolvedDir);
  } catch (error) {
    throw new Error(`Unable to read documents directory ${redactHomePrefix(resolvedDir)}: ${(error as Error).message}`);
  }

  const supportedNames = names
    .filter((name) => !name.startsWith('.'))
    .filter((name) => supportedExtensions[extname(name).toLowerCase()] !== undefined)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  // Phase D: per-file isolation. A single corrupt file (for example a bad
  // PDF) previously rejected the whole Promise.all and failed the directory.
  // Each file is now guarded: failures are skipped with a user-visible
  // warning and the rest of the directory is kept.
  const results: IngestedDocumentSummary[] = [];
  for (const name of supportedNames) {
    const fullPath = join(resolvedDir, name);
    try {
      const summary = await ingestOneFile(root, resolvedDir, fullPath, name);
      if (summary !== null) {
        results.push(summary);
      }
    } catch (error) {
      console.warn(`ingestDocuments: skipping unreadable file '${name}': ${(error as Error).message}`);
    }
  }

  return results;
}

async function ingestOneFile(
  root: string,
  resolvedDir: string,
  fullPath: string,
  name: string,
): Promise<IngestedDocumentSummary | null> {
  const info = await stat(fullPath);
  if (!info.isFile()) {
    // Subdirectories are not scanned (top-level scan only).
    return null;
  }
  const fileType = supportedExtensions[extname(name).toLowerCase()];
  const baseSummary = {
    fileName: name,
    filePath: relative(resolvedDir, fullPath),
    fileType,
    byteSize: info.size,
  };
  if (fileType === 'pdf') {
    const parsed = await parsePdfDocument(fullPath, root);
    return {
      ...baseSummary,
      pageCount: parsed.pageCount,
      text: parsed.text,
    };
  }
  if (fileType === 'docx') {
    const text = await extractDocxText(fullPath);
    return {
      ...baseSummary,
      charCount: text.length,
      text,
    };
  }
  const text = await readTextFile(fullPath);
  return {
    ...baseSummary,
    charCount: text.length,
    text,
  };
}
