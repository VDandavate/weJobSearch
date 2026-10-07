import { readFile } from 'node:fs/promises';
import {
  buildNetworkingContact,
  defaultNetworkingContactsPath,
  readNetworkingContacts,
  writeNetworkingContacts,
  type NetworkingContact,
  type NetworkingContacts,
} from './networkingContacts';

// LinkedIn connections/profile import (EUO-14, SDD Requirement 6). Parses the
// user's own LinkedIn connections CSV export into networkingContacts.json
// entries. Two safety properties are structural, not conventional:
//
//   - The source CSV is read-only (N6): importConnections only ever reads the
//     export file; every test pins the source bytes unchanged after an import.
//   - The contacts write is confirmation-gated (N9): with `confirmed: false`
//     the function returns the proposed additions and writes nothing; only an
//     explicit `confirmed: true` performs the (atomic, schema-validated) write
//     through networkingContacts.ts's existing write path.
//
// Parsing is a deterministic pure function (N7): no network, no LLM, no date
// formatting beyond the contacts store's own defaults.
//
// Ownership (Phase 5c): @standalone CSV utility. No CLI or MCP importer by
// design: the pure parse (parseConnectionsCsv) plus the confirmation-gated
// import (importConnections) are used directly with an explicit CSV path and
// contacts path. Standalone contract pinned in the moduleOwnership block of
// linkedInImport.test.ts. If a future flow wires this module, replace this
// note with the consumer name instead of leaving both.

export const linkedInRelationship = 'linkedInConnection';

export interface ParsedConnection {
  name: string;
  company: string;
  relationship: string;
}

export interface ImportConnectionsOptions {
  /** N9: only a true value permits the write; anything else proposes only. */
  confirmed: boolean;
  /** Temp-dir / canonical-root override for networkingContacts.json. */
  contactsPath?: string;
  /** Deterministic lastContactDate reference for tests. */
  referenceDate?: Date;
}

export interface ImportConnectionsResult {
  written: boolean;
  proposedAdditions: NetworkingContact[];
  /** Rows in the CSV that carried no usable name or company. */
  skippedRows: number;
  /** Parsed rows that were dropped because they duplicated an existing or earlier contact. */
  duplicateCount: number;
  contactsPath: string;
}

interface CsvParseResult {
  connections: ParsedConnection[];
  skippedRows: number;
}

// ---------------------------------------------------------------------------
// Minimal RFC-4180-style CSV tokenizer: quoted fields (with "" escapes and
// embedded commas/newlines), CRLF or LF row endings, and a UTF-8 BOM.
// ---------------------------------------------------------------------------

function parseCsvRows(text: string): string[][] {
  const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let index = 0;
  while (index < input.length) {
    const ch = input[index];
    if (inQuotes) {
      if (ch === '"') {
        if (input[index + 1] === '"') {
          field += '"';
          index += 2;
        } else {
          inQuotes = false;
          index += 1;
        }
      } else {
        field += ch;
        index += 1;
      }
    } else if (ch === '"' && field.length === 0) {
      inQuotes = true;
      index += 1;
    } else if (ch === ',') {
      row.push(field);
      field = '';
      index += 1;
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      index += 1;
    } else if (ch === '\r') {
      if (input[index + 1] !== '\n') {
        row.push(field);
        rows.push(row);
        row = [];
        field = '';
      }
      index += 1;
    } else {
      field += ch;
      index += 1;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function findColumnIndex(header: readonly string[], candidates: readonly string[]): number {
  const normalized = header.map((cell) => cell.trim().toLowerCase());
  for (const candidate of candidates) {
    const index = normalized.indexOf(candidate);
    if (index !== -1) {
      return index;
    }
  }
  return -1;
}

function normalizeKeyPart(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

function parseConnectionsCsvInternal(csvText: string): CsvParseResult {
  const rows = parseCsvRows(csvText);
  const headerIndex = rows.findIndex((row) => row.some((cell) => cell.trim().length > 0));
  if (headerIndex === -1) {
    return { connections: [], skippedRows: 0 };
  }
  const header = rows[headerIndex];
  const firstNameIndex = findColumnIndex(header, ['first name']);
  const lastNameIndex = findColumnIndex(header, ['last name']);
  const companyIndex = findColumnIndex(header, ['company']);

  const connections: ParsedConnection[] = [];
  let skippedRows = 0;
  for (let rowIndex = headerIndex + 1; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex];
    if (row.length === 0 || row.every((cell) => cell.trim().length === 0)) {
      continue;
    }
    const firstName = (firstNameIndex >= 0 ? row[firstNameIndex] ?? '' : '').trim();
    const lastName = (lastNameIndex >= 0 ? row[lastNameIndex] ?? '' : '').trim();
    const company = (companyIndex >= 0 ? row[companyIndex] ?? '' : '').trim();
    const name = [firstName, lastName].filter(Boolean).join(' ');
    if (name.length === 0 || company.length === 0) {
      skippedRows += 1;
      continue;
    }
    connections.push({ name, company, relationship: linkedInRelationship });
  }
  return { connections, skippedRows };
}

/** Pure, deterministic parse of a LinkedIn connections-export CSV. */
export function parseConnectionsCsv(csvText: string): ParsedConnection[] {
  return parseConnectionsCsvInternal(csvText).connections;
}

/**
 * Import a LinkedIn connections CSV export into networkingContacts.json.
 *
 * Reads the CSV read-only (N6), parses it, deduplicates against the existing
 * contacts (by normalized name+company, and within the batch), and writes the
 * merged set atomically through networkingContacts.ts only when
 * `confirmed: true` (N9). A missing CSV is a clear error, never a silent no-op.
 */
export async function importConnections(
  csvPath: string,
  options: ImportConnectionsOptions,
): Promise<ImportConnectionsResult> {
  let csvText: string;
  try {
    csvText = await readFile(csvPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`LinkedIn connections CSV not found at ${csvPath}`);
    }
    throw error;
  }

  const parsed = parseConnectionsCsvInternal(csvText);
  const contactsPath = options.contactsPath ?? defaultNetworkingContactsPath();
  const current = await readNetworkingContacts(contactsPath);

  const existingKeys = new Set(
    current.contacts.map(
      (contact) => `${normalizeKeyPart(contact.name)}\u0000${normalizeKeyPart(contact.company)}`,
    ),
  );

  const additions: NetworkingContact[] = [];
  const seenInBatch = new Set<string>();
  let duplicateCount = 0;
  for (const connection of parsed.connections) {
    const key = `${normalizeKeyPart(connection.name)}\u0000${normalizeKeyPart(connection.company)}`;
    if (existingKeys.has(key) || seenInBatch.has(key)) {
      duplicateCount += 1;
      continue;
    }
    seenInBatch.add(key);
    additions.push(
      buildNetworkingContact(
        {
          name: connection.name,
          company: connection.company,
          relationship: connection.relationship,
        },
        [...current.contacts, ...additions],
        options.referenceDate,
      ),
    );
  }

  if (!options.confirmed) {
    return {
      written: false,
      proposedAdditions: additions,
      skippedRows: parsed.skippedRows,
      duplicateCount,
      contactsPath,
    };
  }

  const merged: NetworkingContacts = { contacts: [...current.contacts, ...additions] };
  await writeNetworkingContacts(merged, contactsPath);
  return {
    written: true,
    proposedAdditions: additions,
    skippedRows: parsed.skippedRows,
    duplicateCount,
    contactsPath,
  };
}
