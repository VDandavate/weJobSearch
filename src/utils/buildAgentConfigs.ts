import { mkdir, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { cwd as processCwd } from 'node:process';

// Single generator for every AI-agent config file produced for this repo
// (SDD Section 4.3). One source of truth for the rules each agent runtime
// (OpenCode, Claude Code, Cursor, Windsurf) re-ingests each fresh session, so
// the platforms never drift apart. Every generated file opens by pointing
// straight at docs/weJobSearch-SDD.md (SDD Section 7, session re-anchoring)
// and AGENTS.md; per AGENTS.md Step 7 that is a direct reference, never a
// paraphrase.

export const sourceOfTruthDoc = 'docs/weJobSearch-SDD.md';
export const executionChecklistDoc = 'AGENTS.md';

export interface AgentConfigPaths {
  opencodePath: string;
  claudeCommandsDir: string;
  cursorRulesDir: string;
  windsurfRulesPath: string;
}

export function agentConfigPaths(repoRoot: string): AgentConfigPaths {
  return {
    opencodePath: join(repoRoot, 'opencode.json'),
    claudeCommandsDir: join(repoRoot, '.claude', 'commands'),
    cursorRulesDir: join(repoRoot, '.cursor', 'rules'),
    windsurfRulesPath: join(repoRoot, '.windsurfrules'),
  };
}

// The shared opening every generated rules/commands file carries: point each
// agent directly at the SDD (the executable spec) and AGENTS.md (the execution
// checklist), then restate the project-wide absolutes from both.
export const sharedBaseRules = `# WeJobSearch agent guidelines

Read the full specification in \`docs/weJobSearch-SDD.md\` and the execution
checklist in \`AGENTS.md\` at the start of every fresh session. Do not rely on
memory of a prior session; long sessions dilute these rules. The SDD wins
wherever this file or AGENTS.md conflicts with it. If either file is missing,
stop and ask rather than improvising.

Hard rules that apply to every change, with no exceptions:

1. Strict naming. Files, directories, variables, and JSON keys use camelCase;
   classes and interfaces use PascalCase. Zero underscores anywhere in paths,
   file names, function identifiers, or JSON keys. External, platform-mandated
   names (SDK exports, protocol names, third-party field names) keep their
   official spelling.
2. No LaTeX. PDF generation uses Typst only (src/utils/typstCompiler.ts); the
   WASM compiler is the preferred path.
3. No personal data in committed code or config. The engine is fully generic.
   All real personal data lives under ONE canonical data root outside the git
   work tree (src/utils/canonicalDataRoot.ts): ~/Documents/weJobSearch/<username>/
   holds the working profile files (masterProfile.md, jobPreferences.yaml,
   screeningAnswers.json, networkingContacts.json), the working resumeVariants.yaml,
   and the applications/ tree (applicationHistory.json plus per-role output).
   Because that root is outside the repository, nothing under it can ever be
   committed. profile/ in the repo ships only blank <name>.example.<ext>
   templates plus the resumeVariants.yaml structure seed; real profile files are
   only ever written by the user, the init wizard, or the agent-facing profile
   MCP tools (getUserProfile, initializeUserProfile, updateUserProfile). You never
   fabricate personal-looking data into a real profile/ or canonical-root file,
   and never run init as part of build or test verification. All pipeline
   verification uses fixtures/, which contains synthetic data only. Profile
   writes require explicit user confirmation before any file changes.
4. No auto-submission, ever, under any framing. The tool prepares and tracks;
   the human submits. Never auto-apply to a posting, never contact an employer
   or recruiter on the user's behalf, never bypass authentication, CAPTCHAs, or
   bot detection. LinkedIn and FlexJobs are scraped despite ToS language
   prohibiting it as a deliberate, user-accepted risk (SDD Requirement 8); never
   quietly extend that posture to a new source.
5. Deterministic checks over judgment calls. Anything checkable by the
   validators (src/utils/namingLinter.ts, atsChecker, typstCompiler page count,
   config schema) is verified by running them, never by self-review.
6. No dead scaffolding. Do not create an empty directory, a dead link, or an
   unused file that nothing references.
7. Every capability is invoked explicitly. Evaluating a posting never
   auto-triggers resume generation; generating a resume never auto-triggers a
   cover letter or outreach message. No command or MCP tool chains into another.
   The CLI with no subcommand presents a menu and does nothing else (SDD
   Section 1.5).

8. Strict data-root confinement. The tool never reads or writes outside the resolved data root. Users stage files by copying into ~/Documents/weJobSearch/<username>/documents/ via the OS; the engine resolves the root through canonicalDataRoot.ts, and the only relocation mechanisms are --dataRoot and WEJOBSEARCHDATAROOT — both move the entire root, never a single file path. No CLI or MCP schema accepts a per-file path override; all filenames are fixed (masterProfile.md, jobPreferences.yaml, screeningAnswers.json, networkingContacts.json, resumeVariants.yaml, applicationHistory.json). Templates resolve through a fixed allowlist (shipped templates/ and <dataRoot>/templates/ only, via resolveTemplatePath). Report file output is redacted by default with a terminal warning; profile completion blocks on required-field placeholders.

Follow the numbered build sequence in AGENTS.md; do not skip ahead. Test only
against fixtures/, never against real profile/ or canonical-root data files.`;

// --- OpenCode -------------------------------------------------------------

export interface OpenCodeLocalMcp {
  type: 'local';
  command: readonly string[];
  cwd?: string;
  enabled?: boolean;
}

export interface OpenCodeConfig {
  $schema: string;
  instructions: readonly string[];
  mcp: Record<string, OpenCodeLocalMcp>;
}

// The generated opencode.json re-points at the source-of-truth instruction
// files (AGENTS.md is auto-loaded; the SDD is referenced explicitly because it
// is the executable spec) and registers the built MCP server binary.
export function buildOpenCodeConfig(repoRoot: string): OpenCodeConfig {
  const entry = join(repoRoot, 'dist', 'mcp', 'jobSearchServer.js');
  return {
    $schema: 'https://opencode.ai/config.json',
    instructions: [executionChecklistDoc, sourceOfTruthDoc],
    mcp: {
      jobSearch: {
        type: 'local',
        command: ['node', relative(repoRoot, entry)],
        enabled: true,
      },
    },
  };
}

// --- Claude Code ---------------------------------------------------------

// One markdown file per CLI/MCP capability in .claude/commands/. Each file is
// fully populated (no placeholders) and each re-points at the SDD.
export function buildClaudeCommand(name: string, description: string, invocation: string): string {
  return `${sharedBaseRules}


## Command: ${name}

${description}

Run exactly this command; do not auto-chain anything else:

\`\`\`bash
${invocation}
\`\`\`

The command may read files and write only its documented output. Report tool
errors verbatim; never expose secrets or personal profile content.`;
}

export function buildClaudeCommandsText(): Record<string, string> {
  return {
    generate: buildClaudeCommand(
      'generate',
      'Generate a tailored 1-page resume (Typst to PDF) for one target role, grounded in masterProfile.md with EEO enforcement and ATS verification.',
      'node dist/cli/jobSearchCore.js generate --company "AcmeCorp" --role "SeniorEngineer" [--variant usDetailedResume]',
    ),
    addContact: buildClaudeCommand(
      'addContact',
      'Log or update one networking contact (canonical-root networkingContacts.json). Tracks people only; never contacts them.',
      'node dist/cli/jobSearchCore.js addContact --name "Jane Smith" --company "AcmeCorp"',
    ),
    report: buildClaudeCommand(
      'report',
      'Print the funnel summary (fitStatus counts, status counts, referral conversion, manual-review backlog, overdue follow-ups).',
      'node dist/cli/jobSearchCore.js report [--format table|json]',
    ),
    reviewQueue: buildClaudeCommand(
      'reviewQueue',
      'List postings awaiting a human decision (fitStatus manualReview).',
      'node dist/cli/jobSearchCore.js reviewQueue',
    ),
    evaluate: buildClaudeCommand(
      'evaluate',
      'Fetch one posting, run fit evaluation, and log status evaluated (idempotent).',
      'node dist/cli/jobSearchCore.js evaluate --jobUrl "URL"',
    ),
    search: buildClaudeCommand(
      'search',
      'Scrape all adapters, dedup, evaluate, persist; renders BOTH fixed result tables (Requirement 2a).',
      'node dist/cli/jobSearchCore.js search --keywords "senior software engineer" --location "Remote"',
    ),
    confirmApp: buildClaudeCommand(
      'confirmApp',
      'Record that the user has submitted an application (local-only manual confirmation).',
      'node dist/cli/jobSearchCore.js confirmApp --company "AcmeCorp" --role "SeniorEngineer"',
    ),
    draftOutreach: buildClaudeCommand(
      'draftOutreach',
      'Draft one outreach message to a networking contact (never sent).',
      'node dist/cli/jobSearchCore.js draftOutreach --contactId "contact001" --company "AcmeCorp" --role "SeniorEngineer"',
    ),
    draftCoverLetter: buildClaudeCommand(
      'draftCoverLetter',
      'Draft a role-specific cover letter grounded in masterProfile.md (never auto-triggered).',
      'node dist/cli/jobSearchCore.js draftCoverLetter --company "AcmeCorp" --role "SeniorEngineer"',
    ),
    help: `${sharedBaseRules}


The CLI menu:

- generate, draftCoverLetter, draftOutreach, evaluate, search, addContact,
  report, reviewQueue, confirmApp.

Profile setup inside an agentic host uses the MCP tools, not the CLI:
getUserProfile (read-only inspection), initializeUserProfile (first-time
creation, requires user confirmation), updateUserProfile (partial updates,
requires user confirmation). The engine never fabricates profile data.

Run \`node dist/cli/jobSearchCore.js\` with no subcommand to print this menu.`,
  };
}

// --- Cursor ---------------------------------------------------------------

export function buildCursorRules(): string {
  return `${sharedBaseRules}


Cursor-specific notes:

- Follow the numbered AGENTS.md build sequence; do not skip ahead.
- Deterministic validators (namingLinter, atsChecker, typst page count, config
  schema) gate every change; run the linter and test suite before finishing.
- Personal data lives only under the canonical data root outside the repo
  (~/Documents/weJobSearch/<username>/ per src/utils/canonicalDataRoot.ts); never
  put a real name, salary, employer, or clearance status into committed code or
  config, and never write into the repository's own profile/ templates.
- The CLI menu and each command stay independently invocable; no auto-chains.`;
}

// --- Windsurf -------------------------------------------------------------

export function buildWindsurfRules(): string {
  return `${sharedBaseRules}


Windsurf-specific rules:

- Read AGENTS.md + docs/weJobSearch-SDD.md before editing any file.
- Keep every capability independently invocable; no command chains into another.
- Personal profile data is created only by the user, the init wizard, or the
  acknowledged-profile MCP tools, and stays under the canonical data root outside
  the git work tree. Never run the CLI init wizard during build or test
  verification.`;
}

// --- persistence ----------------------------------------------------------

export async function writeAgentConfigs(repoRoot: string = processCwd()): Promise<string[]> {
  const targetRoot = repoRoot.length > 0 ? repoRoot : processCwd();
  const paths = agentConfigPaths(targetRoot);
  await mkdir(paths.claudeCommandsDir, { recursive: true });
  await mkdir(paths.cursorRulesDir, { recursive: true });

  const written: string[] = [];

  const commands = buildClaudeCommandsText();
  for (const [name, body] of Object.entries(commands)) {
    const filePath = join(paths.claudeCommandsDir, `${name}.md`);
    await writeFile(filePath, body, 'utf8');
    written.push(filePath);
  }

  const opencodePath = paths.opencodePath;
  await writeFile(opencodePath, `${JSON.stringify(buildOpenCodeConfig(targetRoot), null, 2)}\n`, 'utf8');
  written.push(opencodePath);

  const cursorFile = join(paths.cursorRulesDir, 'weJobSearch.mdc');
  await writeFile(cursorFile, buildCursorRules(), 'utf8');
  written.push(cursorFile);

  await writeFile(paths.windsurfRulesPath, buildWindsurfRules(), 'utf8');
  written.push(paths.windsurfRulesPath);

  return written;
}

if (require.main === module) {
  void (async () => {
    const written = await writeAgentConfigs();
    for (const filePath of written) {
      console.log(filePath);
    }
  })();
}
