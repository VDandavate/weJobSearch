# AGENTS.md

This file is read automatically by agentic coding tools (OpenCode, Claude Code, Cursor, Windsurf, Aider, Copilot CLI) at the start of every session in this repo. Read it before taking any action. Re-read it at the start of every new session, even if you have worked on this repo before. Do not rely on memory of prior sessions.

## Source of truth

The full specification is `docs/weJobSearch-SDD.md`. This file is a summary and execution checklist. If anything here conflicts with the SDD, the SDD wins. If the SDD is missing or you cannot find it, stop and ask rather than improvising.

**Setup routing (first run or after a wipe):** Any user request to set up, initialize, or rebuild the profile ("set up my profile" or any phrasing of first-run setup) means: run the `setup` command and follow `.claude/commands/setup.md` exactly, step by step. Do not improvise the flow, and do not infer that setup chains into any other capability (SDD Section 1.5). A request that already names a listed capability keeps its own command; this trigger is for setup intent only.

**The baseline build is complete.** `HANDOFF.md` documents what was built, verification results, judgment calls, and deviations. Do not rebuild the project from scratch; extend or fix it. If you are tempted to re-run "the build sequence", you are in the wrong session — read HANDOFF.md instead.

## Non-negotiable rules

These apply to every file you create or edit, with no exceptions:

- **Naming:** Strict camelCase for files, variables, and directories. PascalCase for classes and interfaces. Zero underscores anywhere in file names, paths, function identifiers, or JSON/YAML keys. Enforced mechanically by `src/utils/namingLinter.ts`, not by self-review. The linter's documented exemptions are narrow: `__`-prefixed machine/protocol names (`__NEXT_DATA__`, `__INITIAL_DATA__`, `__ref`, `__typename`, `__dirname`), string-literal externals reached via bracket/string access (`f_TPR`, `f_WT`, HTML/CSS classes, `salary_currency`), Node specifiers (`node:child_process`), `$`-prefixed JSON-schema keys, npm `dependencies` keys, and ecosystem filenames (`package-lock.json`, `AGENTS.md`). It is not an "ignore all strings" escape hatch. Read external JSON/YAML payload keys that are not camelCase via bracket/string access rather than renaming them.
- **No LaTeX.** PDF generation uses Typst only. `typstCompiler.ts` uses the npm WASM compiler, preferring a `typst` binary on `PATH` if present.
- **No personal data in committed code.** The engine is fully generic. Never write a real name, salary figure, employer, clearance status, or any other personal fact into a file that is not under the canonical data root. All real user data lives under ONE canonical root outside the git work tree — `~/Documents/weJobSearch/<username>/` per `src/utils/canonicalDataRoot.ts` — which holds the working profile files (`masterProfile.md`, `jobPreferences.yaml`, `screeningAnswers.json`, `networkingContacts.json`), the working `resumeVariants.yaml`, and the `applications/` output tree. `profile/` in the repo ships only blank `.example` templates plus the `resumeVariants.yaml` structure seed, copied into the canonical root by `init` on first run. Real profile and canonical-root files are only ever written by the `init` wizard, the user, or the agent-facing profile MCP tools (`getUserProfile`, `initializeUserProfile`, `updateUserProfile`), never by you during build or verification. `fixtures/` is the only place synthetic test data lives (committed, deliberately fake).
- **No hardcoded thresholds.** Salary floors, clearance rules, and other non-negotiables live in user config (`jobPreferences.yaml`), never in `fitEvaluator.ts` or any other source file.
- **No empty directories, no dead links, no unused scaffolding.** Only create a file or folder when something in this session actually populates it.
- **Deterministic checks over judgment calls.** Anything checkable by code (naming, page count, ATS parse order, gitignore status, config schema, result-table column contract) is enforced by running the validator, never by your own review.
- **No portal automation, and the tool never applies for jobs on the user's behalf under any framing.** Never build functionality that auto-submits applications, contacts employers/recruiters on the user's behalf, or bypasses CAPTCHAs, authentication, or bot detection. The tool prepares and tracks; the human submits. `appliedConfirmed` is only reachable via manual `confirmApplicationSubmission`.
- **Scraping accepted-risk sources honestly.** LinkedIn and FlexJobs are scraped despite their ToS prohibiting it, per SDD Requirement 8, as a deliberate, user-accepted risk. Never bypass authentication, CAPTCHAs, or bot detection — LinkedIn's adapter uses only unauthenticated public endpoints. Never quietly expand this accepted-risk posture to a new source without it being named explicitly in the SDD first.
- **Ask, don't assume.** No command or MCP tool chains automatically into another. Evaluating a posting never auto-triggers resume generation; generating a resume never auto-triggers a cover letter or outreach message. The CLI run with no subcommand presents a menu and does nothing else.
- **Never run `init` yourself, and never fabricate personal-looking data into a real `profile/` or canonical-root file.** All pipeline verification uses `fixtures/`, which contains synthetic data only.

## How to work here

### Commands

```bash
npm install            # needs Node >= 24 (.nvmrc pins 26.5.0)
npm run build          # tsc -> dist/ (dist/ is gitignored; required before CLI/MCP runs)
npm run lint           # tsc --noEmit (typecheck, no output)
npm test               # vitest run (all suites; 1085 tests / 68 files in this baseline)
npx vitest run src/evaluators/fitEvaluator.test.ts   # single file
npm run namingLinter   # naming gate; works on a fresh clone without build (Node 24+ type stripping)
npm run setupHooks     # one-time per clone: git config core.hooksPath .githooks (pre-commit naming gate)
```

- CI runs `lint` -> `build` -> `test` -> `namingLinter` on every push/PR (`.github/workflows/ci.yml`). Run the same four before committing.
- Git discipline: branch per build step (`build|feature|fix|docs/<slug>`). Merge with `noFf`, tag the merge, never rewrite pushed history.
- The CLI and MCP server require `npm run build` first — `dist/` is gitignored, and `opencode.json` registers the MCP server as `node dist/mcp/jobSearchServer.js`.
- Exit codes: 0 = linter clean, 1 = a naming violation exists (fix reported names, re-stage, re-commit; never amend a failed commit).

### Layout and entrypoints

- `src/cli/jobSearchCore.ts` is the real engine: arg parsing, command dispatch, evaluation pipeline (dedup -> extract -> fit -> persist), and the functions backing the MCP tools. Most new logic lands here or in a module it imports.
- `src/mcp/jobSearchServer.ts` is a thin MCP bridge only. It registers tools and delegates to `jobSearchCore.ts` functions; never re-implement evaluation, dedup, reporting, or generation there.
- Scrapers: `src/scrapers/jobSpyAdapter.ts` is a registry dispatching to six adapters in `src/scrapers/adapters/`, all wrapped by `src/scrapers/rateLimiter.ts`. Adapters use public, unauthenticated pages only; nothing bypasses auth/CAPTCHAs/bot detection.
- Evaluators in `src/evaluators/`: `fitEvaluator` (base 5.0, deductions, four bands `hardRejected`/`weakFit`/`manualReview`/`strongFit`; the hard-rejection gate reads only `nonNegotiables` from `jobPreferences.yaml`), `compExtractor`, `postingFactsExtractor`, `postingRequirementsExtractor`, `profileCapabilitiesExtractor`.
- Generators in `src/generators/`: `resumeGenerator` (EEO mapping layer, 1-page Typst loop, ATS check, zero-hallucination verification), `coverLetterGenerator`, `briefGenerator` (deterministic extractive 150-char Brief — the CLI never makes LLM calls), `outreachMessageGenerator` (writes `outreachMessage.md`, never sends).
- Reporting: `scrapeResultsFormatter.ts` (Active Results, fixed 7-column) and `excludedResultsFormatter.ts` (Excluded Results, fixed 6-column). **These column sets are a fixed contract** (SDD Requirement 2a) enforced by tests; never add, remove, or reorder columns. Every command that displays scrape results must call these formatters — never build an ad hoc table.
- Dedup runs before evaluation: `postingDeduplicator.ts` hashes `companyName + roleTitle + location` with a Levenshtein fuzzy fallback.
- Persistence: `applicationHistory.json` (+ per-role dirs) under the canonical data root's `applications/` — outside the git work tree. Writes go through `jobFunnelTracker.ts` and are atomic (temp file + rename) and schema-validated (refuses to write over a malformed file).
- Profile intake: `src/utils/profileService.ts` is the host-neutral core behind the `getUserProfile` / `initializeUserProfile` / `updateUserProfile` MCP tools — read inspection plus confirmation-gated first-time creation and partial updates of the canonical-root real `profile/` files. The CLI `init` wizard stays as an optional developer fallback.

### Generated files

`opencode.json`, `.claude/commands/*.md`, `.cursor/rules/*`, and `.windsurfrules` are all generated from one source of truth: `src/utils/buildAgentConfigs.ts`. Do not hand-edit the generated files' shared rules — edit `buildAgentConfigs.ts` and regenerate with `node dist/utils/buildAgentConfigs.js`. Every generated file must reference `docs/weJobSearch-SDD.md` directly, not a paraphrase (the `sharedBaseRules` export already does this — preserve it).

### Data-boundary discipline

- `profile/`: committed only as blank `.example.*` templates plus `resumeVariants.yaml` (structure only). Real `masterProfile.md`, `jobPreferences.yaml`, `screeningAnswers.json`, `networkingContacts.json` and the working `resumeVariants.yaml` all live under the canonical data root (`~/Documents/weJobSearch/<username>/`) — outside the git work tree, so you never create or populate them in the repo.
- `fixtures/` = the only test/e2e data (synthetic candidate + posting + preferences). Tests and pipeline verification use `fixtures/`, never `profile/`.
- `.reference/` = gitignored clone of `MadsLorentzen/ai-job-search` for study only. Never copy its files into `src/` and never commit it.

### Known limitations (don't "fix" these)

- The CLI menu lists `parsePdf` and `confirmApp`, and both CLI subcommands **are wired** — the `dispatchCli` dispatcher routes them to `runParsePdfCommand` and `runConfirmAppCommand` in `jobSearchCore.ts`, matching the MCP tools `parsePdfDocument` and `confirmApplicationSubmission`. See HANDOFF.md.
- Scraper E2E tests use `globalThis.fetch` stubs (`src/step13Pipeline.test.ts`); they never contact real job boards.
- `src/utils/stateManager.ts` / `pipelineState.json` from the SDD are not implemented; persistence is `applicationHistory.json` plus per-role output directories.

## Definition of done for any change

- `npm run lint`, `npm run build`, `npm test`, and `npm run namingLinter` all pass.
- No real `profile/` file or canonical-root file is tracked or written; `git status` shows only `.example` and `fixtures/` versions, and `.reference/` is untracked.
- No empty directory, dead link, or unused file introduced; every SDD cross-reference resolves to a real file.
- No command or MCP tool chains into another; no capability was added that bypasses manual confirmation.
- If a design decision isn't covered by the SDD, stop and ask instead of guessing.

## Agent skills

### Issue tracker

Issues live as local markdown files under `privateDocs/.scratch/`. See `privateDocs/docs/agents/IssueTracker.md`.

### Triage labels

Five canonical triage roles use their default label strings. See `privateDocs/docs/agents/TriageLabels.md`.

### Domain docs

Single-context: `privateDocs/GLOSSARY.md` plus ADRs in `privateDocs/docs/adr/`. See `privateDocs/docs/agents/Domain.md`.

## If context is running long

Stop, summarize what you have completed against the SDD, and suggest a fresh session for the remainder. Long sessions are where naming drift and rule erosion happen — prefer one command, one deliverable, then a clean session.
