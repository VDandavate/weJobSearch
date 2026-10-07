import { createCliPromptContext } from './initWizard';
import { repoRootFromModule } from '../utils/canonicalDataRoot';
import {
  commandNames,
  menuLines,
  runAddContactCommand,
  runConfirmAppCommand,
  runDigestCommand,
  runDraftCoverLetter,
  runDraftOutreachCommand,
  runEvaluateCommand,
  runExportDataCommand,
  runGenerate,
  runImportDataCommand,
  runInitCommand,
  runParsePdfCommand,
  runPreviewResumeCommand,
  runReportCommand,
  runReviewCommand,
  runReviewQueueCommand,
  runSearchCommand,
  runShowCommand,
  runUpdateStatusCommand,
  runValidateCommand,
  type CliDispatchResult,
} from './jobSearchCore';
import {
  parseAddContactArgs,
  parseConfirmAppArgs,
  parseCoverLetterArgs,
  parseDigestArgs,
  parseEvaluateArgs,
  parseExportDataArgs,
  parseGenerateArgs,
  parseImportDataArgs,
  parseInitArgs,
  parseOutreachArgs,
  parsePdfArgs,
  parsePreviewResumeArgs,
  parseReportArgs,
  parseReviewArgs,
  parseReviewQueueArgs,
  parseSearchArgs,
  parseShowArgs,
  parseUpdateStatusArgs,
  parseValidateArgs,
  type ParsedCoverLetterArgs,
  type ParsedDigestArgs,
  type ParsedEvaluateArgs,
  type ParsedGenerateArgs,
  type ParsedOutreachArgs,
  type ParsedPreviewResumeArgs,
  type ParsedReviewArgs,
  type ParsedSearchArgs,
  type ParsedShowArgs,
} from './argsParser';

// CLI command dispatcher (SDD Section 4.1). Extracted verbatim from
// jobSearchCore.ts in Phase E so the god dispatcher shrinks: this module owns
// the dispatchCli if-chain, the nine thin help-vs-run command-line wrappers,
// and the nineteen per-command help-text string functions. The named run*
// handlers and the menu stay in jobSearchCore.ts and are imported here, so
// dispatched behavior is identical — every commandNames entry still has
// exactly one if-case below (see the menu-vs-dispatch parity test in
// docsContract.test.ts, which reads this file for the dispatch side).

function generateHelpText(): string[] {
  return [
    'generate - tailor a 1-page resume for one target company',
    '',
    'Usage:',
    '  node dist/cli/jobSearchCore.js generate --company NAME --role TITLE [options]',
    '',
    'Options:',
    '  --company NAME             Target company (required).',
    '  --role TITLE               Target role title (required).',
    '  --variant NAME             resumeVariants.yaml variant (optional; auto-selects by trigger).',
    '  --dataRoot PATH            Whole data-root relocation (default canonical data root).',
    '  --help                     Show this help.',
  ];
}

async function generateCommandLines(args: ParsedGenerateArgs): Promise<CliDispatchResult> {
  if (args.help === true) {
    return { exitCode: 0, printedLines: generateHelpText() };
  }
  if (args.company === undefined || args.role === undefined) {
    return {
      exitCode: 1,
      printedLines: [
        'generate requires --company and --role.',
        '',
        'Usage:',
        '  node dist/cli/jobSearchCore.js generate --company "AcmeCorp" --role "SeniorEngineer" [--variant usDetailedResume]',
      ],
    };
  }
  return runGenerate(args);
}

function previewResumeHelpText(): string[] {
  return [
    'previewResume - render a 1-page resume preview from the profile (no target role)',
    '',
    'Usage:',
    '  node dist/cli/jobSearchCore.js previewResume [--variant NAME] [options]',
    '',
    'Options:',
    '  --variant NAME             resumeVariants.yaml variant (optional; defaults to the trigger-less variant).',
    '  --dataRoot PATH            Whole data-root relocation (default canonical data root).',
    '  --help                     Show this help.',
  ];
}

async function previewResumeCommandLines(args: ParsedPreviewResumeArgs): Promise<CliDispatchResult> {
  if (args.help === true) {
    return { exitCode: 0, printedLines: previewResumeHelpText() };
  }
  return runPreviewResumeCommand(args);
}

function coverLetterHelpText(): string[] {
  return [
    'draftCoverLetter - draft a role-specific cover letter (plain Markdown, never auto-triggered)',
    '',
    'Usage:',
    '  node dist/cli/jobSearchCore.js draftCoverLetter --company NAME --role TITLE [options]',
    '',
    'Options:',
    '  --company NAME                  Target company (required).',
    '  --role TITLE                    Target role title (required).',
    '  --postingRequirements "A, B"    Posting requirements; only those genuinely supported by',
    '                                  masterProfile.md are referenced (optional, comma-separated).',
    '  --dataRoot PATH                 Whole data-root relocation (default canonical data root).',
    '  --help                          Show this help.',
  ];
}

async function coverLetterCommandLines(args: ParsedCoverLetterArgs): Promise<CliDispatchResult> {
  if (args.help === true) {
    return { exitCode: 0, printedLines: coverLetterHelpText() };
  }
  if (args.company === undefined || args.role === undefined) {
    return {
      exitCode: 1,
      printedLines: [
        'draftCoverLetter requires --company and --role.',
        '',
        'Usage:',
        '  node dist/cli/jobSearchCore.js draftCoverLetter --company "AcmeCorp" --role "SeniorEngineer"',
      ],
    };
  }
  return runDraftCoverLetter(args);
}

function outreachHelpText(): string[] {
  return [
    'draftOutreach - draft a short networking message for one contact (never sent)',
    '',
    '  Tailored to a specific person from networkingContacts.json (canonical data root) and a target role,',
    '  grounded strictly in masterProfile.md (SDD Requirement 6a). Drafts',
    '  applications/<company><role>/outreachMessage.md (under the canonical data root) and stops; nothing',
    '',
    'Usage:',
    '  node dist/cli/jobSearchCore.js draftOutreach --contactId ID --company NAME --role TITLE [options]',
    '',
    'Options:',
    '  --contactId ID           Networking contact to address (required; from networkingContacts.json).',
    '  --company NAME           Target company (required).',
    '  --role TITLE             Target role title (required).',
    '  --platform linkedin|email  Message format (default linkedin; email = cold-email variant).',
    '  --dataRoot PATH          Whole data-root relocation (default canonical data root).',
    '  --help                   Show this help.',
  ];
}

async function outreachCommandLines(args: ParsedOutreachArgs): Promise<CliDispatchResult> {
  if (args.help === true) {
    return { exitCode: 0, printedLines: outreachHelpText() };
  }
  if (args.contactId === undefined || args.company === undefined || args.role === undefined) {
    return {
      exitCode: 1,
      printedLines: [
        'draftOutreach requires --contactId, --company, and --role.',
        '',
        'Usage:',
        '  node dist/cli/jobSearchCore.js draftOutreach --contactId "contact001" --company "AcmeCorp" --role "SeniorEngineer"',
      ],
    };
  }
  return runDraftOutreachCommand(args);
}

export function digestHelpText(): string[] {
  return [
    'digest - run every saved search, evaluate, and render both fixed result tables',
    '',
    '  Re-runs each saved search (saved via search --save) through the same',
    '  dedup -> extract -> fit -> persist pipeline as search, deduplicates across',
    '  searches, and renders the Active Results (7-column core) and Excluded Results',
    '  (6-column core) tables (SDD Requirement 2a).',
    '',
    'Usage:',
    '  node dist/cli/jobSearchCore.js digest [options]',
    '',
    'Options:',
    '  --dataRoot PATH            Whole data-root relocation (default canonical data root).',
    '  --help                     Show this help.',
  ];
}

export function showHelpText(): string[] {
  return [
    'show - print the stored detail for one evaluated posting',
    '',
    '  Re-reads the posting description, fit score/status, posting facts, salary',
    '  range, sources, link, and status history from applicationHistory.json',
    '  (SRA-02). Read-only; nothing is generated or changed.',
    '',
    'Usage:',
    '  node dist/cli/jobSearchCore.js show --company "AcmeCorp" --role "SeniorEngineer" [options]',
    '',
    'Options:',
    '  --company NAME           Company as recorded when the posting was evaluated (required).',
    '  --role TITLE            Role title as recorded when the posting was evaluated (required).',
    '  --dataRoot PATH          Whole data-root relocation (default canonical data root).',
    '  --help                  Show this help.',
  ];
}

function reviewHelpText(): string[] {
  return [
    'review - review one posting with an explicit next-action menu',
    '',
    '  Prints the same stored detail as show, then offers exactly one action per',
    '  choice: [g]enerate resume, [c]over letter, [o]utreach message, [a]pply',
    '  (confirm submission), or [s]kip. Nothing auto-chains (SDD Section 1.5).',
    '',
    'Usage:',
    '  node dist/cli/jobSearchCore.js review --company "AcmeCorp" --role "SeniorEngineer" [options]',
    '',
    'Options:',
    '  --company NAME           Company as recorded when the posting was evaluated (required).',
    '  --role TITLE            Role title as recorded when the posting was evaluated (required).',
    '  --dataRoot PATH          Whole data-root relocation (default canonical data root).',
    '  --help                  Show this help.',
  ];
}

export function updateStatusHelpText(): string[] {
  return [
    'updateStatus - record a status transition for one evaluated posting',
    '',
    '  Wraps updateApplicationStatus so the funnel reflects reality (SRA-03).',
    '  Only interviewing, offer, and rejected are settable here; appliedConfirmed',
    '  is exclusively reachable through confirmApplicationSubmission, and',
    '  staleNoResponse is a derived visibility flag.',
    '',
    'Usage:',
    '  node dist/cli/jobSearchCore.js updateStatus --company "AcmeCorp" --role "SeniorEngineer" --status interviewing [options]',
    '',
    'Options:',
    '  --company NAME           Company as recorded when the posting was evaluated (required).',
    '  --role TITLE            Role title as recorded when the posting was evaluated (required).',
    '  --status interviewing|offer|rejected  New status (required).',
    '  --notes TEXT            Optional note stored on the status change.',
    '  --dataRoot PATH         Whole data-root relocation (default canonical data root).',
    '  --help                  Show this help.',
  ];
}

function evaluateHelpText(): string[] {
  return [
    'evaluate - fetch and score one posting, then log it with status evaluated',
    '',
    'Usage:',
    '  node dist/cli/jobSearchCore.js evaluate --jobUrl URL [options]',
    '',
    'Options:',
    '  --jobUrl URL           Full job posting URL (LinkedIn, Built In, or Welcome to the Jungle).',
    '  --dataRoot PATH        Whole data-root relocation (default canonical data root).',
    '  --help                 Show this help.',
  ];
}

function searchHelpText(): string[] {
  return [
    'search - scrape every registered adapter, dedup the batch, evaluate each unique posting,',
    'persist it with status evaluated, and render BOTH fixed results tables (Requirement 2a)',
    '',
    'Without --keywords, search runs every targetRoles query from jobPreferences.yaml',
    '(one query per role, merged and deduplicated across queries - never sliced to',
    'the first). With --keywords, it runs exactly that one query.',
    '',
    'Both tables are fixed by contract (SDD Requirement 2a): the Active table has',
    'seven columns and the Excluded table has six, with no conditional columns.',
    '',
    'Usage:',
    '  node dist/cli/jobSearchCore.js search --keywords "senior software engineer" --location "Remote"',
    '  node dist/cli/jobSearchCore.js search   (uses targetRoles from jobPreferences.yaml)',
    '',
    'Options:',
    '  --keywords "WORDS"     What to search for (optional: omit to search by profile).',
    '  --location WHERE       Location/work-mode term (optional).',
    '  --dataRoot PATH        Whole data-root relocation (default canonical data root).',
    '  --save                 Save this search for the digest command (optional; requires --keywords).',
    '  --remoteOnly           Show only postings classified remote (optional; keyword search only).',
    '  --minFit SCORE         Show only postings with fitScore >= SCORE (optional; keyword search only).',
    '  --minSalary AMOUNT     Show only postings whose low salary end >= AMOUNT; postings without a stated salary are kept (optional; keyword search only).',
    '  --maxAgeDays DAYS      Show only postings posted within DAYS; postings without a posted date are kept (optional; keyword search only).',
    '  --help                 Show this help.',
  ];
}

async function evaluateCommandLines(args: ParsedEvaluateArgs): Promise<CliDispatchResult> {
  if (args.help === true) {
    return { exitCode: 0, printedLines: evaluateHelpText() };
  }
  return runEvaluateCommand(args);
}

async function searchCommandLines(args: ParsedSearchArgs): Promise<CliDispatchResult> {
  if (args.help === true) {
    return { exitCode: 0, printedLines: searchHelpText() };
  }
  return runSearchCommand(args);
}

async function digestCommandLines(args: ParsedDigestArgs): Promise<CliDispatchResult> {
  if (args.help === true) {
    return { exitCode: 0, printedLines: digestHelpText() };
  }
  return runDigestCommand(args);
}

async function showCommandLines(args: ParsedShowArgs): Promise<CliDispatchResult> {
  if (args.help === true) {
    return { exitCode: 0, printedLines: showHelpText() };
  }
  return runShowCommand(args);
}

async function reviewCommandLines(args: ParsedReviewArgs): Promise<CliDispatchResult> {
  if (args.help === true) {
    return { exitCode: 0, printedLines: reviewHelpText() };
  }
  if (args.companyName === undefined || args.roleTitle === undefined) {
    return {
      exitCode: 1,
      printedLines: [
        'review requires --company and --role.',
        '',
        'Usage:',
        '  node dist/cli/jobSearchCore.js review --company "AcmeCorp" --role "SeniorEngineer"',
      ],
    };
  }
  const prompt = createCliPromptContext();
  try {
    return await runReviewCommand(args, { prompt });
  } finally {
    prompt.close();
  }
}

export function addContactHelpText(): string[] {
  return [
    'addContact - log or update a networking contact (canonical-root networkingContacts.json)',
    '',
    '  Tracks people, not postings (SDD Requirement 6). This file is a tracker only;',
    '  nothing here ever contacts the person. Run reviewQueue or report to act on it.',
    '',
    'Usage:',
    '  node dist/cli/jobSearchCore.js addContact --name "Jane Smith" --company "AcmeCorp" [options]',
    '',
    'Options:',
    '  --name NAME                Contact name (required).',
    '  --company COMPANY          Contact employer (required).',
    '  --relationship TYPE        Relationship (e.g., formerColleague, recruiter; default unspecified).',
    '  --linkedApplicationIds "#1,#2"  Application ids already referred-in (comma-separated, optional).',
    '  --followUpDue YYYY-MM-DD   Follow-up due date for reporting (optional).',
    '  --dataRoot PATH            Whole data-root relocation (default canonical data root).',
    '  --help                     Show this help.',
  ];
}

export function reportHelpText(): string[] {
  return [
    'report - print the funnel summary from application history + networking contacts',
    '',
    'Usage:',
    '  node dist/cli/jobSearchCore.js report [--format table|json] [options]',
    '',
    'Output (SDD Requirement 9):',
    '  count by fitStatus, count by status (staleNoResponse derived via staleChecker),',
    '  referral-linked vs. cold-apply conversion, applications awaiting manualReview,',
    '  contacts with overdue follow-ups, recent searches (EUO-13).',
    '',
    'Options:',
    '  --format table|json        Output format (default table).',
    '  --noRedact                 Opt out of PII redaction (file output only; terminal always warns).',
    '  --output <fileName>        Write report to a file under the data root (redacted by default).',
    '  --dataRoot PATH            Whole data-root relocation (default canonical data root).',
    '  --help                     Show this help.',
  ];
}

export function reviewQueueHelpText(): string[] {
  return [
    'reviewQueue - list postings awaiting a human decision (fitStatus manualReview)',
    '',
    'Usage:',
    '  node dist/cli/jobSearchCore.js reviewQueue [options]',
    '',
    'Options:',
    '  --dataRoot PATH            Whole data-root relocation (default canonical data root).',
    '  --help                     Show this help.',
  ];
}

export function initHelpText(): string[] {
  const defaultRepoRoot = repoRootFromModule();
  return [
    'init - interactive guided setup wizard (SDD Requirement 1b)',
    '',
    'Usage:',
    '  node dist/cli/jobSearchCore.js init [options]',
    '',
    'Prompts through compensation, clearance, work authorization, preferred',
    'locations, and non-negotiables, then writes ONLY the real',
    'profile files (jobPreferences.yaml, screeningAnswers.json, masterProfile.md,',
    'networkingContacts.json). The .example templates are never touched; a fresh',
    'canonical-root setup also seeds the working resumeVariants.yaml. Existing',
    'files are kept, updated per-section, or replaced only after explicit',
    'confirmation. init never chains into any other command.',
    '',
    'Options:',
    '  --dataRoot PATH            Whole data-root relocation (default canonical data root',
    '                             ~/Documents/weJobSearch/<username>/).',
    '  --repoRoot PATH            Repository root for git profile-protection checks',
    `                             (default: checkout root ${defaultRepoRoot}). The naming`,
    '                             linter still reports here but never blocks onboarding.',
    '  --help                     Show this help.',
    '',
    '  Protection runs before any write: a blocked run writes nothing and',
    '  exits 1. Paths outside the git work tree (including the default data',
    '  root) are inherently protected and never block.',
  ];
}

export function validateHelpText(): string[] {
  return [
    'validate - validate the configuration files without running anything else',
    '',
    '  Reads jobPreferences.yaml and resumeVariants.yaml from the data root,',
    '  checks each against its schema, and reports per-file OK or the specific',
    '  failure. Missing files fail with a pointer to init. Nothing is written,',
    '  generated, or chained (SDD Section 1.5).',
    '',
    'Usage:',
    '  node dist/cli/jobSearchCore.js validate [--dataRoot PATH]',
    '',
    'Options:',
    '  --dataRoot PATH            Whole data-root relocation (default canonical data root).',
    '  --help                     Show this help.',
  ];
}

export function exportDataHelpText(): string[] {
  return [
    'exportData - back up the canonical data root to a gzip tarball (EUO-10)',
    '',
    'Usage:',
    '  node dist/cli/jobSearchCore.js exportData --archivePath PATH [options]',
    '',
    'Tarballs the canonical data root (~/Documents/weJobSearch/<username>/) into',
    'the given archive path. The archive contains ONLY the canonical root',
    'contents - the git work tree is never touched. Deterministic (portable tar',
    'metadata), no network, no LLM. The archive is written atomically (temp file',
    '+ rename) and is refused if it would land inside the root being archived.',
    '',
    'Options:',
    '  --archivePath PATH         Destination archive file (required).',
    '  --rootPath PATH            Canonical root override (default canonical data root).',
    '  --help                     Show this help.',
  ];
}

export function importDataHelpText(): string[] {
  return [
    'importData - restore a backup into a fresh canonical root (EUO-10)',
    '',
    'Usage:',
    '  node dist/cli/jobSearchCore.js importData --archivePath PATH [options]',
    '',
    'Restores a gzip tarball produced by exportData into the canonical data root',
    '(or the --rootPath override). No-overwrite guard: if any real profile file',
    '(masterProfile.md, jobPreferences.yaml, screeningAnswers.json,',
    'networkingContacts.json) already exists at the destination, the import',
    'refuses and names every blocking file - existing profile data is never',
    'overwritten (import never overwrites existing profile data). Extraction is confined to the destination root (absolute paths',
    'and .. traversal are rejected).',
    '',
    'Options:',
    '  --archivePath PATH         Archive file to restore (required).',
    '  --rootPath PATH            Destination root override (default canonical data root).',
    '  --help                     Show this help.',
  ];
}

export function parsePdfHelpText(): string[] {
  return [
    'parsePdf - parse a local PDF resume or job description',
    '',
    '  Read-only: extracts and cleans text via parsePdfDocument and reports',
    '  the page and character counts. Never writes, evaluates, or generates.',
    '',
    'Usage:',
    '  node dist/cli/jobSearchCore.js parsePdf --filePath "./myResume.pdf"',
    '',
    'Options:',
    '  --filePath PATH  Data-root-confined path to the local PDF file to parse (required).',
    '  --dataRoot PATH  Whole data-root relocation (default canonical data root).',
    '  --help           Show this help.',
  ];
}

export function confirmAppHelpText(): string[] {
  return [
    'confirmApp - confirm a submission and update history',
    '',
    '  Thin dispatch over confirmApplicationSubmission: the human submits the',
    '  application on the portal themselves, then this records appliedConfirmed',
    '  in applicationHistory.json. This is the ONLY path into appliedConfirmed;',
    '  nothing here auto-submits or contacts anyone (SDD Sections 1.4, 1.5).',
    '',
    'Usage:',
    '  node dist/cli/jobSearchCore.js confirmApp --company "AcmeCorp" --role "SeniorEngineer" [--notes "Submitted via Greenhouse"]',
    '',
    'Options:',
    '  --company NAME       Company as recorded when the posting was evaluated (required).',
    '  --role TITLE        Role title as recorded when the posting was evaluated (required).',
    '  --notes TEXT        Optional note stored on the confirmation (e.g. portal used).',
    '  --dataRoot PATH     Whole data-root relocation (default canonical data root).',
    '  --help              Show this help.',
  ];
}

export async function dispatchCli(argv: readonly string[]): Promise<CliDispatchResult> {
  const [command] = argv;
  if (command === undefined || command === 'help' || command === '--help' || command === '-h') {
    return { exitCode: 0, printedLines: menuLines() };
  }
  if (command === 'generate') {
    return generateCommandLines(parseGenerateArgs(argv.slice(1)));
  }
  if (command === 'previewResume') {
    return previewResumeCommandLines(parsePreviewResumeArgs(argv.slice(1)));
  }
  if (command === 'parsePdf') {
    return runParsePdfCommand(parsePdfArgs(argv.slice(1)));
  }
  if (command === 'confirmApp') {
    return runConfirmAppCommand(parseConfirmAppArgs(argv.slice(1)));
  }
  if (command === 'draftCoverLetter') {
    return coverLetterCommandLines(parseCoverLetterArgs(argv.slice(1)));
  }
  if (command === 'draftOutreach') {
    return outreachCommandLines(parseOutreachArgs(argv.slice(1)));
  }
  if (command === 'evaluate') {
    return evaluateCommandLines(parseEvaluateArgs(argv.slice(1)));
  }
  if (command === 'search') {
    return searchCommandLines(parseSearchArgs(argv.slice(1)));
  }
  if (command === 'digest') {
    return digestCommandLines(parseDigestArgs(argv.slice(1)));
  }
  if (command === 'show') {
    return showCommandLines(parseShowArgs(argv.slice(1)));
  }
  if (command === 'review') {
    return reviewCommandLines(parseReviewArgs(argv.slice(1)));
  }
  if (command === 'updateStatus') {
    return runUpdateStatusCommand(parseUpdateStatusArgs(argv.slice(1)));
  }
  if (command === 'addContact') {
    return runAddContactCommand(parseAddContactArgs(argv.slice(1)));
  }
  if (command === 'report') {
    return runReportCommand(parseReportArgs(argv.slice(1)));
  }
  if (command === 'reviewQueue') {
    return runReviewQueueCommand(parseReviewQueueArgs(argv.slice(1)));
  }
  if (command === 'init') {
    return runInitCommand(parseInitArgs(argv.slice(1)));
  }
  if (command === 'validate') {
    return runValidateCommand(parseValidateArgs(argv.slice(1)));
  }
  if (command === 'exportData') {
    return runExportDataCommand(parseExportDataArgs(argv.slice(1)));
  }
  if (command === 'importData') {
    return runImportDataCommand(parseImportDataArgs(argv.slice(1)));
  }
  const known = commandNames.find((name) => name === command);
  if (known === undefined) {
    return { exitCode: 1, printedLines: ['Unknown command:', command, '', ...menuLines()] };
  }
  // Unreachable while the menu-vs-dispatch parity test holds (every
  // commandNames entry has an if-case above, and the if-chain shape is what
  // the parity extractor parses — see docsContract.test.ts, which reads this
  // file for the dispatch side). Kept as defense-in-depth, never as a silent
  // pass-through.
  return {
    exitCode: 1,
    printedLines: [
      `The '${known}' command is not implemented yet.`,
      `Only ${commandNames.join(', ')} are wired in this baseline.`,
    ],
  };
}
