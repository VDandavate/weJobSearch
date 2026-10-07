import { describe, expect, it } from 'vitest';
import { screeningAnswersSchema } from './profileSchemas';

// U24/C8: direct bounds tests for the shared screening-answers schema.
// Integration paths (init wizard, profile MCP tools) cover it transitively;
// these pin the shape itself.

const validAnswers = {
  workAuthorization: { usCitizen: false, requiresSponsorship: true, sponsorshipType: 'H-1B' },
  compensation: { minBaseSalary: 0, targetBaseSalary: 0, currency: 'USD' },
  standardQuestions: {
    yearsOfExperience: { softwareEngineering: 6 },
    preferredWorkLocation: 'Remote',
    noticePeriod: '2 weeks',
  },
};

describe('screeningAnswersSchema bounds', () => {
  it('accepts a fully populated document', () => {
    expect(screeningAnswersSchema.safeParse(validAnswers).success).toBe(true);
  });

  it('rejects wrong primitive types', () => {
    const wrongTypes = {
      ...validAnswers,
      workAuthorization: { usCitizen: 'no', requiresSponsorship: false, sponsorshipType: null },
      compensation: { minBaseSalary: 'low', targetBaseSalary: 0, currency: 'USD' },
    };
    expect(screeningAnswersSchema.safeParse(wrongTypes).success).toBe(false);
  });

  it('rejects a missing top-level section', () => {
    const { compensation, ...withoutCompensation } = validAnswers;
    expect(screeningAnswersSchema.safeParse(withoutCompensation).success).toBe(false);
  });

  it('rejects non-numeric experience values', () => {
    const badYears = {
      ...validAnswers,
      standardQuestions: {
        ...validAnswers.standardQuestions,
        yearsOfExperience: { softwareEngineering: 'six' },
      },
    };
    expect(screeningAnswersSchema.safeParse(badYears).success).toBe(false);
  });
});
