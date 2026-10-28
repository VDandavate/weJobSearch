import { describe, expect, it } from 'vitest';
import { buildProfileInput } from './setupPlan';
import { renderProfileDraft, renderProfileSection } from './profileDraft';
import { setupFixtureAnswers } from '../testUtils/setupFixture';

const input = buildProfileInput(setupFixtureAnswers);

const expectedDraft = `Contact
-------
  Name          Jane Sample
  Email         jane.sample@example.com
  Phone         +1 555 0100
  City / State  Austin, TX
  LinkedIn      https://linkedin.com/in/janesample
  Portfolio     https://janesample.dev

Work authorization
------------------
  US Citizen    Yes
  Sponsorship   No
  Clearance     none

Summary
-------
  Senior platform engineer with 8+ years of experience.

Skills
------
  Languages     TypeScript, Rust

Experience
----------
  Senior Platform Engineer | AcmeCorp | San Francisco, CA | 2021-03 - Present

Education
---------
  BS Computer Science | SampleState University | 2010 - 2014

Certifications
--------------
  AWS Certified Developer
`;

describe('profileDraft renderer', () => {
  it('renders the fixture profile as a fixed plain-text table', () => {
    expect(renderProfileDraft(input)).toBe(expectedDraft);
  });

  it('puts City / State on its own row', () => {
    const lines = renderProfileSection('contact', input).split('\n');
    expect(lines.some((line) => line.startsWith('  City / State'))).toBe(true);
  });

  it('renders one line per experience and education entry', () => {
    const experience = renderProfileSection('experience', input)
      .split('\n')
      .filter((line) => line.includes(' | '));
    expect(experience).toHaveLength(1);
    const education = renderProfileSection('education', input)
      .split('\n')
      .filter((line) => line.includes(' | '));
    expect(education).toHaveLength(1);
  });

  it('prints not provided (optional) for empty optional links and sections', () => {
    const blank = buildProfileInput({
      contactName: 'Jane Sample',
      contactEmail: 'jane.sample@example.com',
      contactPhone: '+1 555 0100',
      contactCityState: 'Austin, TX',
    });
    const rendered = renderProfileDraft(blank);
    expect(rendered).toContain('LinkedIn      not provided (optional)');
    expect(rendered).toContain('Portfolio     not provided (optional)');
    expect(rendered).toContain('not provided (optional)');
  });

  it('never emits markdown syntax or JSON brackets', () => {
    const rendered = renderProfileDraft(input);
    expect(rendered).not.toMatch(/^#/m);
    expect(rendered).not.toMatch(/[[\]{}]/);
    expect(rendered).not.toContain('**');
  });
});
