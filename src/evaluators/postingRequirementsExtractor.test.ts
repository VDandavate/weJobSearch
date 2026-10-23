import { describe, expect, it } from 'vitest';
import {
  detectDomains,
  detectYearsOfExperience,
  extractPostingRequirements,
  extractPreferredSkills,
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
  it('reads a candidate-directed figure', () => {
    expect(detectYearsOfExperience('You have 5+ years of experience')).toBe(5);
  });
  it('reads the low end of a candidate-directed range', () => {
    expect(detectYearsOfExperience('At least 3 to 5 years of experience')).toBe(3);
  });
  it('ignores plainer statements', () => {
    expect(detectYearsOfExperience('We value a strong background')).toBe(null);
  });
  it('ignores company history that is not addressed to the candidate', () => {
    expect(detectYearsOfExperience('Our team has 20 years of experience delivering software.')).toBe(null);
    expect(detectYearsOfExperience('The company was founded 20 years ago.')).toBe(null);
    expect(detectYearsOfExperience('Our founder has 15 years of experience.')).toBe(null);
  });
  it('does not borrow a cue from another sentence', () => {
    expect(detectYearsOfExperience('You must ship code. Our team has 20 years of experience.')).toBe(null);
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
  it('keeps skills governed by a preferred cue out of the required list', () => {
    expect(
      extractRequiredSkills('We require Python and SQL. Preferred: Kubernetes, AWS, Terraform.', 'Engineer'),
    ).toEqual(['Python', 'SQL']);
    expect(
      extractPreferredSkills('We require Python and SQL. Preferred: Kubernetes, AWS, Terraform.'),
    ).toEqual(['Kubernetes', 'Terraform', 'AWS']);
  });
  it('scopes a preferred cue to its own sentence or list item', () => {
    const description = [
      'Python is required for the platform.',
      'Nice to have: Kubernetes.',
      'AWS is required for this team.',
    ].join('\n\n');
    expect(extractRequiredSkills(description, 'Engineer')).toEqual(['Python', 'AWS']);
    expect(extractPreferredSkills(description)).toEqual(['Kubernetes']);
  });
  it('applies a preferred heading to the list items that follow it', () => {
    const description = [
      'Requirements:',
      '- Python',
      'Preferred qualifications:',
      '- Kubernetes',
      '- AWS',
    ].join('\n');
    expect(extractRequiredSkills(description, 'Engineer')).toEqual(['Python']);
    expect(extractPreferredSkills(description)).toEqual(['Kubernetes', 'AWS']);
  });
  it('ends a preferred heading when a plain heading follows', () => {
    const description = ['Preferred qualifications:', '- Kubernetes', 'Requirements:', '- Python'].join('\n');
    expect(extractRequiredSkills(description, 'Engineer')).toEqual(['Python']);
    expect(extractPreferredSkills(description)).toEqual(['Kubernetes']);
  });
  it('keeps a skill required when it also appears in an unflagged sentence', () => {
    expect(
      extractRequiredSkills('Python is required. Nice to have: Python and Go.', 'Engineer'),
    ).toEqual(['Python']);
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
        'Automation role requiring Ruby and Python. You need 4+ years of experience. Healthcare domain focus.',
        'Ruby Automation Engineer',
      ),
    );
    expect(requirements.requiredSkills).toEqual(['Python', 'Ruby']);
    expect(requirements.requiredYearsOfExperience).toBe(4);
    expect(requirements.requiredDomains).toEqual(['Healthcare']);
  });

  it('separates preferred skills from required skills', () => {
    const requirements = extractPostingRequirements(
      posting('Python required. Preferred: Kubernetes, AWS, Terraform.', 'Platform Engineer'),
    );
    expect(requirements.requiredSkills).toEqual(['Python']);
    expect(requirements.preferredSkills).toEqual(['Kubernetes', 'Terraform', 'AWS']);
  });

  it('does not create a domain requirement from the company name or role title', () => {
    const requirements = extractPostingRequirements({
      ...posting('We build dashboards for internal teams.', 'HealthTech Platform Engineer'),
      companyName: 'HealthTech Partners',
    });
    expect(requirements.requiredDomains).toEqual([]);
  });

  it('does not create a domain requirement from marketing copy without a domain cue', () => {
    const requirements = extractPostingRequirements(
      posting('We are a cybersecurity leader trusted by thousands of customers.'),
    );
    expect(requirements.requiredDomains).toEqual([]);
  });

  it('creates a domain requirement from description text with a domain cue', () => {
    const requirements = extractPostingRequirements(
      posting('Experience in cybersecurity is required for this role.'),
    );
    expect(requirements.requiredDomains).toEqual(['Cybersecurity']);
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