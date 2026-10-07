import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import type { RawPosting } from '../scrapers/jobSpyAdapter';
import type { FitStatus } from '../utils/jobFunnelTracker';
import { resolveDataRoot } from '../utils/canonicalDataRoot';
import { compensationFromPosting } from './compExtractor';

// Deductive fit evaluator (SDD Requirement 2). Calculations start at a base
// score of 5.0 and apply forced deductions. There is no hardcoded rejection
// condition in this file: every hard-rejection decision comes from iterating
// the nonNegotiables list in jobPreferences.yaml (SDD Requirement 1a). The
// deduction weights here are the spec constants from Requirement 2, not
// personal thresholds — the latter live in user config and are read only
// through the `preferences` argument, never hardcoded.

export const baseFitScore = 5.0;
export const missingHardRequirementPenalty = 2.5;
export const yearsExperienceScoreCap = 2.5;
export const domainDiscrepancyPenalty = 1.0;

export const manualReviewFloor = 2.5;
export const strongFitFloor = 3.5;

export type NonNegotiableCategory = 'location' | 'employerType' | 'clearance' | 'compensation' | 'custom';

export const nonNegotiableCategorySchema = z.enum([
  'location',
  'employerType',
  'clearance',
  'compensation',
  'custom',
]);

export const nonNegotiableSchema = z.object({
  id: z.string(),
  category: nonNegotiableCategorySchema,
  rule: z.string(),
});

export const compensationPreferencesSchema = z.object({
  currency: z.string(),
  minAcceptableBase: z.number().min(0),
  targetBase: z.number().min(0),
  countsBonusTowardMin: z.boolean(),
  countsEquityTowardMin: z.boolean(),
});
export const clearancePreferencesSchema = z.object({
  currentStatus: z.string(),
  currentLevel: z.string().nullable(),
  eligibleToObtain: z.boolean(),
  requiresSponsorshipForVisa: z.boolean(),
});

// Optional directories block. outputRoot and resumeVariantsFile stay
// configurable (blank/null = current behavior); dataRoot relocation via
// config is removed (CLI-plus-env-only, SDD Section 10.2) and rejected loudly
// here so a stale key can never be silently ignored. Resolution precedence
// lives in canonicalDataRoot.ts: CLI flag > WEJOBSEARCHDATAROOT env >
// canonicalDataRoot() default. Templates are NOT configurable here (H1b):
// stale templateRoot keys in existing files are stripped, not rejected. All
// keys are camelCase per the naming rules.
export const directoriesPreferencesSchema = z
  .object({
    dataRoot: z.string().nullable().default(null),
    outputRoot: z.string().nullable().default(null),
    resumeVariantsFile: z.string().nullable().default(null),
  })
  .superRefine((directories, ctx) => {
    if (directories.dataRoot !== null && directories.dataRoot.trim().length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'directories.dataRoot is no longer supported for relocation (CLI-plus-env-only): ' +
          'use an explicit --dataRoot flag or WEJOBSEARCHDATAROOT instead, then remove the key.',
      });
    }
  });

export type DirectoriesPreferences = z.infer<typeof directoriesPreferencesSchema>;

export const jobPreferencesSchema = z.object({
  compensation: compensationPreferencesSchema,
  clearance: clearancePreferencesSchema,
  nonNegotiables: z.array(nonNegotiableSchema),
  preferredLocations: z.array(z.string()),
  directories: directoriesPreferencesSchema.optional(),
  // Roles/titles the user is targeting (EUO-02, G6). Plain data list, not a
  // rule engine (consistent with Req 1a's typed-list design). Optional so
  // existing preference files without the key still validate; the service
  // layer defaults it to [] on init and preserves it on partial updates.
  targetRoles: z.array(z.string()).optional(),
  // Search-result cache freshness window in minutes (SRA-06). Optional: when
  // absent, searchCache.ts falls back to its documented default (30 min).
  searchCacheTtlMinutes: z.number().int().positive().optional(),
});

export type NonNegotiable = z.infer<typeof nonNegotiableSchema>;
export type JobPreferences = z.infer<typeof jobPreferencesSchema>;

export function parseJobPreferences(content: string): JobPreferences {
  let parsed: unknown;
  try {
    parsed = parseYaml(content);
  } catch (error) {
    // Syntactically invalid YAML throws a raw YAMLParseError from the yaml
    // package; normalize it to the same readable prefix as schema failures so
    // every caller (loadJobPreferences, readUserProfile, mergeJobPreferences,
    // initWizard) surfaces one consistent error shape.
    throw new Error(`Invalid jobPreferences YAML: ${(error as Error).message}`);
  }
  const result = jobPreferencesSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`Invalid jobPreferences YAML: ${result.error.message}`);
  }
  return result.data;
}

export async function loadJobPreferences(
  filePath: string = join(resolveDataRoot(), 'jobPreferences.yaml'),
): Promise<JobPreferences> {
  let content: string;
  try {
    content = await readFile(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(
        `jobPreferences.yaml not found at ${filePath}; run the init wizard to create it`,
      );
    }
    throw error;
  }
  return parseJobPreferences(content);
}

export interface PostingRequirements {
  requiredSkills: string[];
  requiredYearsOfExperience: number | null;
  requiredDomains: string[];
}

export interface CandidateCapabilities {
  skills: string[];
  yearsOfExperience: number;
  domains: string[];
}

export interface PostingFacts {
  // 'unknown' is an explicit, honest value from postingFactsExtractor: a
  // location with no remote/hybrid/onsite signal must not be guessed as
  // onsite, since the remoteOnly nonNegotiable flags fully-onsite postings
  // for manualReview and a wrong guess would falsely flag remote-capable roles.
  locationType?: 'remote' | 'hybrid' | 'onsite' | 'unknown';
  employerType?: string | null;
  requiredClearanceLevel?: string | null;
}

export interface FitEvaluationInput {
  posting: RawPosting;
  requirements: PostingRequirements;
  candidate: CandidateCapabilities;
  preferences: JobPreferences;
  postingFacts?: PostingFacts;
}

export type FitDeductionKind = 'missingHardRequirement' | 'yearsOfExperienceCap' | 'domainDiscrepancy';

export interface FitDeduction {
  kind: FitDeductionKind;
  label: string;
  amount: number;
}

export type NonNegotiableCheckOutcome = 'compliant' | 'violated' | 'unknown';

export interface NonNegotiableCheck {
  id: string;
  category: NonNegotiableCategory;
  outcome: NonNegotiableCheckOutcome;
  note: string;
}

export interface FitAssessment {
  fitScore: number;
  fitStatus: FitStatus;
  deductions: FitDeduction[];
  nonNegotiableChecks: NonNegotiableCheck[];
  rejectedNonNegotiableIds: string[];
  notes: string[];
  baseScore: number;
  hasFullDescription: boolean;
}

export function normalizeToken(token: string): string {
  return token.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function uniqueNormalizedSkills(skills: string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const skill of skills) {
    const normalized = normalizeToken(skill);
    if (normalized.length > 0 && !seen.has(normalized)) {
      seen.add(normalized);
      unique.push(normalized);
    }
  }
  return unique;
}

function missingRequiredSkills(required: string[], candidateSkills: string[]): string[] {
  const owned = new Set(candidateSkills.map((skill) => normalizeToken(skill)));
  return uniqueNormalizedSkills(required).filter((skill) => !owned.has(skill));
}

function hasDomainOverlap(candidateDomains: string[], requiredDomains: string[]): boolean {
  const owned = new Set(candidateDomains.map((domain) => normalizeToken(domain)));
  return requiredDomains.some((domain) => owned.has(normalizeToken(domain)));
}

function roundTwoDecimals(value: number): number {
  return Math.round(value * 100) / 100;
}

// Score bands and routing from the SDD Requirement 2 table. A pure function so
// the exact boundary values are unit-testable.
export function classifyScore(score: number): FitStatus {
  const value = roundTwoDecimals(score);
  if (value === 0) {
    return 'hardRejected';
  }
  if (value < manualReviewFloor) {
    return 'weakFit';
  }
  if (value < strongFitFloor) {
    return 'manualReview';
  }
  return 'strongFit';
}

interface DeductiveScore {
  score: number;
  missingSkills: string[];
  missingHardTotal: number;
  domainApplied: boolean;
  yearsDeficit: boolean;
  yearsCapApplied: boolean;
  yearsCapAmount: number;
}

function computeDeductiveScore(
  input: FitEvaluationInput,
  excludeMissingHardRequirements: boolean,
): DeductiveScore {
  const { posting, requirements, candidate } = input;
  let score = baseFitScore;

  const missingSkills = missingRequiredSkills(requirements.requiredSkills, candidate.skills);
  let missingHardTotal = 0;
  if (!excludeMissingHardRequirements && missingSkills.length > 0) {
    if (posting.hasFullDescription) {
      // -2.5 per missing required tool/language/certification.
      missingHardTotal = missingHardRequirementPenalty * missingSkills.length;
    } else {
      // Incomplete source data: cap the missing-requirement deduction at a
      // single unit. A partial description never had the chance to mention
      // every required tool, so it must not push deep into weakFit/hard
      // territory on its own.
      missingHardTotal = missingHardRequirementPenalty;
    }
    score -= missingHardTotal;
  }

  let domainApplied = false;
  if (
    requirements.requiredDomains.length > 0 &&
    !hasDomainOverlap(candidate.domains, requirements.requiredDomains)
  ) {
    score -= domainDiscrepancyPenalty;
    domainApplied = true;
  }

  let yearsDeficit = false;
  let yearsCapApplied = false;
  let yearsCapAmount = 0;
  if (
    requirements.requiredYearsOfExperience !== null &&
    candidate.yearsOfExperience < requirements.requiredYearsOfExperience
  ) {
    yearsDeficit = true;
    if (score > yearsExperienceScoreCap) {
      yearsCapAmount = roundTwoDecimals(score - yearsExperienceScoreCap);
      score = yearsExperienceScoreCap;
      yearsCapApplied = true;
    }
  }

  return {
    score: roundTwoDecimals(Math.max(0, score)),
    missingSkills,
    missingHardTotal,
    domainApplied,
    yearsDeficit,
    yearsCapApplied,
    yearsCapAmount,
  };
}

function classifyPostingLocationType(
  posting: RawPosting,
  facts: PostingFacts,
): 'remote' | 'hybrid' | 'onsite' | 'unknown' {
  if (facts.locationType !== undefined) {
    return facts.locationType;
  }
  const location = (posting.location ?? '').toLowerCase();
  if (/\bremote\b/.test(location)) {
    return 'remote';
  }
  if (/\bhybrid\b/.test(location)) {
    return 'hybrid';
  }
  // Neutral default: a posting with no remote/hybrid/onsite signal is
  // 'unknown', never guessed as 'onsite'. An 'unknown' location never triggers
  // a location rejection (the evaluator reports 'unknown' for the rule instead
  // of 'violated'), so neutral defaults (empty preferredLocations) and
  // signal-free postings are never penalized for location.
  return 'unknown';
}

function postingMatchesPreferredLocation(
  locationType: 'remote' | 'hybrid' | 'onsite' | 'unknown',
  postingLocation: string,
  preferredLocations: string[],
): boolean {
  if (preferredLocations.length === 0) {
    return true;
  }
  const postingStandard = normalizeToken(postingLocation);
  for (const preferred of preferredLocations) {
    if (!preferred || preferred.length === 0) {
      continue;
    }
    const preferredStandard = normalizeToken(preferred);
    if (preferredStandard.length === 0) {
      continue;
    }
    const preferredLabel = preferred.toLowerCase();
    const preferredIsRemote = /\bremote\b/.test(preferredLabel);
    const preferredIsHybrid = /\bhybrid\b/.test(preferredLabel);
    if (locationType === 'remote' || locationType === 'hybrid') {
      if (preferredIsRemote || preferredIsHybrid) {
        return true;
      }
      if (
        preferredStandard === postingStandard ||
        postingStandard.includes(preferredStandard) ||
        preferredStandard.includes(postingStandard)
      ) {
        return true;
      }
    } else {
      // Onsite posting: only an explicit place match satisfies it. A
      // remote-only preference does not accept an onsite posting.
      if (preferredIsRemote && !preferredIsHybrid) {
        continue;
      }
      if (
        preferredStandard === postingStandard ||
        postingStandard.includes(preferredStandard) ||
        preferredStandard.includes(postingStandard)
      ) {
        return true;
      }
    }
  }
  return false;
}

// The sanctioned non-direct-employer tags for the employerType category, taken
// from the canonical SDD example (SDD Requirement 1a). This is a tag taxonomy,
// not a personal threshold, and only applies when a posting's facts carry one
// of these tags.
const flaggedEmployerTypeTags = new Set([
  'staffing',
  'staffingagency',
  'staffingfirm',
  'recruitingagency',
  'tempagency',
]);

function evaluateEmployerTypeRule(postingFacts: PostingFacts): NonNegotiableCheckOutcome {
  const raw = postingFacts.employerType ?? '';
  if (raw.length === 0 || raw.toLowerCase() === 'unknown') {
    // postingFactsExtractor defaults employerType to 'unknown' when no
    // staffing/agency signal is present. That must surface as an honest
    // 'unknown' outcome, never a false 'compliant' direct-employer pass.
    return 'unknown';
  }
  const tag = raw.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (flaggedEmployerTypeTags.has(tag)) {
    return 'violated';
  }
  return 'compliant';
}

const clearanceLevelRank: Record<string, number> = {
  publictrust: 1,
  secret: 2,
  topsecret: 3,
  tssci: 4,
};

function evaluateClearanceRule(
  postingFacts: PostingFacts,
  preferences: JobPreferences,
): NonNegotiableCheckOutcome {
  const requiredLevel = postingFacts.requiredClearanceLevel ?? '';
  if (requiredLevel.length === 0) {
    return 'unknown';
  }
  // postingFactsExtractor emits 'none' when the posting carries no clearance
  // language at all: a posting requiring no clearance can never exceed the
  // candidate's current level, so this is a clean compliant outcome, distinct
  // from 'unknown' (clearance mentioned but level unstated) which must be
  // surfaced for a human decision.
  const normalizedLevel = normalizeToken(requiredLevel);
  if (normalizedLevel === 'none') {
    return 'compliant';
  }
  const requiredRank = clearanceLevelRank[normalizedLevel];
  if (requiredRank === undefined) {
    return 'unknown';
  }
  const currentLevel = preferences.clearance.currentLevel ?? '';
  const currentRank =
    currentLevel.length > 0 ? clearanceLevelRank[normalizeToken(currentLevel)] : undefined;
  const effectiveCurrentRank = currentRank ?? 0;
  if (requiredRank > effectiveCurrentRank && !preferences.clearance.eligibleToObtain) {
    return 'violated';
  }
  return 'compliant';
}

interface CompensationCheckResult {
  outcome: NonNegotiableCheckOutcome;
  // Informational targetBase sentence (never a violation): whether the
  // effective amount meets the user's configured targetBase. Empty when the
  // amount is unknown or incomparable.
  targetNote: string;
}

// A location-category rule whose rule text names manualReview (the SDD
// Requirement 1a remoteOnly example: "flag for manualReview if posting is
// fully onsite") requests human review, not rejection. The intent comes from
// the user's own rule wording in jobPreferences.yaml — never from the rule id
// and never from a hardcoded threshold in this file.
function locationRuleRequestsManualReview(ruleText: string): boolean {
  return /manual\s*-?\s*review/i.test(ruleText);
}

function evaluateCompensationRule(posting: RawPosting, preferences: JobPreferences): CompensationCheckResult {
  const compensation = compensationFromPosting(posting);
  const configCurrency = preferences.compensation.currency.toUpperCase();
  if (compensation === null) {
    return { outcome: 'unknown', targetNote: '' };
  }
  const postingCurrency = compensation.currency.toUpperCase();
  if (postingCurrency !== configCurrency || compensation.period !== 'year') {
    return { outcome: 'unknown', targetNote: '' };
  }
  // Which posted figure is held to the bar is governed by the user's own
  // counting posture (no max-only defect, no dead fallback): under a strict
  // base-only posture (both flags false) the guaranteed floor — the posted
  // minimum — must clear minAcceptableBase; when bonus and/or equity count
  // toward the minimum, the top of the advertised range (achievable total)
  // satisfying the bar suffices. Both figures come from the posting, both
  // thresholds from jobPreferences.yaml, never this file.
  const generousCounting =
    preferences.compensation.countsBonusTowardMin || preferences.compensation.countsEquityTowardMin;
  const representativeAmount = generousCounting ? compensation.maxAmount : compensation.minAmount;
  if (representativeAmount === null) {
    return { outcome: 'unknown', targetNote: '' };
  }
  if (representativeAmount < preferences.compensation.minAcceptableBase) {
    return { outcome: 'violated', targetNote: '' };
  }
  // targetBase is aspirational, never a rejection: it only enriches the note
  // so the user sees whether the posting meets their target as well as their
  // floor. Both numbers come from jobPreferences.yaml, never this file.
  const targetNote =
    representativeAmount >= preferences.compensation.targetBase
      ? `Posted base salary meets targetBase ${preferences.compensation.targetBase}`
      : `Posted base salary meets minAcceptableBase but is below targetBase ${preferences.compensation.targetBase}`;
  return { outcome: 'compliant', targetNote };
}

export function evaluateFit(input: FitEvaluationInput): FitAssessment {
  const { posting, requirements, candidate, preferences } = input;
  const facts: PostingFacts = input.postingFacts ?? {};
  const notes: string[] = [];
  const checkResults: NonNegotiableCheck[] = [];
  const deductions: FitDeduction[] = [];

  const deductive = computeDeductiveScore(input, false);
  const hypotheticalWithoutMissing = computeDeductiveScore(input, true);

  if (posting.hasFullDescription) {
    for (const skill of deductive.missingSkills) {
      deductions.push({
        kind: 'missingHardRequirement',
        label: `Missing required skill: ${skill}`,
        amount: -missingHardRequirementPenalty,
      });
    }
  } else if (deductive.missingSkills.length > 0) {
    deductions.push({
      kind: 'missingHardRequirement',
      label: `Posting source incomplete; required skill(s) ${deductive.missingSkills.join(', ')} could not be confirmed`,
      amount: -missingHardRequirementPenalty,
    });
    notes.push(
      `hasFullDescription=false: missing-requirement deduction capped to ${missingHardRequirementPenalty}`,
    );
  }
  if (deductive.domainApplied) {
    deductions.push({
      kind: 'domainDiscrepancy',
      label: `Candidate lacks required domain: ${requirements.requiredDomains.join(', ')}`,
      amount: -domainDiscrepancyPenalty,
    });
  }
  if (deductive.yearsCapApplied) {
    deductions.push({
      kind: 'yearsOfExperienceCap',
      label: `Candidate has ${candidate.yearsOfExperience} years; posting requires ${requirements.requiredYearsOfExperience} — score capped at ${yearsExperienceScoreCap}`,
      amount: -deductive.yearsCapAmount,
    });
  }

  let score = deductive.score;
  let fitStatus = classifyScore(score);

  // hasFullDescription:false routing: if the only thing keeping this posting
  // out of the manualReview band is a missing-requirement deduction derived
  // from an incomplete description, route to manualReview. This is a "not
  // enough information, a human should look" case, not a fit judgment in
  // either direction — never silently upgrade it to strongFit.
  if (
    !posting.hasFullDescription &&
    deductive.missingSkills.length > 0 &&
    (fitStatus === 'weakFit' || fitStatus === 'hardRejected' || score === 0)
  ) {
    if (hypotheticalWithoutMissing.score >= manualReviewFloor) {
      const previousStatus = fitStatus;
      fitStatus = 'manualReview';
      notes.push(
        `hasFullDescription=false: without the unconfirmable missing-requirement deduction this posting would score ${hypotheticalWithoutMissing.score}; routed to manualReview instead of ${previousStatus}`,
      );
    }
  }

  let anyRejected = false;
  const rejectedNonNegotiableIds: string[] = [];
  let hasCustomRule = false;
  let hasLocationReviewRequest = false;

  for (const rule of preferences.nonNegotiables) {
    let outcome: NonNegotiableCheckOutcome = 'compliant';
    let note = `NonNegotiable '${rule.id}' passed its check`;
    switch (rule.category) {
      // NOTE: a nonNegotiable with id 'remoteOnly' is an ordinary
      // location-category rule: its behavior comes from preferredLocations,
      // not from the id string. It is distinct from the --remoteOnly CLI
      // display filter in the search layer, which only narrows rendered
      // results and never reaches this evaluator. No new evaluator category
      // is introduced for it.
      case 'location': {
        const locationType = classifyPostingLocationType(posting, facts);
        if (locationType === 'unknown') {
          // No remote/hybrid/onsite signal on this posting: the rule cannot be
          // evaluated, so it is reported as 'unknown', never 'violated'. An
          // unknown location never triggers a location rejection.
          outcome = 'unknown';
          note = `Posting location '${posting.location}' carries no remote/hybrid/onsite signal; cannot evaluate`;
          break;
        }
        const compatible = postingMatchesPreferredLocation(
          locationType,
          posting.location,
          preferences.preferredLocations,
        );
        if (compatible) {
          note = `Posting location '${posting.location}' (${locationType}) is within preferredLocations`;
        } else if (locationRuleRequestsManualReview(rule.rule)) {
          // Review intent, not reject intent (SDD Requirement 1a remoteOnly
          // example): an incompatible location under a manualReview-worded
          // rule routes to manualReview via the unknown outcome, never to
          // hardRejected. A reject-worded rule (for example noRelocation's
          // "reject if ...") still violates below.
          outcome = 'unknown';
          note = `Posting location '${posting.location}' (${locationType}) falls outside preferredLocations; rule '${rule.id}' requests manualReview rather than rejection`;
          hasLocationReviewRequest = true;
        } else {
          outcome = 'violated';
          note = `Posting location '${posting.location}' (${locationType}) falls outside preferredLocations`;
        }
        break;
      }
      case 'employerType': {
        const employerOutcome = evaluateEmployerTypeRule(facts);
        outcome = employerOutcome;
        if (employerOutcome === 'violated') {
          note = 'Employer is tagged as a non-direct employer type';
        } else if (employerOutcome === 'compliant') {
          note = 'Employer is a direct employer';
        } else {
          note = 'No employer type signal on this posting; cannot evaluate';
        }
        break;
      }
      case 'clearance': {
        const clearanceOutcome = evaluateClearanceRule(facts, preferences);
        outcome = clearanceOutcome;
        if (clearanceOutcome === 'violated') {
          note = 'Posting requires clearance above current level and eligibility to obtain is false';
        } else if (clearanceOutcome === 'compliant') {
          note = 'Posting clearance requirement is within eligibility';
        } else {
          note = 'No clearance level available on this posting; cannot evaluate';
        }
        break;
      }
      case 'compensation': {
        const compensationCheck = evaluateCompensationRule(posting, preferences);
        outcome = compensationCheck.outcome;
        if (outcome === 'violated') {
          note = 'Posted base salary is below minAcceptableBase';
        } else if (outcome === 'compliant') {
          note = `Posted base salary meets minAcceptableBase. ${compensationCheck.targetNote}`;
        } else {
          note = 'Posted salary is unparseable or incomparable to the configured minimum';
        }
        break;
      }
      case 'custom':
        outcome = 'unknown';
        note = `Custom rule '${rule.id}' cannot be interpreted automatically; flagged for manualReview`;
        hasCustomRule = true;
        break;
    }

    if (outcome === 'violated') {
      rejectedNonNegotiableIds.push(rule.id);
      anyRejected = true;
    }
    if (outcome === 'unknown') {
      notes.push(`Could not evaluate nonNegotiable '${rule.id}' (${rule.category}); ${note}`);
    }

    checkResults.push({
      id: rule.id,
      category: rule.category,
      outcome,
      note,
    });
  }

  if (anyRejected) {
    score = 0;
    fitStatus = 'hardRejected';
    notes.push(`Hard-rejection gate fired on nonNegotiables: ${rejectedNonNegotiableIds.join(', ')}`);
  } else {
    if (hasCustomRule) {
      fitStatus = 'manualReview';
      notes.push('A custom nonNegotiable is present; routed to manualReview');
    }
    if (hasLocationReviewRequest) {
      fitStatus = 'manualReview';
      notes.push('A location nonNegotiable requests manualReview for this posting; routed to manualReview rather than rejected');
    }
    // Salary-unknown is deliberately NOT routed here: a posting lacking
    // parseable salary records an 'unknown' check outcome plus a note above,
    // but the score band stands on its own — an unparseable salary must not
    // permanently bar strongFit where the SDD allows it.
  }

  return {
    fitScore: score,
    fitStatus,
    deductions,
    nonNegotiableChecks: checkResults,
    rejectedNonNegotiableIds,
    notes,
    baseScore: baseFitScore,
    hasFullDescription: posting.hasFullDescription,
  };
}
