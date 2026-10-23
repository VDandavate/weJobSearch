import type { RawPosting } from '../scrapers/jobSpyAdapter';
import { tokenPattern } from '../utils/postingIdentity';
import type { PostingRequirements } from './fitEvaluator';

// Deterministic extraction of the PostingRequirements triple fitEvaluator
// consumes (requiredSkills, requiredYearsOfExperience, requiredDomains) from a
// posting's own text. The CLI has no LLM provider, so nothing here is inferred:
// every returned skill, domain, and year figure is matched verbatim (or by a
// fixed alias table) from the posting description or role title. Unknown
// signals stay empty/null and the evaluator treats them as "not stated" rather
// than guessing.
//
// The skill and domain tables are taxonomies of common US tech-industry terms,
// not personal thresholds (AGENTS.md: thresholds live in jobPreferences.yaml).
// They exist so a posting that states a requirement can drive the same
// deduction the SDD Requirement 2 examples describe deterministically.

const yearsOfExperiencePattern =
  /(\d{1,2})\s*\+?\s*(?:to\s+\d{1,2}\s*)?years?(?:\s+of)?(?:\s+(?:relevant|professional|hands-on|work))?\s+experience/i;

// A years figure only states a candidate requirement when the sentence
// addresses the candidate. Employer history ("our team has 20 years") and
// company marketing must not become a requirement cap.
const candidateDirectedCuePattern =
  /\b(?:you|your|candidate|candidates|must|minimum|at\s+least|required|requires?|requirement|requirements)\b/i;

// Preferred cues apply to the sentence or list item that carries them. The
// governed skills are collected separately and never drive a deduction.
const preferredCuePattern = /\b(?:preferred|nice\s+to\s+have|bonus|a\s+plus|plus|desired)\b/i;

// A domain term is only a posting requirement when the description ties it to
// experience or domain language. Vendor marketing that merely names its
// market ("we are a cybersecurity leader") carries no such cue.
const domainCuePattern = /\bexperience\s+in\b|\bbackground\s+in\b|\bdomain\b/i;

interface VocabularyEntry {
  canonical: string;
  patterns: RegExp[];
}

function vocabularyEntry(canonical: string, terms: string[]): VocabularyEntry {
  return {
    canonical,
    patterns: terms.map((term) => tokenPattern(term)),
  };
}

// Common engineering skills/formats named in US postings. The Go language is
// only matched when the posting literally says "golang" so the common English
// word "go" never fires.
const skillVocabulary: VocabularyEntry[] = [
  vocabularyEntry('TypeScript', ['typescript']),
  vocabularyEntry('JavaScript', ['javascript']),
  vocabularyEntry('Python', ['python']),
  vocabularyEntry('Java', ['java']),
  vocabularyEntry('Go', ['golang']),
  vocabularyEntry('Rust', ['rust']),
  vocabularyEntry('C#', ['c#']),
  vocabularyEntry('C++', ['c++', 'cpp']),
  vocabularyEntry('Ruby', ['ruby']),
  vocabularyEntry('PHP', ['php']),
  vocabularyEntry('Swift', ['swift']),
  vocabularyEntry('Kotlin', ['kotlin']),
  vocabularyEntry('SQL', ['sql']),
  vocabularyEntry('PostgreSQL', ['postgresql', 'postgres']),
  vocabularyEntry('MySQL', ['mysql']),
  vocabularyEntry('MongoDB', ['mongodb', 'mongo']),
  vocabularyEntry('Redis', ['redis']),
  vocabularyEntry('Elasticsearch', ['elasticsearch']),
  vocabularyEntry('React', ['react']),
  vocabularyEntry('Vue', ['vue']),
  vocabularyEntry('Angular', ['angular']),
  vocabularyEntry('Svelte', ['svelte']),
  vocabularyEntry('Node.js', ['nodejs', 'node.js']),
  vocabularyEntry('Next.js', ['nextjs', 'next.js']),
  vocabularyEntry('GraphQL', ['graphql']),
  vocabularyEntry('Docker', ['docker']),
  vocabularyEntry('Kubernetes', ['kubernetes', 'k8s']),
  vocabularyEntry('Terraform', ['terraform']),
  vocabularyEntry('AWS', ['aws']),
  vocabularyEntry('Azure', ['azure']),
  vocabularyEntry('GCP', ['gcp']),
  vocabularyEntry('Kafka', ['kafka']),
  vocabularyEntry('Spark', ['spark']),
  vocabularyEntry('Airflow', ['airflow']),
  vocabularyEntry('Pandas', ['pandas']),
  vocabularyEntry('PyTorch', ['pytorch']),
  vocabularyEntry('TensorFlow', ['tensorflow']),
  vocabularyEntry('Snowflake', ['snowflake']),
  vocabularyEntry('Datadog', ['datadog']),
  vocabularyEntry('GitHub Actions', ['github actions']),
  vocabularyEntry('Scrum', ['scrum']),
];

const domainVocabulary: VocabularyEntry[] = [
  vocabularyEntry('FinTech', ['fintech', 'financial technology']),
  vocabularyEntry('HealthTech', ['healthtech', 'health tech']),
  vocabularyEntry('Healthcare', ['healthcare']),
  vocabularyEntry('ECommerce', ['ecommerce', 'e-commerce']),
  vocabularyEntry('EdTech', ['edtech']),
  vocabularyEntry('Cybersecurity', ['cybersecurity', 'cyber security']),
  vocabularyEntry('Defense', ['defense', 'defence']),
  vocabularyEntry('GovTech', ['govtech']),
  vocabularyEntry('Logistics', ['logistics', 'supply chain']),
  vocabularyEntry('Media', ['media', 'streaming']),
  vocabularyEntry('Gaming', ['gaming', 'video games']),
  vocabularyEntry('BioTech', ['biotech']),
  vocabularyEntry('Robotics', ['robotics']),
];

function matchesCanonicalEntries(entries: VocabularyEntry[], text: string): string[] {
  const found: string[] = [];
  for (const entry of entries) {
    if (entry.patterns.some((pattern) => pattern.test(text))) {
      found.push(entry.canonical);
    }
  }
  return found;
}

function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);
}

export function detectYearsOfExperience(text: string): number | null {
  for (const sentence of splitSentences(text)) {
    if (!candidateDirectedCuePattern.test(sentence)) {
      continue;
    }
    const match = yearsOfExperiencePattern.exec(sentence);
    if (match === null) {
      continue;
    }
    const value = Number(match[1]);
    if (Number.isFinite(value)) {
      return value;
    }
  }
  return null;
}

interface SkillSegment {
  text: string;
  preferred: boolean;
}

function skillSegments(description: string): SkillSegment[] {
  const segments: SkillSegment[] = [];
  for (const paragraph of description.split(/\n\s*\n/)) {
    let inheritedCue = false;
    for (const line of paragraph.split('\n')) {
      const sentences = splitSentences(line);
      const lineHasSkill = sentences.some(
        (sentence) => matchesCanonicalEntries(skillVocabulary, sentence).length > 0,
      );
      const lineHasCue = sentences.some((sentence) => preferredCuePattern.test(sentence));
      for (const sentence of sentences) {
        segments.push({
          text: sentence,
          preferred: inheritedCue || preferredCuePattern.test(sentence),
        });
      }
      // A cue-only heading ("Preferred qualifications:") governs the list
      // items below it inside the same paragraph; a later plain heading ends
      // that scope.
      if (lineHasCue && !lineHasSkill) {
        inheritedCue = true;
      } else if (!lineHasCue && !lineHasSkill && /:\s*$/.test(line)) {
        inheritedCue = false;
      }
    }
  }
  return segments;
}

function classifySkills(
  description: string,
  roleTitle: string,
): { required: string[]; preferred: string[] } {
  const titleSkills = matchesCanonicalEntries(skillVocabulary, roleTitle);
  const segments = skillSegments(description);
  const required: string[] = [];
  const preferred: string[] = [];
  for (const entry of skillVocabulary) {
    const inTitle = titleSkills.includes(entry.canonical);
    const inRequiredSegment = segments.some(
      (segment) =>
        !segment.preferred && entry.patterns.some((pattern) => pattern.test(segment.text)),
    );
    if (inTitle || inRequiredSegment) {
      required.push(entry.canonical);
    } else if (
      segments.some(
        (segment) =>
          segment.preferred && entry.patterns.some((pattern) => pattern.test(segment.text)),
      )
    ) {
      preferred.push(entry.canonical);
    }
  }
  return { required, preferred };
}

export function extractRequiredSkills(description: string, roleTitle: string): string[] {
  return classifySkills(description, roleTitle).required;
}

export function extractPreferredSkills(description: string): string[] {
  return classifySkills(description, '').preferred;
}

// Shared with profileCapabilitiesExtractor so candidate domains and posting
// domains use the exact same taxonomy (consistent in both directions).
export function detectDomains(text: string): string[] {
  return matchesCanonicalEntries(domainVocabulary, text);
}

export function detectPostingDomains(description: string): string[] {
  const found = new Set<string>();
  for (const sentence of splitSentences(description)) {
    if (!domainCuePattern.test(sentence)) {
      continue;
    }
    for (const domain of matchesCanonicalEntries(domainVocabulary, sentence)) {
      found.add(domain);
    }
  }
  return domainVocabulary
    .map((entry) => entry.canonical)
    .filter((domain) => found.has(domain));
}

export function extractPostingRequirements(posting: RawPosting): PostingRequirements {
  const skills = classifySkills(posting.description, posting.roleTitle);
  return {
    requiredSkills: skills.required,
    preferredSkills: skills.preferred,
    requiredYearsOfExperience: detectYearsOfExperience(posting.description),
    requiredDomains: detectPostingDomains(posting.description),
  };
}