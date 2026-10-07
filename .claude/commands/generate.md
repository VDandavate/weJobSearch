# WeJobSearch agent guidelines

Read the full specification in `docs/weJobSearch-SDD.md` and the execution
checklist in `AGENTS.md` at the start of every fresh session. Do not rely on
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
against fixtures/, never against real profile/ or canonical-root data files.


## Command: generate

Generate a tailored 1-page resume (Typst to PDF) for one target role, grounded in masterProfile.md with EEO enforcement and ATS verification.

Run exactly this command; do not auto-chain anything else:

```bash
node dist/cli/jobSearchCore.js generate --company "AcmeCorp" --role "SeniorEngineer" [--variant usDetailedResume]
```

The command may read files and write only its documented output. Report tool
errors verbatim; never expose secrets or personal profile content.