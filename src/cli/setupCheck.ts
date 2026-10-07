import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseJobPreferences } from '../evaluators/fitEvaluator';
import { parseResumeVariants } from '../generators/resumeGenerator';
import { resolveDataRoot, resumeVariantsFileName } from '../utils/canonicalDataRoot';

export type TypstStatus = 'binary' | 'wasmFallback' | 'unknown';

export interface SetupCheckOptions {
  /** Override the Node version string for testing (defaults to process.versions.node). */
  nodeVersion?: string;
  /** Override the Typst availability check for testing (defaults to checking PATH). */
  typstChecker?: () => Promise<boolean>;
  /** Override the config file locations for testing (defaults to the canonical data root). */
  configPaths?: { jobPreferencesPath?: string; resumeVariantsPath?: string };
}

export interface SetupCheckResult {
  nodeOk: boolean;
  nodeVersion: string;
  typstStatus: TypstStatus;
  lines: string[];
  exitCode: number;
}

const minimumNodeMajor = 24;

export function parseNodeMajorVersion(nodeVersion: string): number {
  const match = /^(\d+)/.exec(nodeVersion);
  return match ? parseInt(match[1], 10) : 0;
}

export function checkTypstOnPath(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('typst', ['--version'], (error) => {
      resolve(error === null);
    });
  });
}

export async function runSetupCheck(options: SetupCheckOptions = {}): Promise<SetupCheckResult> {
  const nodeVersion = options.nodeVersion ?? process.versions.node;
  const nodeMajor = parseNodeMajorVersion(nodeVersion);
  const nodeOk = nodeMajor >= minimumNodeMajor;

  const typstChecker = options.typstChecker ?? checkTypstOnPath;
  let typstStatus: TypstStatus;
  try {
    const hasBinary = await typstChecker();
    typstStatus = hasBinary ? 'binary' : 'wasmFallback';
  } catch {
    typstStatus = 'unknown';
  }

  const lines: string[] = [];
  lines.push('weJobSearch setup check');
  lines.push('');
  lines.push(`Node.js: ${nodeVersion}`);
  if (nodeOk) {
    lines.push(`  OK — meets the >= ${minimumNodeMajor} requirement.`);
  } else {
    lines.push(`  FAIL — Node ${nodeMajor} is below the required >= ${minimumNodeMajor}.`);
    lines.push(`  Upgrade Node.js (see .nvmrc, which pins 26.5.0) and re-run 'npm run setup'.`);
  }
  lines.push('');
  lines.push('Typst:');
  if (typstStatus === 'binary') {
    lines.push('  OK — a typst binary was found on PATH; resume/PDF generation will use it.');
  } else if (typstStatus === 'wasmFallback') {
    lines.push('  WASM fallback — no typst binary on PATH; the engine will use the npm WASM compiler.');
    lines.push('  Note: the first WASM compile fetches font assets from a CDN (one-time).');
  } else {
    lines.push('  Unknown — could not determine typst availability; the engine will attempt the WASM fallback.');
  }
  lines.push('');
  lines.push('MCP server registration:');
  lines.push('  OpenCode: already wired — opencode.json registers the server automatically after a build.');
  lines.push('  Other MCP-capable hosts (Claude Code, Cursor, Windsurf, etc.):');
  lines.push('    Register this stdio command in your host MCP configuration:');
  lines.push('      node dist/mcp/jobSearchServer.js');
  lines.push('');
  lines.push('Configuration (fail-fast schema check, SDD Section 5):');
  // Defaults resolve through the effective data root (F2): with
  // WEJOBSEARCHDATAROOT set, setup validates those files, not the canonical
  // ones. Explicit configPaths (tests) still win.
  const configRoot = resolveDataRoot();
  const preferencesPath =
    options.configPaths?.jobPreferencesPath ?? join(configRoot, 'jobPreferences.yaml');
  const variantsPath =
    options.configPaths?.resumeVariantsPath ?? join(configRoot, resumeVariantsFileName);
  let configFailed = false;
  for (const [label, filePath, parse] of [
    ['jobPreferences.yaml', preferencesPath, parseJobPreferences],
    ['resumeVariants.yaml', variantsPath, parseResumeVariants],
  ] as const) {
    let content: string;
    try {
      content = await readFile(filePath, 'utf8');
    } catch {
      lines.push(`  ${label}: not initialized yet at ${filePath} — run init first.`);
      continue;
    }
    try {
      parse(content);
      lines.push(`  ${label}: OK (${filePath}).`);
    } catch (error) {
      configFailed = true;
      lines.push(`  ${label}: FAIL — ${(error as Error).message}`);
    }
  }
  if (configFailed) {
    lines.push('  Fix the files above (or run the validate command for details).');
  }
  lines.push('');
  lines.push('Data root:');
  lines.push(`  Effective root is WEJOBSEARCHDATAROOT when set, else the platform default.`);
  lines.push(`  Override per command with --dataRoot PATH, or persistently with WEJOBSEARCHDATAROOT.`);
  lines.push('');
  lines.push('Next steps:');
  lines.push('  1. npm install         # install dependencies (Node >= 24)');
  lines.push('  2. npm run build       # compile src/ -> dist/');
  lines.push('  3. Register the MCP server in your host (see above).');

  const exitCode = nodeOk && !configFailed ? 0 : 1;
  return { nodeOk, nodeVersion, typstStatus, lines, exitCode };
}

const isMain = typeof require !== 'undefined' && require.main === module;

if (isMain) {
  void (async () => {
    const result = await runSetupCheck();
    for (const line of result.lines) {
      console.log(line);
    }
    process.exitCode = result.exitCode;
  })();
}
