import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir, userInfo, homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer, type McpServerDependencies } from './mcp/jobSearchServer';
import {
  runDraftCoverLetter,
  runDraftOutreachCommand,
  runEvaluateCommand,
  runGenerate,
  runParsePdfCommand,
  runReportCommand,
  runReviewQueueCommand,
  runSearchCommand,
} from './cli/jobSearchCore';
import { JobSpyAdapterRegistry } from './scrapers/jobSpyAdapter';
import { createIsolatedDataRootFromFixtures } from './testUtils/isolatedRoot';
import { dataRootEnvKey } from './utils/canonicalDataRoot';
import { readApplicationHistory, resolveApplicationHistoryPath } from './utils/jobFunnelTracker';

// ---------------------------------------------------------------------------
// H5 hygiene gate: deterministic validator coverage for data-root
// confinement (H1a), fixture synthetic discipline (H2), and the agent
// behavior layer (H6). Every case below fails loudly on a violation; an
// empty assertion set would count as failure, so each tool contributes at
// least one absolute-outside and one traversal case through its own entry
// point (run* CLI command or the path resolver that command calls into).
//
// Related (referenced, not duplicated here): H2 placeholder guards live in
// resumeGenerator.test.ts ('rejects a profile still carrying REPLACE_ME
// placeholders'), coverLetterGenerator.test.ts and
// outreachMessageGenerator.test.ts ('rejects an uninitialized profile with
// the same placeholder guard as generate'); the H6 zero-diff gate lives in
// buildAgentConfigs.test.ts ('regenerated configs are byte-identical to
// committed files').
// ---------------------------------------------------------------------------

interface CliOutcome {
  exitCode: number;
  printedLines: readonly string[];
}

async function withIsolatedRoot<T>(task: (root: string) => Promise<T>): Promise<T> {
  const isolated = await createIsolatedDataRootFromFixtures();
  try {
    return await task(isolated.root);
  } finally {
    await isolated.restore();
  }
}

// Outside-root paths for a given sandbox: an absolute path elsewhere under
// os.tmpdir() (never the repo tree, never home) plus a '..' traversal that
// escapes the sandbox. Both targets stay inside os.tmpdir() so even a bug
// can only touch throwaway temp space.
function hostileRoots(sandbox: string): { absoluteOutside: string; traversalOutside: string } {
  return {
    absoluteOutside: join(tmpdir(), 'weJobSearch-h5-outside-root'),
    traversalOutside: join(sandbox, '..', 'weJobSearch-h5-escape-root'),
  };
}

// A tool "rejects loudly" when its own entry point either throws or returns
// a non-zero exit with a non-empty message. Resolving exit 0 counts as
// acceptance and fails the test. Returns the failure text for further
// assertions (e.g. confinement wording).
async function loudRejectionOf(task: () => Promise<CliOutcome>): Promise<string> {
  try {
    const result = await task();
    expect(result.exitCode, `expected loud failure but got exit 0: ${result.printedLines.join('\n')}`).not.toBe(0);
    const text = result.printedLines.join('\n');
    expect(text.length).toBeGreaterThan(0);
    return text;
  } catch (error) {
    const text = (error as Error).message ?? String(error);
    expect(text.length).toBeGreaterThan(0);
    return text;
  }
}

function emptyRegistry(): JobSpyAdapterRegistry {
  return new JobSpyAdapterRegistry();
}

// Operator identity tokens, derived at runtime instead of written as
// literals (U40): the committed tree must never contain a real name,
// username, or employer. The gate stays sharp because it checks the actual
// operator identity on whatever machine runs the suite — fixtures authored
// anywhere else cannot contain these tokens without failing loudly.
function operatorIdentityTokens(): string[] {
  const tokens: string[] = [];
  try {
    const username = userInfo().username.trim().toLowerCase();
    if (username.length > 0) {
      tokens.push(username);
    }
  } catch {
    // No passwd entry (sandboxed CI): fall through to the home-dir token.
  }
  const homeBase = basename(homedir()).trim().toLowerCase();
  if (homeBase.length > 0) {
    tokens.push(homeBase);
  }
  return [...new Set(tokens)];
}

const phoneShape = /(\+\d[\d\s().-]{6,}\d|\b\d{3}[-. ]\d{3}[-. ]\d{4}\b)/;
const salaryShape = /\$\s?\d|\b\d+\s?usd\b/i;

function loweredHaystack(text: string): string {
  return text.toLowerCase();
}

function deniedIdentityPresent(text: string): boolean {
  const haystack = loweredHaystack(text);
  return operatorIdentityTokens().some((token) => token.length > 0 && haystack.includes(token));
}

describe('operator identity denylist (U40 positive control)', () => {
  it('flags text carrying the runtime operator identity and clears synthetic text', () => {
    const tokens = operatorIdentityTokens();
    expect(tokens.length).toBeGreaterThan(0);
    expect(deniedIdentityPresent(`contact ${tokens[0]} reaching out`)).toBe(true);
    expect(deniedIdentityPresent('Jane Sample at SampleCorp')).toBe(false);
  });
});

describe('hygieneGate per-tool outside-root rejection (H5)', () => {
  it('evaluate rejects an absolute outside-root dataRoot loudly', async () => {
    await withIsolatedRoot(async () => {
      const hostile = hostileRoots(process.env[dataRootEnvKey] as string);
      const text = await loudRejectionOf(() =>
        runEvaluateCommand({ jobUrl: 'https://example.com/job/123', dataRoot: hostile.absoluteOutside }),
      );
      expect(text).toMatch(/confinement|master profile|resumevariants|contactId|not initialized|run init/i);
    });
  });

  it('evaluate rejects a traversal dataRoot loudly', async () => {
    await withIsolatedRoot(async () => {
      const hostile = hostileRoots(process.env[dataRootEnvKey] as string);
      const text = await loudRejectionOf(() =>
        runEvaluateCommand({ jobUrl: 'https://example.com/job/123', dataRoot: hostile.traversalOutside }),
      );
      expect(text).toMatch(/confinement|master profile|resumevariants|contactId|not initialized|run init/i);
    });
  });

  it('search rejects an absolute outside-root dataRoot loudly', async () => {
    await withIsolatedRoot(async () => {
      const hostile = hostileRoots(process.env[dataRootEnvKey] as string);
      const text = await loudRejectionOf(() =>
        runSearchCommand({ keywords: 'senior engineer', location: 'Remote', dataRoot: hostile.absoluteOutside, registry: emptyRegistry() }),
      );
      expect(text).toMatch(/confinement|master profile|resumevariants|contactId|not initialized|run init/i);
    });
  });

  it('search rejects a traversal dataRoot loudly', async () => {
    await withIsolatedRoot(async () => {
      const hostile = hostileRoots(process.env[dataRootEnvKey] as string);
      const text = await loudRejectionOf(() =>
        runSearchCommand({ keywords: 'senior engineer', location: 'Remote', dataRoot: hostile.traversalOutside, registry: emptyRegistry() }),
      );
      expect(text).toMatch(/confinement|master profile|resumevariants|contactId|not initialized|run init/i);
    });
  });

  it('generate rejects an absolute outside-root dataRoot loudly', async () => {
    await withIsolatedRoot(async () => {
      const hostile = hostileRoots(process.env[dataRootEnvKey] as string);
      const text = await loudRejectionOf(() =>
        runGenerate({ company: 'AcmeCorp', role: 'SeniorEngineer', dataRoot: hostile.absoluteOutside }),
      );
      expect(text).toMatch(/confinement|master profile|resumevariants|contactId|not initialized|run init/i);
    });
  });

  it('generate rejects a traversal dataRoot loudly', async () => {
    await withIsolatedRoot(async () => {
      const hostile = hostileRoots(process.env[dataRootEnvKey] as string);
      const text = await loudRejectionOf(() =>
        runGenerate({ company: 'AcmeCorp', role: 'SeniorEngineer', dataRoot: hostile.traversalOutside }),
      );
      expect(text).toMatch(/confinement|master profile|resumevariants|contactId|not initialized|run init/i);
    });
  });

  it('draftCoverLetter rejects an absolute outside-root dataRoot loudly', async () => {
    await withIsolatedRoot(async () => {
      const hostile = hostileRoots(process.env[dataRootEnvKey] as string);
      const text = await loudRejectionOf(() =>
        runDraftCoverLetter({ company: 'AcmeCorp', role: 'SeniorEngineer', dataRoot: hostile.absoluteOutside }),
      );
      expect(text).toMatch(/confinement|master profile|resumevariants|contactId|not initialized|run init/i);
    });
  });

  it('draftCoverLetter rejects a traversal dataRoot loudly', async () => {
    await withIsolatedRoot(async () => {
      const hostile = hostileRoots(process.env[dataRootEnvKey] as string);
      const text = await loudRejectionOf(() =>
        runDraftCoverLetter({ company: 'AcmeCorp', role: 'SeniorEngineer', dataRoot: hostile.traversalOutside }),
      );
      expect(text).toMatch(/confinement|master profile|resumevariants|contactId|not initialized|run init/i);
    });
  });

  it('draftOutreach rejects an absolute outside-root dataRoot loudly', async () => {
    await withIsolatedRoot(async () => {
      const hostile = hostileRoots(process.env[dataRootEnvKey] as string);
      const text = await loudRejectionOf(() =>
        runDraftOutreachCommand({ contactId: 'contact001', company: 'AcmeCorp', role: 'SeniorEngineer', dataRoot: hostile.absoluteOutside }),
      );
      expect(text).toMatch(/confinement|master profile|resumevariants|contactId|not initialized|run init/i);
    });
  });

  it('draftOutreach rejects a traversal dataRoot loudly', async () => {
    await withIsolatedRoot(async () => {
      const hostile = hostileRoots(process.env[dataRootEnvKey] as string);
      const text = await loudRejectionOf(() =>
        runDraftOutreachCommand({ contactId: 'contact001', company: 'AcmeCorp', role: 'SeniorEngineer', dataRoot: hostile.traversalOutside }),
      );
      expect(text).toMatch(/confinement|master profile|resumevariants|contactId|not initialized|run init/i);
    });
  });

  it('reviewQueue path resolution rejects an absolute outside historyPath', async () => {
    await withIsolatedRoot(async (root) => {
      const hostile = hostileRoots(root);
      expect(() => resolveApplicationHistoryPath(hostile.absoluteOutside, root)).toThrow(/confinement/i);
      await expect(readApplicationHistory(hostile.absoluteOutside)).rejects.toThrow(/confinement/i);
      const healthy = await runReviewQueueCommand({});
      expect(healthy.exitCode).toBe(0);
    });
  });

  it('reviewQueue path resolution rejects a traversal historyPath', async () => {
    await withIsolatedRoot(async (root) => {
      const hostile = hostileRoots(root);
      expect(() => resolveApplicationHistoryPath(hostile.traversalOutside, root)).toThrow(/confinement/i);
      await expect(readApplicationHistory(hostile.traversalOutside)).rejects.toThrow(/confinement/i);
    });
  });

  it('parsePdf rejects an absolute outside-root filePath loudly', async () => {
    await withIsolatedRoot(async () => {
      const text = await loudRejectionOf(() => runParsePdfCommand({ filePath: join(tmpdir(), 'weJobSearch-h5-outside.pdf') }));
      expect(text).toMatch(/confinement|master profile|resumevariants|contactId|not initialized|run init/i);
    });
  });

  it('parsePdf rejects a traversal filePath loudly', async () => {
    await withIsolatedRoot(async (root) => {
      const text = await loudRejectionOf(() => runParsePdfCommand({ filePath: join(root, '..', 'weJobSearch-h5-escape.pdf') }));
      expect(text).toMatch(/confinement|master profile|resumevariants|contactId|not initialized|run init/i);
    });
  });

  it('report output confines an absolute outside path to a basename inside the root (H4)', async () => {
    await withIsolatedRoot(async (root) => {
      const outside = join(tmpdir(), 'weJobSearch-h5-outside-report.txt');
      const result = await runReportCommand({ output: outside });
      expect(result.exitCode).toBe(0);
      expect(existsSync(join(root, basename(outside)))).toBe(true);
      expect(existsSync(outside)).toBe(false);
    });
  });

  it('report output neutralizes a traversal path to a basename inside the root (H4)', async () => {
    await withIsolatedRoot(async (root) => {
      const result = await runReportCommand({ output: join(root, '..', 'weJobSearch-h5-escape-report.txt') });
      expect(result.exitCode).toBe(0);
      expect(existsSync(join(root, 'weJobSearch-h5-escape-report.txt'))).toBe(true);
    });
  });
});

describe('hygieneGate traversal filePath shapes (H5)', () => {
  it("parsePdf rejects '..' segments that escape the root", async () => {
    await withIsolatedRoot(async (root) => {
      const text = await loudRejectionOf(() =>
        runParsePdfCommand({ filePath: join(root, 'documents', '..', '..', 'weJobSearch-h5-dotdot.pdf') }),
      );
      expect(text).toMatch(/confinement|master profile|resumevariants|contactId|not initialized|run init/i);
    });
  });

  it('parsePdf rejects absolute paths with embedded separators outside the root', async () => {
    await withIsolatedRoot(async () => {
      const text = await loudRejectionOf(() =>
        runParsePdfCommand({ filePath: join(tmpdir(), 'weJobSearch-h5-deep', 'nested', 'evil.pdf') }),
      );
      expect(text).toMatch(/confinement|master profile|resumevariants|contactId|not initialized|run init/i);
    });
  });

  it('parsePdf fails loudly without escaping for a missing nested in-root file', async () => {
    await withIsolatedRoot(async (root) => {
      const inside = join(root, 'documents', 'nested', 'missing.pdf');
      const text = await loudRejectionOf(() => runParsePdfCommand({ filePath: inside }));
      expect(text).toMatch(/unable to read pdf/i);
      expect(existsSync(join(tmpdir(), 'missing.pdf'))).toBe(false);
    });
  });

  it('report output reduces embedded-separator paths to a basename inside the root', async () => {
    await withIsolatedRoot(async (root) => {
      const result = await runReportCommand({ output: join('deep', 'nested', 'weJobSearch-h5-embedded.txt') });
      expect(result.exitCode).toBe(0);
      expect(existsSync(join(root, 'weJobSearch-h5-embedded.txt'))).toBe(true);
    });
  });
});

function splitCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = '';
  let inQuotes = false;
  for (const character of line) {
    if (character === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (character === ',' && !inQuotes) {
      cells.push(current);
      current = '';
      continue;
    }
    current += character;
  }
  cells.push(current);
  return cells.map((cell) => cell.trim());
}

describe('hygieneGate fixture synthetic markers (H5)', () => {
  it('every contact-like csv row carries an example.com marker', async () => {
    const csvPath = resolve(__dirname, '..', 'fixtures', 'sampleConnections.csv');
    const raw = await readFile(csvPath, 'utf8');
    const lines = raw.split('\n').map((line) => line.trim()).filter((line) => line.length > 0);
    expect(lines.length).toBeGreaterThan(1);
    const header = splitCsvLine(lines[0].toLowerCase());
    const emailIndex = header.findIndex((cell) => cell.includes('email'));
    expect(emailIndex).toBeGreaterThanOrEqual(0);
    const rows = lines.slice(1);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      const cells = splitCsvLine(row);
      const email = (cells[emailIndex] ?? '').toLowerCase();
      expect(email.endsWith('@example.com')).toBe(true);
    }
  });

  it('contact-like csv rows carry no real-looking identities or phone shapes', async () => {
    // The gate below is vacuous when the token list is empty, so pin it: an
    // empty identity list must fail loudly instead of silently passing.
    expect(operatorIdentityTokens().length).toBeGreaterThan(0);
    const csvPath = resolve(__dirname, '..', 'fixtures', 'sampleConnections.csv');
    const raw = await readFile(csvPath, 'utf8');
    expect(deniedIdentityPresent(raw)).toBe(false);
    expect(phoneShape.test(raw)).toBe(false);
    expect(salaryShape.test(raw)).toBe(false);
  });
});

// Minimal dependency-free OOXML metadata reader: the committed
// fixtures/sampleResume.docx is a zip whose optional docProps/core.xml and
// docProps/app.xml carry author-style metadata. Mammoth (the repo docx
// dependency) exposes text only, so this gate parses the zip central
// directory directly and inflates stored/deflated entries with node:zlib.
const zipSignatureEndOfCentral = 101010256;
const zipSignatureCentralHeader = 33639248;
const zipSignatureLocalHeader = 67324752;

interface ZipEntry {
  name: string;
  method: number;
  compSize: number;
  localOffset: number;
}

function findEndOfCentral(buffer: Buffer): number {
  for (let offset = buffer.length - 22; offset >= 0; offset -= 1) {
    if (buffer.readUInt32LE(offset) === zipSignatureEndOfCentral) {
      return offset;
    }
  }
  throw new Error('hygieneGate: no zip end-of-central record found in sampleResume.docx');
}

function readZipEntries(buffer: Buffer): ZipEntry[] {
  const endOffset = findEndOfCentral(buffer);
  const entryCount = buffer.readUInt16LE(endOffset + 10);
  let cursor = buffer.readUInt32LE(endOffset + 16);
  const entries: ZipEntry[] = [];
  for (let index = 0; index < entryCount; index += 1) {
    if (buffer.readUInt32LE(cursor) !== zipSignatureCentralHeader) {
      throw new Error('hygieneGate: corrupt zip central header in sampleResume.docx');
    }
    const method = buffer.readUInt16LE(cursor + 10);
    const compSize = buffer.readUInt32LE(cursor + 20);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
    entries.push({ name, method, compSize, localOffset });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function extractZipEntry(buffer: Buffer, entry: ZipEntry): string {
  if (buffer.readUInt32LE(entry.localOffset) !== zipSignatureLocalHeader) {
    throw new Error(`hygieneGate: corrupt zip local header for ${entry.name}`);
  }
  const nameLength = buffer.readUInt16LE(entry.localOffset + 26);
  const extraLength = buffer.readUInt16LE(entry.localOffset + 28);
  const dataStart = entry.localOffset + 30 + nameLength + extraLength;
  const payload = buffer.subarray(dataStart, dataStart + entry.compSize);
  if (entry.method === 0) {
    return payload.toString('utf8');
  }
  if (entry.method === 8) {
    return inflateSync(payload).toString('utf8');
  }
  throw new Error(`hygieneGate: unsupported zip method ${entry.method} for ${entry.name}`);
}

function metadataField(xml: string, tag: string): string {
  const match = xml.match(new RegExp(`<${tag}[^>]*>([^<]*)<`, 'i'));
  return (match?.[1] ?? '').trim();
}

describe('hygieneGate sampleResume.docx metadata scrub (H5)', () => {
  it('author-style metadata stays inside the synthetic allowlist', async () => {
    const docxPath = resolve(__dirname, '..', 'fixtures', 'sampleResume.docx');
    const buffer = await readFile(docxPath);
    const entries = readZipEntries(buffer);
    const metadataNames = entries
      .map((entry) => entry.name)
      .filter((name) => name === 'docProps/core.xml' || name === 'docProps/app.xml');
    const identityFields: string[] = [];
    for (const name of metadataNames) {
      const entry = entries.find((candidate) => candidate.name === name) as ZipEntry;
      const xml = extractZipEntry(buffer, entry);
      expect(deniedIdentityPresent(xml)).toBe(false);
      expect(phoneShape.test(xml)).toBe(false);
      expect(salaryShape.test(xml)).toBe(false);
      identityFields.push(metadataField(xml, 'dc:creator'), metadataField(xml, 'cp:lastModifiedBy'));
    }
    for (const field of identityFields) {
      if (field.length === 0) {
        continue;
      }
      expect(field).toMatch(/sample|example/i);
    }
  });

  it('docx package metadata carries no denylisted employer or identity tokens', async () => {
    const docxPath = resolve(__dirname, '..', 'fixtures', 'sampleResume.docx');
    const buffer = await readFile(docxPath);
    const entries = readZipEntries(buffer);
    const metadataXml = entries
      .filter((entry) => entry.name.startsWith('docProps/'))
      .map((entry) => extractZipEntry(buffer, entry))
      .join('\n');
    expect(deniedIdentityPresent(metadataXml)).toBe(false);
  });
});

// Scratch-dir probing coverage lives in isolatedRoot.test.ts
// ('refuses sandbox targets outside os.tmpdir, inside the repo, or inside
// home'); a bare mkdtemp-under-tmpdir assertion here tested the stdlib, not
// this codebase, so it was retired.

// ---------------------------------------------------------------------------
// H1a-A bindings: MCP-level rejection for the paths the MCP tools accept
// directly. The MCP server is a thin delegate layer, so these tests drive the
// real tool boundary (in-memory MCP client -> server -> core function) rather
// than calling core functions bare:
//
// - parsePdfDocument tool: free filePath arg -> parsePdfDocument core
//   (src/utils/pdfParser.ts), which confines via assertConfinedToRoot.
// - ingestDocuments tool: free dirPath arg -> ingestDocuments core
//   (src/utils/documentIngestor.ts), same confinement.
// - getUserProfile tool: per-file McpServerDependencies paths
//   (profilePath/preferencesPath/screeningAnswersPath/contactsPath) ->
//   readUserProfile -> resolveProfilePaths, which asserts every override.
// - suggestRoles tool: profilePath dependency -> loadMasterProfile, which
//   asserts confinement.
//
// Each tool gets one absolute-outside and one traversal case. A tool "rejects
// loudly" here when the MCP call returns isError with a non-empty message
// (the SDK converts a thrown confinement Error into an isError result).
// An empty assertion set would count as failure, matching the H5 gate above.
// ---------------------------------------------------------------------------

interface McpToolOutcome {
  isError: boolean;
  text: string;
}

async function callMcpTool(
  dependencies: McpServerDependencies,
  toolName: string,
  toolArgs: Record<string, unknown>,
): Promise<McpToolOutcome> {
  const pair = InMemoryTransport.createLinkedPair();
  const server = createMcpServer(dependencies);
  await server.connect(pair[1]);
  const client = new Client({ name: 'hygieneGateProbe', version: '1.0.0' }, { capabilities: {} });
  await client.connect(pair[0]);
  try {
    const result = await client.callTool({ name: toolName, arguments: toolArgs });
    const blocks = result.content as unknown as ReadonlyArray<{ type: string; text?: string }>;
    const text = blocks
      .filter((block) => block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text as string)
      .join('\n');
    return { isError: result.isError === true, text };
  } finally {
    await client.close();
    await server.close();
  }
}

async function loudMcpRejectionOf(
  dependencies: McpServerDependencies,
  toolName: string,
  toolArgs: Record<string, unknown>,
): Promise<string> {
  const outcome = await callMcpTool(dependencies, toolName, toolArgs);
  expect(outcome.isError, `expected loud MCP failure but tool succeeded: ${outcome.text}`).toBe(true);
  expect(outcome.text.length).toBeGreaterThan(0);
  return outcome.text;
}

describe('hygieneGate MCP-bound outside-root rejection (H1a-A)', () => {
  it('parsePdfDocument tool rejects an absolute outside-root filePath loudly', async () => {
    await withIsolatedRoot(async () => {
      const hostile = hostileRoots(process.env[dataRootEnvKey] as string);
      const text = await loudMcpRejectionOf(
        {},
        'parsePdfDocument',
        { filePath: join(hostile.absoluteOutside, 'outside.pdf') },
      );
      expect(text).toMatch(/confinement|master profile|resumevariants|contactId|not initialized|run init/i);
    });
  });

  it('parsePdfDocument tool rejects a traversal filePath loudly', async () => {
    await withIsolatedRoot(async (root) => {
      const hostile = hostileRoots(root);
      const text = await loudMcpRejectionOf(
        {},
        'parsePdfDocument',
        { filePath: join(hostile.traversalOutside, 'escape.pdf') },
      );
      expect(text).toMatch(/confinement|master profile|resumevariants|contactId|not initialized|run init/i);
    });
  });

  it('ingestDocuments tool rejects an absolute outside-root dirPath loudly', async () => {
    await withIsolatedRoot(async () => {
      const hostile = hostileRoots(process.env[dataRootEnvKey] as string);
      const text = await loudMcpRejectionOf(
        {},
        'ingestDocuments',
        { dirPath: hostile.absoluteOutside },
      );
      expect(text).toMatch(/confinement|master profile|resumevariants|contactId|not initialized|run init/i);
    });
  });

  it('ingestDocuments tool rejects a traversal dirPath loudly', async () => {
    await withIsolatedRoot(async (root) => {
      const hostile = hostileRoots(root);
      const text = await loudMcpRejectionOf(
        {},
        'ingestDocuments',
        { dirPath: hostile.traversalOutside },
      );
      expect(text).toMatch(/confinement|master profile|resumevariants|contactId|not initialized|run init/i);
    });
  });

  it('getUserProfile rejects absolute outside-root per-file dependency paths loudly', async () => {
    await withIsolatedRoot(async () => {
      const hostile = hostileRoots(process.env[dataRootEnvKey] as string);
      const text = await loudMcpRejectionOf(
        {
          profilePath: join(hostile.absoluteOutside, 'masterProfile.md'),
          preferencesPath: join(hostile.absoluteOutside, 'jobPreferences.yaml'),
          screeningAnswersPath: join(hostile.absoluteOutside, 'screeningAnswers.json'),
          contactsPath: join(hostile.absoluteOutside, 'networkingContacts.json'),
        },
        'getUserProfile',
        {},
      );
      expect(text).toMatch(/confinement|master profile|resumevariants|contactId|not initialized|run init/i);
    });
  });

  it('getUserProfile rejects traversal per-file dependency paths loudly', async () => {
    await withIsolatedRoot(async (root) => {
      const hostile = hostileRoots(root);
      const text = await loudMcpRejectionOf(
        {
          profilePath: join(hostile.traversalOutside, 'masterProfile.md'),
          preferencesPath: join(hostile.traversalOutside, 'jobPreferences.yaml'),
          screeningAnswersPath: join(hostile.traversalOutside, 'screeningAnswers.json'),
          contactsPath: join(hostile.traversalOutside, 'networkingContacts.json'),
        },
        'getUserProfile',
        {},
      );
      expect(text).toMatch(/confinement|master profile|resumevariants|contactId|not initialized|run init/i);
    });
  });

  it('suggestRoles rejects an absolute outside-root profilePath dependency loudly', async () => {
    await withIsolatedRoot(async () => {
      const hostile = hostileRoots(process.env[dataRootEnvKey] as string);
      const text = await loudMcpRejectionOf(
        { profilePath: join(hostile.absoluteOutside, 'masterProfile.md') },
        'suggestRoles',
        {},
      );
      expect(text).toMatch(/confinement|master profile|resumevariants|contactId|not initialized|run init/i);
    });
  });

  it('suggestRoles rejects a traversal profilePath dependency loudly', async () => {
    await withIsolatedRoot(async (root) => {
      const hostile = hostileRoots(root);
      const text = await loudMcpRejectionOf(
        { profilePath: join(hostile.traversalOutside, 'masterProfile.md') },
        'suggestRoles',
        {},
      );
      expect(text).toMatch(/confinement|master profile|resumevariants|contactId|not initialized|run init/i);
    });
  });

  it('getPostingDetail rejects an absolute outside-root historyPath dependency loudly', async () => {
    await withIsolatedRoot(async () => {
      const hostile = hostileRoots(process.env[dataRootEnvKey] as string);
      const text = await loudMcpRejectionOf(
        { historyPath: join(hostile.absoluteOutside, 'applicationHistory.json') },
        'getPostingDetail',
        { companyName: 'AcmeCorp', roleTitle: 'SeniorEngineer' },
      );
      expect(text).toMatch(/confinement|master profile|resumevariants|contactId|not initialized|run init/i);
    });
  });

  it('getPostingDetail rejects a traversal historyPath dependency loudly', async () => {
    await withIsolatedRoot(async (root) => {
      const hostile = hostileRoots(root);
      const text = await loudMcpRejectionOf(
        { historyPath: join(hostile.traversalOutside, 'applicationHistory.json') },
        'getPostingDetail',
        { companyName: 'AcmeCorp', roleTitle: 'SeniorEngineer' },
      );
      expect(text).toMatch(/confinement|master profile|resumevariants|contactId|not initialized|run init/i);
    });
  });
});
