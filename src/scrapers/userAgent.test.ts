import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { packageVersion, scraperUserAgent } from './userAgent';

// U03c: a single shared User-Agent constant feeds all six adapters. These
// grep-assertable cases fail loudly if anyone reintroduces a per-adapter
// literal or bypasses the shared import.

const adapterFiles = [
  'linkedinAdapter.ts',
  'hiringCafeAdapter.ts',
  'wellfoundAdapter.ts',
  'welcomeToTheJungleAdapter.ts',
  'builtInAdapter.ts',
  'flexJobsAdapter.ts',
];

describe('shared scraper User-Agent (U03c)', () => {
  it('carries a versioned compatible token', () => {
    expect(scraperUserAgent).toMatch(/Mozilla\/5\.0 \(compatible; wejobsearch\/\d+\.\d+\.\d+\)/);
  });

  it('derives its version from package.json so the two can never drift', () => {
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8')) as {
      version: string;
    };
    expect(packageVersion()).toBe(pkg.version);
    expect(scraperUserAgent).toContain(`wejobsearch/${pkg.version}`);
  });

  it('is the only User-Agent literal across all six adapters', () => {
    expect(adapterFiles).toHaveLength(6);
    for (const file of adapterFiles) {
      const source = readFileSync(join(__dirname, 'adapters', file), 'utf8');
      expect(source).toContain('scraperUserAgent');
      expect(source).not.toMatch(/wejobsearch\/0\.\d+\.\d+/);
      expect(source).not.toMatch(/Mozilla\/5\.0 \(compatible; wejobsearch\//);
    }
  });
});
