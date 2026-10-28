import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  answerSetupQuestion,
  commitSetup,
  getSetupQuestion,
} from './setupCursor';
import { applicableQuestions, buildProfileInput } from './setupPlan';
import {
  initializeUserProfile,
  readUserProfile,
  validateProfileCompletion,
  type ProfileInitializationInput,
} from '../utils/profileService';
import { parseJobPreferences } from '../evaluators/fitEvaluator';
import { writeSetupState } from '../utils/setupState';
import { setupFixtureAnswers } from '../testUtils/setupFixture';

async function withRoot<T>(fn: (dataRoot: string) => Promise<T>): Promise<T> {
  const dataRoot = await mkdtemp(join(tmpdir(), 'weJobSearch-setupCursor-'));
  try {
    return await fn(dataRoot);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
}

async function driveToReady(dataRoot: string): Promise<string[]> {
  const asked: string[] = [];
  for (let guard = 0; guard < 200; guard += 1) {
    const question = await getSetupQuestion({ dataRoot });
    if (question.status === 'readyToConfirm') {
      return asked;
    }
    const questionId = question.questionId as string;
    asked.push(questionId);
    const answer = setupFixtureAnswers[questionId];
    await answerSetupQuestion(
      { questionId, answer: answer === undefined ? null : answer },
      { dataRoot },
    );
  }
  throw new Error('setup plan did not reach readyToConfirm');
}

describe('setup question cursor', () => {
  it('starts at the first question and reports progress', async () => {
    await withRoot(async (dataRoot) => {
      const question = await getSetupQuestion({ dataRoot });
      expect(question.status).toBe('question');
      expect(question.questionId).toBe('contactName');
      expect(question.index).toBe(1);
      expect(question.total).toBe(applicableQuestions({}).length);
      expect(question.draft).toBeUndefined();
    });
  });

  it('never writes a profile file or a checkpoint on a read', async () => {
    await withRoot(async (dataRoot) => {
      await getSetupQuestion({ dataRoot });
      expect(existsSync(join(dataRoot, 'setupState.json'))).toBe(false);
      expect(existsSync(join(dataRoot, 'masterProfile.md'))).toBe(false);
    });
  });

  it('rejects an out-of-order answer', async () => {
    await withRoot(async (dataRoot) => {
      await getSetupQuestion({ dataRoot });
      await expect(
        answerSetupQuestion({ questionId: 'experience', answer: [] }, { dataRoot }),
      ).rejects.toThrow(/Out-of-order answer: expected 'contactName'/);
    });
  });

  it('rejects a skip on a required question with its reason', async () => {
    await withRoot(async (dataRoot) => {
      await getSetupQuestion({ dataRoot });
      await expect(
        answerSetupQuestion({ questionId: 'contactName', answer: null }, { dataRoot }),
      ).rejects.toThrow(/'contactName' is required:/);
    });
  });

  it('accepts a skip on an optional question and advances', async () => {
    await withRoot(async (dataRoot) => {
      await driveToQuestion(dataRoot, 'contactLinkedIn');
      const next = await answerSetupQuestion(
        { questionId: 'contactLinkedIn', answer: null },
        { dataRoot },
      );
      expect(next.questionId).toBe('contactPortfolio');
      expect(existsSync(join(dataRoot, 'setupState.json'))).toBe(true);
    });
  });

  it('validates the answer for the field', async () => {
    await withRoot(async (dataRoot) => {
      await getSetupQuestion({ dataRoot });
      await expect(
        answerSetupQuestion({ questionId: 'contactName', answer: 42 }, { dataRoot }),
      ).rejects.toThrow(/Name must be a non-empty string/);
    });
  });

  it('refuses to commit without confirmed: true and writes nothing', async () => {
    await withRoot(async (dataRoot) => {
      await driveToReady(dataRoot);
      await expect(commitSetup({ confirmed: false }, { dataRoot })).rejects.toThrow(
        /requires confirmed: true/,
      );
      expect(existsSync(join(dataRoot, 'masterProfile.md'))).toBe(false);
      expect(existsSync(join(dataRoot, 'jobPreferences.yaml'))).toBe(false);
    });
  });

  it('reports blocking field ids instead of writing an incomplete profile', async () => {
    await withRoot(async (dataRoot) => {
      await getSetupQuestion({ dataRoot });
      await answerSetupQuestion(
        { questionId: 'contactName', answer: 'Jane Sample' },
        { dataRoot },
      );
      await expect(commitSetup({ confirmed: true }, { dataRoot })).rejects.toThrow(
        /Blocking fields:.*contact\.email/,
      );
      expect(existsSync(join(dataRoot, 'masterProfile.md'))).toBe(false);
    });
  });

  it('resumes at the stored cursor and reports the last answer time instead of discarding answers', async () => {
    await withRoot(async (dataRoot) => {
      await writeSetupState(
        {
          step: 'profileProposed',
          updatedAt: '2026-08-01T10:00:00.000Z',
          cursor: { questionId: 'summary' },
          answers: { contactName: 'Jane Sample' },
        },
        join(dataRoot, 'setupState.json'),
      );
      const question = await getSetupQuestion({ dataRoot });
      expect(question.questionId).toBe('summary');
      expect(question.resuming).toBe(true);
      expect(question.lastAnsweredAt).toBe('2026-08-01T10:00:00.000Z');
    });
  });

  it('clears the checkpoint on an explicit restart', async () => {
    await withRoot(async (dataRoot) => {
      await writeSetupState(
        {
          step: 'profileProposed',
          cursor: { questionId: 'summary' },
          answers: { contactName: 'Jane Sample' },
        },
        join(dataRoot, 'setupState.json'),
      );
      const question = await getSetupQuestion({ dataRoot, restart: true });
      expect(question.questionId).toBe('contactName');
      expect(question.resuming).toBe(false);
      expect(existsSync(join(dataRoot, 'setupState.json'))).toBe(false);
    });
  });

  it('drops answers keyed to removed questions and reports them', async () => {
    await withRoot(async (dataRoot) => {
      await writeSetupState(
        {
          step: 'profileProposed',
          cursor: { questionId: 'contactName' },
          answers: { removedQuestion: 'stale answer' },
        },
        join(dataRoot, 'setupState.json'),
      );
      const question = await getSetupQuestion({ dataRoot });
      expect(question.questionId).toBe('contactName');
      expect(question.changedQuestions).toEqual(['removedQuestion']);
    });
  });

  it('renders the resume section draft as plain text in the question payload', async () => {
    await withRoot(async (dataRoot) => {
      await driveToQuestion(dataRoot, 'summary');
      const question = await getSetupQuestion({ dataRoot });
      expect(question.draft).toContain('Summary');
      expect(question.draft).not.toContain('#');
    });
  });

  it('writes a complete profile end to end and clears the checkpoint', async () => {
    await withRoot(async (dataRoot) => {
      const asked = await driveToReady(dataRoot);
      expect(asked[0]).toBe('contactName');
      expect(asked).toContain('summary');
      expect(asked).toContain('minAcceptableBase');
      expect(existsSync(join(dataRoot, 'masterProfile.md'))).toBe(false);

      const result = await commitSetup({ confirmed: true }, { dataRoot });
      expect(result.filesWritten).toHaveLength(4);
      expect(existsSync(join(dataRoot, 'setupState.json'))).toBe(false);

      const master = await readFile(join(dataRoot, 'masterProfile.md'), 'utf8');
      expect(master).toContain('Jane Sample');
      expect(master).toContain('Austin, TX');

      const preferences = parseJobPreferences(
        await readFile(join(dataRoot, 'jobPreferences.yaml'), 'utf8'),
      );
      expect(preferences.compensation.minAcceptableBase).toBe(150000);
      expect(preferences.compensation.targetBase).toBe(180000);
      expect(preferences.preferredLocations).toEqual(['Remote']);

      const screening = JSON.parse(
        await readFile(join(dataRoot, 'screeningAnswers.json'), 'utf8'),
      ) as { standardQuestions: { yearsOfExperience: Record<string, number> } };
      expect(screening.standardQuestions.yearsOfExperience).toEqual({});

      const inspected = await readUserProfile({ dataRoot });
      expect(inspected.configured).toBe(true);
      expect(validateProfileCompletion(buildProfileInput(setupFixtureAnswers))).toEqual([]);
    });
  });

  it('reports a configuration schema error verbatim', async () => {
    await withRoot(async (dataRoot) => {
      const payload = JSON.parse(
        JSON.stringify(buildProfileInput(setupFixtureAnswers)),
      ) as ProfileInitializationInput;
      delete (payload.jobPreferences.compensation as { currency?: string }).currency;
      await expect(
        initializeUserProfile(payload, { confirmed: true, paths: { dataRoot } }),
      ).rejects.toThrow(/jobPreferences\.compensation\.currency/);
    });
  });
});

// Advance the cursor to a named question using fixture answers for every
// question before it. Keeps each test's setup readable without repeating the
// whole plan.
async function driveToQuestion(dataRoot: string, questionId: string): Promise<void> {
  for (let guard = 0; guard < 200; guard += 1) {
    const question = await getSetupQuestion({ dataRoot });
    if (question.questionId === questionId) {
      return;
    }
    if (question.status === 'readyToConfirm' || question.questionId === null) {
      throw new Error(`never reached '${questionId}'`);
    }
    const id = question.questionId;
    const answer = setupFixtureAnswers[id];
    await answerSetupQuestion({ questionId: id, answer: answer === undefined ? null : answer }, { dataRoot });
  }
  throw new Error(`never reached '${questionId}'`);
}
