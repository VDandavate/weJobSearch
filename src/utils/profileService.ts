import { statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { stringify as stringifyYaml } from 'yaml';
import { redactHomePrefix } from './canonicalDataRoot';
import {
  canonicalDataRoot,
  canonicalMasterProfilePath,
  documentsDirectoryName,
  ensureCanonicalDataDirectories,
  assertConfinedToRoot,
  isPathInside,
  masterProfileFileName,
  networkingContactsFileName,
  profileDirectoryOf,
  resolveDataRoot,
  resolveOutputRoot,
  resolveResumeVariantsPath,
  setupStateFileName,
  type DirectoryOverrides,
} from './canonicalDataRoot';
import { parseMasterProfile, type ParsedMasterProfile } from '../generators/resumeGenerator';
import {
  jobPreferencesSchema,
  parseJobPreferences,
  type JobPreferences,
} from '../evaluators/fitEvaluator';
import { screeningAnswersSchema, type ScreeningAnswers } from './profileSchemas';
import { networkingContactsSchema, type NetworkingContacts } from './networkingContacts';
import { writeProfileFilesAtomically, type ProfileFileWrite } from '../core/profileWriter';
import {
  isSetupStateComplete,
  isSetupStateStale,
  readSetupState,
  type SetupStep,
} from './setupState';

// Agent-facing profile service (SDD Requirements 1, 1a, 1b). This is the
// host-neutral core behind the getUserProfile / initializeUserProfile /
// updateUserProfile MCP tools: the MCP server and any other compatible agent
// bridge delegate here, so profile setup can be completed inside an agentic
// host instead of being CLI-only (the `init` wizard stays as an optional
// developer fallback).
//
// Contract, matching the other persistence modules:
//   - Reads are read-only; a missing profile returns an explicit unconfigured
//     state instead of throwing.
//   - Writes use the same atomic temp-file + rename pattern as the tracker
//     modules and validate-before-write; malformed existing data refuses to be
//     overwritten.
//   - initializeUserProfile refuses to run when a real profile file already
//     exists (no accidental overwrite). updateUserProfile only touches the
//     supplied sections and preserves everything else.
//   - Both write operations require explicit user confirmation
//     (`confirmed: true`); nothing here invents or infers personal data, and
//     no operation touches the network.
//   - networkingContacts.json is created empty on init and is otherwise owned
//     by addContact / logNetworkingContact, never by the generic profile tools.

export class ProfileConfirmationRequiredError extends Error {
  constructor() {
    super(
      'Profile confirmation required: confirmed must be true before any profile write. No profile file was changed.',
    );
    this.name = 'ProfileConfirmationRequiredError';
  }
}

export class ProfileAlreadyInitializedError extends Error {
  constructor(existingPaths: readonly string[]) {
    super(
      `Profile already exists at: ${existingPaths.join(', ')}. ` +
        'Use updateUserProfile to change only the supplied fields, or remove the existing file(s) first.',
    );
    this.name = 'ProfileAlreadyInitializedError';
  }
}

export class ProfileValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProfileValidationError';
  }
}

export interface ProfilePathOverrides {
  profilePath?: string;
  preferencesPath?: string;
  screeningAnswersPath?: string;
  contactsPath?: string;
  setupStatePath?: string;
  // Config-driven directories (outputRoot/resumeVariantsFile only): CLI-level
  // values that win over the directories block in jobPreferences.yaml. The
  // data root itself is CLI-plus-env-only (no directories.dataRoot branch),
  // so callers pass an explicit dataRoot flag or rely on the environment.
  dataRoot?: string;
  outputRoot?: string;
  resumeVariantsPath?: string;
  directories?: DirectoryOverrides;
}

export interface ResolvedProfilePaths {
  masterProfile: string;
  jobPreferences: string;
  screeningAnswers: string;
  networkingContacts: string;
  setupState: string;
  dataRoot: string;
  outputRoot: string;
  resumeVariants: string;
}

export function defaultMasterProfilePath(): string {
  return canonicalMasterProfilePath();
}

export function resolveProfilePaths(overrides: ProfilePathOverrides = {}): ResolvedProfilePaths {
  const dataRoot = resolveDataRoot(overrides.dataRoot, overrides.directories);
  const masterProfile = overrides.profilePath ?? join(dataRoot, masterProfileFileName);
  const jobPreferences = overrides.preferencesPath ?? join(dataRoot, 'jobPreferences.yaml');
  const screeningAnswers = overrides.screeningAnswersPath ?? join(dataRoot, 'screeningAnswers.json');
  const networkingContacts = overrides.contactsPath ?? join(dataRoot, networkingContactsFileName);
  const setupState = overrides.setupStatePath ?? join(dataRoot, setupStateFileName);
  assertConfinedToRoot(dataRoot, masterProfile, 'masterProfile');
  assertConfinedToRoot(dataRoot, jobPreferences, 'jobPreferences');
  assertConfinedToRoot(dataRoot, screeningAnswers, 'screeningAnswers');
  assertConfinedToRoot(dataRoot, networkingContacts, 'networkingContacts');
  assertConfinedToRoot(dataRoot, setupState, 'setupState');
  return {
    masterProfile,
    jobPreferences,
    screeningAnswers,
    networkingContacts,
    setupState,
    dataRoot,
    outputRoot: resolveOutputRoot(overrides.outputRoot, overrides.directories, dataRoot),
    resumeVariants: resolveResumeVariantsPath(overrides.resumeVariantsPath, overrides.directories, dataRoot),
  };
}

// ---------------------------------------------------------------------------
// Structured input schemas (strict so malformed and unknown fields fail loudly)
// ---------------------------------------------------------------------------

// Required-field set (H2): these fields must be populated by the user
// before any profile write is allowed. Placeholders (REPLACE_ME,
// Lorem ipsum) and empty strings in required fields BLOCK completion.
// Optional-field placeholders WARN only (not enforced here).
const requiredMasterProfileFields: readonly string[] = [
  'contact.name',
  'contact.email',
  'contact.phone',
  'contact.cityState',
  'contact.linkedIn',
  'contact.portfolio',
  'workAuthorization.usCitizen',
  'workAuthorization.requiresSponsorship',
  'workAuthorization.clearance',
  'summary',
];
const requiredWizardMasterProfileFields: readonly string[] = [
  'contact.name',
  'contact.email',
  'contact.phone',
  'contact.cityState',
  'contact.linkedIn',
  'contact.portfolio',
  'workAuthorization.usCitizen',
  'workAuthorization.requiresSponsorship',
  'workAuthorization.clearance',
];
const requiredJobPreferencesFields: readonly string[] = [
  'compensation.minAcceptableBase',
  'compensation.targetBase',
  'clearance.currentStatus',
];

const placeholderPatterns: readonly RegExp[] = [/\bREPLACE_ME\b/, /Lorem ipsum/i];

function isPlaceholder(value: string): boolean {
  return placeholderPatterns.some((pattern) => pattern.test(value)) || value === '';
}

/**
 * Validates user completion payloads for required fields. Checks the
 * actual user-provided data (never internal defaults). Returns a list
 * of blocking issue paths; empty means the payload is complete.
 */
export function validateProfileCompletion(input: ProfileInitializationInput): string[] {
  const issues: string[] = [];
  const { masterProfile, jobPreferences } = input;

  for (const field of requiredMasterProfileFields) {
    const value = field.split('.').reduce((obj: unknown, key: string) => {
      if (obj && typeof obj === 'object' && key in obj) {
        return (obj as Record<string, unknown>)[key];
      }
      return undefined;
    }, masterProfile as unknown);
    if (typeof value === 'string' && isPlaceholder(value)) {
      issues.push(`${field}: placeholder or empty value blocks completion`);
    }
  }

  // Experience must have at least one entry
  if (masterProfile.experience.length === 0) {
    issues.push('experience: at least one entry is required');
  }

  for (const field of requiredJobPreferencesFields) {
    const value = field.split('.').reduce((obj: unknown, key: string) => {
      if (obj && typeof obj === 'object' && key in obj) {
        return (obj as Record<string, unknown>)[key];
      }
      return undefined;
    }, jobPreferences as unknown);
    if (field === 'compensation.minAcceptableBase' || field === 'compensation.targetBase') {
      if (typeof value === 'number' && value === 0) {
        issues.push(`${field}: 0 is a placeholder and blocks completion`);
      }
    } else if (field === 'clearance.currentStatus') {
      if (typeof value === 'string' && value === '') {
        issues.push(`${field}: empty string blocks completion`);
      }
    }
  }

  return issues;
}

export function validateWizardCollectedInput(input: ProfileInitializationInput): string[] {
  const issues: string[] = [];
  const { masterProfile, jobPreferences } = input;

  for (const field of requiredWizardMasterProfileFields) {
    const value = field.split('.').reduce((obj: unknown, key: string) => {
      if (obj && typeof obj === 'object' && key in obj) {
        return (obj as Record<string, unknown>)[key];
      }
      return undefined;
    }, masterProfile as unknown);
    if (typeof value === 'string' && isPlaceholder(value)) {
      issues.push(`${field}: placeholder or empty value blocks completion`);
    }
  }

  for (const field of requiredJobPreferencesFields) {
    const value = field.split('.').reduce((obj: unknown, key: string) => {
      if (obj && typeof obj === 'object' && key in obj) {
        return (obj as Record<string, unknown>)[key];
      }
      return undefined;
    }, jobPreferences as unknown);
    if (field === 'compensation.minAcceptableBase' || field === 'compensation.targetBase') {
      if (typeof value === 'number' && value === 0) {
        issues.push(`${field}: 0 is a placeholder and blocks completion`);
      }
    } else if (field === 'clearance.currentStatus') {
      if (typeof value === 'string' && value === '') {
        issues.push(`${field}: empty string blocks completion`);
      }
    }
  }

  return issues;
}

export const masterProfileContactSchema = z
  .object({
    name: z.string(),
    email: z.string(),
    phone: z.string(),
    cityState: z.string(),
    linkedIn: z.string(),
    portfolio: z.string(),
  })
  .strict();

export const masterProfileWorkAuthorizationSchema = z
  .object({
    usCitizen: z.string(),
    requiresSponsorship: z.string(),
    clearance: z.string(),
  })
  .strict();

export const masterProfileSkillGroupSchema = z
  .object({
    category: z.string(),
    items: z.array(z.string()),
  })
  .strict();

export const masterProfileExperienceEntrySchema = z
  .object({
    roleTitle: z.string(),
    employer: z.string(),
    location: z.string(),
    startDate: z.string(),
    endDate: z.string(),
    bullets: z.array(z.string()),
  })
  .strict();

export const masterProfileEducationEntrySchema = z
  .object({
    degree: z.string(),
    institution: z.string(),
    startYear: z.string(),
    endYear: z.string(),
  })
  .strict();

export const masterProfileInputSchema = z
  .object({
    contact: masterProfileContactSchema,
    workAuthorization: masterProfileWorkAuthorizationSchema,
    summary: z.string(),
    skills: z.array(masterProfileSkillGroupSchema),
    experience: z.array(masterProfileExperienceEntrySchema),
    education: z.array(masterProfileEducationEntrySchema),
    certifications: z.array(z.string()),
  })
  .strict();

export type MasterProfileInput = z.infer<typeof masterProfileInputSchema>;

// Complete structured profile used for first-time creation. Strict so an
// unknown/malformed payload fails with an actionable error instead of having
// fields silently dropped.
export const profileInitializationSchema = z
  .object({
    jobPreferences: jobPreferencesSchema,
    screeningAnswers: screeningAnswersSchema,
    masterProfile: masterProfileInputSchema,
  })
  .strict();

export type ProfileInitializationInput = z.infer<typeof profileInitializationSchema>;

// Partial payloads for updates. Only the explicitly supplied sections are
// applied; everything else in the existing profile is preserved.
export const profileUpdateSchema = z
  .object({
    jobPreferences: jobPreferencesSchema.partial().strict().optional(),
    screeningAnswers: screeningAnswersSchema.partial().strict().optional(),
    masterProfile: masterProfileInputSchema.partial().strict().optional(),
  })
  .strict()
  .refine(
    (data) =>
      data.jobPreferences !== undefined ||
      data.screeningAnswers !== undefined ||
      data.masterProfile !== undefined,
    {
      message:
        'updateUserProfile requires at least one section (jobPreferences, screeningAnswers, or masterProfile)',
    },
  );

export type ProfileUpdateInput = z.infer<typeof profileUpdateSchema>;

export interface ProfileSectionApplied {
  kind: 'initialize' | 'update';
  file: string;
  section: string;
}

export interface ProfileWriteResult {
  filesWritten: string[];
  filesUpdated: string[];
  sections: ProfileSectionApplied[];
  summary: string;
}

// ---------------------------------------------------------------------------
// Read-only inspection (getUserProfile)
// ---------------------------------------------------------------------------

export interface ProfileFileInfo {
  exists: boolean;
  configured: boolean;
  reason?: string;
}

export type SerializedMasterProfile = Omit<ParsedMasterProfile, 'rawText'>;

export interface InspectedProfileState {
  configured: boolean;
  incompleteReasons: string[];
  // Present only when the profile is entirely absent (no real profile file
  // exists at all). Structured first-run guidance (EUO-11): concrete next
  // steps for the user/agent to reach a configured profile. Informational
  // only — readUserProfile never runs or writes anything (N2, N9).
  onboardingSteps?: string[];
  // Present only when the profile is not yet configured and a resumable setup
  // checkpoint exists (EUO-15): the in-progress profile-setup step to resume
  // from, complementing onboardingSteps. Stale checkpoints (older than the
  // staleness window) and completed checkpoints (step 'confirmed') are
  // ignored — there is nothing to resume. Informational only — the step is
  // reported, never advanced or cleared (N2, N9).
  setupState?: {
    step: SetupStep;
    updatedAt: string;
    notes?: string;
  };
  // Present when setupState.json exists but cannot be parsed or validated
  // (Phase D): the malformation is surfaced here instead of being swallowed,
  // so inspection callers can tell "no checkpoint" apart from "broken
  // checkpoint". setupState stays undefined in that case.
  setupStateError?: string;
  files: {
    masterProfile: ProfileFileInfo;
    jobPreferences: ProfileFileInfo;
    screeningAnswers: ProfileFileInfo;
    networkingContacts: ProfileFileInfo;
  };
  masterProfile?: SerializedMasterProfile;
  jobPreferences?: JobPreferences;
  screeningAnswers?: ScreeningAnswers;
  networkingContacts?: NetworkingContacts;
}

async function readFileOrNull(path: string, rootDir?: string | null): Promise<string | null> {
  const root = rootDir !== undefined && rootDir !== null && rootDir.trim().length > 0 ? rootDir : resolveDataRoot();
  assertConfinedToRoot(root, path, 'readFileOrNull');
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

function missingReason(label: string, path: string): string {
  return `${label} is missing (${redactHomePrefix(path)})`;
}

function masterProfileFileInfo(content: string | null, parseError: string | null): ProfileFileInfo {
  if (content === null) {
    return { exists: false, configured: false, reason: missingReason('masterProfile.md', defaultMasterProfilePath()) };
  }
  if (parseError !== null) {
    return { exists: true, configured: false, reason: `masterProfile.md does not parse: ${parseError}` };
  }
  if (/\bREPLACE_ME\b|Lorem ipsum/i.test(content)) {
    return {
      exists: true,
      configured: false,
      reason:
        'masterProfile.md still contains placeholder values (REPLACE_ME); fill them before running the search/generate pipeline',
    };
  }
  return { exists: true, configured: true };
}

export async function readUserProfile(
  overrides: ProfilePathOverrides = {},
  referenceDate: Date = new Date(),
): Promise<InspectedProfileState> {
  const paths = resolveProfilePaths(overrides);

  const masterContent = await readFileOrNull(paths.masterProfile, paths.dataRoot);
  let masterParsed: ParsedMasterProfile | null = null;
  let masterParseError: string | null = null;
  if (masterContent !== null) {
    try {
      masterParsed = parseMasterProfile(masterContent);
    } catch (error) {
      masterParseError = (error as Error).message;
    }
  }

  const preferencesContent = await readFileOrNull(paths.jobPreferences, paths.dataRoot);
  let preferencesParsed: JobPreferences | null = null;
  let preferencesParseError: string | null = null;
  if (preferencesContent !== null) {
    try {
      preferencesParsed = parseJobPreferences(preferencesContent);
    } catch (error) {
      preferencesParseError = (error as Error).message;
    }
  }

  const screeningContent = await readFileOrNull(paths.screeningAnswers, paths.dataRoot);
  let screeningParsed: ScreeningAnswers | null = null;
  let screeningParseError: string | null = null;
  if (screeningContent !== null) {
    try {
      screeningParsed = parseScreeningAnswers(screeningContent, paths.screeningAnswers);
    } catch (error) {
      screeningParseError = (error as Error).message;
    }
  }

  const contactsContent = await readFileOrNull(paths.networkingContacts, paths.dataRoot);
  let contactsParsed: NetworkingContacts | null = null;
  let contactsParseError: string | null = null;
  if (contactsContent !== null) {
    try {
      contactsParsed = parseNetworkingContacts(contactsContent, paths.networkingContacts);
    } catch (error) {
      contactsParseError = (error as Error).message;
    }
  }

  const files = {
    masterProfile: masterProfileFileInfo(masterContent, masterParseError),
    jobPreferences: {
      exists: preferencesContent !== null,
      configured: preferencesParsed !== null,
      reason:
        preferencesContent === null
          ? missingReason('jobPreferences.yaml', paths.jobPreferences)
          : preferencesParseError === null
            ? undefined
            : `jobPreferences.yaml does not conform to the schema: ${preferencesParseError}`,
    },
    screeningAnswers: {
      exists: screeningContent !== null,
      configured: screeningParsed !== null,
      reason:
        screeningContent === null
          ? missingReason('screeningAnswers.json', paths.screeningAnswers)
          : screeningParseError === null
            ? undefined
            : `screeningAnswers.json does not conform to the schema: ${screeningParseError}`,
    },
    networkingContacts: {
      exists: contactsContent !== null,
      configured: contactsParsed !== null,
      reason:
        contactsContent === null
          ? missingReason('networkingContacts.json', paths.networkingContacts)
          : contactsParseError === null
            ? undefined
            : `networkingContacts.json does not conform to the schema: ${contactsParseError}`,
    },
  };

  const incompleteReasons: string[] = [];
  for (const file of [
    files.masterProfile,
    files.jobPreferences,
    files.screeningAnswers,
    files.networkingContacts,
  ]) {
    if (!file.configured && file.reason !== undefined) {
      incompleteReasons.push(file.reason);
    }
  }

  // EUO-11: when the canonical root holds no real profile file at all, guide
  // the first contact instead of returning a bare unconfigured state. The
  // steps are informational only — nothing here runs a tool or writes a file
  // (N2, N9). A partial profile keeps the existing per-file reasons and gets
  // no onboarding steps.
  const profileEntirelyAbsent =
    !files.masterProfile.exists &&
    !files.jobPreferences.exists &&
    !files.screeningAnswers.exists &&
    !files.networkingContacts.exists;
  const configured =
    files.masterProfile.configured &&
    files.jobPreferences.configured &&
    files.screeningAnswers.configured &&
    files.networkingContacts.configured;
  const documentsDir = join(dirname(paths.masterProfile), documentsDirectoryName);
  const onboardingSteps = profileEntirelyAbsent
    ? [
        `Place your resume and related documents in the documents/ directory under the canonical data root (${documentsDir}).`,
        'Run ingestDocuments on that directory to parse the documents and propose a profile.',
        'Review the proposed profile returned by ingestDocuments.',
        'Confirm the profile with initializeUserProfile (first-time creation) or updateUserProfile (corrections).',
      ]
    : undefined;

  // EUO-15: surface the in-progress setup checkpoint when the profile is not
  // yet configured, so an interrupted setup can be resumed from the recorded
  // step. Read-only: the step is reported, never advanced or cleared (N2, N9).
  // A stale checkpoint (older than the staleness window) or a completed one
  // (step 'confirmed') is ignored — there is nothing to resume. The staleness
  // check runs against referenceDate (default: now), which tests inject so
  // fixtures stay deterministic as the real clock advances. A malformed
  // checkpoint must not break profile inspection, so it is reported via
  // setupStateError instead of thrown (readSetupState itself still throws for
  // direct callers). Phase D: the error is surfaced, never swallowed, so
  // callers can tell "no checkpoint" apart from "broken checkpoint".
  let setupState: InspectedProfileState['setupState'];
  let setupStateError: string | undefined;
  if (!configured) {
    try {
      const checkpoint = await readSetupState(paths.setupState);
      if (
        checkpoint !== null &&
        !isSetupStateStale(checkpoint, referenceDate) &&
        !isSetupStateComplete(checkpoint)
      ) {
        setupState = {
          step: checkpoint.step,
          updatedAt: checkpoint.updatedAt,
          ...(checkpoint.notes !== undefined ? { notes: checkpoint.notes } : {}),
        };
      }
    } catch (error) {
      setupStateError = (error as Error).message;
    }
  }

  const state: InspectedProfileState = {
    configured,
    incompleteReasons,
    onboardingSteps,
    setupState,
    ...(setupStateError !== undefined ? { setupStateError } : {}),
    files,
  };
  if (masterParsed !== null) {
    const structured: Record<string, unknown> = { ...masterParsed };
    delete structured.rawText;
    state.masterProfile = structured as SerializedMasterProfile;
  }
  if (preferencesParsed !== null) {
    state.jobPreferences = preferencesParsed;
  }
  if (screeningParsed !== null) {
    state.screeningAnswers = screeningParsed;
  }
  if (contactsParsed !== null) {
    state.networkingContacts = contactsParsed;
  }
  return state;
}

function parseScreeningAnswers(content: string, path: string): ScreeningAnswers {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new Error(`not valid JSON at ${redactHomePrefix(path)}: ${(error as Error).message}`);
  }
  const result = screeningAnswersSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(result.error.message);
  }
  return result.data;
}

function parseNetworkingContacts(content: string, path: string): NetworkingContacts {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new Error(`not valid JSON at ${redactHomePrefix(path)}: ${(error as Error).message}`);
  }
  const result = networkingContactsSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(result.error.message);
  }
  return result.data;
}

// ---------------------------------------------------------------------------
// masterProfile.md serialization
// ---------------------------------------------------------------------------

export const masterProfileSectionOrder = [
  'contact',
  'workAuthorization',
  'summary',
  'skills',
  'experience',
  'education',
  'certifications',
] as const;

export type MasterProfileSection = (typeof masterProfileSectionOrder)[number];

export function masterProfileHeading(section: MasterProfileSection): string {
  const headings: Record<MasterProfileSection, string> = {
    contact: '## Contact',
    workAuthorization: '## Work Authorization',
    summary: '## Summary',
    skills: '## Skills',
    experience: '## Experience',
    education: '## Education',
    certifications: '## Certifications',
  };
  return headings[section];
}

function contactSectionMarkdown(contact: MasterProfileInput['contact']): string[] {
  return [
    '## Contact',
    `- Name: ${contact.name}`,
    `- Email: ${contact.email}`,
    `- Phone: ${contact.phone}`,
    `- City / State: ${contact.cityState}`,
    `- LinkedIn: ${contact.linkedIn}`,
    `- Portfolio: ${contact.portfolio}`,
    '',
  ];
}

function workAuthorizationSectionMarkdown(auth: MasterProfileInput['workAuthorization']): string[] {
  return [
    '## Work Authorization',
    `- US Citizen: ${auth.usCitizen}`,
    `- Requires Visa Sponsorship: ${auth.requiresSponsorship}`,
    `- Current Clearance: ${auth.clearance}`,
    '',
  ];
}

function skillsSectionMarkdown(skills: MasterProfileInput['skills']): string[] {
  const lines = ['## Skills'];
  for (const group of skills) {
    if (group.items.length === 0) {
      continue;
    }
    if (group.category.length > 0) {
      lines.push(`- ${group.category}: ${group.items.join(', ')}`);
    } else {
      lines.push(...group.items.map((item) => `- ${item}`));
    }
  }
  lines.push('');
  return lines;
}

function experienceSectionMarkdown(experience: MasterProfileInput['experience']): string[] {
  const lines = ['## Experience'];
  for (const entry of experience) {
    lines.push(`### ${entry.roleTitle} | ${entry.employer} | ${entry.location}`);
    lines.push(`- Start: ${entry.startDate}`);
    lines.push(`- End: ${entry.endDate}`);
    lines.push(...entry.bullets.map((bullet) => `- ${bullet}`));
    lines.push('');
  }
  return lines;
}

function educationSectionMarkdown(education: MasterProfileInput['education']): string[] {
  const lines = ['## Education'];
  for (const entry of education) {
    lines.push(`### ${entry.degree} | ${entry.institution}`);
    lines.push(`- Start: ${entry.startYear}`);
    lines.push(`- End: ${entry.endYear}`);
    lines.push('');
  }
  return lines;
}

function certificationsSectionMarkdown(certifications: MasterProfileInput['certifications']): string[] {
  const lines = ['## Certifications'];
  lines.push(...certifications.map((certification) => `- ${certification}`));
  lines.push('');
  return lines;
}

function masterSectionLines(section: MasterProfileSection, input: MasterProfileInput): string[] {
  switch (section) {
    case 'contact':
      return contactSectionMarkdown(input.contact);
    case 'workAuthorization':
      return workAuthorizationSectionMarkdown(input.workAuthorization);
    case 'summary':
      return ['## Summary', input.summary, ''];
    case 'skills':
      return skillsSectionMarkdown(input.skills);
    case 'experience':
      return experienceSectionMarkdown(input.experience);
    case 'education':
      return educationSectionMarkdown(input.education);
    case 'certifications':
      return certificationsSectionMarkdown(input.certifications);
  }
}

export function masterProfileMarkdown(input: MasterProfileInput): string {
  const lines: string[] = ['# Master Profile (Candidate Ground Truth)', ''];
  for (const section of masterProfileSectionOrder) {
    lines.push(...masterSectionLines(section, input));
  }
  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '')}\n`;
}

export function replaceMasterProfileSection(
  markdown: string,
  section: MasterProfileSection,
  input: MasterProfileInput,
): string {
  const heading = masterProfileHeading(section);
  const replacement = masterSectionLines(section, input).join('\n');
  const lines = markdown.split(/\r?\n/);
  const headingIndex = lines.findIndex((line) => line.trim() === heading);
  if (headingIndex === -1) {
    const trimmed = markdown.replace(/\s+$/, '');
    return `${trimmed}\n\n${replacement}\n`;
  }
  let nextHeading = lines.length;
  for (let index = headingIndex + 1; index < lines.length; index += 1) {
    if (lines[index].startsWith('#')) {
      nextHeading = index;
      break;
    }
  }
  const head = lines.slice(0, headingIndex).join('\n');
  const tail = lines.slice(nextHeading).join('\n');
  const separator = head.length > 0 ? '\n' : '';
  return `${head}${separator}${replacement}${tail.length > 0 ? `\n${tail}` : ''}`;
}

// ---------------------------------------------------------------------------
// Serialization + atomic persistence
// ---------------------------------------------------------------------------


function safeYamlOfPreferences(preferences: JobPreferences): string {
  return stringifyYaml(preferences);
}

function safeJsonOfScreening(answers: ScreeningAnswers): string {
  return `${JSON.stringify(answers, null, 2)}\n`;
}

function emptyContactsPlaceholder(): string {
  return `${JSON.stringify({ contacts: [] }, null, 2)}\n`;
}

// Single-writer seam (Phase 7a): the staged atomic write lives in
// ../core/profileWriter. This entry point keeps its original read-only guard.
async function writePendingProfileWrites(writes: readonly ProfileFileWrite[]): Promise<void> {
  await writeProfileFilesAtomically(writes, { enforceReadOnlyGuard: true });
}

function fileExistsSync(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function assertNothingAlreadyExists(paths: ResolvedProfilePaths): void {
  const existing = [
    paths.masterProfile,
    paths.jobPreferences,
    paths.screeningAnswers,
    paths.networkingContacts,
  ].filter((path) => fileExistsSync(path));
  if (existing.length > 0) {
    throw new ProfileAlreadyInitializedError(existing);
  }
}

function validationIssuesMessage(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
      return `${path}: ${issue.message}`;
    })
    .join('; ');
}

// ---------------------------------------------------------------------------
// initializeUserProfile
// ---------------------------------------------------------------------------

export async function initializeUserProfile(
  payload: ProfileInitializationInput,
  options: { confirmed?: boolean; paths?: ProfilePathOverrides } = {},
): Promise<ProfileWriteResult> {
  if (options.confirmed !== true) {
    throw new ProfileConfirmationRequiredError();
  }
  const parsed = profileInitializationSchema.safeParse(payload);
  if (!parsed.success) {
    throw new ProfileValidationError(`Invalid profile payload: ${validationIssuesMessage(parsed.error)}`);
  }
  const input = parsed.data;

   // H2: validate user completion payloads before writing
   const completionIssues = validateProfileCompletion(input);
   if (completionIssues.length > 0) {
     throw new ProfileValidationError(
       `Profile completion blocked: ${completionIssues.join('; ')}`,
     );
   }

   const paths = resolveProfilePaths(options.paths);

   assertNothingAlreadyExists(paths);

  // When the profile lands in the canonical data root (the default), create the
  // root plus its documents/ and applications/ subdirectories as part of the
  // profile workflow. When callers pass explicit overrides (e.g. tests or
  // alternate locations), the caller owns the directory layout; nothing is
  // created outside the canonical tree.
  if (isPathInside(canonicalDataRoot(), profileDirectoryOf(paths.masterProfile))) {
    await ensureCanonicalDataDirectories();
  }

  // targetRoles is optional in the schema (backward compatible with existing
  // preference files), but a freshly initialized profile always carries the
  // explicit empty list so the field round-trips through inspection.
  const preferences: JobPreferences = {
    ...input.jobPreferences,
    targetRoles: input.jobPreferences.targetRoles ?? [],
  };

  const writes: ProfileFileWrite[] = [
    { targetPath: paths.masterProfile, content: masterProfileMarkdown(input.masterProfile) },
    { targetPath: paths.jobPreferences, content: safeYamlOfPreferences(preferences) },
    { targetPath: paths.screeningAnswers, content: safeJsonOfScreening(input.screeningAnswers) },
    { targetPath: paths.networkingContacts, content: emptyContactsPlaceholder() },
  ];
  await writePendingProfileWrites(writes);

  return {
    filesWritten: writes.map((write) => write.targetPath),
    filesUpdated: [],
    sections: [
      { kind: 'initialize', file: paths.masterProfile, section: 'masterProfile' },
      { kind: 'initialize', file: paths.jobPreferences, section: 'jobPreferences' },
      { kind: 'initialize', file: paths.screeningAnswers, section: 'screeningAnswers' },
      { kind: 'initialize', file: paths.networkingContacts, section: 'networkingContacts' },
    ],
    summary:
      'Profile created. Wrote masterProfile.md, jobPreferences.yaml, screeningAnswers.json, networkingContacts.json under the canonical data root (~/Documents/weJobSearch/<user>).',
  };
}

// ---------------------------------------------------------------------------
// updateUserProfile
// ---------------------------------------------------------------------------

function defaultJobPreferences(): JobPreferences {
  return {
    compensation: {
      currency: 'USD',
      minAcceptableBase: 0,
      targetBase: 0,
      countsBonusTowardMin: false,
      countsEquityTowardMin: false,
    },
    clearance: {
      currentStatus: 'none',
      currentLevel: null,
      eligibleToObtain: true,
      requiresSponsorshipForVisa: false,
    },
    nonNegotiables: [],
    preferredLocations: [],
    targetRoles: [],
    directories: {
      dataRoot: null,
      outputRoot: null,
      resumeVariantsFile: null,
    },
  };
}

function defaultScreeningAnswers(): ScreeningAnswers {
  return {
    workAuthorization: { usCitizen: false, requiresSponsorship: false, sponsorshipType: null },
    compensation: { minBaseSalary: 0, targetBaseSalary: 0, currency: 'USD' },
    standardQuestions: {
      yearsOfExperience: { softwareEngineering: 0, typescript: 0, python: 0 },
      preferredWorkLocation: 'REPLACE_ME',
      noticePeriod: 'REPLACE_ME',
    },
  };
}

function defaultMasterProfileInput(): MasterProfileInput {
  return {
    contact: {
      name: 'REPLACE_ME',
      email: 'REPLACE_ME',
      phone: 'REPLACE_ME',
      cityState: 'REPLACE_ME',
      linkedIn: 'REPLACE_ME',
      portfolio: 'REPLACE_ME',
    },
    workAuthorization: {
      usCitizen: 'REPLACE_ME',
      requiresSponsorship: 'REPLACE_ME',
      clearance: 'REPLACE_ME',
    },
    summary: 'REPLACE_ME',
    skills: [],
    experience: [],
    education: [],
    certifications: [],
  };
}

export function validateMasterProfileCompletion(input: MasterProfileInput): string[] {
  const issues: string[] = [];
  const contactFields: [string, string][] = [
    ['contact.name', input.contact.name],
    ['contact.email', input.contact.email],
    ['contact.phone', input.contact.phone],
    ['contact.cityState', input.contact.cityState],
    ['contact.linkedIn', input.contact.linkedIn],
    ['contact.portfolio', input.contact.portfolio],
  ];
  for (const [field, value] of contactFields) {
    if (isPlaceholder(value)) {
      issues.push(`${field}: placeholder or empty value blocks completion`);
    }
  }
  const authFields: [string, string][] = [
    ['workAuthorization.usCitizen', input.workAuthorization.usCitizen],
    ['workAuthorization.requiresSponsorship', input.workAuthorization.requiresSponsorship],
    ['workAuthorization.clearance', input.workAuthorization.clearance],
  ];
  for (const [field, value] of authFields) {
    if (isPlaceholder(value)) {
      issues.push(`${field}: placeholder or empty value blocks completion`);
    }
  }
  if (isPlaceholder(input.summary)) {
    issues.push('summary: placeholder or empty value blocks completion');
  }
  if (input.experience.length === 0) {
    issues.push('experience: at least one entry is required');
  }
  return issues;
}

export function validateJobPreferencesCompletion(prefs: JobPreferences): string[] {
  const issues: string[] = [];
  if (prefs.compensation.minAcceptableBase === 0) {
    issues.push('compensation.minAcceptableBase: 0 is a placeholder and blocks completion');
  }
  if (prefs.compensation.targetBase === 0) {
    issues.push('compensation.targetBase: 0 is a placeholder and blocks completion');
  }
  if (prefs.clearance.currentStatus === '') {
    issues.push('clearance.currentStatus: empty string blocks completion');
  }
  return issues;
}

async function mergeJobPreferences(
  partial: Partial<JobPreferences> | undefined,
  paths: ResolvedProfilePaths,
): Promise<ProfileFileWrite | null> {
  if (partial === undefined) {
    return null;
  }
  const existingContent = await readFileOrNull(paths.jobPreferences, paths.dataRoot);
  let merged: JobPreferences;
  if (existingContent === null) {
    merged = { ...defaultJobPreferences(), ...partial } as JobPreferences;
  } else {
    let current: JobPreferences;
    try {
      current = parseJobPreferences(existingContent);
    } catch (error) {
      throw new ProfileValidationError(
        `Cannot update ${paths.jobPreferences}: the existing file does not conform to the jobPreferences schema (${(error as Error).message}). No file was changed.`,
      );
    }
    merged = { ...current, ...partial };
  }
  const result = jobPreferencesSchema.safeParse(merged);
  if (!result.success) {
    throw new ProfileValidationError(
      `Updated jobPreferences would not conform to the schema: ${validationIssuesMessage(result.error)}`,
    );
  }
  // H2: validate merged result pre-serialization
  const prefIssues = validateJobPreferencesCompletion(result.data);
  if (prefIssues.length > 0) {
    throw new ProfileValidationError(
      `Profile completion blocked: ${prefIssues.join('; ')}`,
    );
  }
  return { targetPath: paths.jobPreferences, content: safeYamlOfPreferences(result.data) };
}

// Validate a parsed master profile (from markdown) for required fields.
// Used by mergeMasterProfile to validate the merged result pre-serialization.
function validateParsedMasterProfile(profile: {
  name: string;
  email: string;
  phone: string;
  cityState: string;
  linkedIn: string;
  portfolio: string;
  summary: string;
  experience: unknown[];
}): string[] {
  const issues: string[] = [];
  const contactFields: [string, string][] = [
    ['contact.name', profile.name],
    ['contact.email', profile.email],
    ['contact.phone', profile.phone],
    ['contact.cityState', profile.cityState],
    ['contact.linkedIn', profile.linkedIn],
    ['contact.portfolio', profile.portfolio],
  ];
  for (const [field, value] of contactFields) {
    if (isPlaceholder(value)) {
      issues.push(`${field}: placeholder or empty value blocks completion`);
    }
  }
  if (isPlaceholder(profile.summary)) {
    issues.push('summary: placeholder or empty value blocks completion');
  }
  if (profile.experience.length === 0) {
    issues.push('experience: at least one entry is required');
  }
  return issues;
}

async function mergeScreeningAnswers(
  partial: Partial<ScreeningAnswers> | undefined,
  paths: ResolvedProfilePaths,
): Promise<ProfileFileWrite | null> {
  if (partial === undefined) {
    return null;
  }
  const existingContent = await readFileOrNull(paths.screeningAnswers, paths.dataRoot);
  let merged: ScreeningAnswers;
  if (existingContent === null) {
    merged = { ...defaultScreeningAnswers(), ...partial } as ScreeningAnswers;
  } else {
    let current: ScreeningAnswers;
    try {
      current = parseScreeningAnswers(existingContent, paths.screeningAnswers);
    } catch (error) {
      throw new ProfileValidationError(
        `Cannot update ${paths.screeningAnswers}: the existing file does not conform to the screeningAnswers schema (${(error as Error).message}). No file was changed.`,
      );
    }
    merged = { ...current, ...partial };
  }
  const result = screeningAnswersSchema.safeParse(merged);
  if (!result.success) {
    throw new ProfileValidationError(
      `Updated screeningAnswers would not conform to the schema: ${validationIssuesMessage(result.error)}`,
    );
  }
  return { targetPath: paths.screeningAnswers, content: safeJsonOfScreening(result.data) };
}

async function mergeMasterProfile(
  partial: Partial<MasterProfileInput> | undefined,
  paths: ResolvedProfilePaths,
): Promise<ProfileFileWrite | null> {
  if (partial === undefined) {
    return null;
  }
  const existingContent = await readFileOrNull(paths.masterProfile, paths.dataRoot);
  if (existingContent === null) {
    const merged = { ...defaultMasterProfileInput(), ...partial } as MasterProfileInput;
    const result = masterProfileInputSchema.safeParse(merged);
    if (!result.success) {
      throw new ProfileValidationError(
        `Provided masterProfile would not conform to the schema: ${validationIssuesMessage(result.error)}`,
      );
    }
    // H2: validate merged result pre-serialization
    const mpIssues = validateMasterProfileCompletion(result.data);
    if (mpIssues.length > 0) {
      throw new ProfileValidationError(
        `Profile completion blocked: ${mpIssues.join('; ')}`,
      );
    }
    return { targetPath: paths.masterProfile, content: masterProfileMarkdown(result.data) };
  }
  let markdown = existingContent;
  for (const section of masterProfileSectionOrder) {
    const value = partial[section];
    if (value === undefined) {
      continue;
    }
    const completed = { ...defaultMasterProfileInput(), [section]: value } as MasterProfileInput;
    const result = masterProfileInputSchema.safeParse(completed);
    if (!result.success) {
      throw new ProfileValidationError(
        `Provided masterProfile section '${section}' does not conform to the schema: ${validationIssuesMessage(result.error)}`,
      );
    }
    markdown = replaceMasterProfileSection(markdown, section, result.data);
  }
  // H2: validate merged result pre-serialization by re-parsing
  const parsedMaster = parseMasterProfile(markdown);
  const mpIssues = validateParsedMasterProfile(parsedMaster);
  if (mpIssues.length > 0) {
    throw new ProfileValidationError(
      `Profile completion blocked: ${mpIssues.join('; ')}`,
    );
  }
  return { targetPath: paths.masterProfile, content: markdown };
}

export async function updateUserProfile(
  payload: ProfileUpdateInput,
  options: { confirmed?: boolean; paths?: ProfilePathOverrides } = {},
): Promise<ProfileWriteResult> {
  if (options.confirmed !== true) {
    throw new ProfileConfirmationRequiredError();
  }
  const parsed = profileUpdateSchema.safeParse(payload);
  if (!parsed.success) {
    throw new ProfileValidationError(`Invalid profile update: ${validationIssuesMessage(parsed.error)}`);
  }
  const input = parsed.data;
  const paths = resolveProfilePaths(options.paths);

  const pending: ProfileFileWrite[] = [];
  const sections: ProfileSectionApplied[] = [];

  const preferencesWrite = await mergeJobPreferences(input.jobPreferences, paths);
  if (preferencesWrite !== null) {
    pending.push(preferencesWrite);
    sections.push({ kind: 'update', file: paths.jobPreferences, section: 'jobPreferences' });
  }
  const screeningWrite = await mergeScreeningAnswers(input.screeningAnswers, paths);
  if (screeningWrite !== null) {
    pending.push(screeningWrite);
    sections.push({ kind: 'update', file: paths.screeningAnswers, section: 'screeningAnswers' });
  }
  const masterWrite = await mergeMasterProfile(input.masterProfile, paths);
  if (masterWrite !== null) {
    pending.push(masterWrite);
    sections.push({ kind: 'update', file: paths.masterProfile, section: 'masterProfile' });
  }

  if (pending.length === 0) {
    throw new ProfileValidationError('No profile section was supplied to update; nothing to write.');
  }

  await writePendingProfileWrites(pending);

  return {
    filesWritten: [],
    filesUpdated: pending.map((write) => write.targetPath),
    sections,
    summary: `Profile updated. ${sections.length} section(s) applied: ${sections
      .map((section) => section.section)
      .join(', ')}.`,
  };
}