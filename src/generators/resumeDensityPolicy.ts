import { matchesWholeToken } from '../utils/postingIdentity';
import type { ResumeBinding } from './resumeGenerator';

// Text-density reduction policy for the 1-page compile loop (SDD
// Requirement 3). Extracted verbatim from resumeGenerator.ts in Phase E so
// page-loop tuning touches this module only: the 5-step reduction budget
// table plus the density policy live here, while the EEO filter, the
// hallucination check, and the shared whole-token matcher stay where they
// were. No behavior change in the move; the single behavioral fix in this
// phase is that keyword-bullet preservation now uses the shared whole-token
// matcher (matchesWholeToken) instead of a substring includes, so excluded
// 'java' no longer keeps a 'JavaScript' bullet alive across reductions.

export interface ReductionBudget {
  maxBullets: number;
  maxExperience: number;
  maxSkillGroups: number;
  keepSummary: boolean;
  keepCertifications: boolean;
  maxEducation: number;
}

export const reductionBudgets: readonly ReductionBudget[] = [
  { maxBullets: 4, maxExperience: 6, maxSkillGroups: 6, keepSummary: false, keepCertifications: true, maxEducation: 4 },
  { maxBullets: 3, maxExperience: 4, maxSkillGroups: 4, keepSummary: false, keepCertifications: false, maxEducation: 3 },
  { maxBullets: 2, maxExperience: 3, maxSkillGroups: 3, keepSummary: false, keepCertifications: false, maxEducation: 2 },
  { maxBullets: 1, maxExperience: 2, maxSkillGroups: 2, keepSummary: false, keepCertifications: false, maxEducation: 2 },
  { maxBullets: 1, maxExperience: 1, maxSkillGroups: 1, keepSummary: false, keepCertifications: false, maxEducation: 1 },
];

function preserveKeywordBullets(bullets: readonly string[], budget: number, keywords: readonly string[]): string[] {
  // Whole-token matching (shared matcher): a substring includes would keep a
  // bullet merely for mentioning 'JavaScript' when the posting keyword is
  // 'java'. Keyword hits are kept first; regular bullets fill the remainder.
  const keywordHits = bullets.filter((bullet) =>
    keywords.some((keyword) => matchesWholeToken(bullet, keyword)),
  );
  const regular = bullets.filter((bullet) => !keywordHits.includes(bullet));
  const kept = [...keywordHits];
  for (const bullet of regular) {
    if (kept.length >= budget) {
      break;
    }
    kept.push(bullet);
  }
  return kept.slice(0, budget);
}

export function applyReductionBudget(
  binding: ResumeBinding,
  budget: ReductionBudget,
  keywords: readonly string[],
): ResumeBinding {
  const experience = binding.experience
    .slice(0, budget.maxExperience)
    .map((entry) => ({
      ...entry,
      bullets: preserveKeywordBullets(entry.bullets, budget.maxBullets, keywords),
    }));
  const skills = binding.skills.slice(0, budget.maxSkillGroups);
  const education = binding.education.slice(0, budget.maxEducation);
  return {
    ...binding,
    summary: budget.keepSummary ? binding.summary : '',
    experience,
    skills,
    education,
    certifications: budget.keepCertifications ? [...binding.certifications] : [],
  };
}
