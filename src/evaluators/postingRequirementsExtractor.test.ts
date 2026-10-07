import { describe, expect, it } from 'vitest';
import {
  detectDomains,
  detectYearsOfExperience,
  extractPostingRequirements,
  extractRequiredSkills,
} from './postingRequirementsExtractor';
import type { RawPosting } from '../scrapers/jobSpyAdapter';

function posting(description: string, roleTitle = 'Platform Engineer'): RawPosting {
  return {
    sourceAggregator: 'testSource',
    companyName: 'TestCo',
    roleTitle,
    location: 'Remote',
    jobUrl: 'https://example.test/jobs/1',
    description,
    hasFullDescription: true,
    postedAt: null,
  };
}

describe('detectYearsOfExperience', () => {
  it('reads a bare figure', () => {
    expect(detectYearsOfExperience('5+ years of experience')).toBe(5);
  });
  it('reads the low end of a range', () => {
    expect(detectYearsOfExperience('between 3 to 5 years of experience')).toBe(3);
  });
  it('ignores plainer statements', () => {
    expect(detectYearsOfExperience('We value a strong background')).toBe(null);
  });
});

describe('extractRequiredSkills', () => {
  it('matches named skills and ignores common English words', () => {
    expect(extractRequiredSkills('Ship code in Go and Python daily.', 'Engineer')).toEqual([
      'Python',
    ]);
  });
  it('reads the role title too', () => {
    expect(extractRequiredSkills('Build great product.', 'React Engineer')).toContain('React');
  });
  it('extracts non-word tokens like C# and C++ (U41 shared matcher)', () => {
    expect(
      extractRequiredSkills('5+ years with C#, C++, .NET and Azure. Strong JavaScript.', 'Engineer'),
    ).toEqual(expect.arrayContaining(['C#', 'C++', 'JavaScript']));
  });
});

describe('detectDomains', () => {
  it('matches a stated industry', () => {
    expect(detectDomains('We run fintech payment rails.')).toEqual(['FinTech']);
  });
  it('returns nothing when no domain vocabulary fires', () => {
    expect(detectDomains('We judge candidates on plain merit.')).toEqual([]);
  });
});

describe('extractPostingRequirements', () => {
  it('builds the requirement triple from posting text', () => {
    const requirements = extractPostingRequirements(
      posting(
        'Automation role requiring Ruby and Python. 4+ years of experience. Healthcare domain focus.',
        'Ruby Automation Engineer',
      ),
    );
    expect(requirements.requiredSkills).toEqual(['Python', 'Ruby']);
    expect(requirements.requiredYearsOfExperience).toBe(4);
    expect(requirements.requiredDomains).toEqual(['Healthcare']);
  });

  it('leaves unstated signals empty', () => {
    const requirements = extractPostingRequirements(
      posting('Thoughtful platform work for strong generalists.'),
    );
    expect(requirements.requiredSkills).toEqual([]);
    expect(requirements.requiredYearsOfExperience).toBe(null);
    expect(requirements.requiredDomains).toEqual([]);
  });

  it('never invents a skill from dictionary prose', () => {
    const requirements = extractPostingRequirements(
      posting('Established processes, strong communication, and quality outlook.'),
    );
    expect(requirements.requiredSkills).toEqual([]);
  });
});