import { join } from 'node:path';
import { z } from 'zod';
import {
  canonicalContactsPath,
  networkingContactsFileName,
  redactHomePrefix,
} from './canonicalDataRoot';
import {
  readJsonStoreFile,
  resolveStoreFilePath,
  resolveStoreRoot,
  writeJsonStoreFile,
} from './jsonStore';

// Networking & referral tracking (SDD Requirement 6). Tracks people, not
// postings: networkingContacts.json (under the canonical data root) is a
// tracker, never an outreach engine — nothing here sends messages (SDD Section
// 1.4). Same data-integrity discipline as jobFunnelTracker.ts (Section 6.4):
// every write validates the existing file first and is atomic (temp file +
// rename), so an interrupted process cannot corrupt the tracking database and a
// malformed file crashes the write with a clear error instead of being
// overwritten with bad data.

export const networkingContactSchema = z.object({
  contactId: z.string(),
  name: z.string(),
  company: z.string(),
  relationship: z.string(),
  lastContactDate: z.string(),
  linkedApplicationIds: z.array(z.string()),
  followUpDue: z.string(),
});
export type NetworkingContact = z.infer<typeof networkingContactSchema>;

export const networkingContactsSchema = z.object({
  contacts: z.array(networkingContactSchema),
});
export type NetworkingContacts = z.infer<typeof networkingContactsSchema>;

// Resolved at call time (not import time) so a relocated WEJOBSEARCHDATAROOT
// set after import is honored.
export function defaultNetworkingContactsPath(): string {
  return canonicalContactsPath();
}

function dateStringOf(referenceDate?: Date): string {
  return (referenceDate ?? new Date()).toISOString().slice(0, 10);
}

// Deterministic sequential id generation mirroring generateApplicationId in
// jobFunnelTracker.ts: contact001..contactNNN, next id past any existing ones
// (SDD Requirement 6 example shape).
export function generateContactId(contacts: readonly NetworkingContact[]): string {
  let maxIndex = 0;
  for (const contact of contacts) {
    const match = /^contact(\d+)$/.exec(contact.contactId);
    if (match !== null) {
      const index = Number.parseInt(match[1], 10);
      if (index > maxIndex) {
        maxIndex = index;
      }
    }
  }
  return `contact${String(maxIndex + 1).padStart(3, '0')}`;
}

export interface NewContactInput {
  name: string;
  company: string;
  relationship?: string;
  linkedApplicationIds?: readonly string[];
  followUpDue?: string;
  lastContactDate?: string;
}

const defaultRelationship = 'unspecified';

// Phase D: a non-empty followUpDue must be a parseable date. An unvalidated
// string previously passed straight through addContact into the report, where
// the overdue check silently treated it as "not overdue". Fail loudly at
// intake instead; the empty string (no follow-up scheduled) stays valid.
function validateFollowUpDue(followUpDue: string | undefined): string {
  const value = followUpDue ?? '';
  if (value.length === 0) {
    return '';
  }
  if (Number.isNaN(Date.parse(value))) {
    throw new Error(
      `networking contact followUpDue '${value}' is not a parseable date (expected YYYY-MM-DD)`,
    );
  }
  return value;
}

// Input shape matches what the addContact CLI / logNetworkingContact MCP tool
// accept; the example file at profile/networkingContacts.example.json is the
// structural template the real-file output must match (all-level keys, nothing
// invented).
export function buildNetworkingContact(
  input: NewContactInput,
  existingContacts: readonly NetworkingContact[] = [],
  referenceDate?: Date,
): NetworkingContact {
  if (input.name.trim().length === 0) {
    throw new Error('networking contact requires a non-empty name');
  }
  if (input.company.trim().length === 0) {
    throw new Error('networking contact requires a non-empty company');
  }
  const contact = {
    contactId: generateContactId(existingContacts),
    name: input.name,
    company: input.company,
    relationship: input.relationship ?? defaultRelationship,
    lastContactDate: input.lastContactDate ?? dateStringOf(referenceDate),
    linkedApplicationIds: [...(input.linkedApplicationIds ?? [])],
    followUpDue: validateFollowUpDue(input.followUpDue),
  };
  return networkingContactSchema.parse(contact);
}

export async function readNetworkingContacts(
  filePath?: string | null,
  rootDir?: string | null,
): Promise<NetworkingContacts> {
  // Confinement is checked against the effective root: an explicit rootDir
  // (relocated reads) or the env/canonical data root otherwise. The default
  // path is derived from that same root (U43) — defaulting from
  // resolveDataRoot() first made relocated reads resolve the canonical path
  // and then fail confinement against the relocated root.
  const root = resolveStoreRoot(rootDir);
  const resolvedPath = resolveStoreFilePath(filePath, join(root, networkingContactsFileName));
  return readJsonStoreFile({
    resolvedPath,
    root,
    label: 'readNetworkingContacts',
    noun: 'networking contacts',
    schema: networkingContactsSchema,
    missing: () => ({ contacts: [] }),
  });
}

// Validate-before-write (SDD Section 6.4): refuse to write if the existing
// file is already malformed, and refuse to write structurally invalid content,
// surfacing the error instead of overwriting bad data with more bad data.
export async function writeNetworkingContacts(
  contacts: NetworkingContacts,
  filePath?: string | null,
  rootDir?: string | null,
): Promise<void> {
  const root = resolveStoreRoot(rootDir);
  const resolvedPath = resolveStoreFilePath(filePath, join(root, networkingContactsFileName));
  await writeJsonStoreFile({
    data: contacts,
    resolvedPath,
    noun: 'networking contacts',
    schema: networkingContactsSchema,
    verifyExisting: () => readNetworkingContacts(resolvedPath, root),
    confine: { root, label: 'writeNetworkingContacts' },
  });
}

export async function addNetworkingContact(
  input: NewContactInput,
  filePath?: string | null,
  options: { referenceDate?: Date; rootDir?: string | null } = {},
): Promise<NetworkingContact> {
  const root = resolveStoreRoot(options.rootDir);
  const resolvedPath = resolveStoreFilePath(filePath, join(root, networkingContactsFileName));
  const current = await readNetworkingContacts(resolvedPath, root);
  const contact = buildNetworkingContact(input, current.contacts, options.referenceDate);
  if (current.contacts.some((existing) => existing.contactId === contact.contactId)) {
    throw new Error(`Contact with id ${contact.contactId} already exists in ${redactHomePrefix(resolvedPath)}`);
  }
  current.contacts.push(contact);
  await writeNetworkingContacts(current, resolvedPath, root);
  return contact;
}
