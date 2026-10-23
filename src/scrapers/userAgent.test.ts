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

// Read once, so the assertion follows the manifest instead of hardcoding a
// version shape. The prerelease suffix (0.1.0-beta) is part of the token.
const packageManifest = JSON.parse(
  readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8'),
) as { version: string };

describe('shared scraper User-Agent (U03c)', () => {
  it('carries a versioned compatible token', () => {
    expect(packageManifest.version).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
    expect(scraperUserAgent).toBe(
      `Mozilla/5.0 (compatible; wejobsearch/${packageManifest.version})`,
    );
  });

  it('derives its version from package.json so the two can never drift', () => {
    expect(packageVersion()).toBe(packageManifest.version);
    expect(scraperUserAgent).toContain(`wejobsearch/${packageManifest.version}`);
  });

  it('is carried only by the shared bounded fetcher, never a per-adapter literal', () => {
    expect(adapterFiles).toHaveLength(6);
    const fetcher = readFileSync(join(__dirname, 'httpFetcher.ts'), 'utf8');
    expect(fetcher).toContain('scraperUserAgent');
    for (const file of adapterFiles) {
      const source = readFileSync(join(__dirname, 'adapters', file), 'utf8');
      // Every adapter routes its HTTP through the shared fetcher.
      expect(source).toContain('../httpFetcher');
      expect(source).not.toMatch(/wejobsearch\/0\.\d+\.\d+/);
      expect(source).not.toMatch(/Mozilla\/5\.0 \(compatible; wejobsearch\//);
    }
  });
});
