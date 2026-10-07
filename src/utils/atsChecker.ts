import { PDFParse } from 'pdf-parse';
import { matchesWholeToken } from './postingIdentity';

export interface SectionDetection {
  name: string;
  index: number;
}

export interface AtsCheckOptions {
  expectedSections?: readonly string[];
}

export interface AtsCheckResult {
  passed: boolean;
  sectionsInOrder: boolean;
  detectedSections: SectionDetection[];
  missingSections: string[];
  missingKeywords: string[];
}

export const defaultExpectedSections: readonly string[] = ['Experience', 'Education', 'Skills'];

export async function extractPdfText(pdfBytes: Uint8Array): Promise<string> {
  const parser = new PDFParse({ data: Buffer.from(pdfBytes) });
  try {
    const result = await parser.getText();
    return result.text;
  } finally {
    await parser.destroy();
  }
}

// Section headings must stand on their own line (B14b anchoring): a substring
// match would "detect" Experience inside body prose like "work experience
// spans six years". Only the first anchored occurrence per section counts,
// and detection order follows line order. Phase D: a two-word heading whose
// last word is the section name and whose first word is a conventional resume
// qualifier (for example "Work Experience", "Professional Experience",
// "Technical Skills") also counts. The qualifier set is a heading taxonomy,
// not a personal threshold; anything longer stays exact-match-only, so body
// prose ("my extensive work experience spans years") can never match.
const headingQualifierWords: ReadonlySet<string> = new Set(['work', 'professional', 'technical', 'core']);

export function detectSectionHeadings(
  extractableText: string,
  expectedSections: readonly string[],
): SectionDetection[] {
  const detectedSections: SectionDetection[] = [];
  const seen = new Set<string>();
  const lines = extractableText.split(/\r?\n/);
  for (let lineNumber = 0; lineNumber < lines.length; lineNumber += 1) {
    const trimmed = lines[lineNumber].trim();
    const lowered = trimmed.toLowerCase();
    const words = lowered.split(/\s+/).filter((word) => word.length > 0);
    for (const section of expectedSections) {
      if (seen.has(section)) {
        continue;
      }
      const sectionLower = section.toLowerCase();
      if (lowered === sectionLower) {
        seen.add(section);
        detectedSections.push({ name: section, index: lineNumber });
      } else if (
        words.length === 2 &&
        words[1] === sectionLower &&
        headingQualifierWords.has(words[0])
      ) {
        seen.add(section);
        detectedSections.push({ name: section, index: lineNumber });
      }
    }
  }
  return detectedSections;
}

// Keyword presence with whitespace normalization (B14b): PDF text extraction
// inserts line breaks mid-phrase, so both the document text and multi-word
// keywords collapse whitespace before the whole-token match. Empty keywords
// never fail the check.
export function findMissingKeywords(
  extractableText: string,
  targetKeywords: readonly string[],
): string[] {
  return targetKeywords.filter(
    (keyword) => keyword.trim().length > 0 && !matchesWholeToken(extractableText, keyword),
  );
}

export async function checkAtsCompliance(
  pdfBytes: Uint8Array,
  targetKeywords: readonly string[],
  options: AtsCheckOptions = {},
): Promise<AtsCheckResult> {
  const expectedSections = options.expectedSections ?? defaultExpectedSections;
  const extractableText = await extractPdfText(pdfBytes);
  return evaluateAtsText(extractableText, targetKeywords, expectedSections);
}

// Pure ATS verdict over already-extracted text (U24/C8): every decision
// branch of checkAtsCompliance without requiring PDF bytes, so ordering
// failures, keyword misses, and empty documents are covered directly. The
// end-to-end pass on real resumes stays covered by the generator suites.
export function evaluateAtsText(
  extractableText: string,
  targetKeywords: readonly string[],
  expectedSections: readonly string[],
): AtsCheckResult {
  const detectedSections = detectSectionHeadings(extractableText, expectedSections);
  const detectedNames = new Set(detectedSections.map((detection) => detection.name));
  const missingSections = expectedSections.filter((section) => !detectedNames.has(section));
  // Order follows the expected sequence, not detection order (detection is
  // line-ordered by construction, so comparing detection indices could never
  // fail): the detected names, read top to bottom, must appear in expected
  // order.
  const expectedPositions = detectedSections.map((detection) => expectedSections.indexOf(detection.name));
  const sectionsInOrder = expectedPositions.every(
    (position, index) => index === 0 || expectedPositions[index - 1] < position,
  );
  const missingKeywords = findMissingKeywords(extractableText, targetKeywords);
  const passed =
    sectionsInOrder &&
    missingSections.length === 0 &&
    missingKeywords.length === 0 &&
    extractableText.trim().length > 0;
  return {
    passed,
    sectionsInOrder,
    detectedSections,
    missingSections,
    missingKeywords,
  };
}
