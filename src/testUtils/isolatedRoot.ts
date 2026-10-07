import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { dataRootEnvKey, ensureCanonicalDataDirectories } from '../utils/canonicalDataRoot';

// Test-harness hook (H1b, internal only). NEVER import this module from CLI,
// MCP, generator, evaluator, or any other non-test source file: the
// import-graph guard in isolatedRoot.test.ts fails the suite if any
// non-*.test.ts file outside src/testUtils/ imports testUtils. It is also
// never wired into any CLI/MCP command schema - tests set
// WEJOBSEARCHDATAROOT through this helper only.
//
// createIsolatedDataRootFromFixtures builds a throwaway canonical data root
// under os.tmpdir(), seeds it with the committed synthetic fixtures (never
// real profile data), points WEJOBSEARCHDATAROOT at it, and returns a restore
// function that resets the env var and deletes the tree.

export interface IsolatedDataRoot {
  root: string;
  restore: () => Promise<void>;
}

// Fixture file -> canonical root relative destination. Sample names stay
// fixture-side; only synthetic Jane Sample content ever lands in the sandbox.
const fixtureSeedMap: ReadonlyArray<readonly [string, string]> = [
  ['sampleProfile.md', 'masterProfile.md'],
  ['sampleJobPreferences.yaml', 'jobPreferences.yaml'],
  ['sampleApplicationHistory.json', join('applications', 'applicationHistory.json')],
  ['sampleConnections.csv', join('documents', 'sampleConnections.csv')],
  ['sampleJobPosting.txt', join('documents', 'sampleJobPosting.txt')],
  ['sampleResume.docx', join('documents', 'sampleResume.docx')],
  ['sampleNetworkingContacts.json', join('networkingContacts.json')],
];

function fixturesDirectory(): string {
  // src/testUtils/isolatedRoot.ts -> repo root -> fixtures/.
  return resolve(__dirname, '..', '..', 'fixtures');
}

// Guardrail: the sandbox must live under os.tmpdir() and must never target
// the repo work tree or the user's home directory. Exported so tests can
// assert refusal directly with synthetic paths (no litter in the real tmp).
export function assertSandboxTarget(candidate: string, repoRoot: string, homeDir: string): string {
  const resolved = resolve(candidate);
  const systemTmp = resolve(tmpdir());
  const rel = relative(systemTmp, resolved);
  if (rel.startsWith('..')) {
    throw new Error(
      `Refusing to use isolated data root outside os.tmpdir(): '${candidate}'.`,
    );
  }
  const repoRel = relative(resolve(repoRoot), resolved);
  if (repoRel.length === 0 || !repoRel.startsWith('..')) {
    throw new Error(
      `Refusing to use isolated data root inside the repo work tree '${repoRoot}': '${candidate}'.`,
    );
  }
  // On systems where TMPDIR itself sits under home, every tmp path is trivially
  // "inside home" - refusing those would make the helper unusable, so the home
  // check only applies when the system tmp escapes the home tree.
  if (!relative(resolve(homeDir), systemTmp).startsWith('..')) {
    return resolved;
  }
  const homeRel = relative(resolve(homeDir), resolved);
  if (homeRel.length === 0 || !homeRel.startsWith('..')) {
    throw new Error(
      `Refusing to use isolated data root inside the home directory '${homeDir}': '${candidate}'.`,
    );
  }
  return resolved;
}

export async function createIsolatedDataRootFromFixtures(options: {
  repoRoot?: string;
  homeDir?: string;
} = {}): Promise<IsolatedDataRoot> {
  const repoRoot = options.repoRoot ?? resolve(__dirname, '..', '..');
  const homeDir = options.homeDir ?? homedir();
  const dir = await mkdtemp(join(tmpdir(), 'weJobSearch-isolated-'));
  assertSandboxTarget(dir, repoRoot, homeDir);
  await ensureCanonicalDataDirectories(dir);
  const fixturesDir = fixturesDirectory();
  const entries = new Set(await readdir(fixturesDir));
  for (const [fixtureName, destination] of fixtureSeedMap) {
    if (!entries.has(fixtureName)) {
      continue;
    }
    await copyFile(join(fixturesDir, fixtureName), join(dir, destination));
  }
  const previousRoot = process.env[dataRootEnvKey];
  process.env[dataRootEnvKey] = dir;
  let restored = false;
  const restore = async (): Promise<void> => {
    if (restored) {
      return;
    }
    restored = true;
    if (previousRoot === undefined) {
      delete process.env[dataRootEnvKey];
    } else {
      process.env[dataRootEnvKey] = previousRoot;
    }
    await rm(dir, { recursive: true, force: true });
  };
  return { root: dir, restore };
}
