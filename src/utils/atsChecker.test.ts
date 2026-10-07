import { describe, expect, it } from 'vitest';
import { detectSectionHeadings, evaluateAtsText, findMissingKeywords } from './atsChecker';

// B14b: line/heading-anchored section matching plus whitespace-tolerant
// keyword matching. Pure string-level tests (no PDF bytes needed): the
// end-to-end ATS pass on real resumes is covered by the generator suites.

describe('detectSectionHeadings', () => {
  it('detects headings standing on their own line, in order', () => {
    const text = ['Jane Doe', 'Experience', 'Senior Engineer', 'Education', 'BSc', 'Skills', 'TypeScript'].join(
      '\n',
    );
    const detected = detectSectionHeadings(text, ['Experience', 'Education', 'Skills']);
    expect(detected.map((detection) => detection.name)).toEqual(['Experience', 'Education', 'Skills']);
  });

  it('ignores section names buried in body prose', () => {
    const text = ['Jane Doe', 'My work experience spans six years.', 'Skills', 'TypeScript'].join('\n');
    const detected = detectSectionHeadings(text, ['Experience', 'Education', 'Skills']);
    expect(detected.map((detection) => detection.name)).toEqual(['Skills']);
  });

  it('matches headings case-insensitively and keeps first occurrences', () => {
    const text = ['EXPERIENCE', 'Senior Engineer', 'Experience', 'More work'].join('\n');
    const detected = detectSectionHeadings(text, ['Experience']);
    expect(detected).toHaveLength(1);
    expect(detected[0].index).toBe(0);
  });

  it('detects conventional two-word headings like Work Experience (Phase D)', () => {
    const text = ['Jane Doe', 'Work Experience', 'Senior Engineer', 'Technical Skills', 'TypeScript'].join('\n');
    const detected = detectSectionHeadings(text, ['Experience', 'Education', 'Skills']);
    expect(detected.map((detection) => detection.name)).toEqual(['Experience', 'Skills']);
  });

  it('still ignores longer prose lines ending in a section name', () => {
    const text = ['Jane Doe', 'A decade of relevant work experience', 'Skills', 'TypeScript'].join('\n');
    const detected = detectSectionHeadings(text, ['Experience', 'Education', 'Skills']);
    expect(detected.map((detection) => detection.name)).toEqual(['Skills']);
  });
});

describe('findMissingKeywords', () => {
  it('matches multi-word keywords split across line breaks', () => {
    expect(findMissingKeywords('Deep background in machine\nlearning systems.', ['machine learning'])).toEqual([]);
  });

  it('still reports genuinely absent keywords', () => {
    expect(findMissingKeywords('TypeScript and Rust.', ['COBOL'])).toEqual(['COBOL']);
  });

  it('finds non-word tokens like C# that word boundaries miss (U41 shared matcher)', () => {
    expect(findMissingKeywords('Built services in C#, C++ and .NET.', ['C#', 'C++', 'COBOL'])).toEqual([
      'COBOL',
    ]);
  });

  it('never fails on empty keywords', () => {
    expect(findMissingKeywords('Anything.', ['', '   '])).toEqual([]);
  });
});

describe('evaluateAtsText', () => {
  const sections = ['Experience', 'Education', 'Skills'];

  it('passes ordered headings with present keywords', () => {
    const text = ['Jane Doe', 'Experience', 'Built systems.', 'Education', 'BSc.', 'Skills', 'TypeScript'].join(
      '\n',
    );
    const result = evaluateAtsText(text, ['typescript'], sections);
    expect(result.passed).toBe(true);
    expect(result.sectionsInOrder).toBe(true);
    expect(result.missingSections).toEqual([]);
    expect(result.missingKeywords).toEqual([]);
  });

  it('fails out-of-order headings', () => {
    const text = ['Skills', 'TypeScript', 'Experience', 'Built systems.', 'Education', 'BSc.'].join('\n');
    const result = evaluateAtsText(text, [], sections);
    expect(result.passed).toBe(false);
    expect(result.sectionsInOrder).toBe(false);
  });

  it('fails missing sections and missing keywords', () => {
    const result = evaluateAtsText('Jane Doe\nExperience\nBuilt systems.', ['cobol'], sections);
    expect(result.passed).toBe(false);
    expect(result.missingSections).toEqual(['Education', 'Skills']);
    expect(result.missingKeywords).toEqual(['cobol']);
  });

  it('fails empty documents', () => {
    const result = evaluateAtsText('   \n ', [], sections);
    expect(result.passed).toBe(false);
  });
});
