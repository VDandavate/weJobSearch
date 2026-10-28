import { describe, expect, it } from 'vitest';
import { validateProfileCompletion } from '../utils/profileService';
import {
  applicableQuestions,
  buildProfileInput,
  currentPlanVersion,
  reconcileAnswers,
  setupPlan,
  type SetupQuestion,
} from './setupPlan';
import { setupFixtureAnswers } from '../testUtils/setupFixture';

function idsOf(questions: readonly SetupQuestion[]): string[] {
  return questions.map((question) => question.id);
}

describe('setupPlan integrity', () => {
  it('uses a unique camelCase id and a single field path per entry', () => {
    const ids = setupPlan.map((question) => question.id);
    expect(new Set(ids).size).toBe(ids.length);
    const fields = setupPlan.map((question) => question.field);
    expect(new Set(fields).size).toBe(fields.length);
    for (const question of setupPlan) {
      expect(question.id, question.id).toMatch(/^[a-z][a-zA-Z0-9]*$/);
      expect(question.field, question.id).toMatch(/^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)*$/);
      expect(question.field.includes(','), question.id).toBe(false);
    }
  });

  it('gives every entry a non-empty why and recommended value', () => {
    for (const question of setupPlan) {
      expect(question.why.trim().length, question.id).toBeGreaterThan(0);
      expect(question.recommended.trim().length, question.id).toBeGreaterThan(0);
    }
  });

  it('requires the current plan version on every entry', () => {
    for (const question of setupPlan) {
      expect(question.planVersion, question.id).toBe(currentPlanVersion);
    }
  });

  it('gives choice entries options', () => {
    for (const question of setupPlan) {
      if (question.options !== undefined) {
        expect(question.options.length, question.id).toBeGreaterThan(0);
      }
    }
    expect(setupPlan.find((question) => question.id === 'clearanceStatus')?.options).toEqual([
      'none',
      'interim',
      'active',
      'expired',
    ]);
  });

  it('keeps destination sets disjoint across entries', () => {
    const destinations = setupPlan.flatMap((question) => question.destinations);
    expect(new Set(destinations).size).toBe(destinations.length);
  });

  it('covers contact, resume, work authorization, clearance, roles, locations, compensation, non-negotiables and notice period', () => {
    const sections = new Set(setupPlan.map((question) => question.section));
    expect([...sections].sort()).toEqual(
      [
        'clearance',
        'compensation',
        'contact',
        'locations',
        'nonNegotiables',
        'noticePeriod',
        'resume',
        'targetRoles',
        'workAuthorization',
      ].sort(),
    );
  });
});

describe('setupPlan predicates', () => {
  it('returns a boolean for every predicate on an empty answer set', () => {
    for (const question of setupPlan) {
      if (question.appliesWhen !== undefined) {
        expect(typeof question.appliesWhen({}), question.id).toBe('boolean');
      }
    }
  });

  it('skips clearance level until the status is interim or active', () => {
    const ids = (answers: Record<string, unknown>) => idsOf(applicableQuestions(answers));
    expect(ids({ clearanceStatus: 'none' })).not.toContain('clearanceLevel');
    expect(ids({ clearanceStatus: 'interim' })).toContain('clearanceLevel');
    expect(ids({ clearanceStatus: 'active' })).toContain('clearanceLevel');
    expect(ids({ clearanceStatus: 'expired' })).not.toContain('clearanceLevel');
  });

  it('offers remoteOnly only when noRelocation is declined', () => {
    expect(idsOf(applicableQuestions({ noRelocation: true }))).not.toContain('remoteOnly');
    expect(idsOf(applicableQuestions({ noRelocation: false }))).toContain('remoteOnly');
    expect(idsOf(applicableQuestions({}))).toContain('remoteOnly');
  });

  it('asks sponsorship type only when sponsorship is required', () => {
    expect(idsOf(applicableQuestions({ requiresSponsorship: true }))).toContain('sponsorshipType');
    expect(idsOf(applicableQuestions({ requiresSponsorship: false }))).not.toContain('sponsorshipType');
  });

  it('asks for a radius only when a location was provided', () => {
    expect(idsOf(applicableQuestions({ preferredLocations: ['Remote'] }))).toContain('searchRadiusMiles');
    expect(idsOf(applicableQuestions({ preferredLocations: [] }))).not.toContain('searchRadiusMiles');
  });
});

describe('setupPlan required fields match completion validation', () => {
  it('accepts a complete fixture answer set', () => {
    expect(validateProfileCompletion(buildProfileInput(setupFixtureAnswers))).toEqual([]);
  });

  it('blocks completion when any required question is unanswered', () => {
    for (const question of setupPlan.filter((entry) => entry.required)) {
      const answers = { ...setupFixtureAnswers };
      delete answers[question.id];
      const issues = validateProfileCompletion(buildProfileInput(answers));
      expect(issues.length, `${question.id} should block completion`).toBeGreaterThan(0);
    }
  });
});

describe('reconcileAnswers (plan version policy)', () => {
  it('drops answers keyed to question ids the plan no longer contains', () => {
    const result = reconcileAnswers({
      contactName: 'Jane Sample',
      removedQuestion: 'stale answer',
    });
    expect(result.answers).toEqual({ contactName: 'Jane Sample' });
    expect(result.droppedIds).toEqual(['removedQuestion']);
  });
});
