import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { writeFileAtomically } from '../utils/atomicWrite';

import {
  applicationFolderSegment,
  loadValidatedProfile,
  mapProfileToBinding,
  summarizeTokenSet,
  unionProfilesTokens,
  textContainsToken,
  type ResumeBinding,
} from './resumeGenerator';
import {
  networkingContactsFileName,
  resolveDataRoot,
  resolveOutputRoot,
  assertConfinedToRoot,
  type DirectoryOverrides,
} from '../utils/canonicalDataRoot';
import {
  claimableRequirementTokens,
  excludedRequirementTokens,
  hallucinatedProseTokens,
} from './coverLetterGenerator';
import {
  readNetworkingContacts,
  type NetworkingContact,
} from '../utils/networkingContacts';
import { assertNotReadOnly } from '../utils/readOnlyGuard';

// Requirement 6a outreach message drafter (SDD Requirement 6a). Drafts a short
// networking message (LinkedIn-style connection/referral-ask note by default,
// cold email on request) tailored to a specific contact from
// networkingContacts.json (under the canonical data root) and a target role.
// Grounded strictly in
// masterProfile.md with the same zero-hallucination discipline as resume and
// cover letter generation.
//
// Reuse, not reimplementation: the masterProfile.md parser and EEO binding
// layer are resumeGenerator.ts's parseMasterProfile/mapProfileToBinding/
// loadMasterProfile/assertProfilePopulated; the token-traceability scanner is
// coverLetterGenerator.ts's hallucinatedProseTokens plus the shared
// claimableRequirementTokens/excludedRequirementTokens. There is no third
// parser and no copy of the scanner in this file.
//
// Independent capability per SDD Section 1.5: nothing here calls generate,
// draftCoverLetter, evaluate, or search, and none of those call this module.
// Drafting stops at writing applications/<companyName><roleTitle>/
// outreachMessage.md under the canonical data root
// outreachMessage.md. This file makes NO network call of any kind (no fetch,
// no http(s), no net imports), so it is structurally impossible for this code
// path to send the message (SDD Section 1.4).

export class OutreachGenerationError extends Error {}
export class OutreachProfileMissingError extends OutreachGenerationError {}
export class OutreachProfilePlaceholderError extends OutreachGenerationError {}
export class OutreachContactNotFoundError extends OutreachGenerationError {}
export class OutreachInvalidPlatformError extends OutreachGenerationError {}
export class OutreachHallucinationError extends OutreachGenerationError {}

export type OutreachPlatform = 'linkedin' | 'email';
export const outreachPlatforms: readonly OutreachPlatform[] = ['linkedin', 'email'];

export interface OutreachMessageOptions {
  contactId: string;
  companyName: string;
  roleTitle: string;
  platform?: OutreachPlatform | string;
  postingRequirements?: readonly string[];
  // Config-driven directories (v0.2.1 Lane A): explicit CLI-level data root
  // plus the directories block from jobPreferences.yaml.
  dataRoot?: string;
  directories?: DirectoryOverrides;
}

export interface OutreachMessageResult {
  markdownPath: string;
  platform: OutreachPlatform;
  contact: NetworkingContact;
  claimableTokens: string[];
  excludedTokens: string[];
  hallucinatedTokens: string[];
}

// Relationship leads. Every entry is generic connective scaffolding that only
// slots in the contact's own company (grounded in networkingContacts.json); the
// relationship string itself comes from the contact record, never invented
// here. The unfilled templates are part of the scaffold token set below, so a
// filled lead always traces to the scaffold plus contact tokens.
const relationshipLeadTemplates: Record<string, string> = {
  formerColleague: 'As a former colleague at {contactCompany}, ',
  manager: 'As your former manager at {contactCompany}, ',
  recruiter: 'As a recruiter at {contactCompany}, ',
  friend: 'As a friend from {contactCompany}, ',
  alumni: 'As an alum of {contactCompany}, ',
};

const fallbackLeadTemplate = 'Through my network at {contactCompany}, ';

function fillRelationshipLead(contact: NetworkingContact): string {
  const template = relationshipLeadTemplates[contact.relationship] ?? fallbackLeadTemplate;
  return template.replace('{contactCompany}', contact.company);
}

// Fixed connective skeleton shared by both platform variants. Every word here
// is generic outreach scaffolding (never a claim about the candidate); its
// tokens form the outreach scaffold set, exactly analogous to the cover
// letter's coverLetterScaffoldTokens. Dynamic content — contact name/company,
// target company/role, profile sentences — is spliced in separately.
const outreachStaticLines: readonly string[] = [
  'Hi',
  "I'm currently pursuing the",
  'role at',
  "I'd appreciate the chance to connect and learn more about your work.",
  'I would be happy to discuss the opportunity in more detail.',
  'Subject:',
  'Best,',
  'Best regards,',
  ...Object.values(relationshipLeadTemplates),
  fallbackLeadTemplate,
];

// Exported for the token-traceability unit test: the outreach scaffold set a
// message may use without tracing a token to masterProfile.md.
export const outreachScaffoldTokens: ReadonlySet<string> = summarizeTokenSet(outreachStaticLines.join(' '));

export function normalizeOutreachPlatform(raw: OutreachMessageOptions['platform'] | undefined): OutreachPlatform {
  if (raw === undefined || raw === null || String(raw).trim().length === 0) {
    return 'linkedin';
  }
  const normalized = String(raw).toLowerCase();
  if (normalized !== 'linkedin' && normalized !== 'email') {
    throw new OutreachInvalidPlatformError(
      `Unknown outreach platform '${raw}'. Supported platforms: ${outreachPlatforms.join(', ')}.`,
    );
  }
  return normalized;
}

// Contact lookup (SDD Requirement 6). A missing contactId is a hard error, not
// a signal to draft a generic message: the draft is tailored to a specific
// person, and guessing their name/company would be fabrication.
export async function loadOutreachContact(
  contactId: string,
  contactsPath?: string,
  rootDir?: string | null,
): Promise<NetworkingContact> {
  // Relocation-aware defaults (B14f): the contacts path falls back to the
  // effective root (explicit rootDir, else the env/canonical data root), never
  // to an import-time frozen path that ignores relocation.
  const root =
    rootDir !== undefined && rootDir !== null && rootDir.trim().length > 0 ? rootDir : resolveDataRoot();
  const resolvedPath = contactsPath ?? join(root, networkingContactsFileName);
  assertConfinedToRoot(root, resolvedPath, 'loadOutreachContact');
  const contacts = await readNetworkingContacts(resolvedPath, root);
  const contact = contacts.contacts.find((entry) => entry.contactId === contactId);
  if (contact === undefined) {
    const knownIds = contacts.contacts.map((entry) => entry.contactId);
    const knownList = knownIds.length > 0 ? knownIds.join(', ') : '(none)';
    throw new OutreachContactNotFoundError(
      `No networking contact with contactId '${contactId}' in ${resolvedPath}. Known contactIds: ${knownList}. ` +
        'Run addContact first (SDD Requirement 6), then re-run draftOutreach with an existing contactId.',
    );
  }
  return contact;
}

// Ceiling for the grounded summary value line: a summary within this length is
// kept verbatim; a longer one truncates to make room for the ellipsis so the
// rendered line never exceeds the ceiling.
const summaryValueLineMaxLength = 220;
const summaryValueLineTruncateLength = 217;

function groundedValueLine(binding: ResumeBinding, claimableTokens: readonly string[]): string {
  if (claimableTokens.length > 0) {
    for (const token of claimableTokens) {
      for (const entry of binding.experience) {
        for (const bullet of entry.bullets) {
          if (bullet.toLowerCase().includes(token.toLowerCase())) {
            return bullet;
          }
        }
      }
    }
  }
  if (binding.summary.length > 0) {
    return binding.summary.length <= summaryValueLineMaxLength
      ? binding.summary
      : `${binding.summary.slice(0, summaryValueLineTruncateLength)}...`;
  }
  return binding.experience[0]?.bullets[0] ?? '';
}

export interface OutreachBuildMetadata {
  companyName: string;
  roleTitle: string;
  platform: OutreachPlatform;
}

export function buildOutreachMarkdown(
  binding: ResumeBinding,
  contact: NetworkingContact,
  metadata: OutreachBuildMetadata,
  valueLine: string,
): string {
  const firstName = contact.name.split(/\s+/)[0] ?? contact.name;
  const lead = fillRelationshipLead(contact);
  const pursuitLine = `${lead}${outreachStaticLines[1]} ${metadata.roleTitle} ${outreachStaticLines[2]} ${metadata.companyName}.`;

  const lines: string[] = [];
  if (metadata.platform === 'email') {
    lines.push(`${outreachStaticLines[5]} ${metadata.roleTitle} ${outreachStaticLines[2]} ${metadata.companyName}`);
    lines.push('');
  }
  lines.push(`${outreachStaticLines[0]} ${firstName},`);
  lines.push('');
  lines.push(pursuitLine);
  lines.push('');
  if (valueLine.length > 0) {
    lines.push(valueLine);
    lines.push('');
  }
  lines.push(metadata.platform === 'email' ? outreachStaticLines[4] : outreachStaticLines[3]);
  lines.push('');
  lines.push(metadata.platform === 'email' ? outreachStaticLines[7] : outreachStaticLines[6]);
  lines.push(binding.name);
  if (metadata.platform === 'email') {
    const header = [
      `${binding.cityState} | ${binding.email} | ${binding.phone}`,
      [binding.linkedIn, binding.portfolio].filter((value) => value.length > 0).join(' | '),
    ].filter((line) => line.length > 0);
    lines.push('');
    lines.push(...header);
  }
  return lines.join('\n');
}

export async function draftOutreachMessage(options: OutreachMessageOptions): Promise<OutreachMessageResult> {
  const platform = normalizeOutreachPlatform(options.platform);

  const dataRoot = resolveDataRoot(options.dataRoot, options.directories);
  const contactsPath = join(dataRoot, networkingContactsFileName);
  assertConfinedToRoot(dataRoot, contactsPath, 'draftOutreachMessage');
  const contact = await loadOutreachContact(options.contactId, contactsPath, dataRoot);

  const { profile } = await loadValidatedProfile(
    { dataRoot: options.dataRoot, directories: options.directories, label: 'draftOutreachMessage' },
    {
      missingError: OutreachProfileMissingError,
      placeholderError: OutreachProfilePlaceholderError,
    },
  );

  const binding = mapProfileToBinding(profile);
  const profileTokens = unionProfilesTokens(binding);

  const requirements = options.postingRequirements ?? [];
  const claimableTokens = [
    ...new Set(requirements.flatMap((requirement) => claimableRequirementTokens(requirement, profileTokens))),
  ];
  const excludedTokens = excludedRequirementTokens(requirements, profileTokens);

  const contactTokens = summarizeTokenSet(`${contact.name} ${contact.company}`);
  const targetTokens = summarizeTokenSet(`${options.companyName} ${options.roleTitle}`);
  const allowedTokens = new Set<string>([
    ...profileTokens,
    ...outreachScaffoldTokens,
    ...contactTokens,
    ...targetTokens,
  ]);

  const valueLine = groundedValueLine(binding, claimableTokens);
  const markdown = buildOutreachMarkdown(binding, contact, {
    companyName: options.companyName,
    roleTitle: options.roleTitle,
    platform,
  }, valueLine);

  const hallucinations = hallucinatedProseTokens(markdown, allowedTokens);
  if (hallucinations.length > 0) {
    throw new OutreachHallucinationError(
      `Outreach message contains token(s) not traceable to masterProfile.md, the outreach scaffold, the contact, or the target role: ${hallucinations.join(
        ', ',
      )}. This violates the zero-hallucination guarantee (SDD Requirement 1 and 6a).`,
    );
  }
  for (const token of excludedTokens) {
    if (textContainsToken(markdown, token)) {
      throw new OutreachHallucinationError(
        `Posting-only requirement token '${token}' appears in the outreach message but is not present in masterProfile.md. The outreach message never references posting requirements the profile does not genuinely support.`,
      );
    }
  }

  const outputRoot = resolveOutputRoot(undefined, options.directories, dataRoot);
  assertConfinedToRoot(dataRoot, outputRoot, 'draftOutreachMessage');
  const outputFolder = join(outputRoot, applicationFolderSegment(options.companyName, options.roleTitle));
  assertNotReadOnly(outputFolder);
  await mkdir(outputFolder, { recursive: true });
  const markdownPath = join(outputFolder, 'outreachMessage.md');
  await writeFileAtomically(markdownPath, markdown);

  return {
    markdownPath,
    platform,
    contact,
    claimableTokens,
    excludedTokens,
    hallucinatedTokens: hallucinations,
  };
}
