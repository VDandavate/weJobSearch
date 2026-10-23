import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultRequestTimeoutMs } from './requestTimeout';

// Phase 7c RED: one shared request-timeout constant across all six adapters
// and the rate limiter (SDD Requirement 8). Previously each adapter carried
// its own `const requestTimeoutMs = 15000` while rateLimiter.ts used a
// divergent `AbortSignal.timeout(10000)`. This contract pins the single value
// and proves every fetcher references it instead of a local literal.

const here = __dirname;

interface TimeoutOwner {
  file: string;
  importSpecifier: string;
}

const timeoutOwners: TimeoutOwner[] = [
  { file: 'httpFetcher.ts', importSpecifier: './requestTimeout' },
  { file: 'rateLimiter.ts', importSpecifier: './requestTimeout' },
];

const adapterFiles = [
  'adapters/linkedinAdapter.ts',
  'adapters/hiringCafeAdapter.ts',
  'adapters/wellfoundAdapter.ts',
  'adapters/welcomeToTheJungleAdapter.ts',
  'adapters/builtInAdapter.ts',
  'adapters/flexJobsAdapter.ts',
];

describe('defaultRequestTimeoutMs: shared timeout constant (Phase 7c)', () => {
  it('pins the shared request timeout to 15000ms', () => {
    expect(defaultRequestTimeoutMs).toBe(15000);
  });

  it('is owned by the shared bounded fetcher and the rate limiter', () => {
    expect(timeoutOwners.map((owner) => owner.file).sort()).toEqual(
      ['httpFetcher.ts', 'rateLimiter.ts'].sort(),
    );
  });

  it('every request path imports the shared constant and declares no local timeout literal', async () => {
    const violations: string[] = [];
    const files = [...timeoutOwners.map((owner) => owner.file), ...adapterFiles];
    for (const file of files) {
      const text = await readFile(resolve(here, file), 'utf8');
      if (/const requestTimeoutMs\s*=\s*15000/.test(text)) {
        violations.push(`${file}: still declares a local requestTimeoutMs = 15000`);
      }
      if (/AbortSignal\.timeout\(10000\)/.test(text)) {
        violations.push(`${file}: still uses the divergent AbortSignal.timeout(10000)`);
      }
      if (/AbortSignal\.timeout\(15000\)/.test(text)) {
        violations.push(`${file}: still uses a literal AbortSignal.timeout(15000)`);
      }
    }
    for (const owner of timeoutOwners) {
      const text = await readFile(resolve(here, owner.file), 'utf8');
      if (!text.includes(owner.importSpecifier)) {
        violations.push(`${owner.file}: missing import from ${owner.importSpecifier}`);
      }
    }
    expect(violations).toEqual([]);
  });
});
