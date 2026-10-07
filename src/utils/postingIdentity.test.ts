import { describe, expect, it } from 'vitest';
import { matchesWholeToken, tokenPattern } from './postingIdentity';

// U41: the single whole-token matcher shared by the ATS checker, the
// hallucination guards, and the requirements extractor.

describe('matchesWholeToken', () => {
  it('matches plain words with word boundaries', () => {
    expect(matchesWholeToken('Built systems in Java and Rust.', 'java')).toBe(true);
    expect(matchesWholeToken('Built systems in JavaScript.', 'java')).toBe(false);
  });

  it('matches tokens with non-word characters', () => {
    expect(matchesWholeToken('Built services in C#, C++ and .NET.', 'C#')).toBe(true);
    expect(matchesWholeToken('Built services in C#, C++ and .NET.', 'C++')).toBe(true);
    expect(matchesWholeToken('Built services in C#, C++ and .NET.', '.NET')).toBe(true);
    expect(matchesWholeToken('No relevant background here.', 'C#')).toBe(false);
  });

  it('matches across line breaks and ignores case', () => {
    expect(matchesWholeToken('Deep background in Machine\nLearning systems.', 'machine learning')).toBe(true);
  });

  it('never matches empty keywords', () => {
    expect(matchesWholeToken('Anything at all.', '')).toBe(false);
  });

  it('builds equivalent patterns for vocabulary tables', () => {
    expect(tokenPattern('c++').test('uses C++ daily')).toBe(true);
    expect(tokenPattern('node.js').test('uses nodeXjs daily')).toBe(false);
    expect(tokenPattern('node.js').test('uses node.js daily')).toBe(true);
  });
});
