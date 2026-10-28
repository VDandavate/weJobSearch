# weJobSearch — Architecture

A design-focused companion to `README.md`. The binding specification is
`docs/weJobSearch-SDD.md`; conventions live in `AGENTS.md`. This document
describes how the committed baseline (through Step 13) is actually wired.

## Attribution

weJobSearch is a derivative, rewritten-from-scratch refactor of
**MadsLorentzen/ai-job-search** under the MIT License. The original
copyright (Copyright (c) 2026 Mads Lorentzen) is retained in `LICENSE`, as
required by the MIT License. The **agentic drafter-reviewer model** of that
project is the foundational idea: content (resumes, letters, outreach) is
drafted by the tool and reviewed/submitted by the human. weJobSearch keeps
that spirit as a set of explicitly-invoked, non-chaining commands, but the
runtime (TypeScript), PDF engine (Typst), market focus (US), naming
convention (strict camelCase), and most data shapes are new. See
`docs/weJobSearch-SDD.md` Sections 1.2 and 1.3 for the full attribution and
reference-handling policy.

## Purpose and non-goals

**Purpose**: a local, deterministic job-search assistant. It scrapes six
public job-board surfaces, deduplicates postings, scores fit against a user
profile and configurable non-negotiables, persists every evaluation to local
tracking stores, renders two fixed result tables, generates single-page
ATS-ready resumes (Typst), drafts cover letters and outreach notes, tracks
referrals, and reports on the funnel — all without relying on any LLM in the
CLI path and without any API key.

**Non-goals** (from SDD Section 1.4, enforced structurally):

- The tool **never auto-submits applications** and never advances a record to
  `appliedConfirmed` except through explicit manual confirmation.
- The tool **never contacts** employers, recruiters, or references;
  `networkingContacts.json` (under the canonical data root) is a tracker, not an
  outreach engine.
- No legal/immigration/compensation advice; the user is sole party responsible
  for anything submitted.
- No CAPTCHA, bot-detection, or authentication-wall bypass, on any board.
- No paid scraping API; five of the six source adapters are accessed under an
  explicit accepted-risk posture (hiring.cafe is low-risk), all free.

## Layer map

```
                    OpenCode / Cursor / Claude Code / Windsurf / standalone CLI
                                    │   (MCP stdio or direct CLI)
                                    ▼
                  ┌────────────────────────────────────────────┐
                  │  src/mcp/jobSearchServer.ts  (19 tools)    │
                  └───────────────┬────────────────────────────┘
                                  │  delegates to core functions
                                  ▼
                  ┌────────────────────────────────────────────┐
                  │  src/cli/jobSearchCore.ts  (CLI dispatcher  │
                  │  + shared evaluate/search/generate funcs)   │
                  └──────┬──────────┬──────────┬───────┬───────┘
                         ▼          ▼          ▼       ▼
              ┌──────────────┐ ┌────────┐ ┌──────────┐ ┌──────────┐
              │   scrapers   │ │ dedup  │ │evaluators│ │generators│
              │ jobSpyAdapter│ │posting │ │ fit, ext │ │ resume   │
              │ rateLimiter  │ │dedup   │ │ comp,    │ │ letter   │
              │ + 6 adapters │ │licator │ │ fact/reqs│ │ outreach │
              └──────────────┘ └────────┘ │ profile  │ │ brief    │
                                          └────┬─────┘ └──────────┘
                                               │
              ┌────────────────────────────────┼─── reporting ┐
              │ reporting/funnelReporter,      │……  | scrape/  │
              │ reviewQueueFormatter,          │   | excluded  │
              │ scrape+excluded formatters     │   | formatter │
              └────────────────────────────────┴────────────┘
              │
              └—— persistence: src/utils/jobFunnelTracker.ts,
                   src/utils/networkingContacts.ts (applications/, profile/)  | + staleChecker
              └—— validation: src/utils/typstCompiler.ts, atsChecker.ts,
                   namingLinter.ts, initWizard.ts
```

## Layers

1. **Interfaces** — `src/cli/jobSearchCore.ts` (CLI dispatcher + the shared
   evaluation/search/generate handlers that MCP also calls) and
   `src/mcp/jobSearchServer.ts` (stdio MCP server).
2. **Scrapers** — `src/scrapers/jobSpyAdapter.ts` is a *registry* dispatching
   to one adapter per source, all implementing the `SourceAdapter` interface
   and each wrapped by a `RateLimiter` from `src/scrapers/rateLimiter.ts`.
3. **Normalization / deduplication** — `src/dedup/postingDeduplicator.ts`
   normalizes `companyName+roleTitle+location`, computes a SHA-256
   `postingHash`, merges cross-source duplicates, and removes fuzzy
   near-duplicates (Levenshtein).
4. **Evaluators** — `src/evaluators/fitEvaluator.ts` (deduction scoring,
   `nonNegotiables` gate, four-tier routing), `compExtractor.ts` (salary/equity
   band parsing with currency normalization), `postingFactsExtractor.ts`
   (location/employer/clearance facts), `postingRequirementsExtractor.ts`
   (required-skills/years/domains), and `profileCapabilitiesExtractor.ts`
   (candidate capabilities from `masterProfile.md`).
5. **Generators** — `resumeGenerator.ts` (Typst-to-PDF, variant-aware), the
   independent `coverLetterGenerator.ts`, `outreachMessageGenerator.ts`, and
   the deterministic extractive `briefGenerator.ts`.
6. **Reporting** — `src/reporting/funnelReporter.ts` (funnel dashboard),
   `reviewQueueFormatter.ts`, and the two fixed table formatters
   `scrapeResultsFormatter.ts` (Active, 7 columns) / `excludedResultsFormatter.ts`
   (Excluded, 6 columns).
7. **Persistence** — `src/utils/jobFunnelTracker.ts` (application history),
   `src/utils/networkingContacts.ts` (contacts), and staleness
   `src/utils/staleChecker.ts` (returns a visibility flag only). All writes are
   atomic (temp file + rename) and schema-validated before write.
8. **Validation** — `src/utils/typstCompiler.ts` (page-count enforcement),
   `src/utils/atsChecker.ts` (ATS plain-text reading order/keywords),
   `src/utils/namingLinter.ts` (+ pre-commit hook), and the `init` wizard's
   profile-protection checks.

## Adapter registry and the shared RateLimiter

- `JobSpyAdapterRegistry` holds one adapter and one `RateLimiter` per source.
  `searchAll` fans out with per-source failure isolation (a source error lands
  in `SourceSearchResult.error` and never blocks the other five). The registry
  is also the backing for the single-posting `fetchPostingByUrl` (`evaluate`),
  routing a URL to whichever adapter claims its domain and rejecting unknowns
  with `UnsupportedPostingUrlError`.
- `RateLimiter` enforces a jittered minimum delay between requests per source,
  applies exponential backoff on HTTP 429/403/5xx and timeouts (permanent
  failures are counted without backoff), and latches a TTL circuit breaker
  after too many consecutive failures per source, with a trial request after
  the TTL recovering or re-tripping it. `assertPathAllowed` respects `robots.txt`
  unless the config opts out. LinkedIn (most conservative range) and FlexJobs
  (most conservative, 4-5s) are the strictest; the four market adapters use the
  default 2-5s range. Per-source posture is documented in code and in
  `docs/weJobSearch-SDD.md` Requirement 8.

The six registered adapters (all free, public, unauthenticated):

`linkedinAdapter.ts` (ported technique from the reference repo — see SDD
Section 1.3), `hiringCafeAdapter.ts`, `wellfoundAdapter.ts`,
`welcomeToTheJungleAdapter.ts`, `builtInAdapter.ts`, `flexJobsAdapter.ts`.

## Evaluation flow

Given `search` (or `evaluate`), the pipeline for every candidate posting is:

```
scrape/fetch
   │  (registry.searchAll / registry.fetchPostingByUrl, rate-limited)
   ▼
deduplicate     postingDeduplicator.ts (hash + fuzzy match; merge sourceAggregators)
   ▼
extract requirements / facts   postingRequirementsExtractor, postingFactsExtractor
   ▼
evaluate        fitEvaluator → fitScore + fitStatus + notes/deductions
                (determined solely by config nonNegotiables + posting/candidate facts)
   ▼
generate Brief  briefGenerator (extractive, 150-char cap, no LLM)
   ▼
persist evaluated record   jobFunnelTracker (idempotent: same postingHash → merged, no dup)
   ▼
render fixed tables   Active (7 cols) / Excluded (6 cols) — Owners: the
                      two reporting formatters, exact column contracts
```

`evaluate` (single URL) deduplicates first against history and renders only the
table matching the posting's fit status; `search` renders **both** fixed tables
each time, headers included.

## Independent document-generation flows

Generation never fires automatically. Each command is a separate entry point
into a generator module (Section 1.5):

- `generate` → `resumeGenerator.generateResume`: reads `masterProfile.md`,
  selects the template variant (auto triggers `targetsFederal`/`domainTag`;
  explicit `--variant`), maps only EEO-safe fields, splices into the Typst
  template, runs the 1-page compile loop with text-density reduction, verifies
  ATS reading order + posting keywords, and validates zero-hallucination. Writes
  `applications/<company><role>/tailoredResume.{typ,pdf}`.
- `draftCoverLetter` → `coverLetterGenerator.draftCoverLetter`: profile-grounded
  letter; posting requirements are referenced only where the profile genuinely
  supports the claim. Writes `.../coverLetter.md`.
- `draftOutreach` → `outreachMessageGenerator.draftOutreachMessage`: a short
  LinkedIn/email-style note for **one** contact in `networkingContacts.json`,
  profile-grounded only. Writes `.../outreachMessage.md`.

Drafting a resume never triggers a letter or outreach, and vice versa.

## Persistence boundaries

- **Application history**: `applications/applicationHistory.json` under the
  canonical data root (`~/Documents/weJobSearch/<username>/`, per
  `src/utils/canonicalDataRoot.ts`), written only by
  `jobFunnelTracker.logApplication`/`updateApplicationStatus`, atomically and
  schema-validated. `evaluate`/`search` persist every unique posting with status
  `evaluated` (idempotently). `confirmApplicationSubmission` (MCP) sets
  `appliedConfirmed` only from `evaluated`/`generated` state and only after your
  explicit manual action.
- **Networking contacts**: `networkingContacts.json` under the canonical data
  root, written by `networkingContacts`. The committed
  `profile/networkingContacts.example.json` is the blank template.
  Contacts link to application ids; the funnel report flags overdue follow-ups,
  and referral-linked vs. cold-apply conversion is computed separately.
- **Per-role output**: canonical-root `applications/<company><role>/` holds the
  resume source, PDF, cover letter, and outreach draft. Because it is outside
  the git work tree it can never be committed. The SDD's `pipelineState.json`
  design is listed in the spec tree but no
  `stateManager` module exists in this baseline — see Limitations.
- **Layout coupling: `templates/` beside `dist/`.** Shipped Typst templates
  resolve from a `templates/` directory next to the built `dist/` tree
  (`repoRootFromModule`), so the checkout must keep that two-level layout;
  moving `dist/` elsewhere without `templates/` breaks template resolution
  loudly at startup (covered by a dedicated test).
- **Spec deviation — canonical data root (SDD §2.2 errata).** The engine stores
  all real user data under ONE canonical root outside the git work tree
  (`~/Documents/weJobSearch/<username>/`, per `src/utils/canonicalDataRoot.ts`),
  not in the SDD §2.2 in-repo `profile/` + `applications/` tree. `profile/` in
  the repo ships only blank `.example` templates plus the `resumeVariants.yaml`
  structure seed. This deviation is deliberate (real data can never be
  committed); the SDD file tree itself is unchanged.
- **Spec deviation — active run state (SDD §2.2/Requirement 4 errata, DECIDED
  Phase 6).** The full `stateManager.ts` / `pipelineState.json`
  active-run-state engine is not implemented: interrupted search, evaluate, or
  generate runs do not resume; the persistence contract is the
  application-history log plus per-role output directories only. No new module,
  no `pipelineState.json`; the SDD file itself is unchanged.

## MCP boundary

`src/mcp/jobSearchServer.ts` creates an MCP server over stdio. It registers
23 tools:

1. `parsePdfDocument`
2. `ingestDocuments`
3. `getUserProfile`
4. `suggestRoles`
5. `initializeUserProfile`
6. `updateUserProfile`
7. `wipeUserProfile`
8. `getSetupQuestion`
9. `answerSetupQuestion`
10. `commitSetup`
11. `evaluateJobPosting`
12. `searchJobPostings`
13. `searchByProfile`
14. `runSavedSearches`
15. `getPostingDetail`
16. `generateTailoredApplication`
17. `confirmApplicationSubmission`
18. `getReviewQueue`
19. `getFunnelReport`
20. `analyzeApplicationPatterns`
21. `logNetworkingContact`
22. `draftOutreachMessage`
23. `draftCoverLetter`

Every handler delegates to the same engine the CLI uses — the fixed table
contract, dedup-before-evaluate, idempotency, and the "ask, don't assume"
firewall are inherited, not re-implemented. Most handlers call the functions in
`src/cli/jobSearchCore.ts`. The three setup-cursor tools
(`getSetupQuestion`, `answerSetupQuestion`, `commitSetup`) call
`src/core/setupCursor.ts` instead: it computes the question plan, carries the
`setupState.json` checkpoint, and delegates the single confirmed write to
`src/utils/profileService.ts`. The profile tools (`getUserProfile`,
`initializeUserProfile`, `updateUserProfile`) call that same service, which
keeps profile setup fully agent-hostable with explicit confirmation gating; the
CLI `init` wizard remains an optional developer fallback. Cover-letter drafting
is available both as the `draftCoverLetter` CLI command (and the generated
Claude Code command) and as the `draftCoverLetter` MCP tool (see the README).
Agents surface the tool menu and the user picks; no tool chains into another.

## Privacy and safety boundaries

- Real profile data and application output live under the canonical data root
  outside the git work tree (`~/Documents/weJobSearch/<username>/`, per
  `src/utils/canonicalDataRoot.ts`) and are only touched by the `init` wizard,
  the user, or the acknowledged profile MCP tools; committed files ship as blank
  `.example` templates with structural placeholders.
- The resume mapping layer is a whitelist (name, city/state, email, phone,
  LinkedIn, portfolio, summary, skills, experience, education, certifications);
  photo, gender, age, marital status, birth date, and street address never make
  it into a resume, and the templates reject them structurally as a backstop.
- No LLM exists in the CLI path (the Brief is extractive by construction; all
  generators are template/verification based), and no API keys are needed.
- Outreach and confirmation are draft/local-only; nothing is ever sent.

## Typst/WASM + ATS validation path

`typstCompiler` prefers a `typst` binary on `PATH` and falls back to the
WASM package (`@myriaddreamin/typst.ts`, the only Typst compiler dependency).
The WASM engine fetches the standard text font set from a CDN on first compile
(a runtime network dependency; see README section on prerequisites).
`compileWithinPageLimit` re-compiles with `reduceTextDensity` (budget-based
reduction) until `pageCount ≤ 1` or it fails after 5 attempts.
`atsChecker` re-extracts the compiled PDF's plain text via `pdf-parse` and
requires section headers `Experience`, `Education`, `Skills` in reading order
plus every claimable posting keyword to be present in extractable text.

## Naming-linter / pre-commit enforcement path

`src/utils/namingLinter.ts` scans the tree for naming violations. The
`scripts/namingLinterCheck.mjs` entry runs the compiled linter when present else
the TS source via Node 24+ type stripping, so the check works without a build.
`npm run setupHooks` sets the repo-local hook path so `.githooks/pre-commit`
rejects any commit the linter flags. Both run the same logic as `npm run
namingLinter`.

## Testing, verification, and current limitations

The suite (Vitest, 1085 tests across 68 files in this baseline) exercises the
pure logic against synthetic in-memory/temp-directory data and the committed
`fixtures/` directory — never real profile/application data and never the
network (the end-to-end pipeline stubs `globalThis.fetch` with deterministic
synthetic responses): `fitEvaluator`, `postingDeduplicator`, `compExtractor`,
extractors, `staleChecker`, both result-table formatters (header-row column
contracts), `briefGenerator`, generators, `funnelReporter`, `namingLinter`,
`initWizard`, `jobSearchCore`, the MCP server tool registry, and the
six-adapter Step 13 pipeline. Real-data setup is strictly the human's `init`
run.

**Deferred / not in the baseline** (documented so nothing is confused with
implemented behavior):

- `src/utils/stateManager.ts` / `pipelineState.json` active-run-state module
  (SDD §2.2/Requirement 4) — not implemented; per-role output and
  `applicationHistory.json` are the persistence that exists today.
- CLI subcommands `parsePdf` and `confirmApp` appear in the help menu and **are wired** (the `dispatchCli` dispatcher routes them to `runParsePdfCommand` and `runConfirmAppCommand` in `jobSearchCore.ts`); parsing and confirmation are also exposed through the MCP tools `parsePdfDocument` and `confirmApplicationSubmission`.
- Adapters are free public scrapes: they are brittle against site markup
  changes and have no commercial fallback; they get patched when they break.