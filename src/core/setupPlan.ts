import { z } from 'zod';
import {
  masterProfileEducationEntrySchema,
  masterProfileExperienceEntrySchema,
  masterProfileSkillGroupSchema,
  type ProfileInitializationInput,
} from '../utils/profileService';

// Server-side ordered question plan for first-run profile setup
// (privateDocs/specs/setupQuestionCursor). One typed question per field, one
// field path per entry, predicates evaluated here so inapplicable questions
// never reach the model. Destinations are the profile fields an answer writes;
// the set is disjoint across entries, which is what makes "never ask twice" a
// data property rather than a prompt instruction. Non-negotiable answers have
// no single destination because commitSetup assembles the rules array.

export const currentPlanVersion = 1;

export type SetupSection =
  | 'contact'
  | 'resume'
  | 'workAuthorization'
  | 'clearance'
  | 'targetRoles'
  | 'locations'
  | 'compensation'
  | 'nonNegotiables'
  | 'noticePeriod';

export type SetupAnswers = Record<string, unknown>;
export type SetupPredicate = (answers: SetupAnswers) => boolean;
export type SetupValidator = (answer: unknown) => string | null;

export interface SetupQuestion {
  readonly id: string;
  readonly field: string;
  readonly section: SetupSection;
  readonly prompt: string;
  readonly why: string;
  readonly recommended: string;
  readonly options?: readonly string[];
  readonly appliesWhen?: SetupPredicate;
  readonly required: boolean;
  readonly destinations: readonly string[];
  readonly validate?: SetupValidator;
  readonly planVersion: number;
}

function nonEmptyText(label: string): SetupValidator {
  return (answer) =>
    typeof answer === 'string' && answer.trim().length > 0
      ? null
      : `${label} must be a non-empty string.`;
}

function textAnswer(answer: unknown): string | null {
  return typeof answer === 'string' ? null : 'Expected a string; use null to skip.';
}

function booleanAnswer(answer: unknown): string | null {
  return typeof answer === 'boolean' ? null : 'Expected true or false.';
}

function positiveNumber(label: string, integer = false): SetupValidator {
  return (answer) =>
    typeof answer === 'number' &&
    Number.isFinite(answer) &&
    answer > 0 &&
    (!integer || Number.isInteger(answer))
      ? null
      : `${label} must be a positive${integer ? ' whole' : ''} number.`;
}

function oneOf(options: readonly string[]): SetupValidator {
  return (answer) =>
    typeof answer === 'string' && options.includes(answer)
      ? null
      : `Expected one of: ${options.join(', ')}.`;
}

function arrayAnswer(schema: z.ZodTypeAny, label: string, atLeastOne = false): SetupValidator {
  return (answer) => {
    const result = z.array(schema).safeParse(answer);
    if (!result.success) {
      const problem = result.error.issues
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('; ');
      return `${label}: ${problem}`;
    }
    if (atLeastOne && result.data.length === 0) {
      return `${label} needs at least one entry.`;
    }
    return null;
  };
}

const sponsorshipRequired: SetupPredicate = (answers) => answers.requiresSponsorship === true;
const clearanceNeedsLevel: SetupPredicate = (answers) =>
  answers.clearanceStatus === 'interim' || answers.clearanceStatus === 'active';
const noRelocationDeclined: SetupPredicate = (answers) => answers.noRelocation !== true;
const hasLocations: SetupPredicate = (answers) =>
  Array.isArray(answers.preferredLocations) && answers.preferredLocations.length > 0;

const yes = (value: unknown): boolean => value === true;

export const setupPlan: readonly SetupQuestion[] = [
  {
    id: 'contactName',
    field: 'contact.name',
    section: 'contact',
    prompt: 'What name should appear on your resume?',
    why: 'The name line is required by every generated resume.',
    recommended: 'Use the name exactly as it appears on your resume.',
    required: true,
    destinations: ['masterProfile.contact.name'],
    validate: nonEmptyText('Name'),
    planVersion: currentPlanVersion,
  },
  {
    id: 'contactEmail',
    field: 'contact.email',
    section: 'contact',
    prompt: 'What email address should appear on your resume?',
    why: 'Employers reply to this address.',
    recommended: 'Use a personal address you check often.',
    required: true,
    destinations: ['masterProfile.contact.email'],
    validate: nonEmptyText('Email'),
    planVersion: currentPlanVersion,
  },
  {
    id: 'contactPhone',
    field: 'contact.phone',
    section: 'contact',
    prompt: 'What phone number should appear on your resume?',
    why: 'Recruiters use the phone number for scheduling.',
    recommended: 'Use a number that accepts calls during business hours.',
    required: true,
    destinations: ['masterProfile.contact.phone'],
    validate: nonEmptyText('Phone'),
    planVersion: currentPlanVersion,
  },
  {
    id: 'contactCityState',
    field: 'contact.cityState',
    section: 'contact',
    prompt: 'What city and state should appear on your resume?',
    why: 'The location line is required and is shown as its own resume row.',
    recommended: 'City, State - for example Austin, TX.',
    required: true,
    destinations: ['masterProfile.contact.cityState'],
    validate: nonEmptyText('City / State'),
    planVersion: currentPlanVersion,
  },
  {
    id: 'contactLinkedIn',
    field: 'contact.linkedIn',
    section: 'contact',
    prompt: 'What is your LinkedIn URL?',
    why: 'Optional contact link; empty answers print as not provided.',
    recommended: 'Skip if you do not want it on the resume.',
    required: false,
    destinations: ['masterProfile.contact.linkedIn'],
    validate: textAnswer,
    planVersion: currentPlanVersion,
  },
  {
    id: 'contactPortfolio',
    field: 'contact.portfolio',
    section: 'contact',
    prompt: 'What is your portfolio or website URL?',
    why: 'Optional contact link; empty answers print as not provided.',
    recommended: 'Skip if you do not want it on the resume.',
    required: false,
    destinations: ['masterProfile.contact.portfolio'],
    validate: textAnswer,
    planVersion: currentPlanVersion,
  },
  {
    id: 'summary',
    field: 'resume.summary',
    section: 'resume',
    prompt: 'What summary should open your resume?',
    why: 'The summary is required and drives the top of every generated resume.',
    recommended: 'Two sentences taken from your resume, with no new claims.',
    required: true,
    destinations: ['masterProfile.summary'],
    validate: nonEmptyText('Summary'),
    planVersion: currentPlanVersion,
  },
  {
    id: 'skills',
    field: 'resume.skills',
    section: 'resume',
    prompt: 'Which skill groups should the resume list?',
    why: 'Skills are copied verbatim; this step never invents one.',
    recommended: 'Group the skills from your resume, for example Languages then Platforms.',
    required: false,
    destinations: ['masterProfile.skills'],
    validate: arrayAnswer(masterProfileSkillGroupSchema, 'Skills'),
    planVersion: currentPlanVersion,
  },
  {
    id: 'experience',
    field: 'resume.experience',
    section: 'resume',
    prompt: 'Which roles should the experience section contain?',
    why: 'At least one experience entry is required to write masterProfile.md.',
    recommended: 'Copy the roles from your resume, most recent first.',
    required: true,
    destinations: ['masterProfile.experience'],
    validate: arrayAnswer(masterProfileExperienceEntrySchema, 'Experience', true),
    planVersion: currentPlanVersion,
  },
  {
    id: 'education',
    field: 'resume.education',
    section: 'resume',
    prompt: 'Which education entries should the resume list?',
    why: 'Optional section; an empty list is valid.',
    recommended: 'One line per degree, or skip if not relevant.',
    required: false,
    destinations: ['masterProfile.education'],
    validate: arrayAnswer(masterProfileEducationEntrySchema, 'Education'),
    planVersion: currentPlanVersion,
  },
  {
    id: 'certifications',
    field: 'resume.certifications',
    section: 'resume',
    prompt: 'Which certifications should the resume list?',
    why: 'Optional section; an empty list is valid.',
    recommended: 'Names only, or skip if none apply.',
    required: false,
    destinations: ['masterProfile.certifications'],
    validate: arrayAnswer(z.string(), 'Certifications'),
    planVersion: currentPlanVersion,
  },
  {
    id: 'usCitizen',
    field: 'workAuthorization.usCitizen',
    section: 'workAuthorization',
    prompt: 'Are you a US citizen?',
    why: 'Work authorization is required by the profile and by portal screening.',
    recommended: 'Answer from your own documents; this tool does not infer it.',
    required: true,
    destinations: [
      'masterProfile.workAuthorization.usCitizen',
      'screeningAnswers.workAuthorization.usCitizen',
    ],
    validate: booleanAnswer,
    planVersion: currentPlanVersion,
  },
  {
    id: 'requiresSponsorship',
    field: 'workAuthorization.requiresSponsorship',
    section: 'workAuthorization',
    prompt: 'Do you require visa sponsorship?',
    why: 'Drives both the profile and the clearance preferences block.',
    recommended: 'Answer from your own documents; this tool does not infer it.',
    required: true,
    destinations: [
      'masterProfile.workAuthorization.requiresSponsorship',
      'screeningAnswers.workAuthorization.requiresSponsorship',
      'jobPreferences.clearance.requiresSponsorshipForVisa',
    ],
    validate: booleanAnswer,
    planVersion: currentPlanVersion,
  },
  {
    id: 'sponsorshipType',
    field: 'workAuthorization.sponsorshipType',
    section: 'workAuthorization',
    prompt: 'Which sponsorship type do you need?',
    why: 'Only asked because sponsorship is required.',
    recommended: 'For example H-1B; use null to skip.',
    appliesWhen: sponsorshipRequired,
    required: false,
    destinations: ['screeningAnswers.workAuthorization.sponsorshipType'],
    validate: textAnswer,
    planVersion: currentPlanVersion,
  },
  {
    id: 'clearanceStatus',
    field: 'clearance.currentStatus',
    section: 'clearance',
    prompt: 'What is your current clearance status?',
    why: 'Clearance gates the hard-rejection rules and drives masterProfile.md.',
    recommended: 'Answer from your own documents; this tool does not infer it.',
    options: ['none', 'interim', 'active', 'expired'],
    required: true,
    destinations: [
      'jobPreferences.clearance.currentStatus',
      'masterProfile.workAuthorization.clearance',
    ],
    validate: oneOf(['none', 'interim', 'active', 'expired']),
    planVersion: currentPlanVersion,
  },
  {
    id: 'clearanceLevel',
    field: 'clearance.level',
    section: 'clearance',
    prompt: 'Which clearance level do you hold?',
    why: 'Only asked when the status is interim or active.',
    recommended: 'Choose the level on your own records, or skip.',
    options: ['publicTrust', 'secret', 'topSecret', 'tsSci'],
    appliesWhen: clearanceNeedsLevel,
    required: false,
    destinations: ['jobPreferences.clearance.currentLevel'],
    validate: oneOf(['publicTrust', 'secret', 'topSecret', 'tsSci']),
    planVersion: currentPlanVersion,
  },
  {
    id: 'clearanceEligible',
    field: 'clearance.eligibleToObtain',
    section: 'clearance',
    prompt: 'Are you eligible to obtain a clearance?',
    why: 'Separates clearance-eligible candidates from cleared ones.',
    recommended: 'Yes unless a documented restriction applies.',
    required: false,
    destinations: ['jobPreferences.clearance.eligibleToObtain'],
    validate: booleanAnswer,
    planVersion: currentPlanVersion,
  },
  {
    id: 'targetRoles',
    field: 'targetRoles',
    section: 'targetRoles',
    prompt: 'Which role titles should the search target?',
    why: 'Target roles drive profile-based search and role suggestions.',
    recommended: 'Two to five titles from your resume, or skip to use keywords.',
    required: false,
    destinations: ['jobPreferences.targetRoles'],
    validate: arrayAnswer(z.string(), 'Target roles'),
    planVersion: currentPlanVersion,
  },
  {
    id: 'preferredLocations',
    field: 'preferredLocations',
    section: 'locations',
    prompt: 'Which locations should the search prefer?',
    why: 'Preferred locations are used by search and by relocation rules.',
    recommended: 'For example Remote, or Hybrid East Coast US.',
    required: false,
    destinations: [
      'jobPreferences.preferredLocations',
      'screeningAnswers.standardQuestions.preferredWorkLocation',
    ],
    validate: arrayAnswer(z.string(), 'Preferred locations'),
    planVersion: currentPlanVersion,
  },
  {
    id: 'searchRadiusMiles',
    field: 'locations.searchRadiusMiles',
    section: 'locations',
    prompt: 'Which search radius should be used, in miles?',
    why: 'Only asked when a location was named; only LinkedIn honors it.',
    recommended: 'Skip unless you named a metro and want a distance filter.',
    appliesWhen: hasLocations,
    required: false,
    destinations: ['jobPreferences.searchRadiusMiles'],
    validate: positiveNumber('Search radius', true),
    planVersion: currentPlanVersion,
  },
  {
    id: 'minAcceptableBase',
    field: 'compensation.minAcceptableBase',
    section: 'compensation',
    prompt: 'What is your minimum acceptable base salary?',
    why: 'Zero is treated as a placeholder and blocks commitSetup.',
    recommended: 'A number you would genuinely accept, in your currency.',
    required: true,
    destinations: [
      'jobPreferences.compensation.minAcceptableBase',
      'screeningAnswers.compensation.minBaseSalary',
    ],
    validate: positiveNumber('Minimum acceptable base'),
    planVersion: currentPlanVersion,
  },
  {
    id: 'targetBase',
    field: 'compensation.targetBase',
    section: 'compensation',
    prompt: 'What is your target base salary?',
    why: 'Zero is treated as a placeholder and blocks commitSetup.',
    recommended: 'A number at or above the minimum you would accept.',
    required: true,
    destinations: [
      'jobPreferences.compensation.targetBase',
      'screeningAnswers.compensation.targetBaseSalary',
    ],
    validate: positiveNumber('Target base'),
    planVersion: currentPlanVersion,
  },
  {
    id: 'currency',
    field: 'compensation.currency',
    section: 'compensation',
    prompt: 'Which currency should compensation use?',
    why: 'Keeps stated amounts unambiguous.',
    recommended: 'USD',
    required: false,
    destinations: [
      'jobPreferences.compensation.currency',
      'screeningAnswers.compensation.currency',
    ],
    validate: nonEmptyText('Currency'),
    planVersion: currentPlanVersion,
  },
  {
    id: 'countsBonusTowardMin',
    field: 'compensation.countsBonusTowardMin',
    section: 'compensation',
    prompt: 'Does bonus count toward your minimum?',
    why: 'Controls how a posting bonus is compared with the floor.',
    recommended: 'No',
    required: false,
    destinations: ['jobPreferences.compensation.countsBonusTowardMin'],
    validate: booleanAnswer,
    planVersion: currentPlanVersion,
  },
  {
    id: 'countsEquityTowardMin',
    field: 'compensation.countsEquityTowardMin',
    section: 'compensation',
    prompt: 'Does equity count toward your minimum?',
    why: 'Controls how posting equity is compared with the floor.',
    recommended: 'No',
    required: false,
    destinations: ['jobPreferences.compensation.countsEquityTowardMin'],
    validate: booleanAnswer,
    planVersion: currentPlanVersion,
  },
  {
    id: 'noRelocation',
    field: 'nonNegotiables.noRelocation',
    section: 'nonNegotiables',
    prompt: 'Should postings that require relocation be rejected?',
    why: 'One non-negotiable per question; an empty rule list is valid.',
    recommended: 'No (leave off)',
    required: false,
    destinations: [],
    validate: booleanAnswer,
    planVersion: currentPlanVersion,
  },
  {
    id: 'remoteOnly',
    field: 'nonNegotiables.remoteOnly',
    section: 'nonNegotiables',
    prompt: 'Should fully onsite postings be flagged for manual review?',
    why: 'Only offered when relocation rejection is declined; never both.',
    recommended: 'No (leave off)',
    appliesWhen: noRelocationDeclined,
    required: false,
    destinations: [],
    validate: booleanAnswer,
    planVersion: currentPlanVersion,
  },
  {
    id: 'noStaffingAgencies',
    field: 'nonNegotiables.noStaffingAgencies',
    section: 'nonNegotiables',
    prompt: 'Should staffing agencies be rejected?',
    why: 'One non-negotiable per question; an empty rule list is valid.',
    recommended: 'No (leave off)',
    required: false,
    destinations: [],
    validate: booleanAnswer,
    planVersion: currentPlanVersion,
  },
  {
    id: 'clearanceMismatch',
    field: 'nonNegotiables.clearanceMismatch',
    section: 'nonNegotiables',
    prompt: 'Should postings above your clearance level be rejected?',
    why: 'One non-negotiable per question; an empty rule list is valid.',
    recommended: 'No (leave off)',
    required: false,
    destinations: [],
    validate: booleanAnswer,
    planVersion: currentPlanVersion,
  },
  {
    id: 'belowMinSalary',
    field: 'nonNegotiables.belowMinSalary',
    section: 'nonNegotiables',
    prompt: 'Should postings below your minimum base be rejected?',
    why: 'One non-negotiable per question; an empty rule list is valid.',
    recommended: 'No (leave off)',
    required: false,
    destinations: [],
    validate: booleanAnswer,
    planVersion: currentPlanVersion,
  },
  {
    id: 'noticePeriod',
    field: 'noticePeriod',
    section: 'noticePeriod',
    prompt: 'What notice period should screening answers state?',
    why: 'Fills the standard notice-period screening answer.',
    recommended: 'Two weeks',
    required: false,
    destinations: ['screeningAnswers.standardQuestions.noticePeriod'],
    validate: textAnswer,
    planVersion: currentPlanVersion,
  },
];

export function questionById(id: string): SetupQuestion | undefined {
  return setupPlan.find((question) => question.id === id);
}

export function applicableQuestions(answers: SetupAnswers): SetupQuestion[] {
  return setupPlan.filter((question) => question.appliesWhen === undefined || question.appliesWhen(answers));
}

// Drops answers keyed to question ids the current plan no longer has (T09).
// Callers report the dropped ids so a user who resumed after a plan change is
// told which questions changed instead of losing answers silently.
export function reconcileAnswers(answers: SetupAnswers): {
  answers: SetupAnswers;
  droppedIds: string[];
} {
  const known = new Set(setupPlan.map((question) => question.id));
  const kept: SetupAnswers = {};
  const droppedIds: string[] = [];
  for (const [id, value] of Object.entries(answers)) {
    if (known.has(id)) {
      kept[id] = value;
    } else {
      droppedIds.push(id);
    }
  }
  return { answers: kept, droppedIds };
}

function textOf(answers: SetupAnswers, id: string, fallback = ''): string {
  return typeof answers[id] === 'string' ? (answers[id] as string) : fallback;
}

function numberOf(answers: SetupAnswers, id: string): number {
  return typeof answers[id] === 'number' ? (answers[id] as number) : 0;
}

function listOf<T>(answers: SetupAnswers, id: string): T[] {
  return Array.isArray(answers[id]) ? (answers[id] as T[]) : [];
}

function yesNo(answers: SetupAnswers, id: string): string {
  if (answers[id] === true) {
    return 'Yes';
  }
  if (answers[id] === false) {
    return 'No';
  }
  return '';
}

const clearanceLevelLabels: Record<string, string> = {
  publicTrust: 'Public Trust',
  secret: 'Secret',
  topSecret: 'Top Secret',
  tsSci: 'TS/SCI',
};

function clearanceLabel(answers: SetupAnswers): string {
  const status = textOf(answers, 'clearanceStatus');
  if (status.length === 0) {
    return '';
  }
  const level = textOf(answers, 'clearanceLevel');
  const levelLabel = clearanceLevelLabels[level];
  return levelLabel === undefined ? status : `${status} (${levelLabel})`;
}

function nonNegotiables(answers: SetupAnswers): ProfileInitializationInput['jobPreferences']['nonNegotiables'] {
  const rules: ProfileInitializationInput['jobPreferences']['nonNegotiables'] = [];
  if (yes(answers.noRelocation)) {
    rules.push({
      id: 'noRelocation',
      category: 'location',
      rule: 'reject if posting requires relocation outside preferredLocations',
    });
  }
  if (yes(answers.remoteOnly)) {
    rules.push({
      id: 'remoteOnly',
      category: 'location',
      rule: 'flag for manualReview if posting is fully onsite',
    });
  }
  if (yes(answers.noStaffingAgencies)) {
    rules.push({
      id: 'noStaffingAgencies',
      category: 'employerType',
      rule: 'reject if company is tagged staffingAgency',
    });
  }
  if (yes(answers.clearanceMismatch)) {
    rules.push({
      id: 'clearanceMismatch',
      category: 'clearance',
      rule: 'reject if posting requires a clearance level above currentLevel and eligibleToObtain is false',
    });
  }
  if (yes(answers.belowMinSalary)) {
    rules.push({
      id: 'belowMinSalary',
      category: 'compensation',
      rule: 'reject if posted base salary is below minAcceptableBase',
    });
  }
  return rules;
}

// The only place answers become a profile payload. commitSetup owns the write;
// this builder is pure and never touches the filesystem.
export function buildProfileInput(answers: SetupAnswers): ProfileInitializationInput {
  const locations = listOf<string>(answers, 'preferredLocations');
  const radius = numberOf(answers, 'searchRadiusMiles');
  const sponsorshipType = textOf(answers, 'sponsorshipType');
  return {
    masterProfile: {
      contact: {
        name: textOf(answers, 'contactName'),
        email: textOf(answers, 'contactEmail'),
        phone: textOf(answers, 'contactPhone'),
        cityState: textOf(answers, 'contactCityState'),
        linkedIn: textOf(answers, 'contactLinkedIn'),
        portfolio: textOf(answers, 'contactPortfolio'),
      },
      workAuthorization: {
        usCitizen: yesNo(answers, 'usCitizen'),
        requiresSponsorship: yesNo(answers, 'requiresSponsorship'),
        clearance: clearanceLabel(answers),
      },
      summary: textOf(answers, 'summary'),
      skills: listOf(answers, 'skills'),
      experience: listOf(answers, 'experience'),
      education: listOf(answers, 'education'),
      certifications: listOf(answers, 'certifications'),
    },
    jobPreferences: {
      compensation: {
        currency: textOf(answers, 'currency', 'USD'),
        minAcceptableBase: numberOf(answers, 'minAcceptableBase'),
        targetBase: numberOf(answers, 'targetBase'),
        countsBonusTowardMin: yes(answers.countsBonusTowardMin),
        countsEquityTowardMin: yes(answers.countsEquityTowardMin),
      },
      clearance: {
        currentStatus: textOf(answers, 'clearanceStatus', 'none'),
        currentLevel: textOf(answers, 'clearanceLevel').length > 0 ? textOf(answers, 'clearanceLevel') : null,
        eligibleToObtain: answers.clearanceEligible !== false,
        requiresSponsorshipForVisa: yes(answers.requiresSponsorship),
      },
      nonNegotiables: nonNegotiables(answers),
      preferredLocations: locations,
      targetRoles: listOf<string>(answers, 'targetRoles'),
      ...(radius > 0 ? { searchRadiusMiles: radius } : {}),
      directories: { dataRoot: null, outputRoot: null, resumeVariantsFile: null },
    },
    screeningAnswers: {
      workAuthorization: {
        usCitizen: yes(answers.usCitizen),
        requiresSponsorship: yes(answers.requiresSponsorship),
        sponsorshipType:
          yes(answers.requiresSponsorship) && sponsorshipType.length > 0 ? sponsorshipType : null,
      },
      compensation: {
        minBaseSalary: numberOf(answers, 'minAcceptableBase'),
        targetBaseSalary: numberOf(answers, 'targetBase'),
        currency: textOf(answers, 'currency', 'USD'),
      },
      standardQuestions: {
        yearsOfExperience: {},
        preferredWorkLocation: locations.join(', '),
        noticePeriod: textOf(answers, 'noticePeriod'),
      },
    },
  };
}
