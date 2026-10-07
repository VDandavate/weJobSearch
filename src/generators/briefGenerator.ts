// Deterministic extractive posting Brief (SDD Requirement 2a). The CLI has no
// LLM provider integration, so the Brief is never a live model call: this
// module owns Brief generation for the evaluate/search pipeline (invoked from
// the search orchestrator) and selects the first meaningful sentence(s) of the
// posting description verbatim, truncating them to the shared 150-character
// ceiling owned by the Active Results formatter. Because selection and
// compression only re-emit text that already exists in the source posting, the
// zero-hallucination grounding rule is satisfied trivially - it cannot invent a
// claim. When evaluate/search run under MCP inside an agent session, the
// orchestrating agent may supply a richer summary in place of this extractive
// output; the CLI never relies on that being available.

import { briefMaxLength, truncateWithEllipsis } from '../reporting/scrapeResultsFormatter';

// Single-sourced ceiling: the Active Results formatter owns the 150-character
// Brief contract (SDD Requirement 2a). This module consumes it as the default;
// import briefMaxLength directly from the formatter (no alias lives here).

const minimumMeaningfulWordCount = 4;

// Leading section-label phrases stripped once from the start of a description
// so headings ("About the role", "Job description") never become the Brief.
// Ordered longest-first so the alternation prefers the most specific phrase.
const sectionHeaderClause = [
  'about the role',
  'about the job',
  'about the position',
  'job description',
  'job summary',
  'job overview',
  'job details',
  'position description',
  'position summary',
  'position overview',
  'the role overview',
  'what you will do',
  "what you'll do",
  'what are we looking for',
  'what we are looking for',
  'company description',
  'company overview',
  'company about',
  'role overview',
  'responsibilities',
  'requirements',
  'qualifications',
  'the role',
  'the position',
  'about us',
  'who we are',
].join('|');

const leadingSectionHeaderRe = new RegExp(
  `^\\s*(?:${sectionHeaderClause})\\s*[:=—–\\-]?\\s*`,
  'i',
);

// A sentence that collapses to a header label (colon/dash stripped) is a
// section heading, not content; filtering it keeps the extractor on prose.
const wholeSectionHeaderRe = new RegExp(
  `^(?:${sectionHeaderClause})$`,
  'i',
);

function normalizePostingText(description: string): string {
  return description.replace(/\s+/g, ' ').trim();
}

function splitIntoSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);
}

function isMeaningfulSentence(sentence: string): boolean {
  const trimmed = sentence.trim();
  if (trimmed.length === 0) {
    return false;
  }
  if (trimmed.split(/\s+/).length < minimumMeaningfulWordCount) {
    return false;
  }
  return !wholeSectionHeaderRe.test(trimmed.replace(/[:=—–\-]+$/g, ''));
}

export function generateBrief(
  description: string,
  options: { maxLength?: number } = {},
): string {
  const maxLength = options.maxLength ?? briefMaxLength;
  const normalized = normalizePostingText(description);
  if (normalized.length === 0) {
    return '';
  }
  const headerStripped = normalized.replace(leadingSectionHeaderRe, '');
  const candidates = headerStripped.length > 0 ? headerStripped : normalized;
  const sentences = splitIntoSentences(candidates).filter(isMeaningfulSentence);
  if (sentences.length === 0) {
    return textTruncate(normalized, maxLength);
  }

  let brief = sentences[0];
  const second = sentences[1];
  if (second !== undefined && brief.length < Math.floor(maxLength / 2)) {
    brief = `${brief} ${second}`;
  }
  return textTruncate(brief, maxLength);
}

function textTruncate(value: string, maxLength: number): string {
  return truncateWithEllipsis(value, maxLength);
}