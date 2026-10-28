import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { commandNames } from '../cli/jobSearchCore';
import {
  agentConfigPaths,
  buildClaudeCommandsText,
  buildOpenCodeConfig,
  buildWindsurfRules,
  sharedBaseRules,
  sourceOfTruthDoc,
  writeAgentConfigs,
} from './buildAgentConfigs';

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'weJobSearch-config-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe('buildAgentConfigs', () => {
  it('writes every platform config file from a single generator', async () => {
    await withTempDir(async (dir) => {
      const written = await writeAgentConfigs(dir);
      expect(written.length).toBeGreaterThanOrEqual(4);

      const opencode = await readFile(join(dir, 'opencode.json'), 'utf8');
      expect(opencode).toContain('"$schema": "https://opencode.ai/config.json"');

      const claudeDir = join(dir, '.claude', 'commands');
      const claudeFiles = await readdir(claudeDir);
      expect(claudeFiles.length).toBeGreaterThan(0);

      const cursorFiles = await readdir(join(dir, '.cursor', 'rules'));
      expect(cursorFiles.length).toBeGreaterThan(0);

      const windsurf = await readFile(join(dir, '.windsurfrules'), 'utf8');
      expect(windsurf.trim().length).toBeGreaterThan(0);
    });
  });

  it('references docs/weJobSearch-SDD.md directly in every generated file (no paraphrase)', async () => {
    await withTempDir(async (dir) => {
      const written = await writeAgentConfigs(dir);
      expect(written.length).toBeGreaterThanOrEqual(4);

      const markdownFiles = written.filter((path) => path.endsWith('.md') || path.endsWith('.mdc') || path.endsWith('.windsurfrules'));
      for (const filePath of markdownFiles) {
        const text = await readFile(filePath, 'utf8');
        expect(text).toContain('docs/weJobSearch-SDD.md');
      }

      const opencode = await readFile(join(dir, 'opencode.json'), 'utf8');
      const config = JSON.parse(opencode);
      expect(config.instructions).toContain(sourceOfTruthDoc);
      expect(config.instructions).toContain('AGENTS.md');
    });
  });

  it('routes natural-language profile-setup phrasing to the setup command (OpenCode reads no command files)', () => {
    // opencode loads only AGENTS.md + opencode.json instructions; if AGENTS.md
    // loses this trigger, "set up my profile" improvises instead of routing.
    const rules = sharedBaseRules.replace(/\s+/g, ' ');
    expect(rules).toContain('set up, initialize, or rebuild the profile');
    expect(sharedBaseRules).toContain('.claude/commands/setup.md');
    expect(sharedBaseRules).toContain('Do not improvise the flow');
  });

  it('opencode.json is structurally valid for the installed OpenCode config schema', async () => {
    await withTempDir(async (dir) => {
      const config = buildOpenCodeConfig(dir);
      expect(config.$schema).toBe('https://opencode.ai/config.json');
      expect([...config.instructions].sort()).toEqual(['AGENTS.md', 'docs/weJobSearch-SDD.md'].sort());
      // OpenCode has no command-file convention, so /setup must be registered
      // here or a fresh user has no first-run entrypoint at all.
      expect(config.commands?.setup.template).toContain('.claude/commands/setup.md');

      const jobSearch = config.mcp.jobSearch;
      expect(jobSearch.type).toBe('local');
      expect(jobSearch.enabled).toBe(true);
      expect(jobSearch.command[0]).toBe('node');
      expect(jobSearch.command[1]).toContain('dist/mcp/jobSearchServer.js');
    });
  });

  it('generated configs contain no candidate-looking personal data', async () => {
    await withTempDir(async (dir) => {
      const written = await writeAgentConfigs(dir);
      for (const filePath of written) {
        const text = await readFile(filePath, 'utf8');
        expect(text).not.toMatch(/Jane Sample|SampleCorp|jane@sample\.example/);
        expect(text).not.toContain('profile/masterProfile.md');
      }
    });
  });

  it('buildWindsurfRules and the claude commands all open with the SDD anchor', async () => {
    await withTempDir(async (dir) => {
      const written = await writeAgentConfigs(dir);
      const commandDir = join(dir, '.claude', 'commands');
      for (const name of ['search', 'evaluate', 'generate', 'help']) {
        const body = await readFile(join(commandDir, `${name}.md`), 'utf8');
        expect(body).toContain('docs/weJobSearch-SDD.md');
      }
      const windsurf = buildWindsurfRules();
      expect(windsurf).toContain('docs/weJobSearch-SDD.md');
    });
  });

  it('paths directory mirrors SDD structure (opencode.json at root, platform dirs under dot-roots)', async () => {
    await withTempDir(async (dir) => {
      const paths = agentConfigPaths(dir);
      expect(paths.opencodePath).toContain('opencode.json');
      expect(paths.claudeCommandsDir).toContain(join('.claude', 'commands'));
      expect(paths.cursorRulesDir).toContain(join('.cursor', 'rules'));
      expect(paths.windsurfRulesPath).toContain('.windsurfrules');
    });
  });
});

describe('setup command contract', () => {
  function setupBody(): string {
    return (buildClaudeCommandsText().setup.split('## Command: setup')[1] ?? '').replace(/\s+/g, ' ');
  }

  function setupStep(start: string, end?: string): string {
    const body = setupBody();
    const from = body.indexOf(start);
    expect(from, `${start} missing from the setup command`).toBeGreaterThanOrEqual(0);
    if (end === undefined) {
      return body.slice(from);
    }
    const to = body.indexOf(end, from);
    expect(to, `${end} missing from the setup command`).toBeGreaterThan(from);
    return body.slice(from, to);
  }

  it('generates a setup command that anchors on the SDD', () => {
    const commands = buildClaudeCommandsText();
    expect(Object.keys(commands)).toContain('setup');
    expect(commands.setup).toContain('docs/weJobSearch-SDD.md');
  });

  it('Inspect shows the data root in plain language and defers relocation detail', () => {
    const inspect = setupStep('1. Inspect.', '2. Documents.');
    expect(inspect).toContain('chosen automatically from your system account');
    expect(inspect).toContain('nothing to configure');
    const conditional = inspect.indexOf('Only if the user asks about moving the data');
    expect(conditional).toBeGreaterThanOrEqual(0);
    const flagPositions = [
      inspect.indexOf('--dataRoot'),
      inspect.indexOf('WEJOBSEARCHDATAROOT'),
    ].filter((position) => position >= 0);
    expect(flagPositions.length).toBeGreaterThan(0);
    expect(Math.min(...flagPositions)).toBeGreaterThan(conditional);
  });

  it('Documents requires a plain-language staging explanation before copying', () => {
    const documents = setupStep('2. Documents.', '3. Profile draft.');
    expect(documents).toContain('Before staging anything');
    expect(documents).toContain('reads only inside its data root');
    expect(documents).toContain('originals are left untouched');
  });

  it('Stop requires the full closing-message contract', () => {
    const stop = setupStep('12. Stop.');
    expect(stop).toContain('searchByProfile');
    expect(stop).toContain('primary next step');
    expect(stop).toContain('searchJobPostings');
    expect(stop).toContain('saved search');
    expect(stop).toContain('scores it against the profile and logs it to application history');
    expect(stop).toContain('networking contact');
    expect(stop).toContain('funnel report');
    expect(stop).toContain('nothing chains automatically');
  });

  it('names the MCP tools in flow order', () => {
    const body = buildClaudeCommandsText().setup.split('## Command: setup')[1] ?? '';
    const flowOrder = [
      'getUserProfile',
      'ingestDocuments',
      'initializeUserProfile',
      'updateUserProfile',
      'searchByProfile',
      'searchJobPostings',
    ];
    const positions = flowOrder.map((toolName) => body.indexOf(toolName));
    positions.forEach((position, index) => {
      expect(position, `${flowOrder[index]} missing from the setup command`).toBeGreaterThanOrEqual(0);
    });
    expect([...positions].sort((left, right) => left - right)).toEqual(positions);
  });

  it('states the no-write-before-confirmation rule', () => {
    const body = (buildClaudeCommandsText().setup.split('## Command: setup')[1] ?? '').replace(/\s+/g, ' ');
    expect(body).toContain(
      'Do not write, create, or modify any profile file before the user confirms the preview.',
    );
  });

  it('states the offer-dont-run rule for the first search', () => {
    const body = (buildClaudeCommandsText().setup.split('## Command: setup')[1] ?? '').replace(/\s+/g, ' ');
    expect(body).toContain(
      'Never start the search on your own; offer it and wait for an explicit yes.',
    );
  });
});

describe('generated config contract (cleanup Phase 7d)', () => {
  function repoRoot(): string {
    return resolve(__dirname, '..', '..');
  }

  function registeredMcpToolNames(): string[] {
    const source = readFileSync(join(repoRoot(), 'src', 'mcp', 'jobSearchServer.ts'), 'utf8');
    return [...source.matchAll(/registerTool\(\s*'([^']+)'/g)].map((match) => match[1] ?? '');
  }

  // Shared capabilities that must exist in all three surfaces: the CLI name in
  // commandNames, the MCP tool in the server registry, and the Claude command
  // file key from the generator. Names differ across surfaces (confirmApp vs
  // confirmApplicationSubmission), so the map is the contract.
  const sharedCapabilityMap: Readonly<Record<string, string>> = {
    generate: 'generateTailoredApplication',
    evaluate: 'evaluateJobPosting',
    search: 'searchJobPostings',
    confirmApp: 'confirmApplicationSubmission',
    draftCoverLetter: 'draftCoverLetter',
    draftOutreach: 'draftOutreachMessage',
    report: 'getFunnelReport',
    reviewQueue: 'getReviewQueue',
    addContact: 'logNetworkingContact',
  };

  it('keeps shared capabilities consistent across CLI names, MCP tools, and Claude commands', () => {
    const commands = buildClaudeCommandsText();
    const mcpNames = registeredMcpToolNames();
    expect(mcpNames.length).toBeGreaterThan(0);
    for (const [cliName, mcpName] of Object.entries(sharedCapabilityMap)) {
      expect(commandNames, `${cliName} missing from commandNames`).toContain(cliName);
      expect(mcpNames, `${mcpName} missing from the MCP registry`).toContain(mcpName);
      expect(Object.keys(commands), `${cliName}.md missing from the generator`).toContain(cliName);
    }
  });

  it('points every generated Claude command at a wired CLI command (no dead aliases)', () => {
    const commands = buildClaudeCommandsText();
    for (const [name, body] of Object.entries(commands)) {
      const invocation = body.match(/node dist\/cli\/jobSearchCore\.js([^\n`]*)/);
      if (name === 'setup') {
        // Setup is prompt-only: it orchestrates MCP tools and never invokes the CLI.
        expect(invocation, 'setup.md must not invoke the CLI').toBeNull();
        continue;
      }
      expect(invocation, `${name}.md has no CLI invocation`).not.toBeNull();
      const target = (invocation?.[1] ?? '').trim().split(/\s+/)[0] ?? '';
      if (name === 'help') {
        // The help command prints the bare menu; it takes no subcommand.
        expect(target === '' || target.startsWith('-')).toBe(true);
      } else {
        expect(commandNames, `${name}.md points at unwired CLI name '${target}'`).toContain(target);
      }
    }
    // confirmApp regression: now that confirmApp dispatch is wired, the file
    // must reference the live path, never a dead alias.
    expect(commands.confirmApp).toContain('jobSearchCore.js confirmApp');
  });

  it('keeps on-disk .claude/commands files in sync with the generator', async () => {
     const dir = join(repoRoot(), '.claude', 'commands');
     const onDisk = (await readdir(dir)).filter((file) => file.endsWith('.md')).sort();
     const generated = Object.keys(buildClaudeCommandsText())
       .map((name) => `${name}.md`)
       .sort();
     expect(onDisk).toEqual(generated);
     for (const file of onDisk) {
       const body = await readFile(join(dir, file), 'utf8');
       expect(body).toContain('docs/weJobSearch-SDD.md');
       expect(body).not.toContain('not implemented yet');
     }
   });

   it('regenerated configs are byte-identical to committed files (zero-diff gate)', async () => {
     await withTempDir(async (dir) => {
       const written = await writeAgentConfigs(dir);
       const repoRootDir = resolve(__dirname, '..', '..');
       for (const genPath of written) {
         const relPath = relative(repoRootDir, genPath);
         const committedPath = join(repoRootDir, relPath);
         const genContent = await readFile(genPath);
         const committedContent = await readFile(committedPath);
         expect(genContent.equals(committedContent),
           `${relPath}: regenerated output differs from committed file — run node dist/utils/buildAgentConfigs.js and commit the result`
         ).toBe(true);
       }
     });
   });
 });