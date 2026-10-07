import type { ApplicationHistory, ApplicationRecord } from '../utils/jobFunnelTracker';

// Application pattern analysis (EUO-07, goal G9): reads applicationHistory
// records back and turns them into actionable, non-mutating suggestions so the
// tracker becomes a feedback loop (SDD Req 4/9). Deterministic engine (N7):
// pure function, no I/O, no network, no LLM. Suggestions only (N2, N9): this
// module never writes the profile, preferences, or history - the MCP tool and
// any future report section render what this returns and stop.
//
// The history record does not store skills/domains, so signals are derived
// deterministically from roleTitle keywords and postingDescription text via a
// plain keyword table (N4-style: mapping, not scoring). Location signals come
// from postingFacts.locationType (the only location-shaped data persisted).
// Variant signals come from the optional resumeVariant field recorded at
// generation time (EUO-16); when no record carries one, no variant suggestion
// is emitted.
//
// Ownership (Phase 5c): consumed by the analyzeApplicationPatterns MCP tool
// path in src/mcp/jobSearchServer.ts. Single consumer by design, not dead code.

export type PatternSuggestionKind =
  | 'skillDomain'
  | 'location'
  | 'roleTitle'
  | 'variant'
  | 'roleTitleDrift'
  | 'locationDrift';

export interface PatternSuggestion {
  kind: PatternSuggestionKind;
  message: string;
  /** Sorted evidence strings (role titles, work modes) backing the suggestion. */
  evidence: string[];
}

// Preference subset the drift pass compares against (EUO-17, G9): the roles and
// locations the user says they are targeting. Passed in by the caller (the MCP
// handler loads jobPreferences.yaml); the analyzer itself never reads files.
export interface DriftPreferences {
  targetRoles: string[];
  preferredLocations: string[];
}

// Skill/domain keyword table: a label fires for a record when any keyword
// appears as a whole word in the record's roleTitle or postingDescription.
const skillDomainTable: readonly { label: string; keywords: readonly string[] }[] = [
  { label: 'frontend', keywords: ['typescript', 'javascript', 'react', 'angular', 'vue', 'frontend', 'html', 'css'] },
  { label: 'backend', keywords: ['node', 'express', 'backend', 'graphql', 'rest', 'microservices'] },
  { label: 'python', keywords: ['python', 'django', 'flask', 'fastapi'] },
  { label: 'java', keywords: ['java', 'spring', 'kotlin'] },
  { label: 'go', keywords: ['golang'] },
  { label: 'rust', keywords: ['rust'] },
  { label: 'cloud', keywords: ['aws', 'kubernetes', 'docker', 'terraform', 'gcp', 'azure', 'devops', 'helm'] },
  { label: 'data', keywords: ['kafka', 'spark', 'hadoop', 'snowflake', 'airflow', 'databricks', 'pipeline'] },
  { label: 'machine learning', keywords: ['tensorflow', 'pytorch', 'llm', 'nlp', 'machine', 'learning'] },
  { label: 'security', keywords: ['security', 'penetration', 'owasp', 'soc'] },
  { label: 'database', keywords: ['sql', 'postgres', 'mysql', 'mongodb', 'redis', 'database'] },
  { label: 'mobile', keywords: ['mobile', 'ios', 'android', 'swift', 'reactnative'] },
  { label: 'testing', keywords: ['testing', 'qa', 'cypress', 'playwright', 'selenium', 'jest'] },
  { label: 'fintech', keywords: ['fintech', 'finance', 'banking', 'payments'] },
  { label: 'healthtech', keywords: ['healthcare', 'healthtech', 'medical', 'clinical'] },
  { label: 'ecommerce', keywords: ['ecommerce', 'retail'] },
];

// Statuses that mean the user actually applied (as opposed to merely evaluated).
const appliedStatuses: ReadonlySet<string> = new Set([
  'appliedConfirmed',
  'staleNoResponse',
  'rejected',
  'interviewing',
  'offer',
]);

// Statuses that count as a positive outcome signal for the skill/domain pass.
const interviewedStatuses: ReadonlySet<string> = new Set(['interviewing', 'offer']);

// Seniority qualifiers stripped before role-title clustering, so "Senior
// Engineer" and "Staff Engineer" cluster on the shared "engineer" stem.
const seniorityPrefixes: readonly string[] = [
  'senior',
  'staff',
  'principal',
  'lead',
  'junior',
  'jr',
  'sr',
  'i',
  'ii',
  'iii',
  'iv',
  'v',
];

function normalizeText(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function tokensOf(text: string): Set<string> {
  return new Set(normalizeText(text).split(' ').filter((token) => token.length > 0));
}

function recordText(record: ApplicationRecord): string {
  return `${record.roleTitle} ${record.postingDescription ?? ''}`;
}

function matchedLabels(record: ApplicationRecord): Set<string> {
  const tokens = tokensOf(recordText(record));
  const labels = new Set<string>();
  for (const entry of skillDomainTable) {
    if (entry.keywords.some((keyword) => tokens.has(keyword))) {
      labels.add(entry.label);
    }
  }
  return labels;
}

function normalizeRoleStem(roleTitle: string): string {
  const words = normalizeText(roleTitle).split(' ').filter((word) => word.length > 0);
  const stem = words.filter((word) => !seniorityPrefixes.includes(word)).join(' ');
  return stem.length > 0 ? stem : normalizeText(roleTitle);
}

function skillDomainSuggestions(history: ApplicationHistory): PatternSuggestion[] {
  const interviewed = history.applications.filter((record) => interviewedStatuses.has(record.status));
  const rejected = history.applications.filter((record) => record.status === 'rejected');
  if (interviewed.length === 0) {
    return [];
  }
  const interviewedCounts = new Map<string, number>();
  const interviewedTitles = new Map<string, string[]>();
  const rejectedCounts = new Map<string, number>();
  for (const record of interviewed) {
    for (const label of matchedLabels(record)) {
      interviewedCounts.set(label, (interviewedCounts.get(label) ?? 0) + 1);
      const titles = interviewedTitles.get(label) ?? [];
      titles.push(record.roleTitle);
      interviewedTitles.set(label, titles);
    }
  }
  for (const record of rejected) {
    for (const label of matchedLabels(record)) {
      rejectedCounts.set(label, (rejectedCounts.get(label) ?? 0) + 1);
    }
  }
  const suggestions: PatternSuggestion[] = [];
  for (const [label, count] of interviewedCounts) {
    if (count < 2 || count <= (rejectedCounts.get(label) ?? 0)) {
      continue;
    }
    suggestions.push({
      kind: 'skillDomain',
      message: `Interviewed roles commonly mention ${label} skills/domains; rejected roles rarely do.`,
      evidence: [...new Set(interviewedTitles.get(label) ?? [])].sort(),
    });
  }
  return suggestions.sort((first, second) => first.message.localeCompare(second.message));
}

function locationSuggestions(history: ApplicationHistory): PatternSuggestion[] {
  const applied = history.applications.filter((record) => appliedStatuses.has(record.status));
  const known = applied.filter(
    (record) => record.postingFacts?.locationType !== undefined && record.postingFacts.locationType !== 'unknown',
  );
  if (known.length < 2) {
    return [];
  }
  const counts = new Map<string, number>();
  const titles = new Map<string, string[]>();
  for (const record of known) {
    const locationType = record.postingFacts?.locationType as string;
    counts.set(locationType, (counts.get(locationType) ?? 0) + 1);
    const recordTitles = titles.get(locationType) ?? [];
    recordTitles.push(record.roleTitle);
    titles.set(locationType, recordTitles);
  }
  const suggestions: PatternSuggestion[] = [];
  for (const [locationType, count] of counts) {
    if (count < 2 || count / known.length < 0.5) {
      continue;
    }
    suggestions.push({
      kind: 'location',
      message: `Applied roles were predominantly ${locationType}; consider targeting more ${locationType} roles.`,
      evidence: [...new Set(titles.get(locationType) ?? [])].sort(),
    });
  }
  return suggestions.sort((first, second) => first.message.localeCompare(second.message));
}

function roleTitleSuggestions(history: ApplicationHistory): PatternSuggestion[] {
  const clusters = new Map<string, Set<string>>();
  for (const record of history.applications) {
    const stem = normalizeRoleStem(record.roleTitle);
    const titles = clusters.get(stem) ?? new Set<string>();
    titles.add(record.roleTitle);
    clusters.set(stem, titles);
  }
  const suggestions: PatternSuggestion[] = [];
  for (const [stem, titles] of clusters) {
    if (titles.size < 2) {
      continue;
    }
    suggestions.push({
      kind: 'roleTitle',
      message: `Role titles cluster around "${stem}"; consider adding these to targetRoles.`,
      evidence: [...titles].sort(),
    });
  }
  return suggestions.sort((first, second) => first.message.localeCompare(second.message));
}

// Variant-effectiveness analysis (EUO-16): groups records by the resumeVariant
// recorded at generation time (jobFunnelTracker.markResumeGenerated) and
// compares interviewing/offer vs rejected outcomes per variant. A suggestion is
// emitted when a variant has at least 2 outcome records and a directional
// signal (positive !== rejected). Records without a resumeVariant tag are
// skipped entirely, so histories written before EUO-16 stay backward
// compatible. Suggestions only - never writes (N2, N9).
function variantSuggestions(history: ApplicationHistory): PatternSuggestion[] {
  const clusters = new Map<string, { positive: number; rejected: number; titles: Set<string> }>();
  for (const record of history.applications) {
    const variant = record.resumeVariant;
    if (variant === undefined || variant === null || variant.length === 0) {
      continue;
    }
    const cluster = clusters.get(variant) ?? { positive: 0, rejected: 0, titles: new Set<string>() };
    if (record.status === 'interviewing' || record.status === 'offer') {
      cluster.positive += 1;
    } else if (record.status === 'rejected') {
      cluster.rejected += 1;
    }
    cluster.titles.add(record.roleTitle);
    clusters.set(variant, cluster);
  }
  const suggestions: PatternSuggestion[] = [];
  for (const [variant, cluster] of clusters) {
    const outcomeCount = cluster.positive + cluster.rejected;
    if (outcomeCount < 2 || cluster.positive === cluster.rejected) {
      continue;
    }
    const message =
      cluster.positive > cluster.rejected
        ? `Applications using the "${variant}" resume variant reached ${cluster.positive} interviewing/offer vs ${cluster.rejected} rejected; consider making it your default.`
        : `Applications using the "${variant}" resume variant reached ${cluster.positive} interviewing/offer vs ${cluster.rejected} rejected; consider reviewing its fit.`;
    suggestions.push({
      kind: 'variant',
      message,
      evidence: [...cluster.titles].sort(),
    });
  }
  return suggestions.sort((first, second) => first.message.localeCompare(second.message));
}

// Preference-drift analysis (EUO-17, G9): compares applied role titles and
// locations against the user's stated targetRoles/preferredLocations and flags
// drift as a suggestion. Matching is normalized (case/whitespace-insensitive)
// and bidirectional-contains, so "Senior Engineer" applied against a target of
// "Engineer" is NOT flagged as drift. Only records the user actually applied to
// count (appliedStatuses); records without location-shaped data are skipped.
// Suggestions only - never writes preferences or history (N2, N9).
function driftSuggestions(history: ApplicationHistory, preferences: DriftPreferences): PatternSuggestion[] {
  const suggestions: PatternSuggestion[] = [];
  const applied = history.applications.filter((record) => appliedStatuses.has(record.status));

  if (preferences.targetRoles.length > 0) {
    const driftedTitles = applied
      .filter((record) => !matchesAnyPreference(record.roleTitle, preferences.targetRoles))
      .map((record) => record.roleTitle);
    if (driftedTitles.length > 0) {
      suggestions.push({
        kind: 'roleTitleDrift',
        message: `Applied to ${driftedTitles.length} role(s) outside targetRoles; consider adding them to targetRoles or updating your preferences.`,
        evidence: [...new Set(driftedTitles)].sort(),
      });
    }
  }

  if (preferences.preferredLocations.length > 0) {
    const drifted = applied.filter((record) => {
      const locationType = record.postingFacts?.locationType;
      if (locationType === undefined || locationType === 'unknown') {
        return false;
      }
      return !matchesAnyPreference(locationType, preferences.preferredLocations);
    });
    if (drifted.length > 0) {
      suggestions.push({
        kind: 'locationDrift',
        message: `Applied to ${drifted.length} role(s) in locations outside preferredLocations; consider updating preferredLocations.`,
        evidence: [...new Set(drifted.map((record) => record.roleTitle))].sort(),
      });
    }
  }

  return suggestions.sort((first, second) => first.message.localeCompare(second.message));
}

// True when the normalized value matches any preference under bidirectional
// contains matching. An empty normalized value matches nothing to compare
// against, so it is treated as a match (no drift) rather than noise.
function matchesAnyPreference(value: string, preferences: readonly string[]): boolean {
  const normalizedValue = normalizeText(value);
  if (normalizedValue.length === 0) {
    return true;
  }
  return preferences.some((preference) => {
    const normalizedPreference = normalizeText(preference);
    if (normalizedPreference.length === 0) {
      return false;
    }
    return (
      normalizedValue.includes(normalizedPreference) || normalizedPreference.includes(normalizedValue)
    );
  });
}

// Deterministic analysis of one application history snapshot. Pure: takes the
// parsed history (and optionally the preference subset to compare drift
// against), returns suggestions, never touches the filesystem. When preferences
// are omitted or carry empty targetRoles/preferredLocations, no drift
// suggestions are emitted (backward compatible with EUO-07/EUO-16 callers).
export function analyzeApplicationPatterns(
  history: ApplicationHistory,
  preferences?: DriftPreferences,
): PatternSuggestion[] {
  const drift = preferences ? driftSuggestions(history, preferences) : [];
  return [
    ...skillDomainSuggestions(history),
    ...locationSuggestions(history),
    ...roleTitleSuggestions(history),
    ...variantSuggestions(history),
    ...drift,
  ];
}
