import type { ParsedMasterProfile } from '../generators/resumeGenerator';
import type { CandidateCapabilities } from './fitEvaluator';
import { detectDomains } from './postingRequirementsExtractor';

// Derives the CandidateCapabilities triple fitEvaluator consumes
// (skills, yearsOfExperience, domains) from the parsed masterProfile.md. The
// CLI has no LLM provider, so nothing here is invented: skills come verbatim
// from the profile's skills groups and certifications, years of experience is
// read deterministically from the profile's own "N years of experience"
// language (the highest figure stated), and domains reuse the same taxonomy as
// postingRequirementsExtractor so candidate and posting are judged on one
// vocabulary. Signals absent from the profile stay empty/zero and the
// evaluator treats them as unstated rather than guessing.

export function candidateCapabilitiesFromProfile(
  profile: ParsedMasterProfile,
): CandidateCapabilities {
  const skills = [
    ...profile.skills.flatMap((group) => group.items),
    ...profile.certifications,
  ];
  const yearsOfExperience = detectProfileYearsOfExperience(profile);
  const domains = detectDomains(profileSearchableText(profile));
  return { skills, yearsOfExperience, domains };
}

function detectProfileYearsOfExperience(profile: ParsedMasterProfile): number {
  const text = profileSearchableText(profile);
  const matches = [...text.matchAll(/(\d{1,2})\s*\+?\s*years?(?:\s+of)?(?:\s+(?:relevant|professional|hands-on|work))?\s+experience/gi)];
  let best = 0;
  for (const match of matches) {
    const value = Number(match[1]);
    if (Number.isFinite(value) && value <= 40 && value > best) {
      best = value;
    }
  }
  return best;
}

function profileSearchableText(profile: ParsedMasterProfile): string {
  const experienceText = profile.experience
    .map((role) => [role.roleTitle, role.employer, role.bullets.join(' ')].join(' '))
    .join(' ');
  const skillsText = profile.skills
    .flatMap((group) => [group.category, ...group.items])
    .join(' ');
  return [profile.summary, skillsText, experienceText, profile.certifications.join(' ')].join(' ');
}