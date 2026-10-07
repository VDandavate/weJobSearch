import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { join, resolve } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import {
  parseJobPreferences,
  type NonNegotiable,
} from '../evaluators/fitEvaluator';
import { networkingContactsSchema } from '../utils/networkingContacts';
import {
  validateWizardCollectedInput,
  type ProfileInitializationInput,
} from '../utils/profileService';
import {
  canonicalDataRoot,
  ensureCanonicalDataDirectories,
  isPathInside,
  repoRootFromModule,
  resumeVariantsFileName,
} from '../utils/canonicalDataRoot';
import { formatNamingViolations, runNamingLinter } from '../utils/namingLinter';
import { writeProfileFilesAtomically, type ProfileFileWrite } from '../core/profileWriter';
import { realProfileFileNames } from '../utils/dataPortability';

export class InitCancelledError extends Error {
  constructor() {
    super('Setup cancelled by the user; no profile files were changed.');
    this.name = 'InitCancelledError';
  }
}

export class SetupValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SetupValidationError';
  }
}

const cancelWords: readonly string[] = ['q', 'quit', 'cancel', 'abort'];

export interface PromptContext {
  ask(inputPrompt: string): Promise<string>;
  print(lines: readonly string[]): void;
  close(): void;
}

export function createCliPromptContext(): PromptContext {
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  return {
    ask: async (inputPrompt: string) => readline.question(inputPrompt),
    print: (lines: readonly string[]) => {
      for (const line of lines) {
        process.stdout.write(`${line}\n`);
      }
    },
    close: () => {
      readline.close();
    },
  };
}

export interface ValuePrompt<T> {
  question: string;
  label: string;
  defaultValue?: T;
  required?: boolean;
  parse?: (raw: string) => T;
  validate?: (value: T) => string | null;
}

async function askValue<T>(ctx: PromptContext, prompt: ValuePrompt<T>): Promise<T | undefined> {
  for (;;) {
    const defaultText = prompt.defaultValue !== undefined ? ` [${String(prompt.defaultValue)}]` : '';
    ctx.print([`${prompt.question}${defaultText}:`]);
    const raw = (await ctx.ask('> ')).trim();
    if (cancelWords.includes(raw.toLowerCase())) {
      throw new InitCancelledError();
    }
    if (raw.length === 0) {
      if (prompt.required === true) {
        ctx.print([`${prompt.label} is required; enter a value (or 'q' to cancel).`]);
        continue;
      }
      if (prompt.defaultValue !== undefined) {
        return prompt.defaultValue;
      }
      return undefined;
    }
    try {
      const parsed = prompt.parse === undefined ? (raw as unknown as T) : prompt.parse(raw);
      const problem = prompt.validate === undefined ? null : prompt.validate(parsed as T);
      if (problem !== null) {
        ctx.print([problem]);
        continue;
      }
      return parsed;
    } catch (parseError) {
      ctx.print([`${prompt.label}: ${(parseError as Error).message}`]);
    }
  }
}

async function askBoolean(
  ctx: PromptContext,
  label: string,
  question: string,
  defaultValue: boolean,
): Promise<boolean> {
  const parsed = await askValue<boolean>(ctx, {
    question,
    label,
    defaultValue,
    parse: (raw) => {
      const normalized = raw.toLowerCase();
      if (['y', 'yes', 'true', '1'].includes(normalized)) {
        return true;
      }
      if (['n', 'no', 'false', '0'].includes(normalized)) {
        return false;
      }
      throw new Error(`answer yes or no; got '${raw}'.`);
    },
  });
  return parsed === undefined ? defaultValue : parsed;
}

async function askNumber(
  ctx: PromptContext,
  label: string,
  question: string,
  defaultValue: number,
  minimum: number = 0,
): Promise<number> {
  const parsed = await askValue<number>(ctx, {
    question,
    label,
    defaultValue,
    parse: (raw) => {
      const value = Number(raw.replace(/[$,]/g, '').trim());
      if (!Number.isFinite(value)) {
        throw new Error(`enter a number; got '${raw}'.`);
      }
      return value;
    },
    validate: (value) => (value < minimum ? `${label} must be >= ${minimum}; got ${value}.` : null),
  });
  return parsed === undefined ? defaultValue : parsed;
}

async function askCurrency(
  ctx: PromptContext,
  label: string,
  defaultValue: string,
): Promise<string> {
  const parsed = await askValue<string>(ctx, {
    question: 'Currency (3-letter ISO code, e.g. USD or EUR)',
    label,
    defaultValue,
    validate: (value) =>
      /^[A-Za-z]{3}$/.test(value)
        ? null
        : `${label} must be a 3-letter ISO code (e.g. USD, EUR); got '${value}'.`,
  });
  const value = parsed === undefined ? defaultValue : parsed;
  return value.toUpperCase();
}

async function askEnum<T extends string>(
  ctx: PromptContext,
  label: string,
  question: string,
  options: readonly T[],
  defaultValue: T,
): Promise<T> {
  const parsed = await askValue<T>(ctx, {
    question: `${question} (${options.join(' | ')})`,
    label,
    defaultValue,
    parse: (raw) => {
      const match = options.find(
        (option) => option.toLocaleLowerCase() === raw.toLocaleLowerCase(),
      );
      if (match === undefined) {
        throw new Error(`${label} must be one of ${options.join(', ')}; got '${raw}'.`);
      }
      return match;
    },
  });
  return parsed === undefined ? defaultValue : parsed;
}

async function collectStringList(
  ctx: PromptContext,
  label: string,
  entryQuestion: string,
  moreQuestion: string,
): Promise<string[]> {
  const items: string[] = [];
  ctx.print([`${label}: ${entryQuestion}`]);
  for (;;) {
    // Neutral defaults: a blank answer ends the list, so the first answer may
    // already be blank (an empty list means "no preference", never a penalty).
    const value = await askValue<string>(ctx, {
      question: entryQuestion,
      label,
      validate: (entry) => (entry.trim().length === 0 ? `${label} entries cannot be blank.` : null),
    });
    if (value === undefined) {
      break;
    }
    items.push(value.trim());
    const more = await askBoolean(ctx, label, moreQuestion, false);
    if (!more) {
      break;
    }
  }
  return items;
}

async function collectTargetRoles(ctx: PromptContext): Promise<string[]> {
  const parsed = await askValue<string>(ctx, {
    question:
      'Target roles or job titles (comma-separated, e.g. Senior Software Engineer, Staff Engineer)',
    label: 'targetRoles',
    defaultValue: '',
  });
  const value = parsed ?? '';
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

async function collectDirectories(ctx: PromptContext): Promise<CollectedDirectories> {
  const optionalPath = async (question: string, label: string): Promise<string | null> => {
    const value = await askValue<string>(ctx, {
      question: `${question} (blank for the default)`,
      label,
      defaultValue: '',
    });
    const trimmed = (value ?? '').trim();
    return trimmed.length > 0 ? trimmed : null;
  };
  return {
    outputRoot: await optionalPath('Generated-output root directory', 'directories.outputRoot'),
    resumeVariantsFile: await optionalPath('Resume variants file', 'directories.resumeVariantsFile'),
  };
}

const nonNegotiableCategories: readonly NonNegotiable['category'][] = [
  'location',
  'employerType',
  'clearance',
  'compensation',
  'custom',
];

async function collectNonNegotiables(ctx: PromptContext): Promise<NonNegotiable[]> {
  const rules: NonNegotiable[] = [];
  const usedIds = new Set<string>();
  for (;;) {
    const addMore = await askBoolean(ctx, 'nonNegotiables', 'Add a non-negotiable? [y/N]:', false);
    if (!addMore) {
      if (rules.length > 0) {
        break;
      }
      // Explicitly empty list (D-B): explain the effect and require typed
      // acknowledgment. Anything but 'accept empty' returns to rule entry,
      // so an empty gate is always a deliberate choice, never an accident.
      const acknowledged = await askValue<string>(ctx, {
        question:
          "You haven't set any non-negotiables. Job postings won't be rejected or flagged for review by a non-negotiable rule. Other checks still apply. Type accept empty to continue, or press Enter to add a rule.",
        label: 'nonNegotiables empty acknowledgment',
      });
      if ((acknowledged ?? '').trim().toLowerCase() === 'accept empty') {
        break;
      }
      continue;
    }
    const id = await askValue<string>(ctx, {
      question: 'Rule id (camelCase, unique, e.g. noRelocation)',
      label: 'nonNegotiable id',
      required: true,
      validate: (value) => {
        if (!/^[a-z][a-zA-Z0-9]*$/.test(value)) {
          return `id '${value}' must be camelCase (letters/digits, lower-case start).`;
        }
        if (usedIds.has(value)) {
          return `id '${value}' is already used; choose a unique id.`;
        }
        return null;
      },
    });
    if (id === undefined) {
      break;
    }
    usedIds.add(id);
    const category = await askEnum(
      ctx,
      'nonNegotiable category',
      'Category',
      nonNegotiableCategories,
      'custom',
    );
    const rule = await askValue<string>(ctx, {
      question:
        'Rule text (plain language, e.g. "reject if the posted base salary is below minAcceptableBase")',
      label: 'nonNegotiable rule',
      required: true,
      validate: (value) => (value.trim().length === 0 ? 'Rule text cannot be blank.' : null),
    });
    if (rule === undefined) {
      break;
    }
    rules.push({ id, category, rule });
  }
  return rules;
}

export interface CollectedCompensation {
  currency: string;
  minAcceptableBase: number;
  targetBase: number;
  countsBonusTowardMin: boolean;
  countsEquityTowardMin: boolean;
}

export interface CollectedClearance {
  currentStatus: string;
  currentLevel: string | null;
  eligibleToObtain: boolean;
  requiresSponsorshipForVisa: boolean;
}

export interface CollectedJobPreferences {
  compensation?: CollectedCompensation;
  clearance?: CollectedClearance;
  nonNegotiables?: NonNegotiable[];
  preferredLocations?: string[];
  targetRoles?: string[];
  directories?: CollectedDirectories;
}

// Remaining configurable directories (CLI-plus-env-only, SDD Section 10.2:
// the data root itself relocates only via --dataRoot or WEJOBSEARCHDATAROOT,
// so init no longer collects it). Every key is nullable; a blank answer means
// null (current behavior). Collected as one section so init stays idempotent:
// re-running the wizard preserves configured values unless the user edits
// this section.
export interface CollectedDirectories {
  outputRoot: string | null;
  resumeVariantsFile: string | null;
}

export const nullDirectories: CollectedDirectories = {
  outputRoot: null,
  resumeVariantsFile: null,
};

async function collectCompensation(ctx: PromptContext): Promise<CollectedCompensation> {
  return {
    currency: await askCurrency(ctx, 'compensation.currency', 'USD'),
    minAcceptableBase: await askNumber(
      ctx,
      'compensation.minAcceptableBase',
      'Minimum acceptable base salary',
      0,
    ),
    targetBase: await askNumber(ctx, 'compensation.targetBase', 'Target base salary', 0),
    countsBonusTowardMin: await askBoolean(
      ctx,
      'compensation.countsBonusTowardMin',
      'Count bonus toward the minimum? [y/N]:',
      false,
    ),
    countsEquityTowardMin: await askBoolean(
      ctx,
      'compensation.countsEquityTowardMin',
      'Count equity toward the minimum? [y/N]:',
      false,
    ),
  };
}

async function collectClearance(ctx: PromptContext): Promise<CollectedClearance> {
  const currentStatus = await askEnum(
    ctx,
    'clearance.currentStatus',
    'Current clearance status',
    ['none', 'interim', 'active', 'expired'],
    'none',
  );
  const currentLevel= await askEnum(
    ctx,
    'clearance.currentLevel',
    'Current clearance level',
    ['none', 'publicTrust', 'secret', 'topSecret', 'tsSci'],
    'none',
  );
  return {
    currentStatus,
    currentLevel: currentLevel === 'none' ? null : currentLevel,
    eligibleToObtain: await askBoolean(
      ctx,
      'clearance.eligibleToObtain',
      'Eligible to obtain clearance? [y/N]:',
      true,
    ),
    requiresSponsorshipForVisa: await askBoolean(
      ctx,
      'clearance.requiresSponsorshipForVisa',
      'Do you require visa sponsorship? [y/N]:',
      false,
    ),
  };
}

export interface CollectedWorkAuthorization {
  usCitizen: boolean;
  requiresSponsorship: boolean;
  sponsorshipType: string | null;
}

export interface CollectedScreeningCompensation {
  minBaseSalary: number;
  targetBaseSalary: number;
  currency: string;
}

export interface CollectedStandardQuestions {
  yearsOfExperience: Record<string, number>;
  preferredWorkLocation: string;
  noticePeriod: string;
}

export interface CollectedScreeningAnswers {
  workAuthorization?: CollectedWorkAuthorization;
  compensation?: CollectedScreeningCompensation;
  standardQuestions?: CollectedStandardQuestions;
}

interface ScreeningCompensationDefaults {
  currency: string;
  minBaseSalary: number;
  targetBaseSalary: number;
}

export interface ScreeningDefaultsResult {
  defaults: ScreeningCompensationDefaults;
  warning: string | null;
}

export async function screeningDefaultsFromPreferences(
  collectedCompensation: CollectedCompensation | undefined,
  preferenceFile: string,
): Promise<ScreeningDefaultsResult> {
  if (collectedCompensation !== undefined) {
    return {
      defaults: {
        currency: collectedCompensation.currency,
        minBaseSalary: collectedCompensation.minAcceptableBase,
        targetBaseSalary: collectedCompensation.targetBase,
      },
      warning: null,
    };
  }
  let existing: string | null = null;
  try {
    existing = await readFile(preferenceFile, 'utf8');
  } catch {
    existing = null;
  }
  if (existing !== null) {
    try {
      const parsed = parseJobPreferences(existing);
      return {
        defaults: {
          currency: parsed.compensation.currency,
          minBaseSalary: parsed.compensation.minAcceptableBase,
          targetBaseSalary: parsed.compensation.targetBase,
        },
        warning: null,
      };
    } catch (error) {
      // Malformed prefs previously fell through to silent defaults (B14g):
      // keep the fallback but surface exactly why it is in effect.
      return {
        defaults: { currency: 'USD', minBaseSalary: 0, targetBaseSalary: 0 },
        warning:
          `Existing ${preferenceFile} does not parse (${(error as Error).message}); ` +
          'screening compensation prefill falls back to defaults. Fix or replace the file to restore tailored defaults.',
      };
    }
  }
  return { defaults: { currency: 'USD', minBaseSalary: 0, targetBaseSalary: 0 }, warning: null };
}

async function collectScreeningAnswers(
  ctx: PromptContext,
  sections: ReadonlySet<string>,
  defaults: ScreeningCompensationDefaults,
): Promise<CollectedScreeningAnswers> {
  const result: CollectedScreeningAnswers = {};
  if (sections.has('workAuthorization')) {
    const usCitizen = await askBoolean(
      ctx,
      'workAuthorization.usCitizen',
      'Are you a US citizen? [y/N]:',
      false,
    );
    const requiresSponsorship = await askBoolean(
      ctx,
      'workAuthorization.requiresSponsorship',
      'Do you require visa sponsorship? [y/N]:',
      false,
    );
    let sponsorshipType: string | null = null;
    if (requiresSponsorship) {
      const typed = await askValue<string>(ctx, {
        question: 'Sponsorship type (e.g. H-1B)',
        label: 'workAuthorization.sponsorshipType',
        required: true,
      });
      sponsorshipType = typed === undefined ? null : typed;
    } else {
      const typed = await askValue<string>(ctx, {
        question: 'Sponsorship type (Press Enter for none, e.g. H-1B)',
        label: 'workAuthorization.sponsorshipType',
        defaultValue: '',
      });
      sponsorshipType = typed === undefined || typed.length === 0 ? null : typed;
    }
    result.workAuthorization = { usCitizen, requiresSponsorship, sponsorshipType };
  }
  if (sections.has('compensation')) {
    result.compensation = {
      minBaseSalary: await askNumber(
        ctx,
        'compensation.minBaseSalary',
        'Minimum base salary',
        defaults.minBaseSalary,
      ),
      targetBaseSalary: await askNumber(
        ctx,
        'compensation.targetBaseSalary',
        'Target base salary',
        defaults.targetBaseSalary,
      ),
      currency: await askCurrency(ctx, 'compensation.currency', defaults.currency),
    };
  }
  if (sections.has('standardQuestions')) {
    result.standardQuestions = {
      yearsOfExperience: {
        softwareEngineering: await askNumber(
          ctx,
          'yearsOfExperience.softwareEngineering',
          'Software engineering years',
          0,
        ),
        typescript: await askNumber(ctx, 'yearsOfExperience.typescript', 'TypeScript years', 0),
        python: await askNumber(ctx, 'yearsOfExperience.python', 'Python years', 0),
      },
      preferredWorkLocation:
        (await askValue<string>(ctx, {
          question: 'Preferred work location',
          label: 'standardQuestions.preferredWorkLocation',
          defaultValue: 'REPLACE_ME',
        })) ?? 'REPLACE_ME',
      noticePeriod:
        (await askValue<string>(ctx, {
          question: 'Notice period (e.g. 2 weeks)',
          label: 'standardQuestions.noticePeriod',
          defaultValue: 'REPLACE_ME',
        })) ?? 'REPLACE_ME',
    };
  }
  return result;
}

export interface CollectedContact {
  name: string;
  email: string;
  phone: string;
  cityState: string;
  linkedIn: string;
  portfolio: string;
}

export interface CollectedMasterWorkAuthorization {
  usCitizen: string;
  requiresSponsorship: string;
  clearance: string;
}

export interface CollectedMasterProfile {
  contact?: CollectedContact;
  workAuthorization?: CollectedMasterWorkAuthorization;
}

async function collectMasterProfile(
  ctx: PromptContext,
  sections: ReadonlySet<string>,
): Promise<CollectedMasterProfile> {
  const result: CollectedMasterProfile = {};
  if (sections.has('contact')) {
    const text = async (question: string, label: string): Promise<string> => {
      const value = await askValue<string>(ctx, {
        question,
        label,
        defaultValue: 'REPLACE_ME',
      });
      return value === undefined || value.length === 0 ? 'REPLACE_ME' : value;
    };
    result.contact = {
      name: await text('Full name', 'contact.name'),
      email: await text('Email', 'contact.email'),
      phone: await text('Phone', 'contact.phone'),
      cityState: await text('City / State', 'contact.cityState'),
      linkedIn: await text('LinkedIn URL', 'contact.linkedIn'),
      portfolio: await text('Portfolio URL', 'contact.portfolio'),
    };
  }
  if (sections.has('workAuthorization')) {
    result.workAuthorization = {
      usCitizen:
        (await askValue<string>(ctx, {
          question: 'US citizen (yes/no)',
          label: 'masterProfile.workAuthorization.usCitizen',
          defaultValue: 'REPLACE_ME',
        })) ?? 'REPLACE_ME',
      requiresSponsorship:
        (await askValue<string>(ctx, {
          question: 'Requires visa sponsorship (yes/no)',
          label: 'masterProfile.workAuthorization.requiresSponsorship',
          defaultValue: 'REPLACE_ME',
        })) ?? 'REPLACE_ME',
      clearance:
        (await askValue<string>(ctx, {
          question: 'Current clearance (none, secret, topSecret, ...)',
          label: 'masterProfile.workAuthorization.clearance',
          defaultValue: 'REPLACE_ME',
        })) ?? 'REPLACE_ME',
    };
  }
  return result;
}

const jobPreferencesOptionLabels = ['compensation', 'clearance', 'nonNegotiables', 'preferredLocations', 'targetRoles', 'directories'] as const;
const screeningOptionLabels = ['workAuthorization', 'compensation', 'standardQuestions'] as const;
const masterProfileOptionLabels = ['contact', 'workAuthorization'] as const;

function objectSectionsForFile(fileName: string): readonly string[] {
  if (fileName === 'jobPreferences.yaml') {
    return jobPreferencesOptionLabels;
  }
  if (fileName === 'screeningAnswers.json') {
    return screeningOptionLabels;
  }
  if (fileName === 'masterProfile.md') {
    return masterProfileOptionLabels;
  }
  return [];
}

async function askExistingFileMode(
  ctx: PromptContext,
  fileName: string,
): Promise<'keep' | 'update' | 'replace'> {
  const allowUpdate = fileName !== 'networkingContacts.json';
  const keyOptions = allowUpdate ? 'k/u/r' : 'k/r';
  const parsed = await askValue<'keep' | 'update' | 'replace'>(ctx, {
    question: `${fileName} already exists. Keep as is, update a section, or replace? (${keyOptions})`,
    label: `decision for ${fileName}`,
    required: true,
    parse: (raw) => {
      const normalized = raw.toLowerCase();
      if (normalized === 'keep') {
        return 'keep';
      }
      if (normalized === 'replace') {
        return 'replace';
      }
      if (normalized === 'update' && allowUpdate) {
        return 'update';
      }
      throw new Error(`choose ${keyOptions} (update is not allowed for ${fileName}).`);
    },
  });
  return parsed ?? 'keep';
}

async function confirmReplaceFile(ctx: PromptContext, fileName: string): Promise<boolean> {
  const answer = await askValue<string>(ctx, {
    question: `Type 'replace' to overwrite ${fileName}, or press Enter to keep it`,
    label: `replace confirmation for ${fileName}`,
    defaultValue: 'keep',
    parse: (raw) => (raw.trim().toLowerCase() === 'replace' ? 'replace' : 'keep'),
  });
  return answer === 'replace';
}

async function askSectionsToUpdate(
  ctx: PromptContext,
  fileName: string,
): Promise<ReadonlySet<string>> {
  const options = objectSectionsForFile(fileName);
  for (;;) {
    ctx.print([`Select section(s) of ${fileName} to update:`]);
    options.forEach((label, index) => ctx.print([`  ${index + 1}) ${label}`]));
    const raw = (await ctx.ask('Sections to update (comma-separated numbers): ')).trim();
    if (cancelWords.includes(raw.toLowerCase())) {
      throw new InitCancelledError();
    }
    const parts = raw
      .split(',')
      .map((part) => part.trim())
      .filter((part) => part.length > 0);
    if (parts.length === 0) {
      ctx.print(['Select at least one section number.']);
      continue;
    }
    const selected = new Set<string>();
    let invalid = false;
    for (const part of parts) {
      const number = Number.parseInt(part, 10);
      if (!Number.isInteger(number) || number < 1 || number > options.length) {
        ctx.print([`Invalid section number '${part}'; choose 1-${options.length}.`]);
        invalid = true;
        break;
      }
      selected.add(options[number - 1]);
    }
    if (invalid) {
      continue;
    }
    return selected;
  }
}

export type ProfileFileMode = 'create' | 'keep' | 'update' | 'replace';

export interface InitWizardOptions {
  prompt: PromptContext;
  profileDirectory?: string;
  repoRoot?: string;
  // Seed the working resumeVariants.yaml. Defaults to true when no explicit
  // profileDirectory is given (canonical-root setup). The init command always
  // passes true (B1): both the plain canonical-root run and a --dataRoot
  // relocated run target a data root, so both seed. Direct profileDirectory
  // overrides without the flag (tests, alternate locations) keep full
  // control and are never mutated with extra files.
  seedVariants?: boolean;
}

export interface InitWizardResult {
  exitCode: number;
  printedLines: string[];
  created: string[];
  updated: string[];
  unchanged: string[];
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}

async function readTextOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

const defaultCompensation: CollectedCompensation = {
  currency: 'USD',
  minAcceptableBase: 0,
  targetBase: 0,
  countsBonusTowardMin: false,
  countsEquityTowardMin: false,
};

const defaultClearance: CollectedClearance = {
  currentStatus: 'none',
  currentLevel: null,
  eligibleToObtain: true,
  requiresSponsorshipForVisa: false,
};

function validateCollectedJobPreferences(collected: CollectedJobPreferences): void {
  const compensation = collected.compensation;
  if (compensation !== undefined) {
    if (!/^[A-Za-z]{3}$/.test(compensation.currency)) {
      throw new SetupValidationError(
        `compensation.currency: '${compensation.currency}' is not a valid 3-letter ISO code. Enter USD, EUR, GBP, or another 3-letter code.`,
      );
    }
    for (const key of ['minAcceptableBase', 'targetBase'] as const) {
      const value = compensation[key];
      if (!Number.isFinite(value) || value < 0) {
        throw new SetupValidationError(
          `compensation.${key}: must be a non-negative number; got ${String(value)}.`,
        );
      }
    }
  }
  const clearance = collected.clearance;
  if (clearance !== undefined) {
    const statuses = ['none', 'interim', 'active', 'expired'];
    if (!statuses.includes(clearance.currentStatus)) {
      throw new SetupValidationError(
        `clearance.currentStatus: '${clearance.currentStatus}' is not one of ${statuses.join(', ')}.`,
      );
    }
    const levels = [null, 'publicTrust', 'secret', 'topSecret', 'tsSci'];
    if (!levels.includes(clearance.currentLevel)) {
      throw new SetupValidationError(
        `clearance.currentLevel: '${String(clearance.currentLevel)}' is not one of ${levels
          .map((level) => level ?? 'null')
          .join(', ')}.`,
      );
    }
  }
  const rules = collected.nonNegotiables;
  if (rules !== undefined) {
    const ids = new Set<string>();
    const knownCategories = new Set<string>([
      'location',
      'employerType',
      'clearance',
      'compensation',
      'custom',
    ]);
    for (const rule of rules) {
      if (rule.id.trim().length === 0) {
        throw new SetupValidationError('nonNegotiables: every rule id must be non-empty.');
      }
      if (ids.has(rule.id)) {
        throw new SetupValidationError(`nonNegotiables: duplicate rule id '${rule.id}'.`);
      }
      ids.add(rule.id);
      if (!knownCategories.has(rule.category)) {
        throw new SetupValidationError(
          `nonNegotiables '${rule.id}': category '${rule.category}' is not one of ${[
            ...knownCategories,
          ].join(', ')}.`,
        );
      }
      if (rule.rule.trim().length === 0) {
        throw new SetupValidationError(`nonNegotiables '${rule.id}': rule text cannot be blank.`);
      }
    }
  }
  const preferred = collected.preferredLocations;
  if (preferred !== undefined) {
    for (const entry of preferred) {
      if (entry.trim().length === 0) {
        throw new SetupValidationError('preferredLocations entries cannot be blank.');
      }
    }
  }
  const directories = collected.directories;
  if (directories !== undefined) {
    for (const key of ['outputRoot', 'resumeVariantsFile'] as const) {
      const value = directories[key];
      if (value !== null && value.trim().length === 0) {
        throw new SetupValidationError(`directories.${key}: must be a non-blank path or blank (null).`);
      }
    }
  }
}

function buildJobPreferencesYaml(
  collected: CollectedJobPreferences,
  existing: Record<string, unknown> | null,
): string {
  if (existing === null) {
    return stringifyYaml({
      compensation: collected.compensation ?? defaultCompensation,
      clearance: collected.clearance ?? defaultClearance,
      nonNegotiables: collected.nonNegotiables ?? [],
      preferredLocations: collected.preferredLocations ?? [],
      targetRoles: collected.targetRoles ?? [],
      directories: collected.directories ?? { ...nullDirectories },
    });
  }
  const record = { ...existing };
  if (collected.compensation !== undefined) {
    record.compensation = collected.compensation;
  }
  if (collected.clearance !== undefined) {
    record.clearance = collected.clearance;
  }
  if (collected.nonNegotiables !== undefined) {
    record.nonNegotiables = collected.nonNegotiables;
  }
  if (collected.preferredLocations !== undefined) {
    record.preferredLocations = collected.preferredLocations;
  }
  if (collected.targetRoles !== undefined) {
    record.targetRoles = collected.targetRoles;
  }
  if (collected.directories !== undefined) {
    record.directories = collected.directories;
  } else if (record.directories === undefined) {
    // Idempotent backfill: an existing file from before the directories block
    // gains the explicit null block so every file carries the same shape.
    record.directories = { ...nullDirectories };
  }
  return stringifyYaml(record);
}

import { screeningAnswersSchema, type ScreeningAnswers } from '../utils/profileSchemas';

// Re-exported so existing importers keep working; the schema itself is owned
// by the neutral profileSchemas module (see its header comment).
export { screeningAnswersSchema, type ScreeningAnswers };

const defaultScreeningWorkAuthorization: CollectedWorkAuthorization = {
  usCitizen: false,
  requiresSponsorship: false,
  sponsorshipType: null,
};

const defaultScreeningCompensation: CollectedScreeningCompensation = {
  minBaseSalary: 0,
  targetBaseSalary: 0,
  currency: 'USD',
};

const defaultStandardQuestions: CollectedStandardQuestions = {
  yearsOfExperience: { softwareEngineering: 0, typescript: 0, python: 0 },
  preferredWorkLocation: 'REPLACE_ME',
  noticePeriod: 'REPLACE_ME',
};

function buildScreeningAnswersJson(
  collected: CollectedScreeningAnswers,
  existing: Record<string, unknown> | null,
): string {
  if (existing !== null) {
    const record = { ...existing };
    if (collected.workAuthorization !== undefined) {
      record.workAuthorization = collected.workAuthorization;
    }
    if (collected.compensation !== undefined) {
      record.compensation = collected.compensation;
    }
    if (collected.standardQuestions !== undefined) {
      record.standardQuestions = collected.standardQuestions;
    }
    return `${JSON.stringify(record, null, 2)}\n`;
  }
  const answers: ScreeningAnswers = {
    workAuthorization: collected.workAuthorization ?? defaultScreeningWorkAuthorization,
    compensation: collected.compensation ?? defaultScreeningCompensation,
    standardQuestions: collected.standardQuestions ?? defaultStandardQuestions,
  };
  return `${JSON.stringify(answers, null, 2)}\n`;
}

function validateScreeningJson(content: string, path: string): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new SetupValidationError(
      `Could not parse the generated ${path}: ${(error as Error).message}`,
    );
  }
  const result = screeningAnswersSchema.safeParse(parsed);
  if (!result.success) {
    throw new SetupValidationError(
      `Generated ${path} does not conform to the screeningAnswers schema: ${result.error.message}`,
    );
  }
}

function validateNetworkingJson(content: string, path: string): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new SetupValidationError(
      `Could not parse the generated ${path}: ${(error as Error).message}`,
    );
  }
  const result = networkingContactsSchema.safeParse(parsed);
  if (!result.success) {
    throw new SetupValidationError(
      `Generated ${path} does not conform to the networkingContacts schema: ${result.error.message}`,
    );
  }
}

const requiredProfileHeadings = [
  '## Contact',
  '## Work Authorization',
  '## Summary',
  '## Skills',
  '## Experience',
  '## Education',
  '## Certifications',
] as const;

function contactSectionLines(contact: CollectedContact | undefined): string[] {
  const value: Partial<CollectedContact> = contact ?? {};
  return [
    '## Contact',
    `- Name: ${value.name ?? 'REPLACE_ME'}`,
    `- Email: ${value.email ?? 'REPLACE_ME'}`,
    `- Phone: ${value.phone ?? 'REPLACE_ME'}`,
    `- City / State: ${value.cityState ?? 'REPLACE_ME'}`,
    `- LinkedIn: ${value.linkedIn ?? 'REPLACE_ME'}`,
    `- Portfolio: ${value.portfolio ?? 'REPLACE_ME'}`,
    '',
  ];
}

function workAuthorizationSectionLines(
  work: CollectedMasterWorkAuthorization | undefined,
): string[] {
  const value: Partial<CollectedMasterWorkAuthorization> = work ?? {};
  return [
    '## Work Authorization',
    `- US Citizen: ${value.usCitizen ?? 'REPLACE_ME'}`,
    `- Requires Visa Sponsorship: ${value.requiresSponsorship ?? 'REPLACE_ME'}`,
    `- Current Clearance: ${value.clearance ?? 'REPLACE_ME'}`,
    '',
  ];
}

function assertMasterProfileSections(markdown: string, path: string): void {
  for (const heading of requiredProfileHeadings) {
    if (!markdown.includes(heading)) {
      throw new SetupValidationError(
        `masterProfile.md would be missing the '${heading}' section that resumeGenerator expects; refusing to write ${path}.`,
      );
    }
  }
}

function replaceMarkdownSection(
  markdown: string,
  heading: string,
  replacementLines: readonly string[],
): string {
  const lines = markdown.split(/\r?\n/);
  const headingIndex = lines.findIndex((line) => line.trim() === heading);
  if (headingIndex === -1) {
    const trimmed = markdown.replace(/\s+$/, '');
    return `${trimmed}\n\n${replacementLines.join('\n')}`;
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
  return `${head}${separator}${replacementLines.join('\n')}${tail.length > 0 ? `\n${tail}` : ''}`;
}

function buildMasterProfileMarkdown(
  collected: CollectedMasterProfile,
  existing: string | null,
): string {
  if (existing === null) {
    const lines = [
      '# Master Profile (Candidate Ground Truth)',
      '',
      ...contactSectionLines(collected.contact),
      ...workAuthorizationSectionLines(collected.workAuthorization),
      '## Summary',
      'REPLACE_ME',
      '',
      '## Skills',
      '- Languages: item1, item2, item3',
      '- itemWithoutCategory',
      '',
      '## Experience',
      '### Role Title | Employer | Location',
      '- Start: YYYY-MM',
      '- End: YYYY-MM or Present',
      '- Bullet text.',
      '',
      '## Education',
      '### Degree | Institution',
      '- Start: YYYY',
      '- End: YYYY',
      '',
      '## Certifications',
      '- Certification Name',
      '',
    ];
    return `${lines.join('\n')}\n`;
  }
  let markdown = existing;
  if (collected.contact !== undefined) {
    markdown = replaceMarkdownSection(markdown, '## Contact', contactSectionLines(collected.contact));
  }
  if (collected.workAuthorization !== undefined) {
    markdown = replaceMarkdownSection(
      markdown,
      '## Work Authorization',
      workAuthorizationSectionLines(collected.workAuthorization),
    );
  }
  return markdown;
}

function buildNetworkingContactsJson(): string {
  return `${JSON.stringify({ contacts: [] }, null, 2)}\n`;
}

// Stored contact count for the replace-wipe confirmation: null when the
// existing file cannot be read as a contacts document (also confirmation-worthy).
function countStoredContacts(existingText: string): number | null {
  try {
    const parsed = JSON.parse(existingText) as { contacts?: unknown };
    return Array.isArray(parsed.contacts) ? parsed.contacts.length : 0;
  } catch {
    return null;
  }
}

// Placeholders this run would introduce into an update target, relative to
// the on-disk baseline. Update merges only fail on growth, so filling one
// section at a time keeps working while no new REPLACE_ME ships.
function introducedPlaceholderCount(content: string, baseline: string): number {
  const countPlaceholders = (text: string): number => text.split('REPLACE_ME').length - 1;
  return countPlaceholders(content) - countPlaceholders(baseline);
}

function validateJobPreferencesContent(content: string, path: string): void {
  try {
    parseJobPreferences(content);
  } catch (error) {
    throw new SetupValidationError(
      `Generated ${path} does not conform to the jobPreferences schema: ${(error as Error).message}`,
    );
  }
}

export interface ProfileGitStatus {
  path: string;
  inRepo: boolean;
  ignored: boolean;
  tracked: boolean;
}

function gitCommandSucceeded(args: readonly string[]): boolean {
  try {
    execFileSync('git', [...args], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

export function checkProfileGitStatus(
  repoRoot: string,
  paths: readonly string[],
): ProfileGitStatus[] {
  const root = resolve(repoRoot);
  const inRepo = gitCommandSucceeded(['-C', root, 'rev-parse', '--is-inside-work-tree']);
  return paths.map((path) => {
    if (!inRepo) {
      return { path, inRepo: false, ignored: false, tracked: false };
    }
    const absolute = resolve(root, path);
    // A path that resolves outside the git work tree (e.g. the canonical data
    // root under ~/Documents) can never be tracked or committed, so it is
    // inherently protected; skip git checks entirely.
    if (!isPathInside(root, absolute)) {
      return { path, inRepo: false, ignored: false, tracked: false };
    }
    const tracked = gitCommandSucceeded([
      '-C',
      root,
      'ls-files',
      '--error-unmatch',
      '--',
      absolute,
    ]);
    const ignored = gitCommandSucceeded(['-C', root, 'check-ignore', '-q', '--', absolute]);
    return { path, inRepo: true, ignored, tracked };
  });
}

export interface ProfileProtectionReport {
  blocked: boolean;
  reasons: string[];
  statuses: ProfileGitStatus[];
}

// Config-driven directories live outside the four profile files, so a custom
// dataRoot/outputRoot inside the git work tree would not be covered by the
// four-file check above. Parse prefs content (prepared or on-disk) and include
// every configured directories path in the same protection check; paths
// outside the repo are inherently protected and skipped by
// checkProfileGitStatus itself. Malformed YAML throws instead of silently
// skipping the check.
export function parseConfiguredDirectoryPaths(content: string | null): string[] {
  if (content === null) {
    return [];
  }
  const preferences = parseJobPreferences(content);
  const directories = preferences.directories;
  if (directories === undefined) {
    return [];
  }
  return [directories.dataRoot, directories.outputRoot, directories.resumeVariantsFile].filter(
    (value): value is string => value !== null && value.trim().length > 0,
  );
}

export function assessProfileProtections(
  statuses: readonly ProfileGitStatus[],
): ProfileProtectionReport {
  const reasons: string[] = [];
  for (const status of statuses) {
    if (!status.inRepo) {
      // Explicit outside-repo policy (A6): paths outside the git work tree —
      // including the default canonical data root — can never be committed,
      // so they are inherently protected and never block. Documented in the
      // init help text; pinned by test.
      continue;
    }
    if (status.tracked) {
      reasons.push(`${status.path} is tracked by git; remove it from the index before continuing.`);
    } else if (!status.ignored) {
      reasons.push(`${status.path} is not ignored by git; add it to .gitignore before continuing.`);
    }
  }
  return { blocked: reasons.length > 0, reasons, statuses: [...statuses] };
}

export async function runInitWizard(options: InitWizardOptions): Promise<InitWizardResult> {
  const ctx = options.prompt;
  const profileDirectory = options.profileDirectory ?? canonicalDataRoot();
  const repoRoot = options.repoRoot ?? repoRootFromModule();
  // Wizard prompt order (preferences first) is presentation only: membership
  // has one owner (realProfileFileNames in dataPortability.ts, whose order is
  // pinned by the import-blocker message test), so the wizard ranks a copy
  // instead of indexing positionally. Unknown future files sort last but are
  // still included, never silently dropped.
  const wizardPromptRank: Record<string, number> = {
    'jobPreferences.yaml': 0,
    'screeningAnswers.json': 1,
    'masterProfile.md': 2,
    'networkingContacts.json': 3,
  };
  const realPaths = [...realProfileFileNames]
    .sort((a, b) => (wizardPromptRank[a] ?? 99) - (wizardPromptRank[b] ?? 99))
    .map((fileName) => join(profileDirectory, fileName));

  ctx.print([
    'weJobSearch setup wizard (SDD Requirement 1b).',
    '',
    'The wizard writes the real profile files under the canonical data root',
    '(~/Documents/weJobSearch/<username>/), outside the git work tree. The .example',
    'templates are never touched; a fresh canonical-root setup also seeds the',
    'working resumeVariants.yaml from the committed structure template. Nothing',
    'runs automatically: search, evaluate, generate, draftCoverLetter,',
    'draftOutreach, report, and reviewQueue are separate explicit commands.',
    '',
  ]);

  const exists = new Map<string, boolean>();
  for (const path of realPaths) {
    exists.set(path, await pathExists(path));
  }

  const detected = realPaths.filter((path) => exists.get(path) === true);
  if (detected.length > 0) {
    ctx.print([
      'Existing profile files detected:',
      ...detected.map((path) => `  - ${path}`),
      '',
      'Existing files are never silently overwritten. For each file you choose:',
      'keep it, update a selected section, or replace it after explicit confirmation.',
      '',
    ]);
  } else {
    ctx.print(['No profile data exists yet; a fresh setup will create all four files.', '']);
  }

  const modes = new Map<string, ProfileFileMode>();
  const updateSections = new Map<string, ReadonlySet<string>>();
  for (const path of realPaths) {
    const fileName = path.split(/[\\/]/).pop() ?? '';
    if (exists.get(path) !== true) {
      modes.set(path, 'create');
      continue;
    }
    const decision = await askExistingFileMode(ctx, fileName);
    if (decision === 'keep') {
      modes.set(path, 'keep');
      continue;
    }
    if (decision === 'replace') {
      const confirmed = await confirmReplaceFile(ctx, fileName);
      modes.set(path, confirmed ? 'replace' : 'keep');
      continue;
    }
    const sections = await askSectionsToUpdate(ctx, fileName);
    modes.set(path, 'update');
    updateSections.set(path, sections);
  }

  const sectionsToCollect = (path: string, all: readonly string[]): Set<string> => {
    const mode = modes.get(path) ?? 'keep';
    if (mode === 'create' || mode === 'replace') {
      return new Set(all);
    }
    if (mode === 'update') {
      const chosen = updateSections.get(path) ?? new Set<string>();
      return new Set(all.filter((label) => chosen.has(label)));
    }
    return new Set();
  };

  // Name-keyed lookup, never positional: the shared realProfileFileNames
  // order is owned by dataPortability.ts and must not dictate which path is
  // which here (positional indexing silently mapped every section to the
  // wrong file when the orders differed).
  const realPathFor = (fileName: string): string => join(profileDirectory, fileName);
  const preferencePath = realPathFor('jobPreferences.yaml');
  const screeningPath = realPathFor('screeningAnswers.json');
  const profilePath = realPathFor('masterProfile.md');
  const contactsPath = realPathFor('networkingContacts.json');

  const collectedPreferences: CollectedJobPreferences = {};
  const preferenceSections = sectionsToCollect(preferencePath, jobPreferencesOptionLabels);
  if (preferenceSections.has('compensation')) {
    collectedPreferences.compensation = await collectCompensation(ctx);
  }
  if (preferenceSections.has('clearance')) {
    collectedPreferences.clearance = await collectClearance(ctx);
  }
  if (preferenceSections.has('nonNegotiables')) {
    collectedPreferences.nonNegotiables = await collectNonNegotiables(ctx);
  }
  if (preferenceSections.has('preferredLocations')) {
    collectedPreferences.preferredLocations = await collectStringList(
      ctx,
      'preferredLocations',
      'Enter a preferred location (e.g. Remote, "Hybrid East Coast US")',
      'Add another preferred location? [y/N]:',
    );
  }
  if (preferenceSections.has('targetRoles')) {
    collectedPreferences.targetRoles = await collectTargetRoles(ctx);
  }
  if (preferenceSections.has('directories')) {
    collectedPreferences.directories = await collectDirectories(ctx);
  }

  const screeningDefaults = await screeningDefaultsFromPreferences(
    collectedPreferences.compensation,
    preferencePath,
  );
  if (screeningDefaults.warning !== null) {
    ctx.print(['', `Warning: ${screeningDefaults.warning}`, '']);
  }
  const collectedScreening = await collectScreeningAnswers(
    ctx,
    sectionsToCollect(screeningPath, screeningOptionLabels),
    screeningDefaults.defaults,
  );
  const collectedMaster = await collectMasterProfile(
    ctx,
    sectionsToCollect(profilePath, masterProfileOptionLabels),
  );

   validateCollectedJobPreferences(collectedPreferences);

// H2: validate collected input for required-field completion.
    // Only on the fresh-setup path (files being created/replaced).
    // Keep and section-update paths collect nothing fresh (fields
    // fall back to REPLACE_ME/0), so full-completion validation
    // would incorrectly block them; section completeness is
    // enforced by updateUserProfile merge-time validation instead.
    const isFreshSetup = [...modes.values()].some(
      (mode) => mode === 'create' || mode === 'replace',
    );
    if (isFreshSetup) {
      const collectedInput: ProfileInitializationInput = {
        jobPreferences: {
          compensation: collectedPreferences.compensation ?? defaultCompensation,
          clearance: collectedPreferences.clearance ?? defaultClearance,
          nonNegotiables: collectedPreferences.nonNegotiables ?? [],
          preferredLocations: collectedPreferences.preferredLocations ?? [],
          targetRoles: collectedPreferences.targetRoles ?? [],
          // The init section no longer collects a data root (CLI-plus-env
          // only); the schema type still carries the key, always null here.
          directories: { dataRoot: null, ...(collectedPreferences.directories ?? nullDirectories) },
        },
        screeningAnswers: {
          workAuthorization: collectedScreening.workAuthorization ?? defaultScreeningWorkAuthorization,
          compensation: collectedScreening.compensation ?? defaultScreeningCompensation,
          standardQuestions: collectedScreening.standardQuestions ?? defaultStandardQuestions,
        },
        masterProfile: {
          contact: collectedMaster.contact ?? {
            name: 'REPLACE_ME', email: 'REPLACE_ME', phone: 'REPLACE_ME',
            cityState: 'REPLACE_ME', linkedIn: 'REPLACE_ME', portfolio: 'REPLACE_ME',
          },
          workAuthorization: collectedMaster.workAuthorization ?? {
            usCitizen: 'REPLACE_ME', requiresSponsorship: 'REPLACE_ME', clearance: 'REPLACE_ME',
          },
          summary: 'REPLACE_ME',
          skills: [],
          experience: [],
          education: [],
          certifications: [],
        },
      };
      const completionIssues = validateWizardCollectedInput(collectedInput);
      if (completionIssues.length > 0) {
        throw new SetupValidationError(
          `Profile completion blocked: ${completionIssues.join('; ')}`,
        );
      }
    }

   const writes: ProfileFileWrite[] = [];
  const created: string[] = [];
  const updated: string[] = [];
  const unchanged: string[] = [];

  async function preparePreferences(): Promise<void> {
    const mode = modes.get(preferencePath) ?? 'create';
    if (mode === 'keep') {
      unchanged.push(preferencePath);
      return;
    }
    let existingRecord: Record<string, unknown> | null = null;
    const existingText = await readTextOrNull(preferencePath);
    if (existingText !== null) {
      try {
        existingRecord = parseJobPreferences(existingText) as unknown as Record<string, unknown>;
      } catch (error) {
        if (mode === 'replace') {
          // B2: a confirmed replace discards the existing file, so an
          // unparsable one is treated as empty and replacement continues.
          // Update mode still throws (there is nothing sane to merge into).
          existingRecord = null;
        } else {
          throw new SetupValidationError(
            `Cannot update ${preferencePath}: the existing file does not conform to the jobPreferences schema (${(error as Error).message}). No file was changed.`,
          );
        }
      }
    }
    const content = buildJobPreferencesYaml(collectedPreferences, existingRecord);
    validateJobPreferencesContent(content, preferencePath);
    writes.push({ targetPath: preferencePath, content });
    (mode === 'create' ? created : updated).push(preferencePath);
  }

  async function prepareScreening(): Promise<void> {
    const mode = modes.get(screeningPath) ?? 'create';
    if (mode === 'keep') {
      unchanged.push(screeningPath);
      return;
    }
    let existingRecord: Record<string, unknown> | null = null;
    const existingText = await readTextOrNull(screeningPath);
    if (existingText !== null) {
      try {
        const parsed = JSON.parse(existingText);
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
          existingRecord = parsed as Record<string, unknown>;
        }
      } catch (error) {
        if (mode === 'replace') {
          // B2: same recovery as preferences above — a confirmed replace
          // treats invalid JSON as empty. Update mode still throws.
          existingRecord = null;
        } else {
          throw new SetupValidationError(
            `Cannot update ${screeningPath}: the existing file is not valid JSON (${(error as Error).message}). No file was changed.`,
          );
        }
      }
    }
    const content = buildScreeningAnswersJson(collectedScreening, existingRecord);
    validateScreeningJson(content, screeningPath);
    writes.push({ targetPath: screeningPath, content });
    (mode === 'create' ? created : updated).push(screeningPath);
  }

  async function prepareMasterProfile(): Promise<void> {
    const mode = modes.get(profilePath) ?? 'create';
    if (mode === 'keep') {
      unchanged.push(profilePath);
      return;
    }
    // B3: replace is a true full replace. The confirmed overwrite discards
    // the existing file, so the fresh template is built from collected input
    // only — no Experience, Skills, or Summary section is preserved. Update
    // mode still merges the collected sections into the existing file.
    const existingText = mode === 'replace' ? null : await readTextOrNull(profilePath);
    const content = buildMasterProfileMarkdown(collectedMaster, existingText);
    assertMasterProfileSections(content, profilePath);
    writes.push({ targetPath: profilePath, content });
    (mode === 'create' ? created : updated).push(profilePath);
  }

  async function prepareContacts(): Promise<void> {
    const mode = modes.get(contactsPath) ?? 'create';
    if (mode === 'keep') {
      unchanged.push(contactsPath);
      return;
    }
    // Replace must never silently wipe a populated tracker: an explicit
    // wipe confirmation is required whenever the existing file holds
    // contacts (or cannot be read). Declining keeps the file untouched.
    if (mode === 'replace') {
      const existingText = await readTextOrNull(contactsPath);
      if (existingText !== null) {
        const existingCount = countStoredContacts(existingText);
        if (existingCount !== 0) {
          const scope = existingCount === null ? 'could not be read' : `holds ${existingCount} contact(s)`;
          const answer = (
            await ctx.ask(
              `${contactsPath} ${scope}. Replace will discard it. Type 'wipe' to confirm the replacement, or anything else to keep the file unchanged: `,
            )
          ).trim().toLowerCase();
          if (answer !== 'wipe') {
            unchanged.push(contactsPath);
            return;
          }
        }
      }
    }
    const content = buildNetworkingContactsJson();
    validateNetworkingJson(content, contactsPath);
    writes.push({ targetPath: contactsPath, content });
    // B3: a contacts replace overwrites an existing tracker, so it is an
    // update, never a creation. Only a brand-new file counts as created.
    (mode === 'create' ? created : updated).push(contactsPath);
  }

  await preparePreferences();
  await prepareScreening();
  await prepareMasterProfile();
  await prepareContacts();

  // Placeholder boundary (B10): an update merge must not introduce a new
  // REPLACE_ME. Fresh create/replace collection is already completion-checked
  // up front (validateWizardCollectedInput), and uncollected master sections
  // ship structural REPLACE_ME defaults by design for the user to fill later;
  // but update collection runs with that validator skipped, so blank answers
  // on an updated section would silently ship placeholders. Compare each
  // updated write against its on-disk baseline and fail on growth. Runs
  // before any write with the protection gate. Scoped to update mode only:
  // replace writes a full fresh file by design (see B3), so a baseline
  // comparison would misread its structural defaults as introduced
  // placeholders.
  const placeholderOffenders: string[] = [];
  for (const write of writes) {
    if (modes.get(write.targetPath) !== 'update') {
      continue;
    }
    const baseline = await readTextOrNull(write.targetPath);
    if (introducedPlaceholderCount(write.content, baseline ?? '') > 0) {
      placeholderOffenders.push(write.targetPath);
    }
  }
  if (placeholderOffenders.length > 0) {
    throw new SetupValidationError(
      `Cannot write ${placeholderOffenders.join(', ')}: the update would introduce new REPLACE_ME placeholders. Fill the prompted fields instead of leaving them blank. No file was changed.`,
    );
  }

  // Pre-write protection gate (A6): a blocked run writes nothing and exits 1.
  // The git check needs only paths (tracked/ignored resolve without file
  // content), so it runs before any write. The naming linter still scans
  // repoRoot and reports here, but a pre-existing repo violation never blocks
  // onboarding (B4): profile creation depends only on profile validity plus
  // gitignore protection. Directory paths come from the prepared prefs
  // content when this run rewrites it, else from the on-disk file.
  const preparedPreferences = writes.find((write) => write.targetPath === preferencePath)?.content
    ?? await readTextOrNull(preferencePath);
  let configuredPaths: string[];
  try {
    configuredPaths = parseConfiguredDirectoryPaths(preparedPreferences);
  } catch (error) {
    throw new SetupValidationError(
      `Cannot start init: ${preferencePath} does not conform to the jobPreferences schema (${(error as Error).message}). No file was changed.`,
    );
  }
  const protection = assessProfileProtections(
    checkProfileGitStatus(repoRoot, [...realPaths, ...configuredPaths]),
  );
  const linter = await runNamingLinter({ repoRoot });
  const blocked = protection.blocked;

  if (!blocked) {
    await writeProfileFilesAtomically(writes);
  }

  // Variant seeding targets data roots: the canonical default and any
  // relocated root requested via --dataRoot (the init command always sets
  // seedVariants). Direct profileDirectory overrides without the flag
  // (tests, alternate locations) keep full control and are never mutated
  // with extra files. Seeding runs only on unblocked runs, after the profile
  // files are written.
  const shouldSeedVariants = options.seedVariants ?? options.profileDirectory === undefined;
  const variantsSeeded: string[] = [];
  if (!blocked && shouldSeedVariants) {
    await ensureCanonicalDataDirectories(profileDirectory);
    const rootVariantsPath = join(profileDirectory, resumeVariantsFileName);
    if (!(await pathExists(rootVariantsPath))) {
      const committedSeeds = join(repoRoot, 'profile', resumeVariantsFileName);
      const seedContent = await readTextOrNull(committedSeeds);
      if (seedContent !== null) {
        await writeProfileFilesAtomically([{ targetPath: rootVariantsPath, content: seedContent }]);
        created.push(rootVariantsPath);
        variantsSeeded.push(rootVariantsPath);
      }
    }
  }

  const completion: string[] = blocked ? [''] : ['', 'Setup complete.'];
  for (const path of realPaths) {
    // B3: a confirmed overwrite is reported as replaced, never as written
    // (written means a brand-new file). A declined wipe stays unchanged.
    const replaced = modes.get(path) === 'replace' && updated.includes(path);
    const state = replaced
      ? 'replaced'
      : created.includes(path)
        ? 'written'
        : updated.includes(path)
          ? 'updated'
          : 'unchanged';
    completion.push(`  ${path}  ${state}`);
  }
  completion.push('');
  completion.push(`Naming linter: ${linter.violations.length} violation(s) found.`);
  if (linter.violations.length > 0) {
    completion.push(formatNamingViolations(linter.violations));
  }
  const isRepo = protection.statuses.some((status) => status.inRepo);
  if (!isRepo) {
    completion.push('Not inside a git repository; git profile-protection checks were skipped.');
  } else {
    completion.push('Git profile enforcement:');
    for (const status of protection.statuses) {
      completion.push(
        `  ${status.path}  ignored=${status.ignored ? 'yes' : 'no'} tracked=${status.tracked ? 'yes' : 'no'}`,
      );
    }
    if (protection.blocked) {
      completion.push('');
      completion.push('FATAL: real profile data is not protected from version control:');
      for (const reason of protection.reasons) {
        completion.push(`  ${reason}`);
      }
      completion.push('');
      completion.push('Resolve the reasons above, then re-run init. No further commands ran.');
      completion.push('No files were written.');
    }
  }
  completion.push('');
  if (variantsSeeded.length > 0) {
    completion.push(`Seeded the working resumeVariants.yaml at: ${variantsSeeded[0]}`);
  }
  completion.push('Remaining manual steps (never run automatically):');
  completion.push(`  - Fill in ${join(profileDirectory, 'masterProfile.md')} (Summary, Skills, Experience, Education, Certifications).`);
  completion.push('  - Track networking: node dist/cli/jobSearchCore.js addContact --name X --company Y');
  completion.push('  - Re-run init at any time to update a section without overwriting the rest.');
  ctx.print(completion);

  // A blocked run reached no write: report empty created/updated/unchanged so
  // callers never mistake prepared-but-unwritten entries for files on disk.
  return {
    exitCode: blocked ? 1 : 0,
    printedLines: completion,
    created: blocked ? [] : created,
    updated: blocked ? [] : updated,
    unchanged: blocked ? [] : unchanged,
  };
}