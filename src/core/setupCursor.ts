import { initializeUserProfile, resolveProfilePaths, validateProfileCompletion, type ProfileWriteResult } from '../utils/profileService';
import {
  applicableQuestions,
  buildProfileInput,
  currentPlanVersion,
  reconcileAnswers,
  questionById,
  type SetupAnswers,
  type SetupQuestion,
  type SetupSection,
} from './setupPlan';
import { renderProfileSection, type ProfileDraftSection } from './profileDraft';
import {
  clearSetupState,
  readSetupState,
  writeSetupState,
  type SetupState,
} from '../utils/setupState';

// Host-neutral core behind the three setup MCP tools (setupQuestionCursor T04).
// The model asks one question per turn, answers it by id, and commits once the
// user confirms. Nothing here writes a profile file except commitSetup, and
// commitSetup refuses without confirmed: true.

export interface SetupPathOverrides {
  dataRoot?: string;
  setupStatePath?: string;
}

export interface SetupQuestionPayload {
  status: 'question' | 'readyToConfirm';
  questionId: string | null;
  section: SetupSection | null;
  prompt: string;
  why: string;
  options: readonly string[];
  recommended: string;
  required: boolean;
  index: number;
  total: number;
  draft?: string;
  resuming: boolean;
  lastAnsweredAt?: string;
  changedQuestions?: readonly string[];
  preview?: readonly string[];
}

const draftSectionByQuestionId: Record<string, ProfileDraftSection> = {
  summary: 'summary',
  skills: 'skills',
  experience: 'experience',
  education: 'education',
  certifications: 'certifications',
};

function resolved(overrides: SetupPathOverrides) {
  return resolveProfilePaths({
    dataRoot: overrides.dataRoot,
    setupStatePath: overrides.setupStatePath,
  });
}

function readyPayload(
  total: number,
  preview: readonly string[],
  state: SetupState | null,
  changedQuestions: readonly string[],
  resuming: boolean,
): SetupQuestionPayload {
  return {
    status: 'readyToConfirm',
    questionId: null,
    section: null,
    prompt: 'All questions are answered. Confirm to write the profile.',
    why: 'commitSetup is the only step that writes profile files.',
    options: [],
    recommended: 'Review the file paths, then confirm.',
    required: false,
    index: total,
    total,
    resuming,
    lastAnsweredAt: state?.updatedAt,
    changedQuestions: changedQuestions.length > 0 ? changedQuestions : undefined,
    preview,
  };
}

function questionPayload(
  question: SetupQuestion,
  answers: SetupAnswers,
  index: number,
  total: number,
  state: SetupState | null,
  changedQuestions: readonly string[],
  resuming: boolean,
): SetupQuestionPayload {
  const draftSection = draftSectionByQuestionId[question.id];
  const input = buildProfileInput(answers);
  return {
    status: 'question',
    questionId: question.id,
    section: question.section,
    prompt: question.prompt,
    why: question.why,
    options: question.options ?? [],
    recommended: question.recommended,
    required: question.required,
    index,
    total,
    draft: draftSection === undefined ? undefined : renderProfileSection(draftSection, input),
    resuming,
    lastAnsweredAt: state?.updatedAt,
    changedQuestions: changedQuestions.length > 0 ? changedQuestions : undefined,
  };
}

function currentQuestionId(state: SetupState | null, answers: SetupAnswers): string | null {
  const applicable = applicableQuestions(answers);
  const unanswered = applicable.filter((question) => !(question.id in answers));
  if (unanswered.length === 0) {
    return null;
  }
  const cursorId = state?.cursor?.questionId;
  if (cursorId !== undefined && unanswered.some((question) => question.id === cursorId)) {
    return cursorId;
  }
  return unanswered[0].id;
}

export async function getSetupQuestion(
  options: SetupPathOverrides & { restart?: boolean } = {},
): Promise<SetupQuestionPayload> {
  const paths = resolved(options);
  let state: SetupState | null;
  if (options.restart === true) {
    await clearSetupState(paths.setupState);
    state = null;
  } else {
    state = await readSetupState(paths.setupState);
  }

  const rawAnswers = state?.answers ?? {};
  const { answers, droppedIds } = reconcileAnswers(rawAnswers);
  const applicable = applicableQuestions(answers);
  const resuming = state !== null && Object.keys(answers).length > 0 && options.restart !== true;
  const currentId = currentQuestionId(state, answers);

  if (currentId === null) {
    return readyPayload(
      applicable.length,
      [paths.masterProfile, paths.jobPreferences, paths.screeningAnswers, paths.networkingContacts],
      state,
      droppedIds,
      resuming,
    );
  }

  const question = questionById(currentId);
  if (question === undefined) {
    throw new Error(`Unknown setup question '${currentId}'.`);
  }
  const index = applicable.findIndex((entry) => entry.id === currentId) + 1;
  return questionPayload(question, answers, index, applicable.length, state, droppedIds, resuming);
}

export interface AnswerSetupQuestionInput {
  questionId: string;
  answer: unknown;
}

export async function answerSetupQuestion(
  input: AnswerSetupQuestionInput,
  options: SetupPathOverrides = {},
): Promise<SetupQuestionPayload> {
  const paths = resolved(options);
  const state = await readSetupState(paths.setupState);
  const { answers, droppedIds } = reconcileAnswers(state?.answers ?? {});
  const applicable = applicableQuestions(answers);
  const currentId = currentQuestionId(state, answers);
  if (currentId === null) {
    throw new Error('All questions are already answered. Call commitSetup to write the profile.');
  }
  if (input.questionId !== currentId) {
    throw new Error(
      `Out-of-order answer: expected '${currentId}', received '${input.questionId}'. Ask the current question first.`,
    );
  }

  const question = questionById(currentId);
  if (question === undefined) {
    throw new Error(`Unknown setup question '${currentId}'.`);
  }

  if (input.answer === null || input.answer === undefined) {
    if (question.required) {
      throw new Error(`'${question.id}' is required: ${question.why}`);
    }
    answers[question.id] = null;
  } else {
    const problem = question.validate === undefined ? null : question.validate(input.answer);
    if (problem !== null) {
      throw new Error(`'${question.id}': ${problem}`);
    }
    answers[question.id] = input.answer;
  }

  const after = applicableQuestions(answers);
  const currentIndex = after.findIndex((entry) => entry.id === question.id);
  const next = after[currentIndex + 1];

  const written = await writeSetupState(
    {
      step: 'profileProposed',
      answers,
      ...(next === undefined ? {} : { cursor: { questionId: next.id } }),
      planVersion: currentPlanVersion,
    },
    paths.setupState,
  );

  if (next === undefined) {
    return readyPayload(
      after.length,
      [paths.masterProfile, paths.jobPreferences, paths.screeningAnswers, paths.networkingContacts],
      written,
      droppedIds,
      false,
    );
  }

  return questionPayload(
    next,
    answers,
    currentIndex + 2,
    after.length,
    written,
    droppedIds,
    false,
  );
}

function blockingFieldIds(issues: readonly string[]): string[] {
  return issues.map((issue) => {
    const separator = issue.indexOf(':');
    return separator === -1 ? issue : issue.slice(0, separator).trim();
  });
}

export interface CommitSetupInput {
  confirmed: boolean;
}

export async function commitSetup(
  input: CommitSetupInput,
  options: SetupPathOverrides = {},
): Promise<ProfileWriteResult> {
  const paths = resolved(options);
  if (input.confirmed !== true) {
    throw new Error('commitSetup requires confirmed: true. No profile file was written.');
  }

  const state = await readSetupState(paths.setupState);
  if (state === null) {
    throw new Error('No setup in progress. Call getSetupQuestion to start.');
  }
  const { answers } = reconcileAnswers(state.answers ?? {});
  const payload = buildProfileInput(answers);
  const issues = validateProfileCompletion(payload);
  if (issues.length > 0) {
    throw new Error(
      `Setup is incomplete. Blocking fields: ${blockingFieldIds(issues).join(', ')}.`,
    );
  }

  const result = await initializeUserProfile(payload, {
    confirmed: true,
    paths: {
      profilePath: paths.masterProfile,
      preferencesPath: paths.jobPreferences,
      screeningAnswersPath: paths.screeningAnswers,
      contactsPath: paths.networkingContacts,
      dataRoot: paths.dataRoot,
    },
  });

  await clearSetupState(paths.setupState);
  return result;
}
