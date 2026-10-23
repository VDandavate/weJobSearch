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
  resolveOutputRoot,
  assertConfinedToRoot,
  type DirectoryOverrides,
} from '../utils/canonicalDataRoot';
import { assertNotReadOnly } from '../utils/readOnlyGuard';
// Requirement 3a cover letter generator. Distinct, independently-invoked
// capability per SDD Section 1.5: generating a resume never triggers this, and
// this never triggers resume (or outreach) generation. Output is plain
// Markdown (coverLetter.md) — no Typst, no PDF, so no page-limit or ATS
// reading-order concerns apply here.
//
// Zero-hallucination discipline (Requirement 1 / 3a), adapted to prose:
//  - The profile is parsed and EEO-mapped by resumeGenerator's own
//    parseMasterProfile/mapProfileToBinding (reused, not duplicated), so the
//    letter can only ever draw from the sanitized resume binding.
//  - The letter body is composed from a fixed connective skeleton (its tokens
//    become the prose scaffold, mirroring the template-label scaffold tokens
//    resumeGenerator uses) plus profile-derived sentences spliced in verbatim.
//  - Posting requirements are referenced ONLY where the profile genuinely
//    supports the connection: a posting token is "claimable" exactly when it
//    appears in the profile token set. Posting-only vocabulary ("excluded"
//    tokens) is computed up front and verified never to appear in the letter.

export class CoverLetterGenerationError extends Error {}
export class CoverLetterProfileMissingError extends CoverLetterGenerationError {}
export class CoverLetterProfilePlaceholderError extends CoverLetterGenerationError {}
export class CoverLetterHallucinationError extends CoverLetterGenerationError {}

export interface CoverLetterOptions {
  companyName: string;
  roleTitle: string;
  postingRequirements?: readonly string[];
  // Config-driven directories (v0.2.1 Lane A): explicit CLI-level data root
  // plus the directories block from jobPreferences.yaml.
  dataRoot?: string;
  directories?: DirectoryOverrides;
}

export interface CoverLetterResult {
  markdownPath: string;
  claimableTokens: string[];
  excludedTokens: string[];
  hallucinatedTokens: string[];
}

// Fixed connective skeleton. Every word here is generic letter scaffolding
// (never a claim about the candidate); its tokens form the prose scaffold set,
// exactly analogous to resumeGenerator's scaffoldTokens (which is derived from
// the resume template's section labels). Dynamic content — company, role,
// profile sentences, claimable posting vocabulary — is spliced in separately.
const coverLetterStaticLines: readonly string[] = [
  'Dear Hiring Team,',
  'I am writing to apply for the',
  'role at',
  'About my background:',
  'The posting emphasizes the following areas that align with my background:',
  'The following are examples from my experience:',
  'I would welcome the opportunity to discuss how my background can support',
  'Thank you for your consideration.',
  'Sincerely,',
];

// Exported for the token-traceability unit test: the prose scaffold set a
// cover letter may use without tracing a token to masterProfile.md.
export const coverLetterScaffoldTokens: ReadonlySet<string> = summarizeTokenSet(coverLetterStaticLines.join(' '));

// The same per-token traceability scan resumeGenerator applies to compiled
// PDF text (hallucinatedWording), adapted to prose: a token in the letter must
// be traceable to the profile, the fixed letter skeleton, or the target
// metadata (company/role/date). Pure numbers (dates, years, metrics) are
// treated as opaque, matching the resume scanner.
export function hallucinatedProseTokens(markdown: string, allowedTokens: ReadonlySet<string>): string[] {
  const tokens = markdown.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const token of tokens) {
    if (/^\d+$/.test(token)) {
      continue;
    }
    if (allowedTokens.has(token)) {
      continue;
    }
    if (!seen.has(token)) {
      seen.add(token);
      result.push(token);
    }
  }
  return result;
}

export function claimableRequirementTokens(requirement: string, profileTokens: ReadonlySet<string>): string[] {
  const rawTokens = requirement.match(/[a-z0-9]+/gi) ?? [];
  return [...new Set(rawTokens.filter((token) => profileTokens.has(token.toLowerCase())))];
}

// Posting vocabulary that is NOT traceable to the profile AND not part of the
// fixed letter skeleton. These are genuine posting-only claims and must never
// appear anywhere in the letter.
export function excludedRequirementTokens(requirements: readonly string[], profileTokens: ReadonlySet<string>): string[] {
  const rawTokens = requirements.flatMap((requirement) => requirement.match(/[a-z0-9]+/gi) ?? []);
  const excluded = new Set<string>();
  for (const token of rawTokens) {
    const normalized = token.toLowerCase();
    if (coverLetterScaffoldTokens.has(normalized)) {
      continue;
    }
    if (/^\d+$/.test(normalized)) {
      continue;
    }
    if (!profileTokens.has(normalized)) {
      excluded.add(normalized);
    }
  }
  return [...excluded];
}

function evidenceBullets(binding: ResumeBinding, claimableTokens: readonly string[]): string[] {
  const matching: string[] = [];
  for (const token of claimableTokens) {
    for (const entry of binding.experience) {
      for (const bullet of entry.bullets) {
        if (bullet.toLowerCase().includes(token.toLowerCase()) && !matching.includes(bullet)) {
          matching.push(bullet);
        }
      }
    }
  }
  // Fail closed on zero overlap: no bullet with a topical connection means no
  // evidence section, never the first two unrelated bullets as filler. The
  // renderer already skips the section when this returns empty.
  return matching.slice(0, 2);
}

export function buildCoverLetterMarkdown(
  binding: ResumeBinding,
  options: { companyName: string; roleTitle: string },
  claimableTokens: readonly string[],
): string {
  const date = new Date().toISOString().slice(0, 10);
  const header = [
    `${binding.cityState} | ${binding.email} | ${binding.phone}`,
    [binding.linkedIn, binding.portfolio].filter((value) => value !== undefined && value.length > 0).join(' | '),
  ].filter((line) => line.length > 0);

  const lines: string[] = [];
  lines.push(`# ${binding.name}`);
  lines.push('');
  lines.push(...header);
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push(`${options.companyName} | ${options.roleTitle}`);
  lines.push(date);
  lines.push('');
  lines.push(coverLetterStaticLines[0]);
  lines.push('');
  lines.push(`${coverLetterStaticLines[1]} ${options.roleTitle} ${coverLetterStaticLines[2]} ${options.companyName}.`);
  lines.push('');

  if (binding.summary.length > 0) {
    lines.push(`${coverLetterStaticLines[3]} ${binding.summary}`);
    lines.push('');
  }

  if (claimableTokens.length > 0) {
    lines.push(`${coverLetterStaticLines[4]} ${claimableTokens.join(', ')}.`);
    lines.push('');
  }

  const bullets = evidenceBullets(binding, claimableTokens);
  if (bullets.length > 0) {
    lines.push(coverLetterStaticLines[5]);
    for (const bullet of bullets) {
      lines.push(`- ${bullet}`);
    }
    lines.push('');
  }

  lines.push(`${coverLetterStaticLines[6]} ${options.companyName}. ${coverLetterStaticLines[7]}`);
  lines.push('');
  lines.push(coverLetterStaticLines[8]);
  lines.push(binding.name);
  lines.push('');
  return lines.join('\n');
}

export async function draftCoverLetter(options: CoverLetterOptions): Promise<CoverLetterResult> {
  const { dataRoot, profile } = await loadValidatedProfile(
    { dataRoot: options.dataRoot, directories: options.directories, label: 'draftCoverLetter' },
    {
      missingError: CoverLetterProfileMissingError,
      placeholderError: CoverLetterProfilePlaceholderError,
    },
  );

  const binding = mapProfileToBinding(profile);
  const profileTokens = unionProfilesTokens(binding);
  const requirements = options.postingRequirements ?? [];
  const claimableTokens = [...new Set(requirements.flatMap((requirement) => claimableRequirementTokens(requirement, profileTokens)))];
  const excludedTokens = excludedRequirementTokens(requirements, profileTokens);

  const targetTokens = summarizeTokenSet(
    `${options.companyName} ${options.roleTitle} ${new Date().toISOString().slice(0, 10)}`,
  );
  const allowedTokens = new Set<string>([...profileTokens, ...coverLetterScaffoldTokens, ...targetTokens]);

  const markdown = buildCoverLetterMarkdown(binding, options, claimableTokens);

  const hallucinations = hallucinatedProseTokens(markdown, allowedTokens);
  if (hallucinations.length > 0) {
    throw new CoverLetterHallucinationError(
      `Cover letter contains token(s) not traceable to masterProfile.md or the letter scaffold: ${hallucinations.join(
        ', ',
      )}. This violates the zero-hallucination guarantee (SDD Requirement 1 and 3a).`,
    );
  }
  for (const token of excludedTokens) {
    if (textContainsToken(markdown, token)) {
      throw new CoverLetterHallucinationError(
        `Posting-only requirement token '${token}' appears in the cover letter but is not present in masterProfile.md. The cover letter never references posting requirements the profile does not genuinely support.`,
      );
    }
  }

  const outputRoot = resolveOutputRoot(undefined, options.directories, dataRoot);
  assertConfinedToRoot(dataRoot, outputRoot, 'draftCoverLetter');
  const outputFolder = join(outputRoot, applicationFolderSegment(options.companyName, options.roleTitle));
  assertNotReadOnly(outputFolder);
  await mkdir(outputFolder, { recursive: true });
  const markdownPath = join(outputFolder, 'coverLetter.md');
  await writeFileAtomically(markdownPath, markdown);

  return {
    markdownPath,
    claimableTokens,
    excludedTokens,
    hallucinatedTokens: hallucinations,
  };
}
