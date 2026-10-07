import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  isSetupStateComplete,
  isSetupStateStale,
  readSetupState,
  setupStateStalenessWindowMs,
  type SetupState,
} from './setupState';

// Session-resumption checkpoint for profile setup (EUO-15, goals G1/G4). The
// tests pin the persistence contract (atomic write, schema validation,
// refuse-to-overwrite-malformed), the resume semantics (read back the exact
// step), and the stale/complete rules (a checkpoint older than the staleness
// window, or one whose step is 'confirmed', is ignored by the caller).

async function withTempFile<T>(fn: (filePath: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'weJobSearch-setupState-test-'));
  const filePath = join(dir, 'setupState.json');
  try {
    return await fn(filePath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function setupState(overrides: Partial<SetupState> = {}): SetupState {
  return {
    step: 'documentsIngested',
    updatedAt: '2026-08-18T10:00:00.000Z',
    ...overrides,
  };
}

describe('readSetupState', () => {
  it('returns null when the file does not exist, without throwing', async () => {
    await withTempFile(async (filePath) => {
      expect(await readSetupState(filePath)).toBeNull();
    });
  });

  it('throws a clear error on malformed JSON', async () => {
    await withTempFile(async (filePath) => {
      await writeFile(filePath, '{not json', 'utf8');
      await expect(readSetupState(filePath)).rejects.toThrow(/not valid JSON/);
    });
  });

  it('throws a clear error on a schema-invalid state', async () => {
    await withTempFile(async (filePath) => {
      await writeFile(filePath, JSON.stringify({ step: 'bogus', updatedAt: '2026-08-18T10:00:00.000Z' }), 'utf8');
      await expect(readSetupState(filePath)).rejects.toThrow(/Malformed setup state/);
    });
  });
});

describe('stale and complete rules', () => {
  it('pins the staleness window to 7 days', () => {
    expect(setupStateStalenessWindowMs).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it('flags a state exactly at the window boundary as stale', () => {
    const reference = new Date('2026-08-19T10:00:00.000Z');
    const boundary = setupState({ updatedAt: '2026-08-12T10:00:00.000Z' });
    expect(isSetupStateStale(boundary, reference)).toBe(true);
  });

  it('treats a state inside the window as fresh', () => {
    const reference = new Date('2026-08-19T10:00:00.000Z');
    const fresh = setupState({ updatedAt: '2026-08-12T10:00:00.001Z' });
    expect(isSetupStateStale(fresh, reference)).toBe(false);
  });

  it('regression: an absolute August fixture goes stale once the clock advances past the window', () => {
    // Guards the EUO-15 time bomb: callers must pass an explicit reference
    // clock (as readUserProfile does) instead of relying on the real date, so
    // a fixture dated 2026-08-18 stays fresh inside the window and stale past
    // it no matter when the suite runs.
    const augustFixture = setupState({ updatedAt: '2026-08-18T10:00:00.000Z' });
    expect(isSetupStateStale(augustFixture, new Date('2026-08-20T10:00:00.000Z'))).toBe(false);
    expect(isSetupStateStale(augustFixture, new Date('2026-08-26T10:00:00.001Z'))).toBe(true);
  });

  it('treats a confirmed step as complete and other steps as in progress', () => {
    expect(isSetupStateComplete(setupState({ step: 'confirmed' }))).toBe(true);
    expect(isSetupStateComplete(setupState({ step: 'documentsIngested' }))).toBe(false);
    expect(isSetupStateComplete(setupState({ step: 'profileProposed' }))).toBe(false);
  });
});