import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { checkAtsCompliance, extractPdfText, type AtsCheckResult } from '../utils/atsChecker';
import { keywordClaimableByTokens, matchesWholeToken } from '../utils/postingIdentity';
import {
  applyReductionBudget,
  reductionBudgets,
} from './resumeDensityPolicy';
import {
  canonicalMasterProfilePath,
  canonicalResumeVariantsPath,
  masterProfileFileName,
  previewsDirectoryName,
  resolveDataRoot,
  resolveOutputRoot,
  resolveResumeVariantsPath,
  resolveTemplatePath,
  assertConfinedToRoot,
  isPathInside,
  redactHomePrefix,
  userTemplatesRoot,
  type DirectoryOverrides,
} from '../utils/canonicalDataRoot';
import {
  compileWithinPageLimit,
  type PageLimitCompileResult,
  type TypstCompileFailure,
  type TypstSource,
} from '../utils/typstCompiler';
import { assertNotReadOnly } from '../utils/readOnlyGuard';
import { resolveStoreFilePath, resolveStoreRoot } from '../utils/jsonStore';

// Variant-aware, zero-hallucination resume generator (SDD Requirement 3,
// Step 5b). Pipeline: read masterProfile.md -> parse into a structured,
// whitelist-bound object (the mapping layer where US EEO removal happens)
// -> select a .typ template from resumeVariants.yaml trigger rules or an
// explicit --variant flag -> splice the binding into the template's
// BEGIN_PROFILE/END_PROFILE seam -> enforce the 1-page limit via
// compileWithinPageLimit (SDD Requirement 3 page-count verification) ->
// verify ATS reading order and posting keywords via atsChecker (SDD
// Requirement 3) -> enforce zero-hallucination so no skill, tool, or metric
// appears in the compiled PDF unless it is traceable to masterProfile.md.
//
// This module owns ALL of the generate logic; the CLI (src/cli)
// parses flags and delegates here. It never triggers cover letter or
// outreach generation (SDD Section 1.5). Naming is strict camelCase and
// there are no underscore identifiers (AGENTS.md / SDD Section 2.1).

export interface ExperienceRole {
  roleTitle: string;
  employer: string;
  location: string;
  startDate: string;
  endDate: string;
  bullets: string[];
}

export interface SkillGroup {
  category: string;
  items: string[];
}

export interface EducationEntry {
  degree: string;
  institution: string;
  startYear: string;
  endYear: string;
}

export interface ParsedMasterProfile {
  name: string;
  email: string;
  phone: string;
  cityState: string;
  linkedIn: string;
  portfolio: string;
  summary: string;
  skills: SkillGroup[];
  experience: ExperienceRole[];
  education: EducationEntry[];
  certifications: string[];
  rawText: string;
}

export type ProfileInput = Omit<ParsedMasterProfile, 'rawText'>;

export interface PostingMetadata {
  companyName: string;
  roleTitle: string;
  targetsFederal: boolean;
  domainTags: string[];
  requiredKeywords: string[];
}

export interface ResolvedVariant {
  name: string;
  templatePath: string;
  selectionKind: 'explicit' | 'auto' | 'defaultFallback';
  matchedTriggers: string[];
}

export interface ResumeVariantSpec {
  template: string;
  triggers: Record<string, boolean | string>;
}

export interface ResumeVariantsConfig {
  variants: Record<string, ResumeVariantSpec>;
}

export interface GenerateResumeOptions {
  companyName: string;
  roleTitle: string;
  posting?: PostingMetadata;
  explicitVariant?: string;
  maxReductionAttempts?: number;
  // Config-driven directories (v0.2.1 Lane A): explicit CLI-level data root
  // plus the directories block from jobPreferences.yaml. Precedence for every
  // resolved path: explicit option > directories.* > WEJOBSEARCHDATAROOT env >
  // canonical default.
  dataRoot?: string;
  directories?: DirectoryOverrides;
}

export interface GenerateResumeResult {
  variantName: string;
  templatePath: string;
  typPath: string;
  pdfPath: string;
  pageCount: number;
  reductionAttempts: number;
  detectedEngine: 'wasm' | 'systemBinary';
  atsCheck: AtsCheckResult;
  claimableKeywords: string[];
  excludedKeywords: string[];
  hallucinatedTokens: string[];
}

export class ResumeGenerationError extends Error {}
export class ResumeProfilePlaceholderError extends ResumeGenerationError {}
export class ResumeProfileMissingError extends ResumeGenerationError {}
export class ResumeEeoViolationError extends ResumeGenerationError {}
export class ResumeTypstIsolationError extends ResumeGenerationError {}
export class ResumeAtsComplianceError extends ResumeGenerationError {}
export class ResumeHallucinationError extends ResumeGenerationError {}
export class ResumeVariantError extends ResumeGenerationError {}
export class ResumePageLimitError extends ResumeGenerationError {}

export const defaultProfilePath = canonicalMasterProfilePath();
export const defaultResumeVariantsPath = canonicalResumeVariantsPath();

// Single source of truth for the per-role output folder name shared by every
// generator (resume, cover letter, outreach). Each part is sanitized
// separately and joined with a '-' separator: concatenating the raw parts
// first collided ('AB'+'CD' vs 'ABC'+'D' both yielded 'ABCD') and forked one
// role's outputs across two folders. An empty segment (both parts sanitize
// to nothing) throws loudly instead of resolving to the output root itself.
export function applicationFolderSegment(companyName: string, roleTitle: string): string {
  const companyPart = companyName.replace(/[^A-Za-z0-9]/g, '');
  const rolePart = roleTitle.replace(/[^A-Za-z0-9]/g, '');
  const segment = `${companyPart}-${rolePart}`;
  if (companyPart.length === 0 || rolePart.length === 0) {
    throw new Error(
      `Cannot derive an application folder from companyName '${companyName}' and roleTitle '${roleTitle}': one part is empty after sanitizing.`,
    );
  }
  return segment;
}

const beginSeamMarker = '// BEGIN_PROFILE';
const endSeamMarker = '// END_PROFILE';
const mainFilePath = '/main.typ';

// Static tokens emitted by the template scaffold (section headings and their
// singular forms). These are the only tokens that may appear in a compiled
// resume without tracing to the profile.
const scaffoldTokens = new Set([
  'experience',
  'education',
  'skills',
  'summary',
  'certifications',
  'skill',
  'certification',
]);

const resumeVariantsSchema = z.object({
  variants: z.record(
    z.string(),
    z.object({
      template: z.string(),
      triggers: z.record(z.string(), z.union([z.boolean(), z.string()])),
    }),
  ),
});

const supportedTriggerKeys = new Set(['targetsFederal', 'domainTag']);

export function normalizeContactKey(label: string): string {
  return label.toLowerCase().replace(/[^a-z]/g, '');
}

const contactFieldByKey: Record<string, keyof ParsedMasterProfile> = {
  name: 'name',
  email: 'email',
  phone: 'phone',
  cityState: 'cityState',
  citystate: 'cityState',
  linkedin: 'linkedIn',
  portfolio: 'portfolio',
};

/**
 * Line-oriented markdown parser for masterProfile.md (SDD Requirement 1).
 * Sections follow the committed template in masterProfile.example.md:
 *
 *   ## Contact
 *   - Name: Jane Doe
 *   - Email: ...
 *   - Phone: ...
 *   - City / State: Austin, TX
 *   - LinkedIn: ...
 *   - Portfolio: ...
 *
 *   ## Summary
 *   (free text paragraph)
 *
 *   ## Skills
 *   - Languages: TypeScript, Rust, SQL
 *   - containerless items also allowed
 *
 *   ## Experience
 *   ### Senior Engineer | AcmeCorp | San Francisco, CA
 *   - Start: 2021-03
 *   - End: Present
 *   - Delivered ...
 *
 *   ## Education
 *   ### BSc Computer Science | University of Texas
 *   - Start: 2016
 *   - End: 2020
 *
 *   ## Certifications
 *   - AWS Certified Solutions Architect
 *
 * Values are copied verbatim; nothing is summarized or embellished. The
 * Work Authorization block exists for other commands only and is never
 * mapped into a resume (the whitelist is the resume engine's input shape).
 */
export function parseMasterProfile(markdown: string): ParsedMasterProfile {
  const lines = markdown.split(/\r?\n/);
  const profile: ParsedMasterProfile = {
    name: '',
    email: '',
    phone: '',
    cityState: '',
    linkedIn: '',
    portfolio: '',
    summary: '',
    skills: [],
    experience: [],
    education: [],
    certifications: [],
    rawText: markdown,
  };

  let section = '';
  let summaryLines: string[] = [];
  let activeExperience: ExperienceRole | null = null;
  let activeEducation: EducationEntry | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    const headingMatch = trimmed.match(/^##\s+(.+)$/);
    if (headingMatch !== null) {
      section = headingMatch[1].trim();
      if (section.toLowerCase() === 'experience') {
        activeExperience = null;
      }
      if (section.toLowerCase() === 'education') {
        activeEducation = null;
      }
      continue;
    }

    const subsectionMatch = trimmed.match(/^###\s+(.+)$/);
    if (subsectionMatch !== null) {
      const entryText = subsectionMatch[1].trim();
      if (section.toLowerCase() === 'experience') {
        const [role = '', employer = '', location = ''] = entryText.split('|').map((part) => part.trim());
        activeExperience = { roleTitle: role, employer, location, startDate: '', endDate: '', bullets: [] };
        profile.experience.push(activeExperience);
        continue;
      }
      if (section.toLowerCase() === 'education') {
        const [degree = '', institution = ''] = entryText.split('|').map((part) => part.trim());
        activeEducation = { degree, institution, startYear: '', endYear: '' };
        profile.education.push(activeEducation);
        continue;
      }
      continue;
    }

    const bullet = trimmed.match(/^-\s+(.*)$/);
    const isBullet = bullet !== null;
    const bulletText = isBullet && bullet !== null ? bullet[1].trim() : trimmed;

    if (line.startsWith('#') && !line.startsWith('##')) {
      continue;
    }

    switch (section.toLowerCase()) {
      case 'contact':
        if (isBullet) {
          const colon = bulletText.indexOf(':');
          if (colon > 0) {
            const label = bulletText.slice(0, colon).trim();
            const value = bulletText.slice(colon + 1).trim();
            const normalizedKey = normalizeContactKey(label);
            const target = contactFieldByKey[normalizedKey];
            if (target !== undefined && value.length > 0) {
              (profile as unknown as Record<string, unknown>)[target] = value;
            }
          }
        }
        break;
      case 'summary':
        if (!isBullet && bulletText.length > 0) {
          summaryLines.push(bulletText);
        }
        break;
      case 'skills':
        if (isBullet && bulletText.length > 0) {
          const colon = bulletText.indexOf(':');
          if (colon > 0) {
            const category = bulletText.slice(0, colon).trim();
            const items = bulletText
              .slice(colon + 1)
              .split(',')
              .map((item) => item.trim())
              .filter((item) => item.length > 0);
            profile.skills.push({ category, items });
          } else {
            profile.skills.push({ category: '', items: [bulletText] });
          }
        }
        break;
      case 'experience':
        if (activeExperience !== null && isBullet) {
          const startMatch = bulletText.match(/^Start\s*:\s*(.*)$/i);
          const endMatch = bulletText.match(/^End\s*:\s*(.*)$/i);
          if (startMatch !== null) {
            activeExperience.startDate = startMatch[1].trim();
          } else if (endMatch !== null) {
            activeExperience.endDate = endMatch[1].trim();
          } else if (bulletText.length > 0) {
            activeExperience.bullets.push(bulletText);
          }
        }
        break;
      case 'education':
        if (activeEducation !== null && isBullet) {
          const startMatch = bulletText.match(/^Start\s*:\s*(.*)$/i);
          const endMatch = bulletText.match(/^End\s*:\s*(.*)$/i);
          if (startMatch !== null) {
            activeEducation.startYear = startMatch[1].trim();
          } else if (endMatch !== null) {
            activeEducation.endYear = endMatch[1].trim();
          }
        }
        break;
      case 'certifications':
        if (isBullet && bulletText.length > 0) {
          profile.certifications.push(bulletText);
        }
        break;
      default:
        break;
    }
  }

  if (summaryLines.length > 0) {
    profile.summary = summaryLines.join(' ');
  }

  return profile;
}

export async function loadMasterProfile(
  profilePath?: string | null,
  rootDir?: string | null,
): Promise<ParsedMasterProfile> {
  const root = resolveStoreRoot(rootDir);
  const candidate = resolveStoreFilePath(profilePath, join(root, masterProfileFileName));
  const resolvedPath = assertConfinedToRoot(root, candidate, 'loadMasterProfile');
  let content: string;
  try {
    content = await readFile(resolvedPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new ResumeProfileMissingError(
        `No master profile found at ${redactHomePrefix(resolvedPath)}. Run the init wizard to create it under the canonical data root (default ${redactHomePrefix(defaultProfilePath)}).`,
      );
    }
    throw error;
  }
  return parseMasterProfile(content);
}

export function assertProfilePopulated(profile: ParsedMasterProfile): void {
  const required = [
    { key: 'name', value: profile.name },
    { key: 'cityState', value: profile.cityState },
    { key: 'email', value: profile.email },
  ];
  const empties = required.filter((entry) => entry.value.length === 0);
  if (empties.length > 0) {
    throw new ResumeProfilePlaceholderError(
      `masterProfile.md still contains empty or placeholder fields (${empties
        .map((entry) => entry.key)
        .join(', ')}). The profile is not initialized; run the init wizard first.`,
    );
  }
  const hasPlaceholders = /REPLACE_ME|Lorem ipsum/i.test(profile.rawText);
  if (hasPlaceholders) {
    throw new ResumeProfilePlaceholderError(
      'masterProfile.md still contains REPLACE_ME placeholders. Run the init wizard to fill the real profile. No resume is generated from an uninitialized profile.',
    );
  }
}

// Shared profile-load sequence (Phase F): coverLetterGenerator.ts and
// outreachMessageGenerator.ts carried parallel 23-line blocks (resolve root,
// confine path, load with error translation, assert populated with error
// translation), and the two resume entry points below carry the shorter
// untranslated variant. One helper owns the sequence; the caller parameterizes
// only the confinement label and the error classes its surface must throw, so
// every generator's public error contract is unchanged.
export interface ValidatedProfileErrorClasses {
  missingError: new (message: string) => Error;
  placeholderError: new (message: string) => Error;
}

export interface ValidatedProfileInput {
  dataRoot?: string | null;
  directories?: DirectoryOverrides | null;
  label: string;
}

export async function loadValidatedProfile(
  input: ValidatedProfileInput,
  errors: ValidatedProfileErrorClasses,
): Promise<{ dataRoot: string; profile: ParsedMasterProfile }> {
  const dataRoot = resolveDataRoot(input.dataRoot, input.directories);
  const profilePath = join(dataRoot, masterProfileFileName);
  assertConfinedToRoot(dataRoot, profilePath, input.label);
  let profile: ParsedMasterProfile;
  try {
    profile = await loadMasterProfile(profilePath, dataRoot);
  } catch (error: unknown) {
    if (error instanceof ResumeProfileMissingError) {
      throw new errors.missingError(error.message);
    }
    if (error instanceof ResumeProfilePlaceholderError) {
      throw new errors.placeholderError(error.message);
    }
    throw error;
  }
  try {
    assertProfilePopulated(profile);
  } catch (error: unknown) {
    if (error instanceof ResumeProfilePlaceholderError) {
      throw new errors.placeholderError(error.message);
    }
    throw error;
  }
  return { dataRoot, profile };
}

// --------------------------------------------------------------------------
// EEO mapping layer. This function is the sole producer of the template
// binding. It copies exactly the fields the template contract declares and
// nothing else, so a gender, age, photo, or street-address field in the
// profile can never reach the rendered Typst below. The template itself also
// carries a structural guard which double-checks the compiled document, but the
// authoritative removal happens here, in this whitelist.
// --------------------------------------------------------------------------

export interface ResumeBinding {
  name: string;
  cityState: string;
  email: string;
  phone: string;
  linkedIn?: string;
  portfolio?: string;
  summary: string;
  experience: readonly Readonly<ExperienceRole>[];
  skills: readonly Readonly<SkillGroup>[];
  education: readonly Readonly<EducationEntry>[];
  certifications: readonly string[];
}

export function mapProfileToBinding(profile: ParsedMasterProfile | ProfileInput): ResumeBinding {
  const linkedIn = profile.linkedIn.trim();
  const portfolio = profile.portfolio.trim();
  const binding: ResumeBinding = {
    name: profile.name,
    cityState: profile.cityState,
    email: profile.email,
    phone: profile.phone,
    ...(linkedIn === '' ? {} : { linkedIn }),
    ...(portfolio === '' ? {} : { portfolio }),
    summary: profile.summary,
    experience: profile.experience.map((entry) => ({ ...entry, bullets: [...entry.bullets] })),
    skills: profile.skills.map((group) => ({ category: group.category, items: [...group.items] })),
    education: profile.education.map((entry) => ({ ...entry })),
    certifications: [...profile.certifications],
  };
  return binding;
}

// --------------------------------------------------------------------------
// User-template EEO content scan (B8 fail-closed guard). The
// mapProfileToBinding whitelist above is authoritative for the binding, and
// shipped templates carry their own structural Typst guard (guardEeoClean in
// templates/usStandardResume.typ and templates/usDetailedResume.typ). User
// templates under <dataRoot>/templates/ are untrusted: nothing stops them
// from hardcoding EEO text into the rendered document or importing other
// files whose content never passes the whitelist. This scan rejects such
// templates with ResumeEeoViolationError BEFORE compilation is attempted,
// so a hostile template always fails closed instead of rendering.
// --------------------------------------------------------------------------

// Forbidden identifiers, mirroring the shipped templates' structural guard
// (eeoForbiddenFields in templates/usStandardResume.typ). Matched
// case-insensitively as whole words against template code with comments and
// string literals stripped, so the guard's own string table and prose
// comments never trip the scan when a shipped template is copied verbatim
// into the user templates directory.
export const eeoForbiddenIdentifiers: readonly string[] = [
  'photo',
  'headshot',
  'image',
  'photoPath',
  'profilePhoto',
  'gender',
  'sex',
  'maritalStatus',
  'marriageStatus',
  'spouseName',
  'age',
  'birthDate',
  'dateOfBirth',
  'birthYear',
  'yearOfBirth',
  'streetAddress',
  'streetAddressLine1',
  'streetAddressLine2',
  'residentialAddress',
  'homeAddress',
];

// Typst file-loading directives. Any of these in a user template pulls in
// content from another file that this scan never sees, so user templates
// must inline everything instead. import/include take a string path argument;
// read/csv/json/yaml/xml are data-loader function calls.
const templateFileDirectives: readonly string[] = [
  'import',
  'include',
  'read',
  'csv',
  'json',
  'yaml',
  'xml',
];

// Matches a directive used as a bare code-mode call with no `#` prefix
// (e.g. `csv("salaries.csv")` inside a code block, or `import "evil.typ"`
// after `{`/`;`/whitespace). The leading character class keeps the match to
// code positions so body prose is not mistaken for a loader call.

// Strip Typst line comments (// ...), block comments (/* ... */), and
// double-quoted string literals (with backslash escapes) down to blanks,
// preserving newlines so the surviving code keeps its original line layout.
function stripTypstCommentsAndStrings(source: string): string {
  let stripped = '';
  let index = 0;
  let mode: 'code' | 'lineComment' | 'blockComment' | 'stringLiteral' = 'code';
  while (index < source.length) {
    const current = source[index] ?? '';
    const next = source[index + 1] ?? '';
    if (mode === 'code') {
      if (current === '/' && next === '/') {
        mode = 'lineComment';
        stripped += '  ';
        index += 2;
        continue;
      }
      if (current === '/' && next === '*') {
        mode = 'blockComment';
        stripped += '  ';
        index += 2;
        continue;
      }
      if (current === '"') {
        mode = 'stringLiteral';
        stripped += ' ';
        index += 1;
        continue;
      }
      stripped += current;
      index += 1;
      continue;
    }
    if (mode === 'lineComment') {
      if (current === '\n') {
        mode = 'code';
        stripped += '\n';
      } else {
        stripped += ' ';
      }
      index += 1;
      continue;
    }
    if (mode === 'blockComment') {
      if (current === '*' && next === '/') {
        mode = 'code';
        stripped += '  ';
        index += 2;
        continue;
      }
      stripped += current === '\n' ? '\n' : ' ';
      index += 1;
      continue;
    }
    if (current === '\\') {
      stripped += '  ';
      index += 2;
      continue;
    }
    if (current === '"') {
      mode = 'code';
      stripped += ' ';
      index += 1;
      continue;
    }
    stripped += current === '\n' ? '\n' : ' ';
    index += 1;
  }
  return stripped;
}

// Strip Typst line and block comments down to blanks while preserving
// string literals (including their quotes) verbatim. Used only for the
// directive string-argument shape below, which needs the opening quote that
// stripTypstCommentsAndStrings blanks out.
function stripTypstCommentsOnly(source: string): string {
  let stripped = '';
  let index = 0;
  let mode: 'code' | 'lineComment' | 'blockComment' | 'stringLiteral' = 'code';
  while (index < source.length) {
    const current = source[index] ?? '';
    const next = source[index + 1] ?? '';
    if (mode === 'code') {
      if (current === '/' && next === '/') {
        mode = 'lineComment';
        stripped += '  ';
        index += 2;
        continue;
      }
      if (current === '/' && next === '*') {
        mode = 'blockComment';
        stripped += '  ';
        index += 2;
        continue;
      }
      if (current === '"') {
        mode = 'stringLiteral';
        stripped += current;
        index += 1;
        continue;
      }
      stripped += current;
      index += 1;
      continue;
    }
    if (mode === 'lineComment') {
      if (current === '\n') {
        mode = 'code';
        stripped += '\n';
      } else {
        stripped += ' ';
      }
      index += 1;
      continue;
    }
    if (mode === 'blockComment') {
      if (current === '*' && next === '/') {
        mode = 'code';
        stripped += '  ';
        index += 2;
        continue;
      }
      stripped += current === '\n' ? '\n' : ' ';
      index += 1;
      continue;
    }
    if (current === '\\') {
      stripped += current + (next ?? '');
      index += 2;
      continue;
    }
    if (current === '"') {
      mode = 'code';
    }
    stripped += current;
    index += 1;
  }
  return stripped;
}

// EEO-labelled prose inside Typst string literals (U31 fail-closed front
// door). The code scan above strips string literals so a shipped template
// copied verbatim never trips it, but that same stripping blinded the scan
// to hostile quoted prose such as #text["Gender: Female"]. Every pattern
// below requires a label-like `name:` or `name=` shape, so the guard's own
// string table (bare "gender", "photo", ...) and its comma-joined panic
// sentence never match, while any quoted EEO field label fails closed.
// Separators cover spaced prose, hyphenated prose, and camelCase spellings.
const eeoQuotedProsePatterns: readonly { label: string; pattern: RegExp }[] = [
  { label: 'gender', pattern: /\bgender\b\s*[:=]/i },
  { label: 'sex', pattern: /\bsex\b\s*[:=]/i },
  { label: 'maritalStatus', pattern: /\bmarital[\s-]*status\b\s*[:=]/i },
  { label: 'marriageStatus', pattern: /\bmarriage[\s-]*status\b\s*[:=]/i },
  { label: 'spouseName', pattern: /\bspouse([\s-]*name)?\b\s*[:=]/i },
  { label: 'age', pattern: /\bage\b\s*[:=]/i },
  { label: 'birthDate', pattern: /\bbirth[\s-]*date\b\s*[:=]/i },
  { label: 'dateOfBirth', pattern: /\bdate[\s-]*of[\s-]*birth\b\s*[:=]/i },
  { label: 'birthYear', pattern: /\bbirth[\s-]*year\b\s*[:=]/i },
  { label: 'yearOfBirth', pattern: /\byear[\s-]*of[\s-]*birth\b\s*[:=]/i },
  { label: 'streetAddress', pattern: /\bstreet[\s-]*address(\s*line\s*[12])?\b\s*[:=]/i },
  { label: 'residentialAddress', pattern: /\bresidential[\s-]*address\b\s*[:=]/i },
  { label: 'homeAddress', pattern: /\bhome[\s-]*address\b\s*[:=]/i },
  { label: 'photo', pattern: /\bphoto(\s*path)?\b\s*[:=]/i },
  { label: 'profilePhoto', pattern: /\bprofile[\s-]*photo\b\s*[:=]/i },
  { label: 'headshot', pattern: /\bheadshot\b\s*[:=]/i },
  { label: 'image', pattern: /\bimage\b\s*[:=]/i },
];

// Collect double-quoted Typst string literal contents, skipping line and
// block comments so a quote inside a comment never opens a literal. Handles
// backslash escapes. Used only by the quoted-prose scan below.
function collectTypstStringLiterals(source: string): string[] {
  const literals: string[] = [];
  let current = '';
  let index = 0;
  let mode: 'code' | 'lineComment' | 'blockComment' | 'stringLiteral' = 'code';
  while (index < source.length) {
    const currentChar = source[index] ?? '';
    const nextChar = source[index + 1] ?? '';
    if (mode === 'code') {
      if (currentChar === '/' && nextChar === '/') {
        mode = 'lineComment';
        index += 2;
        continue;
      }
      if (currentChar === '/' && nextChar === '*') {
        mode = 'blockComment';
        index += 2;
        continue;
      }
      if (currentChar === '"') {
        mode = 'stringLiteral';
        current = '';
        index += 1;
        continue;
      }
      index += 1;
      continue;
    }
    if (mode === 'lineComment') {
      if (currentChar === '\n') {
        mode = 'code';
      }
      index += 1;
      continue;
    }
    if (mode === 'blockComment') {
      if (currentChar === '*' && nextChar === '/') {
        mode = 'code';
        index += 2;
        continue;
      }
      index += 1;
      continue;
    }
    if (currentChar === '\\') {
      current += source[index + 1] ?? '';
      index += 2;
      continue;
    }
    if (currentChar === '"') {
      mode = 'code';
      literals.push(current);
      current = '';
      index += 1;
      continue;
    }
    current += currentChar === '\n' ? '\n' : currentChar;
    index += 1;
  }
  return literals;
}

// Scan string literal contents for EEO-labelled prose. Returns the matched
// violation labels (empty when clean). Unterminated trailing literals are
// ignored here; the Typst compiler rejects them downstream.
export function scanStringLiteralsForEeoViolations(templateSource: string): string[] {
  const literals = collectTypstStringLiterals(templateSource);
  const violations: string[] = [];
  for (const literal of literals) {
    for (const entry of eeoQuotedProsePatterns) {
      if (entry.pattern.test(literal) && !violations.includes(entry.label)) {
        violations.push(entry.label);
      }
    }
  }
  return violations;
}

// Scan stripped template code for EEO forbidden identifiers plus string
// literal contents for EEO-labelled prose, and file-loading directives.
// Returns the matched violation labels (empty when clean). A hostile template that smuggles a forbidden identifier past this
// scan in a novel spelling still faces the downstream hallucination check,
// but the scan is the fail-closed front door: anything it names aborts
// generation before any compilation, file output, or ATS check runs.
export function scanTemplateForEeoViolations(templateSource: string): string[] {
  const code = stripTypstCommentsAndStrings(templateSource);
  const codeWithStrings = stripTypstCommentsOnly(templateSource);
  const violations: string[] = [];
  for (const identifier of eeoForbiddenIdentifiers) {
    const pattern = new RegExp(`\\b${identifier}\\b`, 'i');
    if (pattern.test(code)) {
      violations.push(identifier);
    }
  }
  for (const quoted of scanStringLiteralsForEeoViolations(templateSource)) {
    if (!violations.includes(quoted)) {
      violations.push(quoted);
    }
  }
  for (const directive of templateFileDirectives) {
    // Function-call shape covers both `#csv(` and bare `csv(`: `#` is a
    // non-word character, so `\b` matches after it as well as after code.
    const callShape = new RegExp(`\\b${directive}\\s*\\(`, 'i');
    // String-argument shape covers `#import "file"` plus bare code-mode
    // `import "file"` (after `#`, whitespace, or a code-opening punctuator).
    // Matched against comment-stripped source with quotes intact (the fully
    // stripped code blanks string quotes out). The mandatory quote keeps
    // body prose from tripping the scan.
    const stringArgShape = new RegExp(`[#\\s{\\[(;,]${directive}\\s*["']`, 'i');
    if (callShape.test(code) || stringArgShape.test(codeWithStrings)) {
      violations.push(`#${directive}`);
    }
  }
  return violations;
}

// True when the resolved template file lives under <dataRoot>/templates/,
// i.e. it is user-supplied rather than repo-shipped. Shipped templates are
// trusted (repo-owned, reviewed, and carrying the structural Typst guard),
// so the content scan applies to user templates only.
function isUserTemplatePath(templatePath: string, dataRoot: string): boolean {
  // userTemplatesRoot already returns a confined absolute path, so no second
  // resolve is needed on it (only the caller-supplied template path is).
  return isPathInside(userTemplatesRoot(dataRoot), resolve(templatePath));
}

// Fail-closed gate for user templates: scan and throw
// ResumeEeoViolationError naming every violation. Called immediately after
// the template file is read, before the profile binding is injected and
// before any Typst compilation is attempted.
function assertUserTemplateEeoSafe(templateSource: string, templatePath: string, dataRoot: string): void {
  if (!isUserTemplatePath(templatePath, dataRoot)) {
    return;
  }
  const violations = scanTemplateForEeoViolations(templateSource);
  if (violations.length === 0) {
    return;
  }
  throw new ResumeEeoViolationError(
    `User template ${basename(templatePath)} contains EEO-prohibited content (${violations.join(', ')}). ` +
      'Resumes may only carry Name, City/State, Email, Phone, LinkedIn, and Portfolio. ' +
      'Remove photo, marital status, gender, age, birth date, and street address fields from the template, ' +
        'and inline any content pulled in through #import, #include, #read, #csv, #json, #yaml, or #xml directives.',
  );
}

// --- Typst literal serialization --------------------------------------------

function escapeTypstString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

function typstString(value: string): string {
  return `"${escapeTypstString(value)}"`;
}

function typstStringArray(items: readonly string[]): string {
  if (items.length === 0) {
    return '()';
  }
  const joined = items.map((item) => typstString(item)).join(', ');
  // A single-element Typst array needs a trailing comma, otherwise Typst
  // parses ("foo") as a string, not a 1-tuple, and the template's for-loops
  // silently produce no rows or error.
  const trailing = items.length === 1 ? ',' : '';
  return `(${joined}${trailing})`;
}

function typstExperience(entry: Readonly<ExperienceRole>): string {
  return [
    '(',
    `  roleTitle: ${typstString(entry.roleTitle)},`,
    `  employer: ${typstString(entry.employer)},`,
    `  location: ${typstString(entry.location)},`,
    `  startDate: ${typstString(entry.startDate)},`,
    `  endDate: ${typstString(entry.endDate)},`,
    `  bullets: ${typstStringArray(entry.bullets)},`,
    ')',
  ].join('\n');
}

function typstSkillGroup(group: Readonly<SkillGroup>): string {
  return `(category: ${typstString(group.category)}, items: ${typstStringArray(group.items)})`;
}

function typstEducation(entry: Readonly<EducationEntry>): string {
  return [
    '(',
    `  degree: ${typstString(entry.degree)},`,
    `  institution: ${typstString(entry.institution)},`,
    `  startYear: ${typstString(entry.startYear)},`,
    `  endYear: ${typstString(entry.endYear)},`,
    ')',
  ].join('\n');
}

// Serialize the binding into a `#let profile = (...) `Typst assignment that the
// templates accept (shape mirrors usStandardResume.typ's PROFILE DATA doc).
// Arrays use () and every object/record uses (key: value) per Typst field
// syntax; nested tuples get one entry per line to avoid parser ambiguity.
export function serializeBinding(binding: ResumeBinding): string {
  const lines: string[] = ['#let profile = ('];
  lines.push(`  name: ${typstString(binding.name)},`);
  lines.push(`  cityState: ${typstString(binding.cityState)},`);
  lines.push(`  email: ${typstString(binding.email)},`);
  lines.push(`  phone: ${typstString(binding.phone)},`);
  if (binding.linkedIn !== undefined) {
    lines.push(`  linkedIn: ${typstString(binding.linkedIn)},`);
  }
  if (binding.portfolio !== undefined) {
    lines.push(`  portfolio: ${typstString(binding.portfolio)},`);
  }
  lines.push(`  summary: ${typstString(binding.summary)},`);
  if (binding.experience.length > 0) {
    lines.push('  experience: (');
    for (const entry of binding.experience) {
      lines.push(`    ${typstExperience(entry)},`);
    }
    lines.push('  ),');
  } else {
    lines.push('  experience: (),');
  }
  if (binding.skills.length > 0) {
    lines.push('  skills: (');
    for (const group of binding.skills) {
      lines.push(`    ${typstSkillGroup(group)},`);
    }
    lines.push('  ),');
  } else {
    lines.push('  skills: (),');
  }
  if (binding.education.length > 0) {
    lines.push('  education: (');
    for (const entry of binding.education) {
      lines.push(`    ${typstEducation(entry)},`);
    }
    lines.push('  ),');
  } else {
    lines.push('  education: (),');
  }
  lines.push(`  certifications: ${typstStringArray(binding.certifications)},`);
  lines.push(')');
  return lines.join('\n');
}

export function injectProfileIntoTemplate(template: string, bindingContent: string): string {
  const beginIndex = template.indexOf(beginSeamMarker);
  const endIndex = template.indexOf(endSeamMarker);
  if (beginIndex === -1 || endIndex === -1) {
    throw new ResumeGenerationError(
      `Template does not contain the expected PROFILE DATA seam markers (${beginSeamMarker}/${endSeamMarker}). It may be a non-resume template or corrupted.`,
    );
  }
  const head = template.slice(0, beginIndex + beginSeamMarker.length);
  const tail = template.slice(endIndex);
  return `${head}\n${bindingContent}\n${tail}`;
}

export function makeTemplateSource(template: string, bindingContent: string): TypstSource {
  return {
    mainFilePath,
    mainContent: injectProfileIntoTemplate(template, bindingContent),
  };
}

// --- Variant selection -------------------------------------------------------

export function parseResumeVariants(content: string): ResumeVariantsConfig {
  const parsed: unknown = parseYaml(content);
  const result = resumeVariantsSchema.safeParse(parsed);
  if (!result.success) {
    throw new ResumeGenerationError(`Invalid resumeVariants YAML: ${result.error.message}`);
  }
  return result.data;
}

async function loadVariants(
  path: string,
  rootDir?: string | null,
): Promise<{ config: ResumeVariantsConfig; resolve: (template: string) => string }> {
  const root = resolveStoreRoot(rootDir);
  const resolvedPath = assertConfinedToRoot(root, path, 'loadVariants');
  let content: string;
  try {
    content = await readFile(resolvedPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new ResumeGenerationError(
        `resumeVariants.yaml not found at ${redactHomePrefix(resolvedPath)}. It is seeded into the canonical data root (default ${redactHomePrefix(defaultResumeVariantsPath)}) by the init wizard.`,
      );
    }
    throw error;
  }
  const config = parseResumeVariants(content);
  const resolver = (template: string): string => resolveTemplatePath(template, root);
  return { config, resolve: resolver };
}

function variantMatchesTrigger(
  key: string,
  expected: boolean | string,
  posting: PostingMetadata,
): boolean {
  if (!supportedTriggerKeys.has(key)) {
    throw new ResumeVariantError(
      `Unknown resume variant trigger '${key}' in resumeVariants.yaml. Supported triggers: ${[...supportedTriggerKeys].join(', ')}.`,
    );
  }
  if (key === 'targetsFederal') {
    return typeof expected === 'boolean' && posting.targetsFederal === expected;
  }
  if (typeof expected === 'string') {
    return posting.domainTags.map((tag) => tag.toLowerCase()).includes(expected.toLowerCase());
  }
  return false;
}

export function selectVariant(
  config: ResumeVariantsConfig,
  posting: PostingMetadata,
  explicitVariant?: string,
): ResolvedVariant {
  const names = Object.keys(config.variants);
  if (explicitVariant !== undefined) {
    const spec = config.variants[explicitVariant];
    if (spec === undefined) {
      throw new ResumeVariantError(`Unknown --variant '${explicitVariant}'. Available variants: ${names.join(', ')}.`);
    }
    return {
      name: explicitVariant,
      templatePath: spec.template,
      selectionKind: 'explicit',
      matchedTriggers: Object.keys(spec.triggers),
    };
  }

  let fallback: { name: string; template: string; matchedTriggers: string[] } | null = null;
  for (const name of names) {
    const spec = config.variants[name];
    const triggerEntries = Object.entries(spec.triggers);
    if (triggerEntries.length === 0) {
      fallback ??= { name, template: spec.template, matchedTriggers: [] };
      continue;
    }
    const matched: string[] = [];
    const allMatch = triggerEntries.every(([key, value]) => {
      const ok = variantMatchesTrigger(key, value, posting);
      if (ok) {
        matched.push(key);
      }
      return ok;
    });
    if (allMatch) {
      return { name, templatePath: spec.template, selectionKind: 'auto', matchedTriggers: matched };
    }
  }
  if (fallback !== null) {
    return { name: fallback.name, templatePath: fallback.template, selectionKind: 'defaultFallback', matchedTriggers: [] };
  }
  throw new ResumeVariantError(
    'No resume variant matches the posting metadata and resumeVariants.yaml defines no default variant (one with empty triggers).',
  );
}

// --- Text density reduction (compileWithinPageLimit hook) --------------------
// Phase E: the 5-step reduction budget table plus the density policy live in
// ./resumeDensityPolicy so page-loop tuning touches one module only. The
// names below are compatibility re-exports; the EEO filter and the
// hallucination check stay in this module.
export { applyReductionBudget, reductionBudgets, type ReductionBudget } from './resumeDensityPolicy';

export function summarizeTokenSet(text: string): Set<string> {
  const tokens = text.toLowerCase().match(/[a-z0-9]+/g);
  return new Set(tokens ?? []);
}

// Allowed-token set for the zero-hallucination scan (B14c): derived from
// the EEO-whitelisted binding ONLY, never from the raw profile text. The raw
// text carries work-authorization content that must never appear in a resume;
// letting it into the allowed set would mask a template leak as legitimate.
// Template scaffold vocabulary (headings) is allowlisted separately in
// hallucinatedWording via scaffoldTokens.
export function unionProfilesTokens(binding: ResumeBinding): Set<string> {
  const extra = [
    ...binding.experience.flatMap((entry) => [entry.roleTitle, entry.employer, entry.location, entry.startDate, entry.endDate, ...entry.bullets]),
    ...binding.skills.flatMap((group) => [group.category, ...group.items]),
    ...binding.education.flatMap((entry) => [entry.degree, entry.institution, entry.startYear, entry.endYear]),
    binding.name,
    binding.cityState,
    binding.email,
    binding.phone,
    binding.linkedIn ?? '',
    binding.portfolio ?? '',
    binding.summary,
    ...binding.certifications,
  ];
  return summarizeTokenSet(extra.join(' '));
}

// Whole-token containment for posting-requirement checks (B14d, shared core
// in U41): delegates to the postingIdentity matcher so the ATS checker, the
// hallucination guards, and the requirements extractor all agree on what a
// whole token is.
export function textContainsToken(text: string, keyword: string): boolean {
  return matchesWholeToken(text, keyword);
}

export function hallucinatedWording(pdfText: string, allowedTokens: ReadonlySet<string>): string[] {
  // pdf-parse appends a page-marker line like "-- 1 of 1 --"; its "of" token
  // is PDF metadata, not resume content, so strip the markers before scanning.
  const withoutPageMarkers = pdfText.replace(/--\s*\d+\s+of\s+\d+\s*--/g, ' ');
  const tokens = withoutPageMarkers.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const token of tokens) {
    if (scaffoldTokens.has(token) || allowedTokens.has(token)) {
      continue;
    }
    // Phase D: no blanket numeric skip. Every genuine number in a compiled
    // resume (phone digits, years, metrics) is already in allowedTokens via
    // unionProfilesTokens, so a pure number outside that set is a figure from
    // nowhere — the old /^\d+$/ skip masked hallucinated numbers as opaque.
    if (!seen.has(token)) {
      seen.add(token);
      result.push(token);
    }
  }
  return result;
}

// Posting-keyword claim partition (Phase E): splits the posting's required
// keywords into claimable (grounded in the profile token set) and excluded
// via the shared whole-token matcher, so this path agrees with the ATS
// checker, the hallucination guards, and the density policy on what counts
// as a match. Excluded 'java' no longer rides on profile token 'javascript'.
export function partitionClaimableKeywords(
  profileTokens: ReadonlySet<string>,
  targetKeywords: readonly string[],
): { claimable: string[]; excluded: string[] } {
  const claimable = targetKeywords.filter((keyword) => keywordClaimableByTokens(profileTokens, keyword));
  const excluded = targetKeywords.filter((keyword) => !claimable.includes(keyword));
  return { claimable, excluded };
}

// --- Orchestration -----------------------------------------------------------

// Shared tail of the pipeline for both generateResume and generateResumePreview:
// compile within the page limit (with text-density reduction), write the Typst
// source and PDF, verify ATS reading order, and enforce the zero-hallucination
// guarantee. The posting-specific parts (variant selection, keyword claim/
// exclusion) stay with each caller.
interface RenderResumeCoreInput {
  template: string;
  binding: ResumeBinding;
  claimable: string[];
  excluded: string[];
  typPath: string;
  pdfPath: string;
  templatePath: string;
  maxReductionAttempts?: number;
}

interface RenderResumeCoreResult {
  pageCount: number;
  reductionAttempts: number;
  engine: 'wasm' | 'systemBinary';
  atsCheck: AtsCheckResult;
  hallucinatedTokens: string[];
  finalBinding: ResumeBinding;
}

async function renderResumeCore(input: RenderResumeCoreInput): Promise<RenderResumeCoreResult> {
  // Guard before compileWithinPageLimit: the compiler writes the PDF to
  // input.pdfPath during compilation, so the containment check must run
  // before any filesystem touch, not just before the explicit writeFile calls.
  assertNotReadOnly(input.typPath);
  assertNotReadOnly(input.pdfPath);
  let currentBinding = input.binding;
  let finalSource: TypstSource = makeTemplateSource(input.template, serializeBinding(currentBinding));
  let budgetIndex = 0;

  const reduceTextDensity = (): TypstSource => {
    const budget = reductionBudgets[Math.min(budgetIndex, reductionBudgets.length - 1)];
    budgetIndex += 1;
    currentBinding = applyReductionBudget(currentBinding, budget, input.claimable);
    finalSource = makeTemplateSource(input.template, serializeBinding(currentBinding));
    return finalSource;
  };

  let compileResult: PageLimitCompileResult;
  try {
    compileResult = await compileWithinPageLimit({
      source: finalSource,
      outputPath: input.pdfPath,
      // Cap attempts at the budget count: beyond the last budget the reducer
      // would repeat the strictest budget forever, so an explicit larger
      // maxReductionAttempts cannot spin additional compiles.
      maxReductionAttempts: Math.min(
        input.maxReductionAttempts ?? reductionBudgets.length,
        reductionBudgets.length,
      ),
      reduceTextDensity,
    });
  } catch (error: unknown) {
    // Phase D: the compiler writes input.pdfPath during compilation, so an
    // over-limit failure previously left a multi-page PDF on disk that looked
    // like a finished resume. Remove both artifacts (best-effort; the .typ
    // may not exist yet), then translate and rethrow.
    await rm(input.typPath, { force: true });
    await rm(input.pdfPath, { force: true });
    throw translateCompileFailure(error, input.templatePath);
  }

  await writeFile(input.typPath, finalSource.mainContent, 'utf8');
  await writeFile(input.pdfPath, compileResult.pdfBytes);

  const assertAtsAndHallucinationFree = async (): Promise<{ ats: AtsCheckResult; hallucinations: string[] }> => {
    const pdfText = await extractPdfText(compileResult.pdfBytes);
    const ats = await checkAtsCompliance(compileResult.pdfBytes, input.claimable, {
      expectedSections: ['Experience', 'Education', 'Skills'],
    });
    if (!ats.passed) {
      throw new ResumeAtsComplianceError(
        `ATS check failed for ${input.typPath}: sections in order=${
          ats.sectionsInOrder
        }, missing sections=${ats.missingSections.join(', ') || '(none)'}, missing keywords=${ats.missingKeywords.join(
          ', ',
        ) || '(none)'}`,
      );
    }

    const allowedTokens = unionProfilesTokens(currentBinding);
    const hallucinations = hallucinatedWording(pdfText, allowedTokens);
  for (const keyword of input.excluded) {
    if (textContainsToken(pdfText, keyword)) {
        throw new ResumeHallucinationError(
          `Keyword '${keyword}' from the posting appears in the compiled resume but is not present in masterProfile.md. The resume generator never adds posting-only skills, tools, or metrics.`,
        );
      }
    }
    if (hallucinations.length > 0) {
      throw new ResumeHallucinationError(
        `Compiled resume contains token(s) not traceable to masterProfile.md: ${hallucinations.join(', ')}. This violates the zero-hallucination guarantee (SDD Requirement 1 and 3).`,
      );
    }
    return { ats, hallucinations };
  };

  let ats: AtsCheckResult;
  let hallucinations: string[];
  try {
    ({ ats, hallucinations } = await assertAtsAndHallucinationFree());
  } catch (error: unknown) {
    // A failed verification must not leave Typst/PDF artifacts behind that
    // look like a finished resume: remove both outputs, then rethrow.
    await rm(input.typPath, { force: true });
    await rm(input.pdfPath, { force: true });
    throw error;
  }

  return {
    pageCount: compileResult.pageCount,
    reductionAttempts: compileResult.reductionAttempts,
    engine: compileResult.engine,
    atsCheck: ats,
    hallucinatedTokens: hallucinations,
    finalBinding: currentBinding,
  };
}

export async function generateResume(options: GenerateResumeOptions): Promise<GenerateResumeResult> {
  const posting: PostingMetadata = options.posting ?? {
    companyName: options.companyName,
    roleTitle: options.roleTitle,
    targetsFederal: false,
    domainTags: [],
    requiredKeywords: [],
  };

  // Relative template paths in resumeVariants.yaml resolve through the H1b
  // allowlist (shipped templates/ first, <dataRoot>/templates/ second);
  // absolute paths must already sit inside one of those roots.
  const dataRoot = resolveDataRoot(options.dataRoot, options.directories);
  const resumeVariantsPath = resolveResumeVariantsPath(undefined, options.directories, dataRoot);
  const { config: variantsConfig, resolve: resolveTemplate } = await loadVariants(resumeVariantsPath, dataRoot);

  const selected = selectVariant(variantsConfig, posting, options.explicitVariant);
  const templatePath = resolveTemplate(selected.templatePath);
  const template = await readTemplateFile(templatePath);
  assertUserTemplateEeoSafe(template, templatePath, dataRoot);

  const { profile } = await loadValidatedProfile(
    { dataRoot, label: 'loadMasterProfile' },
    {
      missingError: ResumeProfileMissingError,
      placeholderError: ResumeProfilePlaceholderError,
    },
  );
  const binding = mapProfileToBinding(profile);

  const outputRoot = resolveOutputRoot(undefined, options.directories, dataRoot);
  const outputFolder = join(outputRoot, applicationFolderSegment(options.companyName, options.roleTitle));
  assertConfinedToRoot(dataRoot, outputFolder, 'generateResume');
  assertNotReadOnly(outputFolder);
  await mkdir(outputFolder, { recursive: true });
  const typPath = join(outputFolder, 'tailoredResume.typ');
  const pdfPath = join(outputFolder, 'tailoredResume.pdf');

  const targetKeywords = posting.requiredKeywords;
  const profileTokens = unionProfilesTokens(binding);
  const { claimable, excluded } = partitionClaimableKeywords(profileTokens, targetKeywords);

  const rendered = await renderResumeCore({
    template,
    binding,
    claimable,
    excluded,
    typPath,
    pdfPath,
    templatePath,
    maxReductionAttempts: options.maxReductionAttempts,
  });

  return {
    variantName: selected.name,
    templatePath,
    typPath,
    pdfPath,
    pageCount: rendered.pageCount,
    reductionAttempts: rendered.reductionAttempts,
    detectedEngine: rendered.engine,
    atsCheck: rendered.atsCheck,
    claimableKeywords: claimable,
    excludedKeywords: excluded,
    hallucinatedTokens: rendered.hallucinatedTokens,
  };
}

export interface GenerateResumePreviewOptions {
  explicitVariant?: string;
  maxReductionAttempts?: number;
  dataRoot?: string;
  directories?: DirectoryOverrides;
}

export interface GenerateResumePreviewResult {
  variantName: string;
  templatePath: string;
  typPath: string;
  pdfPath: string;
  pageCount: number;
  reductionAttempts: number;
  detectedEngine: 'wasm' | 'systemBinary';
  atsCheck: AtsCheckResult;
  hallucinatedTokens: string[];
}

// Profile-only resume preview (SRA-05): renders the profile through the same
// Typst pipeline as generateResume but without any target role. Variant
// selection uses an explicit --variant or falls back to the trigger-less
// default; the 1-page limit, ATS reading-order check, and zero-hallucination
// scan all still run. Output lands in previews/ under the effective data root.
// Never triggers any other generation.
export async function generateResumePreview(
  options: GenerateResumePreviewOptions,
): Promise<GenerateResumePreviewResult> {
  const dataRoot = resolveDataRoot(options.dataRoot, options.directories);
  const resumeVariantsPath = resolveResumeVariantsPath(undefined, options.directories, dataRoot);
  const { config: variantsConfig, resolve: resolveTemplate } = await loadVariants(resumeVariantsPath, dataRoot);

  const emptyPosting: PostingMetadata = {
    companyName: 'Preview',
    roleTitle: 'Resume',
    targetsFederal: false,
    domainTags: [],
    requiredKeywords: [],
  };
  const selected = selectVariant(variantsConfig, emptyPosting, options.explicitVariant);
  const templatePath = resolveTemplate(selected.templatePath);
  const template = await readTemplateFile(templatePath);
  assertUserTemplateEeoSafe(template, templatePath, dataRoot);

  const { profile } = await loadValidatedProfile(
    { dataRoot, label: 'loadMasterProfile' },
    {
      missingError: ResumeProfileMissingError,
      placeholderError: ResumeProfilePlaceholderError,
    },
  );
  const binding = mapProfileToBinding(profile);

  // Phase D: the directories.outputRoot option is honored, not ignored. The
  // previews directory sits beside the resolved applications output root, so
  // the default (no override) still resolves to <dataRoot>/previews/ while a
  // configured outputRoot relocates previews alongside it.
  const applicationsRoot = resolveOutputRoot(undefined, options.directories, dataRoot);
  const outputRoot = join(dirname(applicationsRoot), previewsDirectoryName);
  assertConfinedToRoot(dataRoot, outputRoot, 'generateResumePreview');
  assertNotReadOnly(outputRoot);
  await mkdir(outputRoot, { recursive: true });
  const typPath = join(outputRoot, 'previewResume.typ');
  const pdfPath = join(outputRoot, 'previewResume.pdf');

  const rendered = await renderResumeCore({
    template,
    binding,
    claimable: [],
    excluded: [],
    typPath,
    pdfPath,
    templatePath,
    maxReductionAttempts: options.maxReductionAttempts,
  });

  return {
    variantName: selected.name,
    templatePath,
    typPath,
    pdfPath,
    pageCount: rendered.pageCount,
    reductionAttempts: rendered.reductionAttempts,
    detectedEngine: rendered.engine,
    atsCheck: rendered.atsCheck,
    hallucinatedTokens: rendered.hallucinatedTokens,
  };
}

// ---------------------------------------------------------------------------
// Internal helpers: reading the template file and translating Typst failure
// objects into actionable errors.
// ---------------------------------------------------------------------------

async function readTemplateFile(templatePath: string): Promise<string> {
  try {
    return await readFile(templatePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new ResumeGenerationError(`Template file not found: ${templatePath}`);
    }
    throw error;
  }
}

function translateCompileFailure(error: unknown, templatePath: string): ResumeGenerationError {
  if (error instanceof ResumeGenerationError) {
    return error;
  }
  const diagnostics = (error as TypstCompileFailure)?.diagnostics;
  const messageText = diagnostics?.join('\n') ?? (error instanceof Error ? error.message : String(error));
  if (/EEO compliance filter rejected/i.test(messageText)) {
    const fieldMatch = messageText.match(/rejected field\(s\):?\s*([^.]+)/i);
    throw new ResumeEeoViolationError(
      `Template rejected an EEO-protected field (${fieldMatch?.[1]?.trim() ?? 'unknown'}): ${basename(templatePath)}. ` +
        'Resumes may only carry Name, City/State, Email, Phone, LinkedIn, and Portfolio. ' +
        'Remove photo, marital status, gender, age, birth date, or street address fields from the profile contact block.',
    );
  }
  if (/exceeding the \d+-page limit/i.test(messageText)) {
    const attemptMatch = messageText.match(/after (\d+) reduction attempts/i);
    const attemptNote =
      attemptMatch === null ? '' : ` (${attemptMatch[1]} reduction attempts exhausted).`;
    throw new ResumePageLimitError(
      'The resume could not be reduced to a single page even after trimming optional content' +
        `${attemptNote} Reduce the length of masterProfile.md or shorten the detailed sections before generating again.`,
    );
  }
  throw new ResumeTypstIsolationError(
    `Typst failed to compile tailoredResume.typ: ${diagnostics?.join('\n') || (error as Error).message}`,
  );
}
