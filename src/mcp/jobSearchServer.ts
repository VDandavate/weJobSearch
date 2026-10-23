import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { screeningAnswersSchema } from '../cli/initWizard';
import {
  confirmApplicationSubmission,
  draftCoverLetterForRole,
  draftOutreachMessage,
  evaluateJobPosting,
  generateForRole,
  getApplicationPatternSuggestions,
  getFunnelReport,
  getPostingDetail,
  getReviewQueue,
  ingestDocuments,
  initializeUserProfile,
  jobPreferencesSchema,
  logNetworkingContact,
  masterProfileInputSchema,
  parsePdfDocument,
  readUserProfile,
  runSavedSearchesDigest,
  searchByProfile,
  searchJobPostings,
  suggestRolesForProfile,
  updateUserProfile,
  type ProfileWriteResult,
} from '../cli/jobSearchCore';
import type { JobSpyAdapterRegistry } from '../scrapers/jobSpyAdapter';
import { packageVersion } from '../scrapers/userAgent';

// MCP server exposing the job-search engine as native tools (SDD Section 4.2,
// Requirement 9). Every handler delegates to the same core functions that back
// the CLI commands; nothing here re-implements evaluation, deduplication,
// reporting, or generation. Capabilities stay firewalled per SDD Section 1.5:
// search never auto-evaluates into generation, confirmApplicationSubmission is
// a local-only status write after the human submits on the portal, and
// draftOutreachMessage only writes a local Markdown draft - it never sends.
//
// Argument validation and errors: the SDK validates required args against the
// inputSchema below; a missing required argument surfaces as a typed tool
// error. Handler-level failures (missing file, malformed config, unsupported
// URL, unknown contact) throw Error, which the SDK converts to an isError tool
// result carrying the message. Messages never include profile contents.

export interface McpServerDependencies {
  profilePath?: string;
  preferencesPath?: string;
  screeningAnswersPath?: string;
  historyPath?: string;
  contactsPath?: string;
  savedSearchesPath?: string;
  searchHistoryPath?: string;
  // Whole data-root relocation (U44): when set, every tool that resolves
  // paths from the data root (history, contacts, saved searches, search
  // history, profile, preferences, generated output) reads and writes under
  // this root instead of the env/canonical default.
  dataRoot?: string;
  registry?: JobSpyAdapterRegistry;
}

export const serverInfo = {
  name: 'wejobsearch-mcp',
  version: packageVersion(),
};

export function createMcpServer(dependencies: McpServerDependencies = {}): McpServer {
  const server = new McpServer(serverInfo);

  server.registerTool(
    'parsePdfDocument',
    {
      description:
        'Parse a PDF file and return structured sections (contact, summary, experience, education, skills) plus cleaned extracted text and page count.',
      inputSchema: {
        filePath: z.string().describe('Absolute or project-relative path to the PDF file to parse.'),
      },
    },
    async (args) => {
      const parsed = await parsePdfDocument(args.filePath, dependencies.dataRoot);
      const text = parsed.text;
      return {
        content: [
          {
            type: 'text',
            text: `Pages: ${parsed.pageCount}\nCharacters: ${text.length}`,
          },
        ],
        structuredContent: {
          pageCount: parsed.pageCount,
          extractedText: text,
        },
      };
    },
  );

  server.registerTool(
    'ingestDocuments',
    {
      description:
        'Scan a directory for supported source documents (PDF via pdfParser, Markdown .md and plain-text .txt via the text reader), parse each one read-only, and return a structured per-file summary (file name, relative path, type, byte size, page count for PDFs or character count for text, and cleaned extracted text). Never writes or modifies any file; hidden files (dot-prefixed), unsupported extensions, and subdirectories are skipped silently. An empty directory returns an empty result.',
      inputSchema: {
        dirPath: z.string().describe('Absolute path to the directory to scan for documents.'),
      },
    },
    async (args) => {
      const summaries = await ingestDocuments(args.dirPath, dependencies.dataRoot);
      const text =
        summaries.length === 0
          ? 'No supported documents found in the directory.'
          : JSON.stringify(summaries, null, 2);
      return {
        content: [{ type: 'text', text }],
        structuredContent: {
          documentCount: summaries.length,
          summaries,
        },
      };
    },
  );

  server.registerTool(
    'getUserProfile',
    {
      description:
        'Inspect the saved local profile (masterProfile.md, jobPreferences.yaml, screeningAnswers.json, networkingContacts.json under the canonical data root) and report whether it is fully configured for the search/generate pipeline. Read-only: never writes or creates any file. Returns structured profile sections plus per-file configured flags and the list of incomplete items.',
      inputSchema: {},
    },
    async () => {
      const state = await readUserProfile({
        profilePath: dependencies.profilePath,
        preferencesPath: dependencies.preferencesPath,
        screeningAnswersPath: dependencies.screeningAnswersPath,
        contactsPath: dependencies.contactsPath,
        dataRoot: dependencies.dataRoot,
      });
      const summary = state.configured
        ? 'Profile is fully configured.'
        : `Profile is not fully configured. ${state.incompleteReasons.length} item(s) need attention.`;
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                configured: state.configured,
                incompleteReasons: state.incompleteReasons,
                onboardingSteps: state.onboardingSteps,
              },
              null,
              2,
            ),
          },
        ],
        structuredContent: {
          configured: state.configured,
          incompleteReasons: state.incompleteReasons,
          onboardingSteps: state.onboardingSteps,
          files: state.files,
          masterProfile: state.masterProfile,
          jobPreferences: state.jobPreferences,
          screeningAnswers: state.screeningAnswers,
          networkingContacts: state.networkingContacts,
        },
      };
    },
  );

  server.registerTool(
    'suggestRoles',
    {
      description:
        'Suggest role titles from the saved profile: maps profile skills, years of experience, and domains through a deterministic role-title taxonomy and returns the list. Read-only; never runs a search, evaluation, or generation, and never writes anything.',
      inputSchema: {},
    },
    async () => {
      // Phase E thin bridge: delegates to the core seam in jobSearchCore.ts
      // instead of composing profile loading plus capabilities plus suggestRoles.
      const suggestions = await suggestRolesForProfile({
        profilePath: dependencies.profilePath,
        dataRoot: dependencies.dataRoot,
      });
      const text =
        suggestions.length > 0
          ? JSON.stringify(suggestions, null, 2)
          : 'No role suggestions could be derived from the saved profile.';
      return {
        content: [{ type: 'text', text }],
        structuredContent: {
          suggestionCount: suggestions.length,
          suggestions,
        },
      };
    },
  );

  server.registerTool(
    'initializeUserProfile',
    {
      description:
        'Create the local profile for the first time from a full structured payload (jobPreferences, screeningAnswers, masterProfile). Requires explicit user confirmation (confirmed: true) before any file is written - the tool writes NOTHING without it. Refuses to run if a real profile file already exists (no accidental overwrite); use updateUserProfile for changes. networkingContacts.json is created empty. This is a local write only; nothing is sent anywhere.',
      inputSchema: {
        jobPreferences: jobPreferencesSchema,
        screeningAnswers: screeningAnswersSchema,
        masterProfile: masterProfileInputSchema,
        confirmed: z
          .boolean()
          .describe('Must be true, set by the user, to authorize the write. Defaults to false so no write can happen by accident.'),
      },
    },
    async (args) => {
      const { confirmed, ...payload } = args;
      const result: ProfileWriteResult = await initializeUserProfile(payload, {
        confirmed,
        paths: {
          profilePath: dependencies.profilePath,
          preferencesPath: dependencies.preferencesPath,
          screeningAnswersPath: dependencies.screeningAnswersPath,
          contactsPath: dependencies.contactsPath,
          dataRoot: dependencies.dataRoot,
        },
      });
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              { filesWritten: result.filesWritten, summary: result.summary },
              null,
              2,
            ),
          },
        ],
        structuredContent: {
          filesWritten: result.filesWritten,
          filesUpdated: result.filesUpdated,
          sections: result.sections,
          summary: result.summary,
        },
      };
    },
  );

  server.registerTool(
    'updateUserProfile',
    {
      description:
        'Update specific sections of the saved local profile (jobPreferences, screeningAnswers, masterProfile) without touching anything else. Only the supplied sections are merged; all other fields and files are preserved. Requires explicit user confirmation (confirmed: true) before any file is written - the tool writes NOTHING without it. Local write only; nothing is sent anywhere.',
      inputSchema: {
        jobPreferences: jobPreferencesSchema.partial().strict().optional(),
        screeningAnswers: screeningAnswersSchema.partial().strict().optional(),
        masterProfile: masterProfileInputSchema.partial().strict().optional(),
        confirmed: z
          .boolean()
          .describe('Must be true, set by the user, to authorize the write. Defaults to false so no write can happen by accident.'),
      },
    },
    async (args) => {
      const { confirmed, ...payload } = args;
      const result: ProfileWriteResult = await updateUserProfile(payload, {
        confirmed,
        paths: {
          profilePath: dependencies.profilePath,
          preferencesPath: dependencies.preferencesPath,
          screeningAnswersPath: dependencies.screeningAnswersPath,
          contactsPath: dependencies.contactsPath,
          dataRoot: dependencies.dataRoot,
        },
      });
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              { filesUpdated: result.filesUpdated, summary: result.summary },
              null,
              2,
            ),
          },
        ],
        structuredContent: {
          filesWritten: result.filesWritten,
          filesUpdated: result.filesUpdated,
          sections: result.sections,
          summary: result.summary,
        },
      };
    },
  );

  server.registerTool(
    'evaluateJobPosting',
    {
      description:
        'Fetch one job posting by URL, evaluate fit against the saved profile and preferences (fitEvaluator), and log it to applicationHistory.json with status evaluated. Persistence is idempotent: a posting already in history is never re-logged as a duplicate. No auto-triggering of resume generation.',
      inputSchema: {
        jobUrl: z.string().describe('Direct job posting URL. Unsupported domains are rejected with a clear error.'),
      },
    },
    async (args) => {
      const outcome = await evaluateJobPosting(args.jobUrl, {
        registry: dependencies.registry,
        dataRoot: dependencies.dataRoot,
      });
      const entry = outcome.entry;
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                companyName: entry.posting.companyName,
                roleTitle: entry.posting.roleTitle,
                fitStatus: entry.assessment.fitStatus,
                fitScore: entry.assessment.fitScore,
                alreadyRecorded: outcome.alreadyRecorded,
                applicationId: outcome.record.applicationId,
              },
              null,
              2,
            ),
          },
        ],
        structuredContent: {
          companyName: entry.posting.companyName,
          roleTitle: entry.posting.roleTitle,
          jobUrl: entry.posting.jobUrl,
          fitStatus: entry.assessment.fitStatus,
          fitScore: entry.assessment.fitScore,
          brief: entry.brief,
          alreadyRecorded: outcome.alreadyRecorded,
          applicationId: outcome.record.applicationId,
          postingHash: outcome.record.postingHash,
        },
      };
    },
  );

  server.registerTool(
    'searchJobPostings',
    {
      description:
        'Scrape every registered adapter for keywords/location, dedup within the batch and against application history, evaluate each unique posting via fitEvaluator, and persist status evaluated. Returns BOTH fixed result tables defined by Requirement 2a: Active Results (7-column core) and Excluded Results (6-column core). No resume or cover letter is generated.',
      inputSchema: {
        keywords: z
          .string()
          .describe('Keyword phrase to search for (required; e.g. "senior software engineer").'),
        location: z
          .string()
          .optional()
          .describe('Location or work-mode term (optional). Omit or pass empty string for no location context.'),
        remoteOnly: z
          .boolean()
          .optional()
          .describe('Show only postings classified remote (optional; applied after evaluation, before display).'),
        minFit: z
          .number()
          .optional()
          .describe('Show only postings with fitScore >= this value (optional; applied after evaluation, before display).'),
        minSalary: z
          .number()
          .optional()
          .describe('Show only postings whose low salary end >= this amount; postings without a stated salary are kept (optional).'),
        maxAgeDays: z
          .number()
          .optional()
          .describe('Show only postings posted within this many days; postings without a posted date are kept (optional).'),
      },
    },
    async (args) => {
      const outcome = await searchJobPostings(
        args.keywords,
        args.location ?? '',
        {
          registry: dependencies.registry,
          dataRoot: dependencies.dataRoot,
        },
        {
          remoteOnly: args.remoteOnly,
          minFit: args.minFit,
          minSalary: args.minSalary,
          maxAgeDays: args.maxAgeDays,
        },
      );
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                newRecords: outcome.newRecords,
                alreadyRecorded: outcome.alreadyRecorded,
                evaluatedCount: outcome.evaluatedCount,
                activeResults: outcome.activeResults,
                excludedResults: outcome.excludedResults,
              },
              null,
              2,
            ),
          },
        ],
        structuredContent: {
          keywords: args.keywords,
          location: args.location ?? '',
          newRecords: outcome.newRecords,
          alreadyRecorded: outcome.alreadyRecorded,
          evaluatedCount: outcome.evaluatedCount,
          activeResults: outcome.activeResults,
          excludedResults: outcome.excludedResults,
        },
      };
    },
  );

  server.registerTool(
    'searchByProfile',
    {
      description:
        'Search every registered adapter using queries derived from the saved profile: one query per targetRoles entry (role title plus top profile skills), or a skills-derived fallback query when targetRoles is empty. Merges and deduplicates results across queries, evaluates each unique posting via fitEvaluator, persists status evaluated, and returns BOTH fixed result tables defined by Requirement 2a: Active Results (7-column core) and Excluded Results (6-column core). No resume, cover letter, or outreach is generated.',
      inputSchema: {},
    },
    async () => {
      const outcome = await searchByProfile({
      registry: dependencies.registry,
      dataRoot: dependencies.dataRoot,
    });
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                queries: outcome.queries,
                location: outcome.location,
                newRecords: outcome.newRecords,
                alreadyRecorded: outcome.alreadyRecorded,
                evaluatedCount: outcome.evaluatedCount,
                activeResults: outcome.activeResults,
                excludedResults: outcome.excludedResults,
              },
              null,
              2,
            ),
          },
        ],
        structuredContent: {
          queries: outcome.queries,
          location: outcome.location,
          newRecords: outcome.newRecords,
          alreadyRecorded: outcome.alreadyRecorded,
          evaluatedCount: outcome.evaluatedCount,
          activeResults: outcome.activeResults,
          excludedResults: outcome.excludedResults,
        },
      };
    },
  );

  server.registerTool(
    'runSavedSearches',
    {
      description:
        'Run every saved search (saved via search --save or the savedSearches store), dedup within the batch and against application history, evaluate each unique posting via fitEvaluator, and persist status evaluated. Returns BOTH fixed result tables defined by Requirement 2a: Active Results (7-column core) and Excluded Results (6-column core). No resume or cover letter is generated.',
      inputSchema: {},
    },
    async () => {
      const outcome = await runSavedSearchesDigest({
      registry: dependencies.registry,
      savedSearchesPath: dependencies.savedSearchesPath,
      dataRoot: dependencies.dataRoot,
    });
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                newRecords: outcome.newRecords,
                alreadyRecorded: outcome.alreadyRecorded,
                evaluatedCount: outcome.evaluatedCount,
                activeResults: outcome.activeResults,
                excludedResults: outcome.excludedResults,
              },
              null,
              2,
            ),
          },
        ],
        structuredContent: {
          newRecords: outcome.newRecords,
          alreadyRecorded: outcome.alreadyRecorded,
          evaluatedCount: outcome.evaluatedCount,
          activeResults: outcome.activeResults,
          excludedResults: outcome.excludedResults,
        },
      };
    },
  );

  server.registerTool(
    'getPostingDetail',
    {
      description:
        'Return the stored detail for one evaluated posting: posting description, fit score/status, posting facts (location type, employer type, required clearance), salary range, source aggregators, job URL, and status history. Read-only; nothing is generated or changed.',
      inputSchema: {
        companyName: z.string().describe('Company name as recorded when the posting was evaluated.'),
        roleTitle: z.string().describe('Role title as recorded when the posting was evaluated.'),
        postingHash: z
          .string()
          .optional()
          .describe('Optional posting hash to target one record when the company and role match several.'),
      },
    },
    async (args) => {
      const record = await getPostingDetail(args.companyName, args.roleTitle, {
        historyPath: dependencies.historyPath,
        dataRoot: dependencies.dataRoot,
        postingHash: args.postingHash,
      });
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(record, null, 2),
          },
        ],
        structuredContent: record,
      };
    },
  );

  server.registerTool(
    'generateTailoredApplication',
    {
      description:
        'Generate a tailored resume (Typst to PDF) for a specific company and role, grounded strictly in masterProfile.md with EEO enforcement, 1-page compile loop, and ATS reading-order/keyword verification. Writes applications/<company><role>/tailoredResume.typ and tailoredResume.pdf under the canonical data root. Does NOT draft a cover letter or outreach message; those are separate tools.',
      inputSchema: {
        companyName: z.string().describe('Target company name (used for output folder naming).'),
        roleTitle: z.string().describe('Target role title (used for output folder naming).'),
        variant: z
          .string()
          .optional()
          .describe('Optional explicit resume variant override (e.g. usDetailedResume).'),
      },
    },
    async (args) => {
      // A1: single generate seam - delegates to the same core function the CLI
      // runGenerate command uses, so both surfaces produce the same history
      // mutation (status plus variant tag). This path never composes
      // generateResume or readApplicationHistory directly and never reads
      // jobPreferences (the generate path needs no preference data).
      const outcome = await generateForRole(args.companyName, args.roleTitle, {
        explicitVariant: args.variant,
        dataRoot: dependencies.dataRoot,
        historyPath: dependencies.historyPath,
      });
      const result = outcome.result;
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                variant: result.variantName,
                pages: result.pageCount,
                atsPassed: result.atsCheck.passed,
                pdfPath: result.pdfPath,
                typPath: result.typPath,
              },
              null,
              2,
            ),
          },
        ],
        structuredContent: {
          variantName: result.variantName,
          templatePath: result.templatePath,
          typPath: result.typPath,
          pdfPath: result.pdfPath,
          pageCount: result.pageCount,
          detectedEngine: result.detectedEngine,
          atsPassed: result.atsCheck.passed,
          atsMissingSections: result.atsCheck.missingSections,
          atsMissingKeywords: result.atsCheck.missingKeywords,
          claimableKeywords: result.claimableKeywords,
          excludedKeywords: result.excludedKeywords,
          hallucinatedTokens: result.hallucinatedTokens,
        },
      };
    },
  );

  server.registerTool(
    'confirmApplicationSubmission',
    {
      description:
        'Record that the HUMAN has submitted an application for a previously evaluated posting. Local-only manual confirmation that writes appliedConfirmed to applicationHistory.json. Only applications in evaluated or generated status can be confirmed; nothing is auto-submitted to any portal and no one is contacted.',
      inputSchema: {
        companyName: z.string().describe('Company name as recorded when the posting was evaluated.'),
        roleTitle: z.string().describe('Role title as recorded when the posting was evaluated.'),
        notes: z
          .string()
          .optional()
          .describe('Optional note (confirmation ref, portal name) stored on the status change.'),
        postingHash: z
          .string()
          .optional()
          .describe('Optional posting hash to confirm exactly one record when the company and role match several.'),
      },
    },
    async (args) => {
      const outcome = await confirmApplicationSubmission(args.companyName, args.roleTitle, args.notes ?? '', {
        historyPath: dependencies.historyPath,
        dataRoot: dependencies.dataRoot,
        postingHash: args.postingHash,
      });
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                applicationId: outcome.record.applicationId,
                status: outcome.record.status,
                alreadyConfirmed: outcome.alreadyConfirmed,
              },
              null,
              2,
            ),
          },
        ],
        structuredContent: {
          applicationId: outcome.record.applicationId,
          companyName: outcome.record.companyName,
          roleTitle: outcome.record.roleTitle,
          status: outcome.record.status,
          alreadyConfirmed: outcome.alreadyConfirmed,
        },
      };
    },
  );

  server.registerTool(
    'getReviewQueue',
    {
      description:
        'List every application whose fitStatus is manualReview and therefore awaits a human decision (SDD Requirement 6/9). Read-only: does not modify history and does not trigger generation.',
      inputSchema: {},
    },
    async () => {
      const entries = await getReviewQueue(dependencies.historyPath, dependencies.dataRoot);
      return {
        content: [
          {
            type: 'text',
            text:
              entries.length > 0
                ? JSON.stringify(entries, null, 2)
                : 'No applications are awaiting a human decision (fitStatus manualReview).',
          },
        ],
        structuredContent: { reviewCount: entries.length, entries },
      };
    },
  );

  server.registerTool(
    'getFunnelReport',
    {
      description:
        'Produce the funnel report across application history and networking contacts: fits by fitStatus and by funnel status, referral-linked conversions, manual-review backlog, and overdue contact follow-ups (SDD Requirement 9). Read-only. H4 PII hygiene: identity fields (names, companies, contact IDs, role titles, application IDs, job links) are redacted by default; pass redact false to opt out. No terminal warning is emitted on this path.',
      inputSchema: {
        redact: z.boolean().optional().describe('Redact identity fields (names, companies, contact IDs, role titles, application IDs, job links). Default true.'),
      },
    },
    async (args) => {
      const report = await getFunnelReport({
        historyPath: dependencies.historyPath,
        contactsPath: dependencies.contactsPath,
        searchHistoryPath: dependencies.searchHistoryPath,
        dataRoot: dependencies.dataRoot,
        redact: args.redact ?? true,
      });
      return {
        content: [{ type: 'text', text: JSON.stringify(report, null, 2) }],
        structuredContent: {
          fitStatusCounts: report.fitStatusCounts,
          statusCounts: report.statusCounts,
          referralConversion: report.referralConversion,
          awaitingManualReview: report.awaitingManualReview,
          overdueFollowUps: report.overdueFollowUps,
        },
      };
    },
  );

  server.registerTool(
    'analyzeApplicationPatterns',
    {
      description:
        'Analyze applicationHistory.json for patterns and return SUGGESTIONS ONLY (SDD Requirement 9 feedback loop): skills/domains common in interviewed vs rejected roles, work-mode (locationType) patterns among applied roles, role-title clusters worth adding to targetRoles, per-resume-variant outcome signals when variant tags exist, and preference drift when applied roles/locations fall outside the saved targetRoles/preferredLocations. Deterministic engine; read-only - nothing is written, generated, or sent.',
      inputSchema: {},
    },
    async () => {
      // Phase E thin bridge: delegates to the core seam in jobSearchCore.ts
      // instead of composing readApplicationHistory plus loadJobPreferences
      // plus analyzeApplicationPatterns.
      const suggestions = await getApplicationPatternSuggestions({
        historyPath: dependencies.historyPath,
        preferencesPath: dependencies.preferencesPath,
        dataRoot: dependencies.dataRoot,
      });
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(suggestions, null, 2),
          },
        ],
        structuredContent: {
          suggestionCount: suggestions.length,
          suggestions,
        },
      };
    },
  );

  server.registerTool(
    'logNetworkingContact',
    {
      description:
        'Log or update a networking contact in networkingContacts.json under the canonical data root (SDD Requirement 6). This only records contact info and never contacts the person.',
      inputSchema: {
        name: z.string().describe('Contact full name (required).'),
        company: z.string().describe('Contact employer (required).'),
        relationship: z.string().optional().describe('Relationship, e.g. formerColleague or recruiter.'),
        linkedApplicationIds: z
          .array(z.string())
          .optional()
          .describe('Application ids already referred in by this contact.'),
        followUpDue: z.string().optional().describe('ISO date the follow-up is due, used by the funnel report.'),
      },
    },
    async (args) => {
      const contact = await logNetworkingContact(args.name, args.company, args.relationship, {
        linkedApplicationIds: args.linkedApplicationIds,
        followUpDue: args.followUpDue,
        contactsPath: dependencies.contactsPath,
        dataRoot: dependencies.dataRoot,
      });
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              { contactId: contact.contactId, name: contact.name, company: contact.company },
              null,
              2,
            ),
          },
        ],
        structuredContent: {
          contactId: contact.contactId,
          name: contact.name,
          company: contact.company,
          relationship: contact.relationship,
        },
      };
    },
  );

  server.registerTool(
    'draftOutreachMessage',
    {
      description:
        'Draft a short networking message for ONE contact from networkingContacts.json, grounded strictly in the candidate profile for a target company and role. Writes ONLY applications/<company><role>/outreachMessage.md under the canonical data root and never sends anything.',
      inputSchema: {
        contactId: z.string().describe('Contact id from networkingContacts.json.'),
        companyName: z.string().describe('Target company name (used for folder naming).'),
        roleTitle: z.string().describe('Target role title.'),
        platform: z
          .string()
          .optional()
          .describe('Message format: linkedin or email (default derived from the contact record).'),
      },
    },
    async (args) => {
      const draft = await draftOutreachMessage(args.contactId, args.companyName, args.roleTitle, args.platform, {
        dataRoot: dependencies.dataRoot,
      });
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                markdownPath: draft.markdownPath,
                platform: draft.platform,
                contactId: draft.contactId,
                contactName: draft.contactName,
                claimableTokens: draft.claimableTokens,
                excludedTokens: draft.excludedTokens,
              },
              null,
              2,
            ),
          },
        ],
        structuredContent: {
          markdownPath: draft.markdownPath,
          platform: draft.platform,
          contactId: draft.contactId,
          contactName: draft.contactName,
          claimableTokens: draft.claimableTokens,
          excludedTokens: draft.excludedTokens,
        },
      };
    },
  );

  server.registerTool(
    'draftCoverLetter',
    {
      description:
        'Draft a role-specific cover letter grounded strictly in masterProfile.md, referencing posting requirements only where the profile genuinely supports the connection. Writes ONLY applications/<company><role>/coverLetter.md under the canonical data root and never sends anything. Does not trigger resume generation or outreach drafting.',
      inputSchema: {
        companyName: z.string().describe('Target company name (used for output folder naming).'),
        roleTitle: z.string().describe('Target role title (used for output folder naming).'),
        postingRequirements: z
          .string()
          .optional()
          .describe('Optional comma-separated posting requirements; only those genuinely supported by masterProfile.md are referenced. When omitted, the stored posting description is used.'),
        postingHash: z
          .string()
          .optional()
          .describe('Optional posting hash to target one record when the company and role match several.'),
      },
    },
    async (args) => {
      const draft = await draftCoverLetterForRole(args.companyName, args.roleTitle, args.postingRequirements, {
        dataRoot: dependencies.dataRoot,
        postingHash: args.postingHash,
      });
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                markdownPath: draft.markdownPath,
                claimableTokens: draft.claimableTokens,
                excludedTokens: draft.excludedTokens,
              },
              null,
              2,
            ),
          },
        ],
        structuredContent: {
          markdownPath: draft.markdownPath,
          claimableTokens: draft.claimableTokens,
          excludedTokens: draft.excludedTokens,
        },
      };
    },
  );

  return server;
}

export async function startMcpServer(dependencies: McpServerDependencies = {}): Promise<void> {
  const server = createMcpServer(dependencies);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  await new Promise<void>((resolve) => {
    transport.onclose = () => resolve();
  });
}

if (require.main === module) {
  void startMcpServer();
}