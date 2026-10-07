import { readFile } from 'node:fs/promises';
import mammoth from 'mammoth';
import { cleanExtractedText } from './pdfParser';
import { redactHomePrefix } from './canonicalDataRoot';

// Lightweight .docx text extraction (EUO-12). Word documents are OOXML zip
// packages; mammoth extracts the plain text without any Word dependency.
//
// Discipline:
//   - Read-only (N6): this module only reads the source file into memory and
//     hands the buffer to mammoth; it never writes to the source path. The
//     test proves it by hashing the fixture file before and after extraction.
//   - Deterministic (N7): pure file reading + extraction, zero LLM calls.
//   - The extracted text goes through the same line-break-artifact cleanup as
//     pdfParser.ts (cleanExtractedText), so downstream consumers see one
//     consistent text shape regardless of source format.
//   - Missing/unreadable files and non-docx payloads produce clear errors
//     naming the path, mirroring the error convention of parsePdfDocument in
//     pdfParser.ts. No symmetric parseDocxDocument alias exists on purpose:
//     extractDocxText is the single canonical entry point (it returns plain
//     text, while parsePdfDocument returns text plus a page count, so a shared
//     name would mislead).
//
// Ownership (Phase 5c): consumed by documentIngestor.ts ingestDocuments.
// Single consumer by design, not dead code.

export async function extractDocxText(filePath: string): Promise<string> {
  let buffer: Buffer;
  try {
    buffer = await readFile(filePath);
  } catch (error) {
    throw new Error(`Unable to read docx file at ${redactHomePrefix(filePath)}: ${(error as Error).message}`);
  }
  try {
    const result = await mammoth.extractRawText({ buffer });
    return cleanExtractedText(result.value);
  } catch (error) {
    throw new Error(`Unable to parse docx at ${redactHomePrefix(filePath)}: ${(error as Error).message}`);
  }
}