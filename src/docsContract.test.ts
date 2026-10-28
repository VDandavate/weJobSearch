import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Floor, not pin: the registry must carry at least the documented tool set.
// Adding tools is fine (the README parity gate below keeps the documented
// list truthful); dropping below the documented floor fails loudly.
const documentedToolFloor = 19;

const toolWordToCount: Record<string, number> = {
  nineteen: 19,
  twenty: 20,
};

// Public docs manifest: only the parent SDD ships to the public tree. The
// export filter (scripts/exportFilter.mjs) mirrors this list and denies every
// other docs/ path. Internal-process docs at docs/ root and the completed
// histories under docs/archive/ are tracked but never staged. This test is
// the tracked authority: any new docs file fails here until it is classified.
const publicDocsManifest = ['docs/weJobSearch-SDD.md'];
const privateActiveDocs = [
  'docs/baselineRecord.md',
  'docs/v050SummaryReport.md',
  'docs/wejsPublicFixer.md',
  'docs/wejsPublicPrivate.md',
];
const archivedDocs = [
  'docs/archive/cleanupImplementationPlan.md',
  'docs/archive/phaseFEvidence.md',
  'docs/archive/planIndependence.md',
  'docs/archive/planIndependenceOrchestration.md',
  'docs/archive/publicReleaseAuditAndPlan.md',
  'docs/archive/releaseChecklist.md',
  'docs/archive/releaseProcess.md',
  'docs/archive/supersededNote.md',
  'docs/archive/weJobSearch-EndUserOptimization-SDD.md',
  'docs/archive/weJobSearch-SearchReviewApply-SDD.md',
  'docs/archive/wejsLetsMakePublic.md',
];

// HANDOFF.md is the public-excluded marker: its presence means the private
// posture (full classification on disk), its absence means the public posture
// (only the parent SDD ships). Tests that read HANDOFF.md skip when it is
// absent instead of throwing (Phase 0 dual-tree discipline).
const handoffExists = existsSync(join(repoRootOf(), 'HANDOFF.md'));

// Work-product paths: tracked privately but export-denied from the public
// tree. The candidate-purity test asserts the release filter excludes every
// one of them and that they are absent from the shipped tree.
const workProductPaths = [...privateActiveDocs, ...archivedDocs, 'HANDOFF.md', 'scripts/exportFilter.mjs'];

function repoRootOf(): string {
  return resolve(__dirname, '..');
}

function readDoc(fileName: string): string {
  return readFileSync(join(repoRootOf(), fileName), 'utf8');
}

function readServerSource(): string {
  return readFileSync(join(repoRootOf(), 'src', 'mcp', 'jobSearchServer.ts'), 'utf8');
}

function readCoreSource(): string {
  return readFileSync(join(repoRootOf(), 'src', 'cli', 'jobSearchCore.ts'), 'utf8');
}

function readDispatcherSource(): string {
  // Phase E thin-dispatcher split: commandNames still lives in
  // jobSearchCore.ts, but the dispatchCli if-chain moved to cliDispatcher.ts.
  return readFileSync(join(repoRootOf(), 'src', 'cli', 'cliDispatcher.ts'), 'utf8');
}

// Phase 0 dual-tree discipline, locked mechanically: HANDOFF.md is
// public-excluded, so a test may read it only inside a skipIf-guarded test
// (absence skips, never throws). This helper fails loudly if any test file
// reads HANDOFF.md from an unguarded it/test block.
function assertHandoffReadsAreSkipGuarded(source: string, fileName: string): void {
  const readPatterns = [/readDoc\('HANDOFF\.md'\)/g, /readFileSync\([^)]*HANDOFF\.md[^)]*\)/g];
  for (const pattern of readPatterns) {
    for (const read of source.matchAll(pattern)) {
      const before = source.slice(0, read.index);
      const headers = [...before.matchAll(/(?:it|test)\.skipIf\s*\(|(?:it|test)\s*\(/g)];
      const lastHeader = headers[headers.length - 1];
      expect(lastHeader?.[0], `${fileName}: HANDOFF.md read outside a skipIf-guarded test`).toContain('skipIf');
    }
  }
}

function collectTestFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...collectTestFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.test.ts')) {
      found.push(full);
    }
  }
  return found;
}

function countTestCases(source: string): number {
  // Count plain it/test and conditionally-skipped it.skipIf/test.skipIf
  // (Phase 0 dual-tree discipline: HANDOFF-dependent tests skip when the
  // public-excluded HANDOFF.md is absent). Any other unrecognized form
  // undercounts and trips the guard loudly for a human to extend.
  const matches = source.match(/^\s*(?:it|test)(?:\.skipIf\s*\([^)]*\))?\(/gm);
  const singleCount = matches === null ? 0 : matches.length;
  // Parameterized tables generate one case per array-literal row. Only
  // array-literal tables are expanded; any other form undercounts and trips
  // the guard loudly for a human to extend.
  let eachCount = 0;
  const eachTables = source.matchAll(/(?:^|\s)(?:it|test|describe)\.each\(\[([^\]]*)\]/gm);
  for (const table of eachTables) {
    const rows = table[1].split(',').map((row) => row.trim()).filter((row) => row.length > 0);
    eachCount += rows.length;
  }
  return singleCount + eachCount;
}

function countRegisteredTools(serverSource: string): number {
  const matches = serverSource.match(/registerTool\s*\(/g);
  return matches === null ? 0 : matches.length;
}

function collectRegisteredToolNames(serverSource: string): string[] {
  const matches = serverSource.matchAll(/registerTool\(\s*'([^']+)'/g);
  return Array.from(matches, (match) => match[1]).sort();
}

function collectReadmeToolNames(readme: string): string[] {
  const listStart = readme.indexOf('The server registers **');
  expect(listStart).toBeGreaterThanOrEqual(0);
  const listSection = readme.slice(listStart);
  const matches = listSection.matchAll(/^\d+\.\s+`(\w+)`/gm);
  return Array.from(matches, (match) => match[1]).sort();
}

function toolWordValue(word: string): number {
  if (/^\d+$/.test(word)) {
    return Number(word);
  }
  const value = toolWordToCount[word.toLowerCase()];
  if (value === undefined) {
    throw new Error(`Unknown tool count word in docs: ${word}`);
  }
  return value;
}

function extractCommandNames(coreSource: string): string[] {
  const match = coreSource.match(/export const commandNames:\s*readonly\s*string\[\]\s*=\s*\[([\s\S]*?)\];/);
  if (!match) throw new Error('Could not find commandNames array in jobSearchCore.ts');
  return match[1].match(/'(\w+)'/g)!.map((s) => s.replace(/'/g, ''));
}

function extractDispatchedCommands(coreSource: string): string[] {
  const dispatchMatches = coreSource.matchAll(/if\s*\(command\s*===\s*'(\w+)'\s*\)/g);
  return Array.from(dispatchMatches, (m) => m[1]);
}

describe('docsContract', () => {
  it('registers at least the documented floor of MCP tools in the server source', () => {
    expect(countRegisteredTools(readServerSource())).toBeGreaterThanOrEqual(documentedToolFloor);
  });

  it('README tool list matches the registered tool set exactly (behavior parity, no count pin)', () => {
    const registered = collectRegisteredToolNames(readServerSource());
    const documented = collectReadmeToolNames(readDoc('README.md'));
    expect(documented).toEqual(registered);
  });

  it('README tool count statements match the server registry', () => {
    const readme = readDoc('README.md');
    const liveCount = countRegisteredTools(readServerSource());
    const listMatch = readme.match(/(\w+) MCP tools:/);
    expect(listMatch).not.toBeNull();
    expect(toolWordValue(listMatch?.[1] ?? '')).toBe(liveCount);
    const serverMatch = readme.match(/registers \*\*(\w+)\*\* tools:/);
    expect(serverMatch).not.toBeNull();
    expect(toolWordValue(serverMatch?.[1] ?? '')).toBe(liveCount);
  });

  it.skipIf(!handoffExists)('HANDOFF tool count statements match the server registry', () => {
    const handoff = readDoc('HANDOFF.md');
    const liveCount = countRegisteredTools(readServerSource());
    const tableMatch = handoff.match(/jobSearchServer\.ts`, (\d+) tools/);
    expect(tableMatch).not.toBeNull();
    expect(Number(tableMatch?.[1])).toBe(liveCount);
    const bulletMatch = handoff.match(/MCP tools.+?(\w+) tools over stdio/);
    expect(bulletMatch).not.toBeNull();
    expect(toolWordValue(bulletMatch?.[1] ?? '')).toBe(liveCount);
  });

  it('no test reads the public-excluded HANDOFF.md unconditionally (Phase 0 dual-tree discipline)', () => {
    for (const file of collectTestFiles(join(repoRootOf(), 'src'))) {
      const source = readFileSync(file, 'utf8');
      if (!source.includes('HANDOFF')) {
        continue;
      }
      assertHandoffReadsAreSkipGuarded(source, file);
    }
  });

  it('AGENTS and HANDOFF suite totals are live claims or dated history (no stale time-bombs)', () => {
    const liveFiles = collectTestFiles(join(repoRootOf(), 'src'));
    const liveCases = liveFiles
      .map((file) => countTestCases(readFileSync(file, 'utf8')))
      .reduce((total, count) => total + count, 0);
    const docFiles = ['AGENTS.md', 'HANDOFF.md', 'ARCHITECTURE.md'].filter((fileName) =>
      existsSync(join(repoRootOf(), fileName)),
    );
    for (const fileName of docFiles) {
      const doc = readDoc(fileName);
      const lines = doc.split('\n');
      lines.forEach((line, index) => {
        for (const claim of line.matchAll(/(\d+) tests|(\d+) files|(\d+) across (\d+) files/g)) {
          const claimedTests = claim[1] !== undefined ? Number(claim[1]) : claim[3] !== undefined ? Number(claim[3]) : null;
          const claimedFiles = claim[2] !== undefined ? Number(claim[2]) : claim[4] !== undefined ? Number(claim[4]) : null;
          // Historical notes carry their date on the claim line or an adjacent
          // line (see the Step 9/Step 13 recount note); undated lines are live
          // claims and must match the tree.
          const window = [lines[index - 1] ?? '', line, lines[index + 1] ?? ''].join('\n');
          if (/\d{4}-\d{2}-\d{2}/.test(window)) {
            continue;
          }
          if (claimedTests !== null) {
            expect(
              claimedTests,
              `${fileName} claims ${claimedTests} tests but the tree has ${liveCases} (refresh the total or date the line)`,
            ).toBe(liveCases);
          }
          if (claimedFiles !== null) {
            expect(
              claimedFiles,
              `${fileName} claims ${claimedFiles} files but the tree has ${liveFiles.length} (refresh the total or date the line)`,
            ).toBe(liveFiles.length);
          }
        }
      });
    }
  });

  it.skipIf(!handoffExists)('AGENTS and HANDOFF suite totals agree with each other (F3: cross-doc consistency, never pinned literals)', () => {
    const agents = readDoc('AGENTS.md');
    const handoff = readDoc('HANDOFF.md');
    const agentsMatch = agents.match(/(\d+) tests \/ (\d+) files/);
    expect(agentsMatch).not.toBeNull();
    const handoffMatch = handoff.match(/\*\*(\d+) across (\d+) files\*\*/);
    expect(handoffMatch).not.toBeNull();
    // The two docs must state the same totals. They are intentionally NOT
    // compared against pinned literals or the live tree: any contributor
    // adding a test stays green without a doc edit (U28 probe acceptance),
    // and the wave-end recount process keeps the numbers truthful.
    expect([agentsMatch?.[1], agentsMatch?.[2]]).toEqual([handoffMatch?.[1], handoffMatch?.[2]]);
  });

  it('derives live suite totals from the tree without pinning them', () => {
    const testFiles = collectTestFiles(join(repoRootOf(), 'src'));
    expect(testFiles.length).toBeGreaterThan(0);
    const liveCases = testFiles
      .map((file) => countTestCases(readFileSync(file, 'utf8')))
      .reduce((total, count) => total + count, 0);
    expect(liveCases).toBeGreaterThan(testFiles.length);
  });

  it('docs/ holds only classified files — no unmanifested doc can ship by default', () => {
    const rootEntries = readdirSync(join(repoRootOf(), 'docs'), { withFileTypes: true });
    const rootFiles = rootEntries
      .filter((entry) => entry.isFile())
      .map((entry) => `docs/${entry.name}`);
    if (!handoffExists) {
      // Public posture: exactly the parent SDD ships; the archive and the
      // active process docs are absent from the tree entirely.
      expect(rootFiles).toEqual(['docs/weJobSearch-SDD.md']);
      for (const entry of rootEntries) {
        if (entry.isDirectory()) {
          expect.unreachable(`unexpected docs/ subdirectory ${entry.name} in the public tree`);
        }
      }
      return;
    }
    // Private posture: full classification — root holds the SDD plus the
    // tracked-but-export-excluded active docs, archive holds the completed
    // histories, and no unclassified file or subdirectory exists.
    expect(rootFiles.sort()).toEqual([...publicDocsManifest, ...privateActiveDocs].sort());
    const archiveFiles = rootEntries
      .filter((entry) => entry.isDirectory() && entry.name === 'archive')
      .flatMap((entry) => readdirSync(join(repoRootOf(), 'docs', entry.name)))
      .map((name) => `docs/archive/${name}`);
    expect(archiveFiles.sort()).toEqual([...archivedDocs].sort());
    for (const entry of rootEntries) {
      if (entry.isDirectory() && entry.name !== 'archive') {
        expect.unreachable(`unexpected docs/ subdirectory ${entry.name} (classify it or remove it)`);
      }
    }
    const knownDocs = [...publicDocsManifest, ...privateActiveDocs, ...archivedDocs];
    for (const file of knownDocs) {
      expect(() => readDoc(file), `classified doc ${file} missing from the tree`).not.toThrow();
    }
  });

  it('candidate purity: public candidate ships the SDD and zero work-product paths; public tree excludes them', () => {
    if (!handoffExists) {
      // Public posture: every work-product path is absent from disk, and the
      // release filter itself is absent from the shipped tree.
      for (const path of workProductPaths) {
        expect(existsSync(join(repoRootOf(), path)), `work-product path ${path} present in the public tree`).toBe(false);
      }
      return;
    }
    // Private posture: run the release filter over HEAD and assert the public
    // candidate (tracked files minus filter-denied) contains the SDD and zero
    // work-product paths.
    const tmpStaging = mkdtempSync(join(tmpdir(), 'wejsCandidatePurity-'));
    try {
      const output = execFileSync(
        'node',
        [join(repoRootOf(), 'scripts', 'exportFilter.mjs'), '--tag', 'HEAD', '--staging', tmpStaging, '--dryRun'],
        { cwd: repoRootOf(), encoding: 'utf8' },
      );
      const candidate = output
        .split('\n')
        .filter((line) => line.startsWith('  stage: '))
        .map((line) => line.slice('  stage: '.length));
      expect(candidate, 'SDD missing from the public candidate').toContain('docs/weJobSearch-SDD.md');
      for (const path of workProductPaths) {
        expect(candidate, `work-product path ${path} present in the public candidate`).not.toContain(path);
      }
    } finally {
      rmSync(tmpStaging, { recursive: true, force: true });
    }
  });

  it('CLI menu lists exactly the wired handlers — no menu drift', () => {
    const commandNames = extractCommandNames(readCoreSource());
    const dispatched = extractDispatchedCommands(readDispatcherSource());
    // Every advertised command must have a dispatch case
    for (const cmd of commandNames) {
      expect(dispatched).toContain(cmd);
    }
    // Every dispatch case must correspond to an advertised command
    for (const cmd of dispatched) {
      expect(commandNames).toContain(cmd);
    }
    expect([...dispatched].sort()).toEqual([...commandNames].sort());
  });
});

  it('README references the setup command and the SDD', () => {
    const readme = readDoc('README.md');
    expect(readme).toContain('setup');
    expect(readme).toContain('weJobSearch-SDD.md');
  });

  it('README does not contain the "That is the entire setup" passage', () => {
    const readme = readDoc('README.md');
    expect(readme).not.toContain('That is the entire setup');
  });

  it('README contains the radius limitation table', () => {
    const readme = readDoc('README.md');
    expect(readme).toContain('Radius limitation');
    expect(readme).toContain('LinkedIn');
    expect(readme).toContain('hiring.cafe');
    expect(readme).toContain('Wellfound');
    expect(readme).toContain('Welcome to the Jungle');
    expect(readme).toContain('Built In');
    expect(readme).toContain('FlexJobs');
  });

  it('README does not contradict the generated setup command', () => {
    const readme = readDoc('README.md');
    // The generated setup command says setup is agent-driven and never auto-runs search
    // The phrase "never auto-runs a search" is consistent with the setup command
    expect(readme).not.toContain('automatically run');
  });

  it('committed setup command carries the plain-language data-root, staging, and closing wording', () => {
    const setup = readFileSync(join(repoRootOf(), '.claude', 'commands', 'setup.md'), 'utf8').replace(/\s+/g, ' ');
    expect(setup).toContain('chosen automatically from your system account');
    expect(setup).toContain('Before staging anything');
    expect(setup).toContain('nothing chains automatically');
  });

  it('AGENTS.md routes natural-language profile-setup phrasing to the setup command (no paraphrase drift)', () => {
    const agents = readDoc('AGENTS.md').replace(/\s+/g, ' ');
    expect(agents).toContain('set up, initialize, or rebuild the profile');
    expect(agents).toContain('follow `.claude/commands/setup.md`');
    expect(agents).toContain('Do not improvise the flow');
  });
