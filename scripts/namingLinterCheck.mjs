#!/usr/bin/env node

// CLI entry point for the naming linter (AGENTS.md Step 8). Runs the compiled
// dist entry when present; otherwise runs the TypeScript source directly via
// Node 24+ native type stripping, so the linter works on a fresh clone the
// moment `npm install` finishes - no build step required.
//
// Exit codes: 0 when the repository passes, 1 when a naming violation exists.

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Repo root is derived from this runner file's own location, never from the
// caller's working directory, so the check works identically whether invoked
// via `npm run namingLinter`, from the pre-commit hook, or from a temp dir.
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(here);

const distEntry = join(repoRoot, 'dist', 'utils', 'namingLinter.js');
const srcEntry = join(repoRoot, 'src', 'utils', 'namingLinter.ts');
const entry = existsSync(distEntry) ? distEntry : srcEntry;

const moduleExports = await import(pathToFileURL(entry).href);
const { runNamingLinter, formatNamingViolations } = moduleExports;

const result = await runNamingLinter({ repoRoot });

if (result.violations.length > 0) {
  process.stdout.write(`${formatNamingViolations(result.violations)}\n`);
  process.stdout.write(`Naming linter: ${result.violations.length} violation(s) found.\n`);
} else {
  process.stdout.write('Naming linter: clean (0 violations).\n');
}
process.exitCode = result.exitCode;