# weJobSearch

A local-first, **portable agentic skill** for running a US tech/corporate job
search from inside an agentic coding tool (Claude, Codex, OpenCode, Cursor,
Windsurf, Aider, Copilot CLI, and similar hosts). The primary product is the
skill itself: a set of host-neutral instructions plus a deterministic local
engine that your agent drives through the Model Context Protocol (MCP) server
and the portable skill rules this repository ships. You use weJobSearch by
**asking your agent to do the work**; the agent calls the weJobSearch tools,
keeps your real data under a private local root, and never submits anything for
you.

The same engine also has a thin CLI, but the CLI is a **developer interface,
not the user workflow** — see *Optional developer interface*.

weJobSearch is a derivative, rewritten-from-scratch refactor of
[MadsLorentzen/ai-job-search](https://github.com/MadsLorentzen/ai-job-search),
under this repository's conventions:

- Pure TypeScript (no Python/Bun), strict camelCase naming, zero underscores.
- 1-page ATS-optimized PDF resumes compiled with **Typst** (never LaTeX).
- US-market job-board adapters with rate limiting and an honest ToS posture.
- A deduction-based fit evaluator with a manual-review tier.
- Deterministic behavior with zero skill/claim hallucinations, no LLM in the
  CLI path, and no API keys.

**This is not an official Mads Lorentzen project.** It is a derivative work,
rewritten under different conventions; the original MIT copyright notice is
retained in `LICENSE` (SDD Section 1.2).

The agentic drafter-reviewer model of the original project lives on here as a
set of separate, explicitly-invoked capabilities: search and evaluate, then
independently generate a resume, draft a cover letter, or draft an outreach
message. **Nothing chains automatically into anything else**, and the tool
never submits an application or contacts anyone for you (SDD Sections 1.4
and 1.5).

## Product layout

Understand what is what before you use it:

| Layer | What it is | Where |
|---|---|---|
| **Portable skill instructions** | The primary user-facing product: host-neutral rules and workflows an agent reads at session start. | `AGENTS.md`, `docs/weJobSearch-SDD.md` |
| **Local engine** | Adapters, dedup, evaluation, persistence, document generation, reporting, and tests. Deterministic and offline-capable (except live scraping and the optional font fetch). | `src/` |
| **MCP integration layer** | The tool bridge your agent host uses to expose the engine over stdio. | `src/mcp/jobSearchServer.ts` |
| **Optional CLI / developer interface** | A thin command dispatcher over the same core functions. Used for local scripting and development, not routine operation. | `src/cli/jobSearchCore.ts` |
| **Per-host config** | Pre-generated agent configs for several hosts, all pointing at the same source of truth. Host-specific installation only. | `opencode.json`, `.claude/commands/`, `.cursor/rules/`, `.windsurfrules` |

The binding specification is `docs/weJobSearch-SDD.md`; `AGENTS.md` is the
execution checklist both for human contributors and for agents that read it.
Each host's config file re-anchors the agent on the SDD directly.

## Quick Start — agent-first workflow

This is the normal way to use weJobSearch. You talk to your agent; your agent
uses the weJobSearch tools.

### What you need before starting

- A computer where you can install software and run terminal commands —
  the one-time bootstrap below needs Node.js plus two commands. If that
  is unfamiliar, ask a technical friend for 15 minutes of help; after
  the bootstrap, everything happens in plain conversation with your agent.
- An agentic coding tool (Claude, Codex, OpenCode, Cursor, Windsurf,
  Aider, Copilot CLI, or similar) with the weJobSearch tool bridge
  registered (steps 2–3 below).
- Your resume or supporting documents as local files (PDF, Word,
  Markdown, or text).

### Plain-language glossary

- **Agent / agentic host**: the AI coding tool you already use. You talk
  to it in plain language; it operates the weJobSearch tools for you.
- **MCP (Model Context Protocol)**: the standard plug that lets your agent
  call weJobSearch's tools over a local connection — your data never
  leaves your machine. Setup is a one-time registration (step 3).
- **Canonical data root**: a private folder on your own machine
  (`~/Documents/weJobSearch/<username>/`) holding your profile and
  outputs. It sits outside the repository, so it can never be published.
- **Non-negotiables**: your deal-breakers (locations, salary floor,
  employer types) that automatically rule postings out.
- **Dedup / deduplicate**: recognizing the same job seen on two boards as
  a single posting.
- **Typst / WASM**: the technology that builds your 1-page resume PDF.
  You only need to know these names if the troubleshooting section sends
  you there.

### 1. What the agentic skill is

From your agent, you can ask for each of these independently:

- **Read your local profile** (resume facts, preferences, screening answers,
  networking contacts) — with guided first-run onboarding steps when nothing
  is configured yet, and a resumable setup step if a setup was interrupted.
- **Ingest a directory of documents** (PDF, Word, Markdown, text) read-only,
  into structured sections and cleaned text.
- **Search** the configured job sources for keywords and location (location
  auto-fills from your preferred locations when omitted).
- **Search by profile** — one call runs a query per target role using your
  skills and preferred locations.
- **Suggest roles** aligned with your learned profile.
- **Deduplicate and evaluate** the returned postings against your profile and
  non-negotiable preferences.
- **Persist** every evaluated role to local application history.
- **Generate a tailored resume** for one company and role.
- **Draft a cover letter** for one company and role.
- **Draft an outreach message** to a networking contact — drafted locally,
  never sent.
- **Review roles** that require a human decision.
- **Analyze application patterns** — a deterministic learning loop that
  suggests skill/domain signals, role-title clusters, resume-variant
  effectiveness, and preference drift; suggestions only, nothing auto-applied.
- **Produce funnel reports** over everything tracked, including recent
  searches.
- **Back up or restore** the canonical data root (export/import, never
  overwrites existing profile data).
- **Confirm an application** — but only ever as an explicit, local-only status
  write after *you* submit on the portal yourself.

### 2. Open the repository in an agentic host

1. Clone or otherwise obtain this repository locally.
2. Open the repository folder in your agentic host — Claude, Codex, OpenCode,
   Cursor, Windsurf, Aider, Copilot CLI, or similar. OpenCode is one example,
   not a requirement.
3. Complete the one-time technical bootstrap below (typically `npm install`
   and `npm run build` once) so the local MCP server is available to your host.
4. Each host picks up the integration layer it understands: OpenCode reads
   `opencode.json` (which registers the MCP server), Cursor reads
   `.cursor/rules/`, Windsurf reads `.windsurfrules`, Claude Code reads
   `.claude/commands/`. **MCP registration differs by host** — not every host
   auto-discovers the server the same way. See *One-time technical bootstrap*
   and *Host neutrality*.

### 3. Verify the weJobSearch tools are available

Ask your agent to list the weJobSearch tools it can call. You should see the
nineteen MCP tools: `getUserProfile`, `initializeUserProfile`,
`updateUserProfile`, `parsePdfDocument`, `ingestDocuments`,
`searchJobPostings`, `searchByProfile`, `evaluateJobPosting`,
`generateTailoredApplication`, `draftCoverLetter`,
`confirmApplicationSubmission`, `getReviewQueue`, `getFunnelReport`,
`getPostingDetail`, `logNetworkingContact`, `draftOutreachMessage`,
`suggestRoles`, `analyzeApplicationPatterns`, and `runSavedSearches`. If the
tools are missing,
finish the *One-time technical bootstrap* (usually a build and an MCP
registration) and try again.

### 4. Provide a local resume or supporting-document path

Give your agent a local path to a PDF you want to work from — a legacy resume,
a saved job description, or any supporting document. Keep the file in the
canonical root's `documents/` directory
(`~/Documents/weJobSearch/<username>/documents/`) or in any other private local
directory; the path is read locally and nothing is uploaded anywhere.

For example, tell your agent:

```
Set up my weJobSearch profile from this local resume:
/private/path/resume.pdf

Parse it read-only, show me the extracted information, ask for missing
preferences, and show me the complete proposed profile. Do not write
anything until I explicitly confirm.
```

### 5. The agent parses the document read-only

Your agent calls the `parsePdfDocument` tool, which reads the file locally and
returns structured sections (contact, summary, experience, education, skills)
plus cleaned extracted text and a page count. **Parsing never writes or creates
anything.** The agent then shows you what it extracted so you can correct it.

### 6. The agent presents a proposed profile

From the parsed document and your answers to any missing questions (compensation
floor and target, clearance, work authorization, preferred locations,
non-negotiables), the agent assembles a complete proposed profile — a
`masterProfile.md`, `jobPreferences.yaml`, and `screeningAnswers.json` — and
shows it to you for review before any file is written.

### 7. You confirm profile creation

Profile creation is **confirmation-gated**: the `initializeUserProfile` tool
writes **nothing** unless you explicitly confirm (`confirmed: true`). The real
profile files are written only under the canonical data root
(`~/Documents/weJobSearch/<username>/`), outside the Git work tree, and the tool
refuses to overwrite an existing profile. Later edits go through
`updateUserProfile`, which is likewise confirmation-gated. Nothing is sent
anywhere.

### 8. Search, evaluate, review, report, and generate drafts

With a confirmed profile in place, ask your agent for any of these:

- **Search & evaluate**: "Search for `senior software engineer` in `Remote`."
  The agent searches all configured sources, deduplicates, evaluates each unique
  posting against your profile and non-negotiables, persists every evaluation
  locally, and returns the two fixed result tables (Active and Excluded).
- **Evaluate one posting**: "Evaluate `https://www.linkedin.com/jobs/view/123456`."
  The agent fetches that single posting, deduplicates it against your history,
  evaluates it, persists it, and shows the matching table.
- **Review queue**: "Show the review queue" lists every role flagged
  `manualReview` that needs your decision before anything is generated.
- **Funnel report**: "Show the funnel report" summarizes fit counts, status
  counts, referral-vs-cold conversion, the manual-review backlog, overdue
  contact follow-ups, and recent searches.
- **Generate a resume**: "Generate a tailored resume for AcmeCorp /
  SeniorEngineer." This is an independent request — evaluating never
  auto-generates a resume, and generating never auto-drafts a letter or message.
- **Draft a cover letter**: "Draft a cover letter for AcmeCorp / SeniorEngineer."
  A profile-grounded draft is written locally and nothing is sent.
- **Draft outreach**: "Draft an outreach message for contact contact001 about
  AcmeCorp / SeniorEngineer." A local Markdown draft is written and **never
  sent**.

### 9. Safety boundaries and confirmation behavior

- **Nothing auto-chains.** Each capability is invoked explicitly; no command or
  MCP tool chains into another (SDD Section 1.5).
- **Profile writes require your confirmation.** `initializeUserProfile` and
  `updateUserProfile` write nothing without explicit `confirmed: true`, and
  never overwrite an existing real profile.
- **Outreach is draft-only.** `draftOutreachMessage` writes a Markdown draft
  under `applications/<company><role>/outreachMessage.md` and stops. Sending it,
  on LinkedIn, email, or anywhere else, is always a manual action by you (SDD
  Sections 1.4 and 6a).
- **Application confirmation is a local record, after you submit.** Nothing
  changes application history to `appliedConfirmed` unless you explicitly
  confirm the submission yourself, and only once *you* have personally submitted
  on the portal. No command or tool auto-submits an application, contacts an
  employer or recruiter, or attempts to bypass CAPTCHAs/authentication walls
  (SDD Section 1.4).
- **Cover letters are drafts, not sent mail.** The `draftCoverLetter` command
  and the generated Claude Code command draft a file locally; only you send it.

### 10. Optional technical/bootstrap details

The only routine setup is the one-time technical bootstrap below
(`npm install` + `npm run build`, then MCP registration per host). You do **not**
need to run `npm run init`, edit profile files by hand, or invoke the CLI for
normal use. The interactive `init` wizard is documented only as an optional
developer/fallback path.

## Agent-first example prompts

The following prompts work in any agentic host once the tools are available.
Each is an independent request; nothing chains into anything else.

**Set up a profile from a local resume:**

```
Set up my weJobSearch profile from this local resume:
/private/path/resume.pdf

Parse it read-only, show me the extracted information, ask for missing
preferences, and show me the complete proposed profile. Do not write
anything until I explicitly confirm.
```

**Search and evaluate a batch:**

```
Search for roles matching my confirmed profile across the configured sources.
Deduplicate and evaluate them, then show the results.
```

**Search by profile (one call, all target roles):**

```
Search by profile and show the results.
```

**Suggest roles from my profile:**

```
What roles should I target based on my profile?
```

**Analyze application patterns (learning loop, suggestions only):**

```
Analyze my application history and suggest what is working and what to adjust.
```

**Evaluate a single posting:**

```
Evaluate this posting and explain the fit decision:
<job URL>
```

**Review and reporting:**

```
Show the review queue.
```

```
Show the funnel report.
```

**Generate a tailored resume (resume only — no cover letter or outreach):**

```
Generate a tailored resume for this selected role only.
```

**Draft a cover letter (local draft, nothing sent):**

```
Draft a cover letter. Do not send anything.
```

**Draft outreach (local draft, never sent):**

```
Draft outreach. Never send it.
```

## Normal user workflow

The skill is used through the agentic host and its MCP tools. For routine
operation you:

- **Do not** run `npm run init` to set up your profile — the agent drives
  profile creation and updates through `initializeUserProfile` /
  `updateUserProfile` with your explicit confirmation.
- **Do not** manually edit profile files — they live under the canonical data
  root and are managed through the profile tools.
- **Do not** invoke CLI commands — the CLI is a developer surface, not the user
  workflow.

You talk to your agent; your agent calls the weJobSearch tools. That is the
whole workflow.

## One-time technical bootstrap

This is the minimum host-specific setup that makes the local MCP server
available. Do it once per clone.

**Start with install, then the setup check.** `npm run setup` runs a one-command health check
that verifies your environment and prints exactly what to do next. It checks
your Node.js version (must be >= 24), reports whether a `typst` binary is
available on `PATH` (or whether the WASM fallback will be used), and prints the
host-specific MCP registration instructions. It writes nothing and changes no
config — it only inspects and reports. It works on a fresh clone with or
without a prior build.

**Node:** a newcomer installs Node 26.5.0 from `.nvmrc` (for example with `nvm use`). `engines` in `package.json` requires >= 24 as the supported minimum, and CI installs from `.nvmrc`, so 26.5.0 is the version to install.

**Typst (per OS):** install the binary for your OS, then verify on every OS with `typst --version`:

```bash
brew install typst                         # macOS
sudo apt update && sudo apt install typst  # Debian/Ubuntu (distro package may lag upstream; check typst --version)
winget install Typst.Typst                 # Windows (then confirm typst is on PATH, for example with where typst)
typst --version                            # all OSes: confirms the binary is found
```

Without a system binary, the first resume compile downloads font assets over
the network (WASM fallback); fully offline machines must install the binary.
Distribution posture is clone-only: `package.json` is `private: true` (no
registry publishing, no installable binary) — you run the tool from a git
clone with Node only. CI (`.github/workflows/ci.yml`) is the public gate;
`npm run setupHooks` is an optional local pre-commit gate for contributors.

**Env:** no keys needed and no `.env` copy step. The six default adapters are
free scrapes; `.env.example` documents only the optional `WEJOBSEARCHDATAROOT`
relocation key, and no code reads API tokens from `.env` — skip it unless you
relocate the data root via the environment instead of `--dataRoot`.

**Full bootstrap in working order (four steps):** install Typst for your OS above, then run:

```bash
npm install          # use Node 26.5.0 from .nvmrc (minimum >= 24)
npm run setup        # health check; works before or after build
npm run build        # compiles src/ -> dist/
```

Verify with `typst --version` and `npm run setup` before registering the MCP server.

**WASM versus binary:** the system `typst` binary on `PATH` is preferred. Without it the WASM fallback compiles instead, but the first WASM compile needs a one-time CDN font fetch; fully offline machines must install the binary (see *Resume / WASM / Typst / font behavior*).

Then register/host the MCP server for your agent host:

- **OpenCode**: already wired — `opencode.json` registers
  `node dist/mcp/jobSearchServer.js` as a local stdio server. Just open the
  repo.
- **Other MCP-capable hosts** (Claude Code, Cursor, and similar): register the
  same stdio command in your host's MCP configuration, pointing at this repo:
  `node dist/mcp/jobSearchServer.js`.
- **Hosts that read repo config files** (Claude Code's `.claude/commands/`,
  Cursor's `.cursor/rules/`, Windsurf's `.windsurfrules`, OpenCode's
  `AGENTS.md`): these are already present and point the agent at the SDD and the
  tool layer.

That is the entire setup. `npm run setupHooks` and the interactive `init`
wizard are developer conveniences, not part of the user bootstrap.

## Optional developer interface

Everything in this section is for developers and scripters. None of it is
required to use the skill. The CLI is a convenience interface for local
scripting and development, not the user experience. Build first, then run
`node dist/cli/jobSearchCore.js <command> [options]`. Running the CLI with **no
subcommand** (or `--help` / `-h`) prints an available help menu and does
nothing else. Commands are independent: none chains into another capability.

| Command | What it does |
|---|---|
| `init` | Interactive guided setup wizard (writes the canonical-root real profile files; seeds the working `resumeVariants.yaml` on first run). Developer fallback — the agent-first profile tools are the normal path. |
| `search --keywords "..." [--location "..."]` | Scrape all six sources, dedup the batch and against history, evaluate each unique posting, persist `evaluated`, and render both fixed result tables. |
| `evaluate --jobUrl URL` | Fetch one posting, evaluate, dedup-check against history, persist, and render the matching table. |
| `generate --company NAME --role TITLE [--variant NAME]` | Tailor a 1-page Typst resume (auto-selects variant from triggers, or accepts an explicit `--variant`). |
| `draftCoverLetter --company NAME --role TITLE [--postingRequirements "A, B"]` | Draft a role-specific cover letter grounded in the profile only. |
| `draftOutreach --contactId ID --company NAME --role TITLE [--platform linkedin\|email]` | Draft an outreach message; writes `applications/<company><role>/outreachMessage.md`, sends nothing. |
| `digest` | Run every saved search, evaluate, and render both fixed tables. |
| `previewResume` | Render a 1-page resume preview from the profile (no target role). |
| `show --company NAME --role TITLE` | Show stored detail for one evaluated posting. |
| `review --company NAME --role TITLE` | Review one posting with an explicit next-action menu. |
| `updateStatus --company NAME --role TITLE --status interviewing\|offer\|rejected` | Record a status transition in application history. |
| `reviewQueue` | List postings flagged `manualReview` awaiting a human decision. |
| `report [--format table\|json]` | Print the funnel summary (fit counts, status counts, referral vs cold conversion, manual-review backlog, overdue follow-ups, recent searches). |
| `addContact --name NAME --company NAME [--relationship TYPE]` | Log or update a networking contact in the canonical `networkingContacts.json`. |
| `exportData --archivePath PATH` | Back up the canonical data root to a gzip tarball. |
| `importData --archivePath PATH` | Restore a backup into a fresh canonical root; refuses to overwrite existing profile files. |
| `validate [--dataRoot PATH]` | Validate `jobPreferences.yaml` and `resumeVariants.yaml` against their schemas (fail-fast, writes nothing). |
| `parsePdf --filePath PATH` | Parse a local PDF resume or job description (read-only text extraction). |
| `confirmApp --company NAME --role TITLE [--notes TEXT]` | Confirm a submission and update history (manual portal submission first; the only path into `appliedConfirmed`). |

Examples:

```bash
node dist/cli/jobSearchCore.js search --keywords "senior product manager" --location "Remote"
node dist/cli/jobSearchCore.js generate --company "AcmeCorp" --role "SeniorEngineer" --variant usDetailedResume
node dist/cli/jobSearchCore.js report --format json
```

**CLI status of `parsePdf` and `confirmApp`:** the help menu lists `parsePdf` and `confirmApp`, and both CLI subcommands **are wired** in the current baseline — `runParsePdfCommand` and `runConfirmAppCommand` are dispatched in `dispatchCli` in `jobSearchCore.ts`. The equivalent MCP capabilities (`parsePdfDocument`, `confirmApplicationSubmission`) are also available.

Use each command's `--help` flag for the exact option set.

### Development and verification

```bash
npm run lint          # tsc --noEmit (type-check only)
npm run build         # tsc (emit to dist/)
npm test              # vitest run (935 tests across 59 files in this baseline)
npm run namingLinter  # strict camelCase/PascalCase/zero-underscore scan, no build needed
npm run setupHooks    # per-clone: git config core.hooksPath .githooks
```

Tests use **fully synthetic data written to OS temp directories** and the
committed `fixtures/` directory — never real profile data, and **never the live
network**: the end-to-end pipeline tests stub `globalThis.fetch` with
deterministic responses so the six adapters are exercised without contacting
any job board. Only the profile tools (with your explicit confirmation) create
real canonical-root profile files (under `~/Documents/weJobSearch/<username>/`).
`.reference/`, `dist/`, `node_modules/`, and `.env` are gitignored and never
committed.

### Troubleshooting

- **Missing or malformed profile files**: no confirmed profile exists yet, or
  the canonical `jobPreferences.yaml` / `masterProfile.md` are absent or contain
  placeholders (`REPLACE_ME`, `Lorem ipsum`). `generate` refuses to build from
  an empty profile; `evaluate`/`search` fail with a clear message. Set up the
  profile agent-first (see Quick Start steps 4–7) or use the `init` wizard as a
  developer fallback.
- **MCP tools not visible in your host**: finish the *One-time technical
  bootstrap* (`npm install`, `npm run build`) and verify your host's MCP
  registration points at `node dist/mcp/jobSearchServer.js` in this repo.
- **Unsupported posting URLs**: `evaluate`/`evaluateJobPosting` only hand URLs
  to adapters that claim that domain; an unrecognized host produces an explicit
  `UnsupportedPostingUrlError` naming the supported sources, with no network
  attempt.
- **Source sites changing markup**: the adapters are free public scrapes and
  will break when boards change their layout. Broken adapters fail per-source
  (reported in `search` output) and get patched; there is no commercial
  fallback.
- **403/429 responses and the rate limiter**: see *Scraping, robots, ToS,
  login, CAPTCHA, and rate-limit limitations* below.
- **Typst/font-asset availability**: see *Resume / WASM / Typst / font
  behavior* below.
- **Stale setup checkpoint**: an in-progress `setupState.json` older than 7 days is treated as abandoned and ignored; resume setup to recreate it.
- **Node version mismatch**: install 26.5.0 from `.nvmrc` (`nvm use`); `engines >= 24` is the supported floor, not the install target.

## Data and document locations

Everything real lives under **one canonical data root** outside the Git work
tree: `~/Documents/weJobSearch/<username>/` (per
`src/utils/canonicalDataRoot.ts`). Because that root is outside the repository,
none of it can ever be committed.

| Path (under the canonical data root, unless noted) | Purpose | Git status |
|---|---|---|
| `masterProfile.md` | Your ground-truth resume facts; the source for all generated documents. | Outside the repo (real); blank `.example` committed |
| `jobPreferences.yaml` | Salary, clearance, work auth, non-negotiables, preferred locations. | Outside the repo (real); blank `.example` committed |
| `screeningAnswers.json` | Pre-filled portal screening answers. | Outside the repo (real); blank `.example` committed |
| `networkingContacts.json` | Networking/referral tracker. | Outside the repo (real); blank `.example` committed |
| `resumeVariants.yaml` | Working resume variant → template trigger mapping. | Outside the repo (working); structure seed committed at `profile/resumeVariants.yaml` |
| `documents/` | **Private source documents**: legacy resumes, saved job postings. Keep source documents (PDF, Word, Markdown, text) here or in any private local directory, then give the local path to your agent. | Outside the repo |
| `applications/applicationHistory.json` | Permanent evaluation/application history. | Outside the repo |
| `searchHistory.json` | Recent search queries with timestamps and result counts (reviewable/repeatable). | Outside the repo |
| `setupState.json` | In-progress profile-setup checkpoint for session resumption (created lazily, cleared on completion). | Outside the repo |
| `applications/<company><role>/` | Per-role output: `tailoredResume.{typ,pdf}`, `coverLetter.md`, `outreachMessage.md`. | Outside the repo |
| `profile/` (in the repo) | Only blank `.example` templates plus the `resumeVariants.yaml` structure seed. | Committed |
| `fixtures/` | Synthetic sample data used by the tests and dry-run pipeline. | Committed |

Rules you must respect:

- **Real profile data, documents, and outputs stay under the canonical root** —
  outside the Git work tree. The repository's `profile/` directory contains only
  templates/structure seeds.
- **Never commit or upload real resumes, applications, contacts, credentials,
  or profile data.** All of it is private to your machine.
- **Working with source PDFs**: you may keep source PDFs in the canonical
  `documents/` directory or in another private local directory; either way you
  provide the local path to your agent and the file is parsed read-only.

### Relocating the data root

The default root above is only the fallback. Relocation is CLI-plus-env-only:

- `--dataRoot PATH` on any command uses that root for the command.
- `WEJOBSEARCHDATAROOT` set in the environment moves every command (including
  MCP tools, which honor the environment per handler) to that root.
- Without either, the platform default applies: the OS documents directory
  (Windows known-folder `Documents` with OneDrive awareness), `$XDG_DATA_HOME`
  when set on Linux/macOS, otherwise `~/Documents` — always suffixed with
  `weJobSearch/<username>/`.
- `jobPreferences.yaml` `directories.dataRoot` is not a relocation mechanism:
  setting it fails validation loudly instead of being silently ignored.

## Configuration and path resolution

Two files configure the engine (both validated by the `validate` command,
which fails fast with per-file verdicts):

- `jobPreferences.yaml` — compensation floor/target, clearance, work
  authorization, preferred locations, non-negotiables, target roles, and the
  `directories` block (`outputRoot`, `resumeVariantsFile`; `dataRoot` is
  rejected, see above).
- `resumeVariants.yaml` — variant name → template + trigger rules
  (structure only, no personal data).

Path resolution precedence, everywhere: explicit CLI value, then
`WEJOBSEARCHDATAROOT`, then the platform canonical default. The environment
is read in exactly one module (`src/utils/canonicalDataRoot.ts`); every other
module resolves through its helpers so the precedence lives in one place.

## Documents workflow

Keep your source documents (legacy resumes, saved job postings, notes) in the
canonical `documents/` directory
(`~/Documents/weJobSearch/<username>/documents/`) or any other private local
directory. To ingest several at once, ask your agent to call the
`ingestDocuments` MCP tool with that directory path: it scans the directory for
supported files — `.pdf` (via the PDF parser), `.docx` (via the Word parser),
`.md`, and `.txt` (via the plain-text reader) — and returns a per-file summary
(file name, type, byte size, page count for PDFs or character count for text,
and cleaned extracted text). Ingestion is strictly read-only: it never writes,
renames, or deletes anything in the source directory; hidden files
(dot-prefixed), unsupported extensions, and subdirectories are skipped. An
empty directory returns an empty result; a missing directory errors with the
path named.

## Host neutrality

The skill instructions are portable and host-neutral:

- **OpenCode is one example, not a requirement.** The instructions, SDD, and
  tool layer work identically in Claude, Codex, Cursor, Windsurf, Aider, Copilot
  CLI, and similar hosts.
- **MCP registration differs by host.** OpenCode reads `opencode.json` and
  auto-registers the local server after a build; other hosts have their own
  MCP configuration and you register the same stdio command
  (`node dist/mcp/jobSearchServer.js`) there.
- **Not every host supports identical automatic discovery.** Repo-config hosts
  (Cursor, Windsurf, Claude Code) read their respective generated files; a host
  without MCP support falls back to the CLI via the agent-driven command layer.
- **Integration layers stay separate:** `AGENTS.md`, `docs/weJobSearch-SDD.md`,
  `opencode.json`, `.claude/commands/`, `.cursor/rules/`, and `.windsurfrules`
  are each their own layer pointing at the same source of truth — do not merge
  or inline them.

## MCP / tool-bridge reference

The MCP server lives at `src/mcp/jobSearchServer.ts` and exposes the engine as
native tools over stdio. Register it in your MCP-capable host as a stdio server
running:

```bash
node dist/mcp/jobSearchServer.js
```

(`opencode.json` already wires exactly this for OpenCode as a local stdio
server.) For hosts with their own MCP configuration, register the same command
plus the path to your local repo. Run `npm run build` if `dist/` is missing.

The server registers **nineteen** tools:

1. `getUserProfile` — read-only inspection of the saved profile; reports per-file
   configured state, what still needs attention, first-run onboarding steps when
   nothing is configured, and the resumable setup step when a setup was
   interrupted.
2. `initializeUserProfile` — first-time profile creation from a structured
   payload (jobPreferences + screeningAnswers + masterProfile). Writes the
   gitignored real files locally and **requires explicit user confirmation**
   before anything is written; refuses to overwrite an existing profile.
3. `updateUserProfile` — partial profile updates. Only the supplied sections are
   merged; all other fields and files are preserved. Also confirmation-gated.
4. `parsePdfDocument` — parse a local PDF to structured sections and cleaned
   text. Read-only: never writes.
5. `ingestDocuments` — scan a directory of source documents (`.pdf`, `.docx`,
   `.md`, `.txt`) and return a per-file summary with cleaned extracted text.
   Strictly read-only; hidden files, unsupported extensions, and subdirectories
   are skipped.
6. `evaluateJobPosting` — fetch one posting by URL and evaluate (idempotent).
7. `searchJobPostings` — scrape all adapters, dedup, evaluate, persist, record
   search history, and return both fixed result tables (Active: 7 columns,
   Excluded: 6 columns). Location auto-fills from `preferredLocations` when
   omitted.
8. `searchByProfile` — one call searches every target role using your skills and
   preferred locations, deduped, both fixed tables rendered.
9. `suggestRoles` — deterministic role-title suggestions derived from the
   profile; returns suggestions and stops (never auto-runs a search).
10. `generateTailoredApplication` — resume generation only (Typst → PDF + ATS check).
11. `draftCoverLetter` — draft a role-specific cover letter grounded in the profile only; writes a local Markdown draft, never sends.
12. `confirmApplicationSubmission` — **local-only** manual confirmation that
    writes `appliedConfirmed` to history after your explicit action.
13. `getReviewQueue` — list `manualReview` postings awaiting your decision.
14. `getFunnelReport` — current funnel summary across history, contacts, and
    recent searches.
15. `getPostingDetail` — stored detail for one evaluated posting (description,
    fit score/status, posting facts, salary, sources, status history).
16. `logNetworkingContact` — record a contact; never contacts that person.
17. `draftOutreachMessage` — draft a local outreach Markdown draft; never sends.
18. `analyzeApplicationPatterns` — deterministic learning loop over application
    history: skill/domain signals, role-title clusters, resume-variant
    effectiveness, and preference drift. Suggestions only; nothing is written.
19. `runSavedSearches` — run every saved search, dedup, evaluate, persist, and
    render both fixed tables.

The profile tools delegate to `src/utils/profileService.ts`, which makes
first-time setup completable entirely inside an agentic host (the interactive
`init` wizard remains an optional developer fallback).

MCP handlers call the same core functions the CLI calls
(`evaluateJobPosting`, `searchJobPostings`, `generateResume`, etc. from
`src/cli/jobSearchCore.ts`), so the fixed table contract, dedup-before-evaluate,
and idempotency rules are preserved. No MCP tool chains operations
automatically — the host surfaces the capability and you choose.

## Fixed result-table contract

Every batch display of scraped, evaluated postings renders **two** fixed
tables. The columns, order, and naming below are non-negotiable and are also
asserted verbatim by tests.

**Active Results** (postings with `manualReview` or `strongFit`):

Columns in order: **Sr. No., Job Title, Organization, Brief, Fit Score,
Justification, Link**.

| Sr. No. | Job Title | Organization | Brief | Fit Score | Justification | Link |
|---|---|---|---|---|---|---|

**Excluded Results** (postings with `hardRejected` or `weakFit`), rendered
separately so a promising role is never buried among rejections:

Columns in order: **Sr. No., Job Title, Organization, Fit Score, Justification,
Link**.

| Sr. No. | Job Title | Organization | Fit Score | Justification | Link |
|---|---|---|---|---|---|

`Brief` is a deterministic extractive summary produced by
`src/generators/briefGenerator.ts`: the first meaningful posting sentence(s),
truncated to a fixed max length (150 chars) with an ellipsis. It is compressed
from the posting text only — it never claims anything not stated in the posting
and never uses a live LLM call (the CLI has no LLM integration). Sr. No. is
sequential per batch, and because deduplication runs before evaluation, a role
found on multiple boards appears exactly once.

## Supported job sources

The six sources are free, public, and unauthenticated — no paid API, no paid
scraping service, no login, no cookies, no credentials, no CAPTCHA solving, no
bot-detection bypass. One of them (hiring.cafe) is currently Cloudflare-blocked
from some networks; see its row for the visible failure behavior:

| Source | Adapter module | Posture |
|---|---|---|
| LinkedIn | `src/scrapers/adapters/linkedinAdapter.ts` | **Accepted risk.** LinkedIn's ToS prohibits automated access; we proceed anyway, deliberately and with your explicit sign-off, using only public unauthenticated search/detail endpoints. Conservative rate limiting. |
| hiring.cafe | `src/scrapers/adapters/hiringCafeAdapter.ts` | Low-risk free scrape; only public listing pages; robots.txt respected. **Currently unavailable from networks where Cloudflare returns HTTP 403 on every public path (observed 2026-10 from a residential connection).** The adapter fails visibly as `hiring.cafe is unavailable (...)`, naming the source in the per-source summary, and never attempts to bypass the block. Expect reduced coverage until Cloudflare access is restored. |
| Wellfound | `src/scrapers/adapters/wellfoundAdapter.ts` | **Accepted risk.** Wellfound's Talent General terms exclude scraping; we use only public unauthenticated `/role/` pages (first page). |
| Welcome to the Jungle | `src/scrapers/adapters/welcomeToTheJungleAdapter.ts` | **Accepted risk.** WTTJ CGUs prohibit automated extraction. We use robots-allowed sitemaps and server-rendered detail pages only. WTTJ is EU/city-oriented: a remote/work-mode or non-European location returns zero results without fetching, because those terms cannot appear in its city-based job slugs. |
| Built In | `src/scrapers/adapters/builtInAdapter.ts` | **Accepted risk.** Built In's Community ToU prohibit bots/scraping; we stay on robots-sitemap-listed paths. |
| FlexJobs | `src/scrapers/adapters/flexJobsAdapter.ts` | **Accepted risk.** FlexJobs' ToS prohibit bots and scraping. This adapter is the most conservative (4-5s delay), stays on the public `/remote-jobs` listing page, and may only expose ~200-character *teaser* cards because full descriptions and applying are paywalled. |

## Scraping, robots, ToS, login, CAPTCHA, and rate-limit limitations

**Read this section before running `search` or `evaluate`.**

Scraping is subject to each job board's Terms of Service, its robots rules,
applicable law, and your account/network policies. Legal responsibility is
yours alone. **This documentation is not legal advice.** weJobSearch is a local
concern, and it does rate-limit honestly and never tries to defeat access
controls, but it cannot make a scrape legal.

Points to be deliberate about, not softened:

- LinkedIn and FlexJobs are scraped **despite** ToS language prohibiting it.
  That is a **deliberate, user-accepted risk** — not an oversight.
- LinkedIn uses **only** unauthenticated public endpoints; FlexJobs uses only
  the public unauthenticated listing surface (which may be teaser-only).
- hiring.cafe, Wellfound, Welcome to the Jungle and Built In must use only the
  currently implemented public routes and robots-respecting behavior.
- The shared rate limiter (`src/scrapers/rateLimiter.ts`) enforces a jittered
  minimum delay per source (default 2-5s; LinkedIn and FlexJobs use the most
  conservative 4-5s range), respects `robots.txt` where applicable, applies
  exponential backoff on HTTP 429/403/5xx and timeouts (permanent failures
  are counted without backoff), and latches a **TTL circuit breaker** after
  too many consecutive failures rather than hammering the source. The latch
  throws `RateLimitHardStopError` for that source only until the TTL elapses;
  other sources continue.
- Source failures are handled by the shared rate limiter and do not justify
  "bypassing" the controls. If a board blocks you, stop changing the request
  pattern; drop that board or respect its boundary.
- The adapters are free public scrapes and are **brittle against site markup
  changes**; they get patched when they break and have no commercial fallback.
- No paid API or paid scraping service is used by this baseline.

## Salary and missing-data behavior

- **Unknown or non-comparable salary**: when no salary can be parsed, or the
  currency/period is not comparable to your configured base, the compensation
  check is `unknown` — the posting is routed to `manualReview`, never silently
  accepted or rejected.
- **FlexJobs teaser-only limitations**: public content is ~200-character teaser
  cards; `hasFullDescription=false` routes such postings to `manualReview`
  rather than a strong rejection because the missing-requirement deduction
  cannot be trusted without a full description.
- **Manual review caused by incomplete descriptions**: `manualReview`
  intentionally catches: `hasFullDescription=false` postings, custom
  non-negotiables that cannot be interpreted automatically, and unparsable
  salaries. These are decisions for you, not the evaluator.
- Hard-rejection precedence: a posting that trips a `nonNegotiables` rule is
  `hardRejected` regardless of salary-unknown routing.

## Resume / WASM / Typst / font behavior

- **1-page enforcement**: `src/utils/typstCompiler.ts` runs a compile loop
  (`compileWithinPageLimit`) with text-density reduction until the PDF is
  exactly 1 page, or fails after 5 attempts.
- **WASM vs system binary**: a `typst` binary on `PATH` is preferred; otherwise
  the WASM engine compiles via `@myriaddreamin/typst.ts`. Without a `typst`
  binary, the first WASM compile fetches font assets from a CDN; if the fetch
  fails (offline, blocked CDN) compilation fails with the Typst diagnostics.
  Install a system `typst` (and ensure it is on `PATH`) to compile without
  network.
- **ATS verification**: `src/utils/atsChecker.ts` re-extracts the compiled
  PDF's plain text and requires section headers `Experience`, `Education`,
  `Skills` in reading order plus every claimable posting keyword to be present
  in extractable text.
- **EEO filter**: the resume mapping layer only carries name, city/state,
  email, phone, LinkedIn, portfolio, summary, skills, experience, education,
  and certifications; photo, gender, age, marital status, birth date, and
  street address never make it into a resume, and the templates reject them
  structurally as a backstop.
- **Zero hallucination**: no skill, tool, or metric appears in a generated
  resume/letter/outreach unless it is traceable to `masterProfile.md`.

## Privacy and Git safety

- **Real profile files live outside the repo**: `masterProfile.md`,
  `jobPreferences.yaml`, `screeningAnswers.json`, `networkingContacts.json`, and
  the working `resumeVariants.yaml` all live under the canonical data root
  (`~/Documents/weJobSearch/<username>/`), outside the git work tree, so they
  can never be committed. Only you, with explicit confirmation, writes them via
  the profile tools (`initializeUserProfile` / `updateUserProfile`).
- **Source documents and applications stay local**: the canonical `documents/`
  and `applications/` trees (history plus per-role output) never leave the
  machine unless you copy them yourself; `.env` is gitignored. `dist/`,
  `node_modules/`, and `.reference/` (a throwaway reference clone, SDD §1.3) are
  also gitignored.
- **No personal information belongs in committed code**: sources, fixtures,
  `.example` templates, generated agent configs, and these docs must remain
  generic. If you fork and publish, keep `email@example.com` and placeholder
  values. Verify before pushing with `git status`.
- **The user is responsible for reviewing every generated artifact**: resumes,
  letters, outreach drafts, screening answers, and everything submitted to an
  employer.
- The system **never sends outreach and never submits applications**. Tools
  draft and track; a human reads, edits, and submits.

## Security reporting

- **How to report**: email `security@example.com` with a description of the
  issue and steps to reproduce. Do not file public issues for suspected
  vulnerabilities. Do not include real resumes, credentials, or other
  personal data in a report.
- **Placeholders**: `security@example.com` (and the `email@example.com`
  placeholders above) are not real addresses. If you publish a fork,
  replace them with your own private address.
- **Support limits**: best effort on pinned versions only, with no SLA; this
  is a personal job-search tool, not a maintained service.