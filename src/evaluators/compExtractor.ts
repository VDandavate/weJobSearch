import type { RawPosting } from '../scrapers/jobSpyAdapter';

// Parses the inconsistent rawSalaryText formats each adapter emits into a
// single normalized compensation structure for fitEvaluator and both result
// tables. This module makes no fit judgment and applies no thresholds; it is
// pure text normalization. When rawSalaryText is absent, parseCompensation
// returns null rather than throwing.
//
// Real committed output formats this parses (from the six Step 3 adapters):
//   - hiringCafe:    "USD 160,000-190,000/yr"        (currency prefix, dash, /yr|/mo|/wk|/hr suffix)
//   - WTTJ:          "Salary: EUR 45,000 - 55,000 (per year)"  (parenthesized period label)
//   - builtIn:       "USD 120,000 - 225,000 per year" (currency prefix, trailing "per X")
//   - flexJobs:      "68,000 - 85,000 USD Annually"  (amounts first, currency, sliding label)
//   - linkedIn, wellfound: no rawSalaryText (absence -> null)

export type CompensationPeriod = 'year' | 'hour' | 'unknown';

export interface ParsedCompensation {
  currency: string;
  minAmount: number | null;
  maxAmount: number | null;
  period: CompensationPeriod;
}

// US-market target default when no currency marker is present (SDD 1.1).
const defaultCurrency = 'USD';

const currencyCodeRe = /\b(USD|EUR|GBP|CAD|AUD|CHF|JPY|CNY|SEK|NOK|DKK|PLN)\b/i;

const yearPeriodRe = /(?:per\s+year|per\s+annum|\/yr\b|\byearly\b|\bannually\b)/i;
const hourPeriodRe = /(?:per\s+hour|hourly|\/hr\b|\bhr\b|\bhour\b)/i;

function detectCurrency(raw: string): string {
  const codeMatch = currencyCodeRe.exec(raw);
  if (codeMatch !== null) {
    return codeMatch[1].toUpperCase();
  }
  if (raw.includes('\u20AC')) {
    return 'EUR';
  }
  if (raw.includes('$')) {
    return 'USD';
  }
  if (raw.includes('\u00A3')) {
    return 'GBP';
  }
  if (raw.includes('\u00A5')) {
    return 'JPY';
  }
  return defaultCurrency;
}

function detectPeriod(raw: string): CompensationPeriod {
  if (yearPeriodRe.test(raw)) {
    return 'year';
  }
  if (hourPeriodRe.test(raw)) {
    return 'hour';
  }
  // Explicit month/week units map to unknown; the normalized contract only
  // distinguishes year and hour. Never scale a figure here - that would be a
  // fit judgment, which belongs to fitEvaluator (Step 4), not this normalizer.
  return 'unknown';
}

function normalizeAmountToken(token: string): number {
  if (/^\d{1,3}(?:[.,]\d{3})+$/.test(token)) {
    return Number(token.replace(/[.,]/g, ''));
  }
  if (/^\d+(?:\.\d+)?$/.test(token)) {
    return Number(token);
  }
  return Number(token.replace(/[.,]/g, ''));
}

function extractAmounts(raw: string): number[] {
  const values: number[] = [];
  const tokenRe = /(\d[\d,.]*)\s*([kK])?/g;
  let match: RegExpExecArray | null;
  while ((match = tokenRe.exec(raw)) !== null) {
    const rawToken = match[1] ?? '';
    if (rawToken.length === 0) {
      continue;
    }
    const value = normalizeAmountToken(rawToken);
    if (!Number.isFinite(value)) {
      continue;
    }
    const multiplier = match[2] !== undefined && match[2].length > 0 ? 1000 : 1;
    values.push(value * multiplier);
  }
  return values;
}

export function parseCompensation(
  rawSalaryText: string | null | undefined,
): ParsedCompensation | null {
  if (rawSalaryText === null || rawSalaryText === undefined) {
    return null;
  }
  const normalized = rawSalaryText.replace(/[\u2013\u2014]/g, '-').trim();
  if (normalized.length === 0) {
    return null;
  }
  const amounts = extractAmounts(normalized);
  if (amounts.length === 0) {
    return null;
  }
  const minAmount = Math.min(...amounts);
  const maxAmount = Math.max(...amounts);
  return {
    currency: detectCurrency(normalized),
    minAmount,
    maxAmount,
    period: detectPeriod(normalized),
  };
}

export function compensationFromPosting(posting: Pick<RawPosting, 'rawSalaryText'>): ParsedCompensation | null {
  return parseCompensation(posting.rawSalaryText);
}