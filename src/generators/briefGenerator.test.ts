import { describe, expect, it } from 'vitest';
import { generateBrief } from './briefGenerator';
import { briefMaxLength } from '../reporting/scrapeResultsFormatter';

describe('generateBrief', () => {
  it('returns the first meaningful sentence of a posting description verbatim', () => {
    const description =
      'About the role\nWe need a reliable senior engineer to own our large event streaming pipeline end to end. This is a secondary detail.';
    const brief = generateBrief(description);
    expect(brief).toBe(
      'We need a reliable senior engineer to own our large event streaming pipeline end to end.',
    );
  });

  it('prefers the overview paragraph when the description does not start with the body text', () => {
    const description =
      'Job description\nEnvironment, Health, and Safety practices. Build a real-time trading dashboard with TypeScript.';
    const brief = generateBrief(description);
    expect(brief).toContain('TypeScript');
  });

  it('truncates an overlong first sentence to 150 total characters including the ellipsis', () => {
    const filler = 'We stack up a very long run-on sentence that keeps going and going';
    const description = `${filler} ${filler} ${filler} ${filler} ${filler} without stopping for a breath.`;
    const brief = generateBrief(description);
    expect(brief.length).toBe(150);
    expect(brief.endsWith('...')).toBe(true);
  });

  it('never exceeds the configured max length', () => {
    const description = 'A '.repeat(120).trim();
    const brief = generateBrief(description, { maxLength: 80 });
    expect(brief.endsWith('...')).toBe(true);
    const source = brief.replace(/\.\.\.$/, '');
    expect(source.length).toBeLessThanOrEqual(80);
  });

  it('is deterministic: identical input yields identical output', () => {
    const description = 'We schedule a flat predictable interview loop. Expect four stages.';
    const first = generateBrief(description);
    const second = generateBrief(description);
    expect(first).toBe(second);
  });

  it('is extractive: every output fragment is present in the source description', () => {
    const description = 'Operate a stable release train across the whole service fleet.';
    const brief = generateBrief(description);
    expect(description.includes(brief)).toBe(true);
  });

  it('returns an empty string for an empty description', () => {
    expect(generateBrief('')).toBe('');
    expect(generateBrief('   ')).toBe('');
  });

  it('respects the 150 character default ceiling', () => {
    const brief = generateBrief('Sentence one. '.repeat(40));
    const withoutEllipsis = brief.endsWith('...') ? brief.slice(0, -3) : brief;
    expect(withoutEllipsis.length).toBeLessThanOrEqual(briefMaxLength);
  });
});