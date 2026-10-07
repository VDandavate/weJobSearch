import { readFile } from 'node:fs/promises';
import { PDFParse } from 'pdf-parse';
import { assertConfinedToRoot, redactHomePrefix, resolveDataRoot } from './canonicalDataRoot';

export interface ParsedPdfDocument {
  text: string;
  pageCount: number;
}

export function cleanExtractedText(rawText: string): string {
  let text = rawText.replace(/\r\n?/g, '\n');
  text = text.replace(/([A-Za-z])-\n/g, '$1');
  text = text.replace(/([A-Za-z])- \n/g, '$1 ');
  text = text.replace(/[ \t\u00A0]+/g, ' ');
  text = text.replace(/\n{3,}/g, '\n\n');
  return text.trim();
}

export async function parsePdfDocument(filePath: string, rootDir?: string | null): Promise<ParsedPdfDocument> {
  const root = rootDir !== undefined && rootDir !== null && rootDir.trim().length > 0 ? rootDir : resolveDataRoot();
  const resolvedPath = assertConfinedToRoot(root, filePath, 'parsePdfDocument');
  let buffer: Buffer;
  try {
    buffer = await readFile(resolvedPath);
  } catch (error) {
    throw new Error(`Unable to read PDF file at ${redactHomePrefix(resolvedPath)}: ${(error as Error).message}`);
  }
  const parser = new PDFParse({ data: buffer });
  try {
    const result = await parser.getText();
    return {
      text: cleanExtractedText(result.text),
      pageCount: result.total,
    };
  } catch (error) {
    throw new Error(`Unable to parse PDF at ${redactHomePrefix(resolvedPath)}: ${(error as Error).message}`);
  } finally {
    await parser.destroy();
  }
}
