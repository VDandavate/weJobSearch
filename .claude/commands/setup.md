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

First-run setup: run the `setup` command. Hosts without command files read
`.claude/commands/setup.md` and follow it.

Follow the numbered build sequence in AGENTS.md; do not skip ahead. Test only
against fixtures/, never against real profile/ or canonical-root data files.


## Command: setup

First-run onboarding and configuration. Work through these steps in order; do
not skip ahead, and do not chain into any other capability.

1. Inspect. Call getUserProfile. Print the resolved data root with one
   plain-language line: "Your job search data lives here. It was chosen
   automatically from your system account, so there is nothing to configure."
   Then show this file map: masterProfile.md (profile), jobPreferences.yaml
   (compensation, clearance, non-negotiables, locations, target roles, radius),
   screeningAnswers.json (portal answers), networkingContacts.json (contacts
   and referrals), resumeVariants.yaml (resume variants), savedSearches.json
   and searchHistory.json (search records),
   applications/applicationHistory.json (application tracking), documents/
   (source documents), previews/ and templates/. If every profile file is
   already configured, show what is set and offer section-by-section updates
   instead of starting over. Do not mention relocation mechanics by default.
   Only if the user asks about moving the data, explain that the whole root
   can be relocated with the --dataRoot flag or the WEJOBSEARCHDATAROOT
   environment variable, that per-file relocation through the profile tools
   is unsupported by design, and that this should happen before any files are
   written. Never move existing data.

2. Documents. Before staging anything, explain in one plain-language line that
   the tool reads only inside its data root, so it will copy the files into
   the root's documents/ directory and the originals are left untouched. Ask
   which folder or folders hold the user's resumes. Call ingestDocuments once
   per folder (top-level scan only). If a folder is outside the data root, the
   confinement error names the documents/ directory to copy into; stage the
   files there and retry rather than reading outside the root. Name every
   unreadable, empty, or image-only file. Ask for another file or for the
   details to be typed. Never invent content for a file you could not read. If
   the user has no documents, run the rest of this flow as an interview.

3. Profile draft. Propose masterProfile.md sections: contact, work
   authorization, summary, skills, experience, education, certifications. Show
   the draft and let the user correct each section. linkedIn and portfolio may
   be left empty.

4. Target roles. Ask which role titles to search for, using the reviewed draft
   as context. The user may type any list.

5. Locations. Ask for preferred locations as free text (Remote, Hybrid East
   Coast US, a city, or a ZIP code inside the location string). If the user
   names a metro, offer an optional radius in miles. The radius is applied only
   to LinkedIn. hiring.cafe uses path slugs, Wellfound has no radius parameter,
   Built In's allowed listing has none, Welcome to the Jungle uses sitemaps,
   and FlexJobs ignores query parameters. State this plainly instead of
   implying a global distance filter.

6. Clearance, then compensation, then work authorization. Clearance status is
   none, interim, active, or expired; level is publicTrust, secret, topSecret,
   tsSci, or null; ask eligibility to obtain and whether sponsorship is needed.
   Ask the compensation floor and target in the user's currency, and whether
   bonus and equity count toward the floor.

7. Non-negotiables. Propose noRelocation, noStaffingAgencies,
   clearanceMismatch, and belowMinSalary as reject-intent rules. Offer
   remoteOnly (wording that names manualReview) only if noRelocation is
   declined, never both. Every rule can be switched off, and an empty list is
   valid.

8. Screening answers. Derive work authorization and compensation from the
   earlier answers; never ask the same question twice. Ask only the notice
   period, per-skill years for skills present in the profile, and sponsorship
   type when sponsorship is required.

9. Preview and confirm. Show every file that will be written, and a diff for
   any file that already exists. Do not write, create, or modify any profile
   file before the user confirms the preview. On confirmation, call
   initializeUserProfile with confirmed: true on a first run, or updateUserProfile
   with only the changed sections on a re-run. Never write a real profile file
   into the repository.

10. Health check. Run the setup check (npm run setup) and report Node, Typst,
    and configuration status. A configuration schema error stops here and is
    reported verbatim. A missing Typst binary is a warning only.

11. First search. Never start the search on your own; offer it and wait for an
    explicit yes. On yes, call searchByProfile when target roles exist;
    otherwise ask for keywords and call searchJobPostings. Apply no filters
    unless the user asks. After the results, offer to save the search, defaulting
    to no.

12. Stop. Print the closing message and the command menu. The closing message
    must contain one plain-language line for each of these, in this order:
    (1) profile-based search (searchByProfile) is the primary next step when
    target roles exist; otherwise keyword search (searchJobPostings) is the
    alternative; (2) a saved search is a remembered keyword and location
    search the agent can re-run or save on request; (3) evaluating a posting
    URL scores it against the profile and logs it to application history;
    (4) logging a networking contact tracks referrals and follow-ups that the
    funnel report surfaces; (5) nothing chains automatically, so each step is
    requested explicitly. Do not generate a resume, cover letter, or outreach
    message, and do not confirm an application.