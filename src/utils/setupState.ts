import { readFile, rm } from 'node:fs/promises';
import { z } from 'zod';
import { writeFileAtomically } from './atomicWrite';
import { canonicalSetupStatePath, redactHomePrefix } from './canonicalDataRoot';
import { assertNotReadOnly } from './readOnlyGuard';

// Session-resumption checkpoint for profile setup (EUO-15, goals G1/G4).
// A minimal, schema-validated setupState.json under the canonical data root
// records the in-progress profile-setup step (documents ingested, profile
// proposed, confirmed) so an interrupted agent session can be resumed from
// where it stopped. Scope-limited to profile setup — this is not a general
// run-state engine (the SDD's pipelineState.json stays deliberately
// unimplemented).
//
// Persistence contract, mirroring applicationHistory.json / searchHistory.json
// (SDD Requirement 4): reads are read-only and validate-before-return, and a
// malformed existing file surfaces an error instead of being silently
// ignored. The file is created lazily by the setup workflow; this module owns
// the read side only (profileService.ts consumes the checkpoint, the setup
// workflow manages the file lifecycle).

export const setupStepSchema = z.enum(['documentsIngested', 'profileProposed', 'confirmed']);
export type SetupStep = z.infer<typeof setupStepSchema>;

// Cursor and answers are optional so the original three-key checkpoint
// (step/updatedAt/notes) still parses. They are written by the setup question
// cursor (answerSetupQuestion) and read by getSetupQuestion; the file remains
// one checkpoint under the canonical data root.
export const setupCursorSchema = z
  .object({
    questionId: z.string(),
  })
  .strict();
export type SetupCursor = z.infer<typeof setupCursorSchema>;

export const setupStateSchema = z
  .object({
    step: setupStepSchema,
    updatedAt: z.string().datetime(),
    notes: z.string().optional(),
    cursor: setupCursorSchema.optional(),
    answers: z.record(z.string(), z.unknown()).optional(),
    planVersion: z.number().int().positive().optional(),
  })
  .strict();
export type SetupState = z.infer<typeof setupStateSchema>;

// Resolved at call time (not import time) so a relocated WEJOBSEARCHDATAROOT
// set after import is honored.
export function defaultSetupStatePath(): string {
  return canonicalSetupStatePath();
}

// Staleness window for an in-progress setup checkpoint: a state whose
// updatedAt is older than this is treated as stale (an abandoned setup) and
// ignored by the caller. Pinned by setupState.test.ts.
export const setupStateStalenessWindowMs = 7 * 24 * 60 * 60 * 1000;

// True when the checkpoint is older than the staleness window relative to
// referenceDate (defaults to now). The boundary is inclusive: a state exactly
// at the window is stale.
export function isSetupStateStale(state: SetupState, referenceDate: Date = new Date()): boolean {
  return referenceDate.getTime() - Date.parse(state.updatedAt) >= setupStateStalenessWindowMs;
}

// True when the checkpoint records a completed setup. A 'confirmed' step means
// the setup finished, so there is nothing to resume — the caller ignores the
// state (and the setup workflow clears the file on completion).
export function isSetupStateComplete(state: SetupState): boolean {
  return state.step === 'confirmed';
}

export async function readSetupState(
  filePath: string = defaultSetupStatePath(),
): Promise<SetupState | null> {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Malformed setup state at ${redactHomePrefix(filePath)}: not valid JSON (${(error as Error).message})`);
  }
  const result = setupStateSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`Malformed setup state at ${redactHomePrefix(filePath)}: ${result.error.message}`);
  }
  return result.data;
}

// Write side of the checkpoint (setupQuestionCursor T03). Refuses to replace a
// malformed existing file (readSetupState throws first) and always refreshes
// updatedAt unless the caller supplies one. Atomic replace only.
export async function writeSetupState(
  state: Omit<SetupState, 'updatedAt'> & { updatedAt?: string },
  filePath: string = defaultSetupStatePath(),
  now: Date = new Date(),
): Promise<SetupState> {
  assertNotReadOnly(filePath);
  await readSetupState(filePath);
  const parsed = setupStateSchema.safeParse({
    ...state,
    updatedAt: state.updatedAt ?? now.toISOString(),
  });
  if (!parsed.success) {
    throw new Error(`Invalid setup state: ${parsed.error.message}`);
  }
  await writeFileAtomically(filePath, `${JSON.stringify(parsed.data, null, 2)}\n`);
  return parsed.data;
}

// Clears the checkpoint after a confirmed commit (or an explicit restart).
export async function clearSetupState(filePath: string = defaultSetupStatePath()): Promise<void> {
  assertNotReadOnly(filePath);
  await rm(filePath, { force: true });
}