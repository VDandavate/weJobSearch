#!/usr/bin/env node

// CLI entry point for the setup check. Runs the compiled dist entry when
// present; otherwise compiles it first via `npm run build` (dist/ is
// gitignored, so the build is a safe local side effect), so `npm run setup`
// works on a fresh clone the moment `npm install` finishes. The TypeScript
// source is deliberately NOT run via Node 24+ native type stripping here:
// src/cli/setupCheck.ts uses extensionless relative imports (shared with the
// tsc commonjs build), which Node ESM type stripping cannot resolve, so a
// direct source import crashes with ERR_MODULE_NOT_FOUND on a fresh clone.
// (The naming-linter wrapper can use the source directly only because its
// source module is dependency-free.)
//
// Output strings live in src/cli/setupCheck.ts (runSetupCheck); this wrapper
// only resolves the entry, prints its lines, and propagates its exit code.

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Repo root is derived from this runner file's own location, never from the
// caller's working directory, so the check works identically whether invoked
// via `npm run setup` or from a temp dir.
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(here);

const distEntry = join(repoRoot, 'dist', 'cli', 'setupCheck.js');

function resolveEntry() {
  if (existsSync(distEntry)) {
    return distEntry;
  }
  execFileSync('npm', ['run', 'build'], { cwd: repoRoot, stdio: 'ignore' });
  if (!existsSync(distEntry)) {
    console.error('Setup check failed: the build did not produce dist/cli/setupCheck.js.');
    process.exit(2);
  }
  return distEntry;
}

const entry = resolveEntry();

const moduleExports = await import(pathToFileURL(entry).href);
const { runSetupCheck } = moduleExports;

const result = await runSetupCheck();
for (const line of result.lines) {
  console.log(line);
}
process.exitCode = result.exitCode;
