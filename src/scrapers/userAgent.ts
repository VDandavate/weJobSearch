// Shared scraper User-Agent (B14/U03c single source). All six adapters read
// this constant instead of carrying their own literal, so the version token
// changes in exactly one place. The version is derived from package.json at
// load time (U27 single-source rule): the file sits two levels below the repo
// root in both the src/ and dist/ layouts, so the same __dirname-relative
// lookup works built and unbuilt. A missing/unparseable package.json falls
// back to an explicit unknown marker instead of a stale hardcoded version.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const loadedPackageVersion = ((): string => {
  try {
    const pkg = JSON.parse(
      readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8'),
    ) as { version?: unknown };
    if (typeof pkg.version === 'string' && pkg.version.length > 0) {
      return pkg.version;
    }
  } catch {
    // Fall through to the unknown marker below.
  }
  return '0.0.0-unknown';
})();

export function packageVersion(): string {
  return loadedPackageVersion;
}

export const scraperUserAgent = `Mozilla/5.0 (compatible; wejobsearch/${packageVersion()})`;
