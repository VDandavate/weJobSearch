# Software Requirements & System Architecture Specification (SDD)

**Project Title:** weJobSearch
**Refactor Base:** MadsLorentzen/ai-job-search
**Target Runtimes:** Tool-Agnostic (OpenCode, Claude Code, Cursor, Windsurf, Aider, Copilot CLI, Standalone CLI/MCP)
**Target Market:** United States Tech & Corporate Ecosystem
**Naming Standard:** Strict camelCase and PascalCase. Zero underscores allowed in files, paths, variable names, or JSON parameters.

---

## 1. Executive Summary & Legal Attribution

### 1.1 Scope of Refactor

This specification defines the complete refactoring of `MadsLorentzen/ai-job-search` into a deterministic, tool-agnostic job search system. Key changes:

- Replace multi-page European CVs with 1-page ATS-optimized Typst documents, with **variant support** for role-specific resume structures (e.g., a standard version and a detailed federal/GSE version).
- Replace Nordic scrapers with US-focused aggregators, with rate-limiting and ToS-aware scraping behavior.
- Enforce a deduction-based fit evaluation rubric with a **manual-review tier**, not just accept/reject.
- Support local PDF ingestion for existing resumes or saved job postings.
- Guarantee zero skill hallucinations against an immutable ground-truth profile.
- Deduplicate postings pulled from multiple aggregators.
- Log verified application histories, track **referral/networking context**, and support automatic staleness/rejection handling.
- Provide execution via a pure TypeScript CLI engine, an MCP server, and auto-generated AI agent rule profiles.
- Provide a funnel reporting command so logged data is actually usable, not just archived.

### 1.2 Open-Source Attribution

- **Original Copyright:** Copyright (c) 2026 Mads Lorentzen (`ai-job-search`, MIT License).
- **Attribution Requirement:** The root `LICENSE` file retains Mads Lorentzen's original copyright notice. All generated documentation (`README.md`, `ARCHITECTURE.md`) must credit Mads Lorentzen's foundational agentic drafter-reviewer model.

### 1.3 Source Acquisition and Reference Handling (updated)

Every architectural constraint in this spec (naming convention, US market focus, Typst instead of LaTeX, pure TypeScript instead of Python/Bun) means most files are rewritten from scratch rather than edited in place. This is a reference-and-rebuild, not a literal fork-and-patch, so it needs an explicit acquisition step rather than assuming the original code is already present, and an explicit statement of what gets ported versus rebuilt.

- Clone `MadsLorentzen/ai-job-search` into a local, gitignored scratch directory, for example `.reference/aiJobSearch/`. This directory is never committed to `weJobSearch` and exists only so the agent can study the original evaluator logic, scraper structure, and the drafter-reviewer agentic pattern before rebuilding equivalent functionality under this spec's conventions.
- **Do not copy files verbatim from `.reference/` into `src/`.** Naming, structure, market logic, runtime (Python/Bun vs. TypeScript), and document engine (LaTeX vs. Typst) all differ enough that a straight copy would violate Section 2.1 and Requirement 3 immediately. Treat it as documentation of intent and working technique, not a starting point to edit.
- **Named exception — LinkedIn scraping technique.** The reference repo's `.agents/skills/linkedin-search/` skill scrapes LinkedIn via unauthenticated public search endpoints (no login, no auth bypass). This specific request/parsing *approach* is deliberately studied and ported — rewritten as idiomatic TypeScript under `src/scrapers/adapters/linkedinAdapter.ts`, following this spec's naming and architecture rules — rather than reinvented from scratch. This is the one case where reusing proven, working logic outweighs building blind. See Requirement 8 for the full source list and per-source build order.
- **Built In — verify before assuming reusable logic.** Unlike LinkedIn, there is no confirmed native Built In skill in the public reference repo; any prior Built In scraping behavior may have come from that repo's `/add-portal` command generating custom, non-stock logic in a personal fork rather than being part of the base project. During this acquisition step, explicitly check `.reference/aiJobSearch/` for any Built In–specific skill or adapter code. If found, treat it the same way as the LinkedIn exception above (study and port the technique, don't copy the file). If not found, `builtInAdapter.ts` is built fresh in its normal build-sequence position, using the same reverse-engineering approach the reference repo's `/add-portal` command uses (inspect the site's public search/result structure and access rules directly), not by assuming code that doesn't exist.
- Because git history is not preserved, attribution is satisfied entirely through Section 1.2 (the `LICENSE` file and README credit), not through commit provenance. This is sufficient under the original MIT license, which requires the copyright notice to travel with the code, not that history be preserved.
- Once `weJobSearch`'s own structure exists and no longer needs the reference material, `.reference/` can be deleted locally. It is `.gitignore`-excluded from the start, so nothing needs to be done to keep it out of the repo.

### 1.4 Non-Goals and Scope Boundaries (new)

Explicit boundaries prevent an autonomous agent from expanding scope into something riskier than intended.

- **The tool never auto-submits applications to job portals, and never applies for jobs on the user's behalf under any framing.** This is absolute, not limited to the literal submit button. No feature, workflow, or "agentic" mode is permitted to advance an application to `appliedConfirmed` without the user explicitly performing and confirming that action themselves. This is already implied by Requirement 4's `appliedConfirmed` status requiring manual confirmation; this section makes it an explicit non-goal so no future session interprets "automation" as license to build portal-submission bots, which carries real legal and account-ban risk.
- **The tool never contacts employers, recruiters, or references on the user's behalf.** `networkingContacts.json` is a tracker, not an outreach engine. The tool may draft outreach content (Requirement 6a) but never sends it.
- **The tool does not provide legal, immigration, or compensation negotiation advice.** Screening answers and clearance/salary fields reflect what the user has entered; the user is solely responsible for the accuracy of anything submitted to an employer.
- **The tool does not attempt to bypass CAPTCHAs, bot-detection, or authentication walls** on any job board or portal, regardless of how the scraping requirement is phrased.

### 1.5 Ask, Don't Assume (new)

The user controls the path through the tool at every step. The tool must never infer "the user probably wants X next" and chain into it. Concretely:

- Running the CLI with no subcommand, or `--help`, presents a menu of what the tool can help with (search postings, evaluate a posting, build a tailored resume, draft a cover letter, draft an outreach message, review the manual-review queue, view the funnel report) and waits for the user to choose. It does not default to running the full funnel end to end.
- Each capability is invoked explicitly and independently. Evaluating a posting does not automatically trigger resume generation; generating a resume does not automatically trigger cover letter or outreach drafting. The user asks for each piece of help they want.
- The MCP server tools follow the same principle: an orchestrating agent should surface the available tools and ask the user which they want, rather than chaining `evaluateJobPosting` into `generateTailoredApplication` into `confirmApplicationSubmission` on its own initiative.

### 1.6 Work Product Rule

The public tree contains only the engine, user documentation, and this
specification. Development work product — internal planning, review, and
release-process artifacts — is excluded by construction: the release
export filter (`scripts/exportFilter.mjs`) stages the public tree from a
fixed allowlist, and any path not on that allowlist is absent from the
shipped repository. No work-product file, private path, or process detail
appears in the public tree.

---

## 2. Global Naming & Directory Architecture

### 2.1 Strict Naming Rules

- **Directories & Source Files:** camelCase (e.g., `fitEvaluator.ts`, `stateManager.ts`)
- **Classes & Interfaces:** PascalCase (e.g., `JobPosting`, `FitAssessment`)
- **JSON Keys & Schema Attributes:** camelCase (e.g., `fitScore`, `unmatchedRequirements`)
- **Zero underscores** permitted anywhere in file names, directory paths, function identifiers, or JSON keys.

### 2.2 System File Tree

```
weJobSearch/
├── LICENSE                          # Original MIT License (Mads Lorentzen) + Refactor Notice
├── README.md                        # Setup, prerequisites, quickstart
├── ARCHITECTURE.md                  # Design rationale, attribution
├── HANDOFF.md                       # Generated once, at baseline completion (Section 9)
├── .gitignore                       # Excludes profile/*.yaml, profile/*.json, profile/*.md, applications/, .env, .reference/
├── .env.example                     # API keys template (no secrets committed)
├── .nvmrc                           # Pinned Node version
├── package.json
├── package-lock.json
├── tsconfig.json
├── .github/
│   └── workflows/
│       └── ci.yml                   # Lint, test, namingLinter on push/PR
├── opencode.json                    # Generated OpenCode agent workflows
├── fixtures/
│   ├── sampleProfile.md             # Synthetic test data, committed, never real
│   ├── sampleJobPosting.txt
│   └── sampleJobPreferences.yaml
├── profile/
│   ├── masterProfile.example.md         # Committed, blank template
│   ├── masterProfile.md                 # Real file, gitignored, filled in offline
│   ├── jobPreferences.example.yaml      # Committed, blank template
│   ├── jobPreferences.yaml              # Real file, gitignored: work auth, salary, clearance, non-negotiables
│   ├── screeningAnswers.example.json    # Committed, blank template
│   ├── screeningAnswers.json            # Real file, gitignored
│   ├── networkingContacts.example.json  # Committed, blank template
│   ├── networkingContacts.json          # Real file, gitignored
│   └── resumeVariants.yaml              # Maps variant name -> template + trigger rules (structure only, no personal data)
├── templates/
│   ├── usStandardResume.typ         # 1-page ATS Typst template (default)
│   └── usDetailedResume.typ         # Variant template (e.g. federal/GSE-style, multi-entry)
├── src/
│   ├── cli/
│   │   └── jobSearchCore.ts         # Pure CLI engine entry point
│   ├── mcp/
│   │   └── jobSearchServer.ts       # Model Context Protocol (MCP) server
│   ├── scrapers/
│   │   ├── jobSpyAdapter.ts         # US job board scraper adapter
│   │   └── rateLimiter.ts           # Politeness delay + backoff + robots.txt respect
│   ├── evaluators/
│   │   ├── fitEvaluator.ts          # Deduction-based scoring logic
│   │   ├── compExtractor.ts         # Salary & equity band parser
│   │   ├── postingFactsExtractor.ts # PostingFacts extraction (location/employer/clearance)
│   │   ├── postingRequirementsExtractor.ts # Deterministic required-skill/years/domain extraction
│   │   └── profileCapabilitiesExtractor.ts # CandidateCapabilities derived from masterProfile.md
│   ├── generators/
│   │   ├── briefGenerator.ts        # Deterministic extractive posting Brief (Requirement 2a)
│   │   └── outreachMessageGenerator.ts  # Grounded LinkedIn/email outreach drafting
│   ├── dedup/
│   │   └── postingDeduplicator.ts   # Cross-aggregator duplicate detection
│   ├── reporting/
│   │   ├── funnelReporter.ts        # Reads applicationHistory.json -> summary/report
│   │   ├── scrapeResultsFormatter.ts  # Active Results 7-column table (Requirement 2a)
│   │   └── excludedResultsFormatter.ts # Excluded Results 6-column table (Requirement 2a)
│   └── utils/
│       ├── pdfParser.ts             # Local PDF document parser
│       ├── typstCompiler.ts         # Typst PDF compiler & page boundary checker
│       ├── atsChecker.ts            # ATS plain-text parsing validator
│       ├── staleChecker.ts          # Auto-flags stale/no-response applications
│       └── jobFunnelTracker.ts      # Confirmed application history logger
└── applications/
    ├── applicationHistory.json      # Permanent tracking database
    └── <companyName><roleTitle>/    # CamelCase output directory per target role
        ├── pipelineState.json        # RETRACTED: not implemented - see Requirement 4
        ├── fitAssessment.json
        ├── tailoredResume.typ
        ├── tailoredResume.pdf
        ├── coverLetter.md
        └── outreachMessage.md
```

---

## 3. Detailed Technical Requirements

### Requirement 1: Grounded Candidate Profile & PDF Ingestion

- **`masterProfile.md` integrity:** Primary source of truth for candidate experience. The resume generator must never infer, add, or embellish skills, job titles, metrics, or tools not explicitly present in `masterProfile.md`.
- **PDF ingestion (`pdfParser.ts`):** Parses raw text from local `.pdf` files (legacy resumes, saved job descriptions) using `pdf-parse`. Extracted text is cleaned of line-break artifacts before passing to `fitEvaluator.ts` or profile builders.
- **PII handling:** `masterProfile.md` and `screeningAnswers.json` contain sensitive personal data (visa status, salary targets, contact info). Both are `.gitignore`-excluded by default. README must warn against committing these to a public fork.
- **Genericity requirement (new):** The engine itself must contain zero hardcoded personal facts, employer names, or individual circumstances. Every `profile/*` file ships as a blank `.example` template in the committed repo. A first-run setup step copies each `.example` file to its real counterpart, which the user fills in offline and which never leaves their machine unless they choose to sync it elsewhere later.

### Requirement 1a: Configurable Non-Negotiables, Clearance, and Compensation Profile (new)

This generalizes the hard-rejection logic in Requirement 2 so the rules themselves live in user config, not in code. Anyone forking the repo defines their own; the engine has no opinion about what counts as a dealbreaker.

`jobPreferences.yaml` (real file, gitignored):

```yaml
compensation:
  currency: USD
  minAcceptableBase: 0        # placeholder, set via weJobSearch init, not committed with real value
  targetBase: 0               # placeholder, set via weJobSearch init, not committed with real value
  countsBonusTowardMin: false
  countsEquityTowardMin: false

clearance:
  currentStatus: none        # none | interim | active | expired
  currentLevel: null         # publicTrust | secret | topSecret | tsSci
  eligibleToObtain: true
  requiresSponsorshipForVisa: false

nonNegotiables:
  - id: noRelocation
    category: location
    rule: "reject if posting requires relocation outside preferredLocations"
  - id: remoteOnly
    category: location
    rule: "flag for manualReview if posting is fully onsite"
  - id: noStaffingAgencies
    category: employerType
    rule: "reject if company is tagged staffingAgency"
  - id: clearanceMismatch
    category: clearance
    rule: "reject if posting requires a clearance level above currentLevel and eligibleToObtain is false"
  - id: belowMinSalary
    category: compensation
    rule: "reject if posted base salary is below minAcceptableBase"

preferredLocations:
  - "Remote"
  - "Hybrid, East Coast US"
```

- **`nonNegotiables` is a typed list, not a free-form rule engine.** Each entry has a fixed `category` (`location`, `employerType`, `clearance`, `compensation`, or `custom`) and a plain-language `rule` string. `fitEvaluator.ts` interprets known categories directly; `custom` entries are logged and flagged for `manualReview` rather than silently ignored, since arbitrary rule parsing is out of scope for v1.
- **Clearance is a spectrum, not a binary.** `currentLevel` vs. a posting's required level drives the gate, instead of a single citizenship/visa check. This also supports candidates who are clearance-eligible but not currently cleared, a common case the binary check missed.
### Requirement 1b: Guided Setup Wizard (new)

Manually hand-editing `jobPreferences.yaml` risks exactly the problem above: placeholder-looking numbers get mistaken for real defaults, or get left in by accident. Instead:

- `node dist/cli/jobSearchCore.js init` runs an interactive prompt sequence that asks for compensation floor/target, clearance status and level, work authorization, preferred locations, and non-negotiables (selected from the typed categories in Requirement 1a, with free text for `custom` entries).
- The wizard writes directly to the gitignored real files (`jobPreferences.yaml`, `masterProfile.md` scaffold, `screeningAnswers.json`). The `.example` files are never touched by the wizard and never contain anything but structural placeholders (`0`, `null`, `"REPLACE_ME"`), so there is no plausible-looking number anywhere in the committed repo to copy by mistake.
- `init` is idempotent: re-running it detects existing real files and asks whether to update specific sections rather than overwrite everything.
- `init` ends by running the naming linter and a `.gitignore` check that confirms no real profile file is currently tracked by git, and fails loudly if one is.

### Requirement 2: Deductive Fit Evaluator (`fitEvaluator.ts`)

Calculations start at a base score of 5.0 and apply forced deductions:

- **Missing Hard Requirement:** −2.5 points per missing required tool, language, or certification.
- **Years of Experience Deficit:** Score capped at 2.5/5.0 if candidate experience < posting requirement.
- **Domain Discrepancy:** −1.0 point if candidate lacks direct industry domain experience (e.g., FinTech, HealthTech).
- **Hard Rejection Gate (0.0/5.0):** Driven entirely by `nonNegotiables` in `jobPreferences.yaml` (Requirement 1a). `fitEvaluator.ts` contains no hardcoded rejection logic; it iterates the configured rules and applies whatever the user has defined as a dealbreaker. A `custom`-category rule that can't be evaluated automatically routes to `manualReview` instead of being silently skipped.

**Score bands and routing (new, replaces binary accept/reject):**

| Score Range | Status | Action |
|---|---|---|
| 0.0 | `hardRejected` | Auto-archived, no generation |
| 0.1 – 2.4 | `weakFit` | Archived, visible in report, not generated by default |
| 2.5 – 3.4 | `manualReview` | Flagged for human decision before any generation runs |
| 3.5 – 5.0 | `strongFit` | Displayed as a strong match; generation still requires the user to explicitly run `generate` |

This closes the gap where a legitimately promising role scoring 2.8 was previously indistinguishable from a 0.5. No score band, including `strongFit`, triggers generation on its own; that would violate Section 1.5 (Ask, Don't Assume). The score band only determines what gets surfaced and how it's flagged.

### Requirement 2a: Fixed Scrape Results Display (updated, non-negotiable)

Any time `weJobSearch` displays a batch of scraped and evaluated job postings, in the CLI, in an MCP-driven agent surface, or anywhere else, it renders **two** fixed tables. Neither table's columns, order, or naming may be added to, removed from, or reordered by any future session.

**Table 1 — Active Results** (postings with `fitStatus` of `manualReview` or `strongFit`):

| # | Column | Source |
|---|---|---|
| 1 | Sr. No. | Sequential integer for this result batch, starting at 1 |
| 2 | Job Title | `roleTitle` |
| 3 | Organization | `companyName` |
| 4 | Brief | Deterministic extractive summary of the posting produced by the CLI's summarizer (`src/generators/briefGenerator.ts`): the first meaningful sentence(s) of the posting description, truncated to a fixed max length (150 characters) with an ellipsis. It is a compression of the source text only, never inferring claims not present in it. The CLI has no LLM provider integration anywhere in its architecture, so it never makes a live LLM API call to fill this column |
| 5 | Fit Score | `fitScore` (0.0–5.0) |
| 6 | Justification | `fitStatus` label plus a one-line reason (e.g. "strongFit — meets all required tools, 1 domain gap") |
| 7 | Link | `jobUrl` |

**Table 2 — Excluded Results** (postings with `fitStatus` of `hardRejected` or `weakFit`), rendered separately so a promising role is never buried among clear rejections, and so the user can audit whether the evaluator is over-rejecting:

| # | Column | Source |
|---|---|---|
| 1 | Sr. No. | Sequential integer for this batch, starting at 1 (independent sequence from Table 1) |
| 2 | Job Title | `roleTitle` |
| 3 | Organization | `companyName` |
| 4 | Fit Score | `fitScore` (0.0–5.0) |
| 5 | Justification | Full reason for exclusion: for `hardRejected`, the specific `nonNegotiables` rule `id` that fired; for `weakFit`, the dominant deduction(s) that drove the score down |
| 6 | Link | `jobUrl` |

- **Brief grounding rule (updated):** The Brief field carries the same zero-hallucination discipline as resume generation (Requirement 1), scoped to the job posting rather than the candidate. The summarizer may only compress and rephrase text actually present in the scraped posting. It must never add inferred seniority, inferred tech stack, inferred company size, or any other claim not explicitly stated in the source text.
- **Brief generation is deterministic extractive summarization by default (new):** The CLI's summarizer selects the first meaningful sentence(s) verbatim from the posting description and truncates to 150 characters with an ellipsis — it is not a live LLM call and does not depend on any provider key or external service. Because extraction can only select and compress sentences that already exist in the source text, the grounding rule above is satisfied trivially. When `evaluateJobPosting` or `searchJobPostings` are invoked via MCP inside an agent session, the orchestrating agent may supply a richer generated summary in place of the extractive one, but the CLI's own default never relies on that being available; it always produces its own extractor before displaying any table.
- **`src/reporting/scrapeResultsFormatter.ts` (updated):** Renders Table 1. Owns the fixed 7-column contract for active results.
- **`src/reporting/excludedResultsFormatter.ts` (new):** Renders Table 2. Owns the fixed 6-column contract for excluded results. Every code path that displays scrape results calls both formatters as appropriate; no command builds its own ad hoc table for either.
- **Test coverage (Section 6.3):** A test asserts each formatter's header row equals its exact column set, in order. If a future session tries to add, remove, or reorder a column in either table, the test fails loudly rather than the format silently drifting.
- **Deduplication happens before display.** Per Requirement 7, postings are deduplicated before evaluation, so both tables' Sr. No. sequences reflect unique postings only, never the same role listed twice because two aggregators returned it.

### Requirement 3: 1-Page Typst Resume Engine (Variant-Aware)

### Requirement 3a: Cover Letter Generator (new)

Grounded in the same masterProfile.md and zero-hallucination rules as
resume generation, but a distinct, independently-invoked capability per
Section 1.5 — generating a resume never auto-triggers this, and vice versa.

- **`src/generators/coverLetterGenerator.ts` (new):** Drafts a role-specific
  cover letter grounded strictly in masterProfile.md content, referencing
  the target posting's stated requirements only where masterProfile.md
  content genuinely supports the connection. Never invents claims not
  present in masterProfile.md, matching Requirement 1's resume rule exactly.
- **CLI:** `node dist/cli/jobSearchCore.js draftCoverLetter --company "AcmeCorp" --role "SeniorEngineer"`
- **MCP tool:** `draftCoverLetter(companyName: string, roleTitle: string)`
- **Output:** Written to `applications/<companyName><roleTitle>/coverLetter.md`,
  independent of whether a resume has been generated for that role yet.

Section 4.1's `generate` command example is corrected to read "Generate
tailored 1-page Typst resume (auto-selects variant)" only — cover letter
generation is its own explicit command, never bundled.

- **Compilation Tool:** Uses `typst compile` for multi-platform PDF generation.
- **US EEO Compliance Filter:** Automatically removes personal identifiers (photos, marital status, gender, age, birth date, full residential street address). Only Name, City/State, Email, Phone, LinkedIn, and Portfolio links are permitted.
- **Page Count Verification (`typstCompiler.ts`):** Checks page boundaries post-compilation. If the PDF exceeds 1 page, triggers a text-density reduction pass until `pageCount == 1`.
- **ATS Reading Order Verifier (`atsChecker.ts`):** Extracts plain text from the compiled PDF to verify standard parsers detect section headers (Experience, Education, Skills) sequentially. Also checks that target-role keywords from the job posting appear in extractable text (not just visually present).
- **Resume Variant Support (new):** `resumeVariants.yaml` maps trigger conditions (e.g., `targetsFederal: true`, `domainTag: "GSE"`) to a specific `.typ` template. `jobSearchCore.ts generate` selects the variant automatically based on posting metadata, or accepts an explicit `--variant` flag. This lets one profile support multiple structurally different resumes (e.g., a compressed standard version vs. a version with standalone entries for specific employers) without duplicating `masterProfile.md`.

### Requirement 4: Active Run State & Confirmed Application History

- **Active Run State (`pipelineState.json`): RETRACTED.** Section 6.4 is
  normative: the active run-state engine was never implemented, and
  persistence is `applicationHistory.json` plus per-role output directories.
  Earlier drafts described this as live; they were wrong and are superseded
  by this paragraph.
- **Confirmed History Logger (`jobFunnelTracker.ts`):** Stores application histories in `applications/applicationHistory.json`. A run moves to `appliedConfirmed` status only after manual user confirmation.
- **Staleness Handling (new, `staleChecker.ts`):** Applications sitting in `appliedConfirmed` with no status update for a configurable window (default 45 days) are auto-flagged `staleNoResponse` in reporting. This is a visibility flag only. It never deletes or overwrites history.

**`applications/applicationHistory.json` Schema:**

```json
{
  "applications": [
    {
      "applicationId": "app2026AcmeCorpSeniorEngineer",
      "companyName": "AcmeCorp",
      "roleTitle": "SeniorEngineer",
      "jobUrl": "https://example.com/job",
      "postingHash": "sha256OfNormalizedCompanyRoleLocation",
      "sourceAggregators": ["indeed", "linkedin"],
      "salaryRange": "$160,000 - $190,000",
      "fitScore": 4.2,
      "fitStatus": "strongFit",
      "referralContact": null,
      "status": "appliedConfirmed",
      "statusHistory": [
        { "stage": "evaluated", "timestamp": "2026-08-08T10:00:00Z" },
        { "stage": "generated", "timestamp": "2026-08-08T10:05:00Z" },
        { "stage": "appliedConfirmed", "timestamp": "2026-08-08T10:30:00Z", "notes": "Submitted via Greenhouse portal" }
      ]
    }
  ]
}
```

- **`postingHash`** (new): SHA-256 of normalized `companyName + roleTitle + location`. Used by `postingDeduplicator.ts` to prevent the same role, scraped from two aggregators, from generating two separate application folders.
- **`sourceAggregators`** (new): Tracks every source a duplicate was seen on, for scraper-quality auditing.
- **`referralContact`** (new): Nullable link into `networkingContacts.json`. Roles with a referral are a meaningfully different funnel stage than cold applications and should be reportable separately.
- **Evaluation-time persistence (new, sub-note):** evaluate and search persist every uniquely-evaluated posting to applicationHistory.json immediately upon evaluation, with status 'evaluated', regardless of fitStatus (including hardRejected and weakFit). This is a tracking action, not a generation or outreach action, so it does not violate Section 1.5's 'ask, don't assume' principle, which governs document generation and outreach, not read/write tracking of what was evaluated. Re-running evaluate or search against an already-logged posting is idempotent: postingDeduplicator.ts's hash/fuzzy matching against existing history prevents duplicate records, and the command reports 'already present' rather than creating a second entry. This is what makes Requirement 6's getReviewQueue and Requirement 9's getFunnelReport meaningful — without this, applicationHistory.json would only ever contain postings that reached generate or confirmApp.

### Requirement 5: Screening Question Bank (`screeningAnswers.json`)

Requirement 5 is schema plus profile tools only: a standalone
`screeningPrefiller` module was evaluated and deleted (zero non-test callers;
screening answers flow through `screeningAnswers.json`, the init wizard, and
the profile MCP tools instead). There is no prefill engine to wire.

Pre-fills non-resume screening questions commonly found on US portals (Lever, Greenhouse, Workday):

```json
{
  "workAuthorization": {
    "usCitizen": false,
    "requiresSponsorship": true,
    "sponsorshipType": "H-1B"
  },
  "compensation": {
    "minBaseSalary": 0,
    "targetBaseSalary": 0,
    "currency": "USD"
  },
  "standardQuestions": {
    "yearsOfExperience": {
      "softwareEngineering": 6,
      "typescript": 4,
      "python": 5
    },
    "preferredWorkLocation": "Remote / Hybrid East Coast",
    "noticePeriod": "2 weeks"
  }
}
```

### Requirement 6: Networking & Referral Tracking (new)

Cold-apply fit scoring alone ignores how most roles are actually filled. `profile/networkingContacts.json` tracks people, not postings:

```json
{
  "contacts": [
    {
      "contactId": "contact001",
      "name": "Jane Smith",
      "company": "AcmeCorp",
      "relationship": "formerColleague",
      "lastContactDate": "2026-07-15",
      "linkedApplicationIds": ["app2026AcmeCorpSeniorEngineer"],
      "followUpDue": "2026-08-20"
    }
  ]
}
```

`funnelReporter.ts` surfaces referral-linked applications separately from cold applications, and flags contacts with a `followUpDue` date in the past.

### Requirement 6a: Outreach Message Drafting (new)

Grounded in the same `masterProfile.md` and non-hallucination rules as resume generation, but scoped to short networking messages rather than application submission.

- **`src/generators/outreachMessageGenerator.ts` (new):** Drafts a short message (default: LinkedIn-style connection or referral-ask note; the user can request other formats like a cold email) tailored to a specific contact and role, grounded strictly in `masterProfile.md`, with the same zero-hallucination rule as the resume generator.
- **CLI:** `node dist/cli/jobSearchCore.js draftOutreach --contactId "contact001" --company "AcmeCorp" --role "SeniorEngineer" [--platform linkedin|email]`
- **MCP tool:** `draftOutreachMessage(contactId: string, companyName: string, roleTitle: string, platform?: string)`
- **Output:** Written to `applications/<companyName><roleTitle>/outreachMessage.md`, alongside the resume and cover letter. The tool drafts the text and stops. Sending it, on LinkedIn, email, or anywhere else, is always a manual action by the user, per Section 1.4.

### Requirement 7: Cross-Aggregator Deduplication (new)

`src/dedup/postingDeduplicator.ts` runs immediately after scraping, before evaluation:

- Normalizes `companyName + roleTitle + location`, generates `postingHash`.
- If a hash already exists in `applicationHistory.json`, the new posting is merged into `sourceAggregators` on the existing record instead of creating a duplicate `applications/<companyName><roleTitle>/` folder.
- Fuzzy-match fallback (Levenshtein threshold) catches near-duplicates where role titles differ slightly across boards (e.g., "Senior Engineer" vs. "Sr. Engineer").

### Requirement 8: Scraper Rate Limiting & ToS Posture (new)

`src/scrapers/rateLimiter.ts` wraps `jobSpyAdapter.ts`:

- Enforces a minimum delay between requests per target board (configurable, default 2–5s jittered).
- Respects `robots.txt` disallow rules per domain.
- Exponential backoff on 429/403 responses; hard stop after N consecutive failures rather than hammering a board.
- README explicitly documents that scraping is subject to each job board's Terms of Service and that the user is responsible for compliance. This is a legal exposure point that should not be silently assumed away.

### Requirement 9: Funnel Reporting (new)

`src/reporting/funnelReporter.ts` reads `applicationHistory.json` and outputs a summary (CLI table and/or JSON) covering:

- Count by `fitStatus` (strongFit / manualReview / weakFit / hardRejected)
- Count by `status` (evaluated / generated / appliedConfirmed / staleNoResponse / rejected / interviewing / offer)
- Referral-linked vs. cold-apply conversion rate
- Applications awaiting `manualReview` action
- Contacts with overdue follow-ups

Without this, everything logged in Requirement 4 is write-only. This is the command that turns the tracker into an actual job-search dashboard.

---

## 4. Architecture & Tool-Agnostic Abstraction

```
               ┌──────────────────────────────────────────────┐
               │              AI Agent Interfaces              │
               │ (OpenCode, Claude Code, Cursor, Copilot CLI)  │
               └──────────────────────┬───────────────────────┘
                                       │
                     (Calls standard MCP or CLI Commands)
                                       │
                                       ▼
               ┌──────────────────────────────────────────────┐
               │              MCP Server Layer                 │
               │          (src/mcp/jobSearchServer.ts)         │
               └──────────────────────┬───────────────────────┘
                                       │
                                       ▼
               ┌──────────────────────────────────────────────┐
               │             Job Search Core CLI                │
               │          (src/cli/jobSearchCore.ts)            │
               └──────┬───────────┬───────────┬──────────┬─────┘
                      ▼           ▼           ▼          ▼
               ┌────────────┐ ┌─────────┐ ┌──────────┐ ┌────────────┐
               │fitEvaluator│ │stateMgr │ │typstCompl│ │funnelReport│
               └────────────┘ └─────────┘ └──────────┘ └────────────┘
```

### 4.1 CLI Core Commands

```bash
# Parse local PDF resume or job description
node dist/cli/jobSearchCore.js parsePdf --filePath "./myResume.pdf"

# Evaluate target posting (runs dedup check first)
node dist/cli/jobSearchCore.js evaluate --jobUrl "https://..."

# Search and evaluate a batch of postings (always renders both fixed results tables, Requirement 2a)
node dist/cli/jobSearchCore.js search --keywords "senior product manager" --location "Remote"

# Generate tailored 1-page Typst resume (auto-selects variant)
node dist/cli/jobSearchCore.js generate --company "AcmeCorp" --role "SeniorEngineer" [--variant usDetailedResume]

# Confirm submission and update history log
node dist/cli/jobSearchCore.js confirmApp --company "AcmeCorp" --role "SeniorEngineer" --notes "Submitted via Greenhouse"

# Review roles flagged for manual decision
node dist/cli/jobSearchCore.js reviewQueue

# Print funnel summary
node dist/cli/jobSearchCore.js report [--format table|json]

# Log or update a networking contact
node dist/cli/jobSearchCore.js addContact --name "Jane Smith" --company "AcmeCorp"

# Validate the configuration files (fail-fast schema check, writes nothing)
node dist/cli/jobSearchCore.js validate [--dataRoot PATH]

# Draft an outreach message (never sent automatically)
node dist/cli/jobSearchCore.js draftOutreach --contactId "contact001" --company "AcmeCorp" --role "SeniorEngineer" [--platform linkedin|email]

# Show available help with no assumptions about what to do next
node dist/cli/jobSearchCore.js
```

CLI/MCP parity is explicitly not required (accepted superset, recorded
2026-10): the CLI exposes additional commands beyond these examples
(`previewResume`, `digest`, `show`, `review`, `updateStatus`, `exportData`,
`importData`, `draftCoverLetter`), and the MCP server exposes additional tools
beyond the list in Section 4.2. Neither list is exhaustive; the menu-vs-dispatch
parity test is the only enforced correspondence.

### 4.2 Model Context Protocol (MCP) Integration

`src/mcp/jobSearchServer.ts` exposes native tools for AI environments:

- `parsePdfDocument(filePath: string)`
- `evaluateJobPosting(jobUrl: string)`
- `searchJobPostings(keywords: string, location?: string)`: returns results in the fixed seven-column active shape (Requirement 2a)
- `generateTailoredApplication(companyName: string, roleTitle: string, variant?: string)`
- `confirmApplicationSubmission(companyName: string, roleTitle: string, notes: string)`
- `getReviewQueue()`: returns roles pending manual review
- `getFunnelReport()`: returns current funnel summary
- `logNetworkingContact(name: string, company: string, relationship: string)`
- `draftOutreachMessage(contactId: string, companyName: string, roleTitle: string, platform?: string)`

The MCP surface is likewise an accepted superset: further tools exist beyond
this list (profile intake, saved searches, outreach/cover-letter drafting,
pattern analysis); see `src/mcp/jobSearchServer.ts` as truth, not this list.

### 4.3 Multi-Platform Config Adapter Builder (`buildAgentConfigs.ts`)

Outputs native rule files during the build step:

- **OpenCode:** `opencode.json`
- **Claude Code:** `.claude/commands/`
- **Cursor:** `.cursor/rules/`
- **Windsurf:** `.windsurfrules`

---

## 5. Setup & Environment Prerequisites (new)

`README.md` must specify, at minimum:

- Node.js version (recommend LTS, pin in `.nvmrc`)
- Typst binary installed and on `PATH` (with install instructions per OS)
- `pdf-parse` and other npm dependencies via `npm install`
- No API keys required: all six default aggregator adapters are free scrapes (Requirement 8), so there is no `.env` copy step. `.env.example` documents only the data-root relocation key and must stay secret-free
- Config validation: `jobSearchCore.js` should validate `jobPreferences.yaml` and `resumeVariants.yaml` against a schema on startup and fail fast with a clear error rather than partial-running with bad config

---

## 6. Build Tooling, Testing, and Continuous Integration (new)

### 6.1 Project Scaffolding

- `package.json` with `engines.node` pinned to match `.nvmrc`, and scripts for `build`, `lint`, `test`, `init`, `evaluate`, `generate`, `report`.
- `tsconfig.json` in strict mode.
- `package-lock.json` committed, so a fresh clone builds identically regardless of when it's cloned.

### 6.2 Test Fixtures (new)

The real `profile/` files are intentionally empty until the user runs `init`. The agent still needs to verify the pipeline actually works (evaluate, generate, compile, ATS-check) before declaring the baseline ready, without ever fabricating real personal data into a real profile file.

- Create a committed `fixtures/` directory containing clearly synthetic data: `fixtures/sampleProfile.md` (e.g., candidate name "Jane Sample", employer "SampleCorp"), `fixtures/sampleJobPosting.txt`, `fixtures/sampleJobPreferences.yaml`. Fake enough that nobody could mistake it for a real person's data.
- All automated tests and the agent's own end-to-end verification run against `fixtures/`, never against `profile/`.
- `fixtures/` is committed (unlike `profile/`), since it contains no real information and is what proves the build works to anyone who clones the repo.

### 6.3 Automated Tests

- Test framework: Vitest (or Jest if the agent has a strong reason to prefer it, stated in `ARCHITECTURE.md`).
- Minimum required test coverage before the baseline is considered done:
  - `fitEvaluator.ts`: each deduction rule, each score band boundary, and at least one test per `nonNegotiables` category (location, employerType, clearance, compensation, custom-routes-to-manualReview).
  - `postingDeduplicator.ts`: exact-hash match and fuzzy near-duplicate match.
  - `namingLinter.ts`: at least one intentional violation fixture that the linter must catch.
  - `staleChecker.ts`: date-boundary behavior around the configurable staleness window.
- Config schema validation uses a runtime library (e.g., `zod`) rather than hand-rolled checks, so a malformed real `jobPreferences.yaml` fails with a specific, readable error instead of a silent bad run.

### 6.4 Data Integrity

- All writes to `applicationHistory.json` and `networkingContacts.json` are atomic (write to a temp file, then rename) so an interrupted process cannot corrupt the tracking database. The `pipelineState.json` active-run-state module is not implemented; persistence is `applicationHistory.json` plus per-role output directories.
- `jobFunnelTracker.ts` validates the existing file against its schema before writing, and refuses to write if the existing file is already malformed, surfacing the error instead of overwriting bad data with more bad data.

### 6.5 Continuous Integration

- `.github/workflows/ci.yml` runs `lint`, `test`, and the naming linter on every push and pull request. This is the concrete implementation of the "pre-commit / CI gate" principle in Section 7 below; it must actually exist as a workflow file, not just be described in prose.

### 6.6 Typst Compilation in Constrained Environments (new)

Agent sandboxes do not always allow installing arbitrary system binaries. `typstCompiler.ts` prefers a system `typst` binary on `PATH` when present (binary-preferred, the more reliable default: the WASM path needs a one-time CDN font fetch), with an npm-installable WASM compiler (e.g. a package like `@myriaddreamin/typst.ts`) as the fallback. Either way, LaTeX is never used. This keeps Requirement 3 buildable and testable inside the agent's own environment, not just on the end user's machine.

---

Long-running agentic sessions (OpenCode, Claude Code, Cursor, etc.) degrade over time as context fills up and instructions get diluted relative to more recent output. Rules must be enforced structurally, not remembered by the agent.

- **`src/utils/namingLinter.ts` (new):** Scans all files, paths, variables, and JSON keys for underscore violations and camelCase/PascalCase non-compliance. Fails the build with a specific file/line reference. This turns Section 2.1's naming rule from a convention the agent might forget into a check code enforces every run.
- **Deterministic validators over agent judgment:** `typstCompiler.ts` (page count) and `atsChecker.ts` (reading order) already follow this pattern; every rule in this spec that can be checked by code should be, rather than left to the agent to self-police.
- **Session re-anchoring:** Every generated agent config (`opencode.json`, `.claude/commands/`, `.cursor/rules/`, `.windsurfrules`) opens by pointing back at this SDD file directly, not a paraphrased summary, so each fresh session re-ingests the actual rules rather than inheriting drift from earlier sessions.
- **Scoped sessions:** Prefer one command, one deliverable, then a clean session, over one long session handling multiple tasks. Drift compounds with session length.
- **Pre-commit / CI gate:** Run `namingLinter.ts` and the compiler/ATS validators automatically before any commit, so a wayward session is caught mechanically rather than during manual review.

---

### Requirement 8: Scraper Sources, Adapter Registry, Rate Limiting & ToS Posture (updated)

#### Adapter Registry (updated)

`src/scrapers/jobSpyAdapter.ts` is no longer a single scraper — it is a registry that dispatches to one adapter per source, all implementing a shared `SourceAdapter` interface (`search(keywords, location) -> RawPosting[]`), and all wrapped by the same `src/scrapers/rateLimiter.ts`. This keeps per-source markup changes, access patterns, and risk postures isolated from each other and from `postingDeduplicator.ts`, `fitEvaluator.ts`, and the reporting layer, none of which should need to know which source a posting came from.

src/scrapers/
├── jobSpyAdapter.ts # Registry: dispatches to the six adapters below
├── rateLimiter.ts # Shared politeness delay + backoff + robots.txt respect
└── adapters/
├── linkedinAdapter.ts
├── hiringCafeAdapter.ts
├── wellfoundAdapter.ts
├── welcomeToTheJungleAdapter.ts
├── builtInAdapter.ts
└── flexJobsAdapter.ts


#### Named Sources, Build Order, and Risk Posture (new)

Sources are built in this order — highest confidence in a working, reusable technique first, highest ToS risk and least precedent last — so a stalled or broken adapter never blocks the ones ahead of it:

| Order | Source | Technique Basis | Risk Posture |
|---|---|---|---|
| 1 | LinkedIn | Ported from the reference repo's `linkedin-search` skill (unauthenticated public search endpoints, no login) — see SDD Section 1.3 | **Accepted risk.** LinkedIn's ToS prohibits automated access; this project proceeds anyway, deliberately and with the user's explicit sign-off, using only public unauthenticated endpoints (no credential use, no auth bypass) |
| 2 | hiring.cafe | Built fresh; free scrape only, no paid API tier | Low — aggregator built for this kind of programmatic use |
| 3 | Wellfound | Built fresh, informed by public scraper conventions; free scrape only | **Accepted risk.** Wellfound's Talent General Terms Article III explicitly prohibits automated or non-automated harvesting, collection, or scraping of content; this project proceeds anyway, deliberately and with the user's explicit sign-off (same discipline as hiring.cafe), using only public unauthenticated `/role/` SEO listing pages, no login, no bot-detection/CAPTCHA bypass. Guest sessions cannot paginate past page 1, so only the first role-listing page is fetched |
| 4 | Welcome to the Jungle | Built fresh; free scrape only, no paid API tier | **Accepted risk.** WTTJ's site CGUs (27 Apr 2026 version) explicitly prohibit developing or using any software, script, robot, or other means to perform automated data extraction ("scraping") or to copy or download site content; this project proceeds anyway, deliberately and with the user's explicit sign-off (same discipline as hiring.cafe and Wellfound), using only public unauthenticated pages. Access is via the robots-allowed `job-listings` sitemap `.xml.gz` files plus directly-fetched server-rendered `/en/companies/{company}/jobs/{slug}` detail pages (which embed full structured data, salary and currency in `__INITIAL_DATA__`); no login, no JS execution, no CAPTCHA/bot-detection bypass, and no referer spoofing to defeat the Algolia search API's referer allow-list |
| 5 | Built In | Built fresh via direct site inspection (no reference-repo logic found in Step 0 — confirmed absent; SDD Section 1.3) | **Accepted risk.** Built In's Community Terms of Use (May 23, 2025) Section 3(f) explicitly prohibits accessing, using, or copying the Site through "bots, spiders, scrapers, web crawlers, indexing agents, or other automated devices or mechanisms"; this project proceeds anyway, deliberately and with the user's explicit sign-off (same discipline as hiring.cafe, Wellfound, and Welcome to the Jungle), using only the pages those robots.txt sitemaps themselves advertise (listing pages only), direct plain-HTTP fetches of server-rendered `/job/{slug}/{id}` detail pages (which embed a full schema.org `JobPosting` JSON-LD incl. salary + currency in `baseSalary`), and `/jobs`/`/jobs/*` listing pages that embed an `ItemList` JSON-LD. Never builds `?search=` query URLs or city-filter paths robots.txt disallows, never hits disallowed paths, no login, no JS execution, no CAPTCHA/bot-detection bypass |
| 6 | FlexJobs | Built fresh; no precedent to reuse (§1.3). Reality-checked 2026-08-08: subscription paywall is the product — public unauthenticated pages expose only ~200-character teaser cards, and `/search` plus `/publicjobs/{slug}` detail pages return HTTP 403 (Akamai edge) on an honest plain-HTTP GET. The adapter therefore stays entirely on the robots-allowed `/remote-jobs` first listing page, which server-renders a Next.js `__NEXT_DATA__` JSON island with one record per job (employer name, ISO posted date, `salaryRange` string, remote/on-site flags, teaser). Full descriptions, employer contact, and applying are paywalled and never fetched | **Accepted risk.** FlexJobs' ToS (Jan 16, 2025) explicitly prohibits bots and scraping ("spiders, robots ... such as scraping, spidering, crawling") and separately forbids content reuse "without FlexJobs' authorisation"; this project proceeds anyway, deliberately and with the user's explicit sign-off, using only public unauthenticated listing pages over plain HTTP — no login, no session/cookie handling, no CAPTCHA or bot-detection bypass. Built last and with the most conservative rate-limiting of the six (4–5s), given the least tolerance for aggressive request patterns |

All six are free-only. No source in this list uses a paid API or paid scraping service; this is a deliberate cost constraint, not a technical limitation, and it means these adapters are expected to be more fragile against site markup changes than a paid/maintained API would be. There is no commercial fallback if an adapter breaks — it gets patched.

#### Rate Limiting & ToS Posture

`src/scrapers/rateLimiter.ts` wraps every adapter in the registry:

- Enforces a minimum delay between requests per target source (configurable per adapter, default 2–5s jittered; FlexJobs and LinkedIn default to the most conservative end of this range).
- Respects `robots.txt` disallow rules per domain where the source's terms don't already forbid access outright (LinkedIn and FlexJobs are accessed under the accepted-risk posture above regardless of robots.txt, since their objection is contractual/ToS-based, not robots-file-based).
- Exponential backoff on 429/403 responses; hard stop after N consecutive failures rather than hammering a source.
- **README disclosure (updated):** `README.md` must explicitly name LinkedIn and FlexJobs as sources scraped despite ToS language prohibiting it, state this is a deliberate, user-accepted risk rather than an oversight, and repeat the existing general statement that all scraping is subject to each job board's Terms of Service and is the user's sole responsibility.

---

## 9. Handoff and Completion Reporting (new)

The agent's job ends at a working, tested, generic baseline. It does not end with the tool being used for a real job search, since that requires the user's own data entered through `init`.

When every step in Section 8 is complete, the agent produces a final summary (as `HANDOFF.md` in the repo root, and restated in its final chat message) covering:

- What was built, mapped against each numbered requirement in this spec, with any deviations and the reasoning for each.
- Full test suite results (pass/fail counts), and confirmation that `namingLinter.ts` and the fixture-based end-to-end run both passed.
- Confirmation, explicitly stated, that no real personal data was entered anywhere and that `git status` shows only `.example` and `fixtures/` files as tracked under `profile/`-adjacent paths.
- The exact remaining commands for the user to run: `npm install` (if not already run), Typst binary install (if the WASM path was not used), and `node dist/cli/jobSearchCore.js init`.
- Anything the agent could not complete or had to make a judgment call on, flagged explicitly rather than silently resolved.

This is the signal that the baseline is ready for handoff. The agent should stop here and wait, rather than continuing on to populate real data or start using the tool.
