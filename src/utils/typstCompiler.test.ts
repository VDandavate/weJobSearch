import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { compileTypstToPdf, compileWithinPageLimit, countPdfPages } from './typstCompiler';

// Phase 6c: the WASM engine downloads its font assets from a CDN on first
// compile, so an offline or CDN-blocked run must fail fast with an actionable
// memo (install a system typst binary, verify with typst --version, automatic
// pickup via detectSystemTypstBinary) instead of a raw diagnostic dump.

afterEach(() => {
  vi.unstubAllGlobals();
});

// Page-limit hardening (residuals pass): the loop tests below perform real
// Typst compiles. With a system binary they are fast; on binary-less
// machines the WASM fallback downloads font assets and compiles while the
// full suite saturates parallel workers, so the budget scales up when no
// system typst is found (Phase A/G explicit-timeout precedent).
function pageLimitTimeout(): number {
  try {
    execFileSync('typst', ['--version'], { stdio: 'ignore' });
    return 60000;
  } catch {
    return 120000;
  }
}

describe('wasm font offline memo (Phase 6c)', () => {
  it('fails fast with an actionable system-binary memo when the font CDN fetch is blocked', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new Error('net blocked by test')));
    const dir = await mkdtemp(join(tmpdir(), 'weJobSearch-typst-'));
    const failure = await compileTypstToPdf({
      source: { mainFilePath: '/main.typ', mainContent: '#set page(width: auto)\nHello' },
      outputPath: join(dir, 'out.pdf'),
      engine: 'wasm',
    }).then(
      () => null,
      (error: unknown) => error as Error,
    );
    expect(failure).not.toBeNull();
    expect(failure?.message).toMatch(/system typst binary/);
    expect(failure?.message).toMatch(/typst --version/);
  });
});

describe('page-limit loop and page counting (U24)', () => {
  it('returns a fitting document on the first attempt with zero reductions', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'weJobSearch-typstloop-'));
    try {
      let reductions = 0;
      const result = await compileWithinPageLimit({
        source: { mainFilePath: '/main.typ', mainContent: '= Hello\n\nShort doc.' },
        outputPath: join(dir, 'out.pdf'),
        maxReductionAttempts: 3,
        reduceTextDensity: () => {
          reductions += 1;
          return { mainFilePath: '/main.typ', mainContent: '= Hello\n\nShort doc.' };
        },
      });
      expect(result.pageCount).toBeLessThanOrEqual(1);
      expect(result.reductionAttempts).toBe(0);
      expect(reductions).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, pageLimitTimeout());

  it('throws the page-limit error after exhausting reductions', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'weJobSearch-typstloop-'));
    try {
      // maxPages 0 keeps every compile tiny and fast while still exercising
      // the reduction loop: nothing can satisfy a zero-page limit.
      const tiny = { mainFilePath: '/main.typ', mainContent: '= Hello\n\nShort doc.' };
      let reductions = 0;
      await expect(
        compileWithinPageLimit({
          source: tiny,
          outputPath: join(dir, 'out.pdf'),
          maxPages: 0,
          maxReductionAttempts: 2,
          reduceTextDensity: () => {
            reductions += 1;
            return tiny;
          },
        }),
      ).rejects.toThrow(/page limit/i);
      expect(reductions).toBe(2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    // Two real Typst compiles (WASM fallback) can exceed the 5s default
    // under full-suite parallel load; the sibling test above carries the
    // same explicit budget.
  }, pageLimitTimeout());

  it('countPdfPages rejects an empty buffer without parsing', async () => {
    await expect(countPdfPages(new Uint8Array(0))).rejects.toThrow(/empty PDF buffer/);
  });

  it('retries the font-asset init before failing with the offline memo', async () => {
    let fetchCalls = 0;
    vi.stubGlobal('fetch', () => {
      fetchCalls += 1;
      return Promise.reject(new Error('net blocked by test'));
    });
    const dir = await mkdtemp(join(tmpdir(), 'weJobSearch-typst-'));
    try {
      const failure = await compileTypstToPdf({
        source: { mainFilePath: '/main.typ', mainContent: '= Hello' },
        outputPath: join(dir, 'out.pdf'),
        engine: 'wasm',
      }).then(
        () => null,
        (error: unknown) => error as Error,
      );
      expect(failure).not.toBeNull();
      expect(failure?.message).toMatch(/system typst binary/);
      expect(fetchCalls).toBeGreaterThan(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
