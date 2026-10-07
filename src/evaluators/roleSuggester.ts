import type { CandidateCapabilities } from './fitEvaluator';
import { normalizeToken } from './fitEvaluator';

// Deterministic role-title suggestion (EUO-06): maps a candidate's capability
// triple (skills, yearsOfExperience, domains) through a plain role-title
// taxonomy and returns the suggested titles. Pure function: no I/O, no network,
// no LLM (N7). The taxonomy is a mapping table, not a scoring threshold (N4):
// a skill either maps to a role title or it does not, and nothing is ever
// invented for skills or domains outside the table. Output is deduplicated and
// sorted so identical input always yields identical output.

export interface SkillRoleEntry {
  /** Normalized skill keywords (lowercase, alphanumeric only) that trigger the entry. */
  keywords: readonly string[];
  /** Base role titles (no seniority prefix) produced when any keyword matches. */
  roles: readonly string[];
  /** Optional group tag used for combination rules (e.g. full-stack). */
  group?: 'frontend' | 'backend';
}

// Skill keyword -> role-title mapping table. Keywords are matched against the
// candidate's normalized skills; every matching entry contributes its roles.
const skillRoleMapping: readonly SkillRoleEntry[] = [
  {
    keywords: ['typescript', 'javascript', 'react', 'angular', 'vue', 'nextjs', 'redux', 'html', 'css'],
    roles: ['Frontend Engineer'],
    group: 'frontend',
  },
  {
    keywords: ['node', 'nodejs', 'express', 'nestjs', 'graphql', 'rest'],
    roles: ['Backend Engineer'],
    group: 'backend',
  },
  {
    keywords: ['python', 'django', 'flask', 'fastapi'],
    roles: ['Backend Engineer', 'Python Engineer'],
    group: 'backend',
  },
  {
    keywords: ['java', 'spring', 'kotlin'],
    roles: ['Backend Engineer', 'Java Engineer'],
    group: 'backend',
  },
  {
    keywords: ['go', 'golang'],
    roles: ['Backend Engineer', 'Go Engineer'],
    group: 'backend',
  },
  {
    keywords: ['rust'],
    roles: ['Systems Engineer', 'Rust Engineer'],
  },
  {
    keywords: ['c', 'cpp', 'cplusplus', 'embedded'],
    roles: ['Systems Engineer', 'Embedded Engineer'],
  },
  {
    keywords: ['aws', 'kubernetes', 'docker', 'terraform', 'gcp', 'azure', 'helm', 'jenkins', 'githubactions'],
    roles: ['DevOps Engineer', 'Platform Engineer'],
  },
  {
    keywords: ['kafka', 'spark', 'hadoop', 'snowflake', 'airflow', 'databricks', 'pyspark'],
    roles: ['Data Engineer'],
  },
  {
    keywords: ['tensorflow', 'pytorch', 'pandas', 'numpy', 'scikitlearn', 'machinelearning', 'ml', 'llm', 'nlp'],
    roles: ['Machine Learning Engineer', 'Data Scientist'],
  },
  {
    keywords: ['reactnative', 'swift', 'ios', 'android', 'flutter', 'dart', 'mobile'],
    roles: ['Mobile Engineer'],
  },
  {
    keywords: ['sql', 'postgres', 'postgresql', 'mysql', 'mongodb', 'redis', 'dynamodb'],
    roles: ['Database Engineer'],
  },
  {
    keywords: ['cypress', 'jest', 'playwright', 'selenium', 'testing', 'qa'],
    roles: ['QA Engineer', 'Test Automation Engineer'],
  },
  {
    keywords: ['security', 'penetration', 'owasp', 'soc'],
    roles: ['Security Engineer'],
  },
  {
    keywords: ['figma', 'sketch', 'ux', 'ui', 'design'],
    roles: ['Product Designer'],
  },
];

// Domain -> role-title mapping table. Only domains with a natural role title
// mapping appear here; other domains contribute nothing.
const domainRoleMapping: Readonly<Record<string, readonly string[]>> = {
  Cybersecurity: ['Security Engineer'],
  Gaming: ['Game Developer'],
  Robotics: ['Robotics Engineer'],
};

// Seniority qualifier bands derived from yearsOfExperience: <3y no prefix,
// 3-6y "Senior", 7y+ "Staff". A plain banding table, not a scoring rule.
function seniorityPrefix(yearsOfExperience: number): string {
  if (yearsOfExperience >= 7) {
    return 'Staff';
  }
  if (yearsOfExperience >= 3) {
    return 'Senior';
  }
  return '';
}

export function suggestRoles(capabilities: CandidateCapabilities): string[] {
  const matchedRoles = new Set<string>();
  const matchedGroups = new Set<string>();

  for (const skill of capabilities.skills) {
    const normalized = normalizeToken(skill);
    if (normalized.length === 0) {
      continue;
    }
    for (const entry of skillRoleMapping) {
      if (!entry.keywords.includes(normalized)) {
        continue;
      }
      for (const role of entry.roles) {
        matchedRoles.add(role);
      }
      if (entry.group !== undefined) {
        matchedGroups.add(entry.group);
      }
    }
  }

  // Combination rule: frontend + backend skills together suggest full-stack.
  if (matchedGroups.has('frontend') && matchedGroups.has('backend')) {
    matchedRoles.add('Full-Stack Engineer');
  }

  for (const domain of capabilities.domains) {
    const domainRoles = domainRoleMapping[domain];
    if (domainRoles !== undefined) {
      for (const role of domainRoles) {
        matchedRoles.add(role);
      }
    }
  }

  const prefix = seniorityPrefix(capabilities.yearsOfExperience);
  return [...matchedRoles]
    .map((role) => (prefix.length > 0 ? `${prefix} ${role}` : role))
    .sort();
}