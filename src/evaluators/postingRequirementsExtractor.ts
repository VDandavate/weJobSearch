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

export function detectYearsOfExperience(text: string): number | null {
  const match = yearsOfExperiencePattern.exec(text);
  if (match === null) {
    return null;
  }
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

function extractRequiredYearsOfExperience(description: string): number | null {
  return detectYearsOfExperience(description);
}

export function extractRequiredSkills(description: string, roleTitle: string): string[] {
  return matchesCanonicalEntries(skillVocabulary, `${roleTitle} ${description}`);
}

// Shared with profileCapabilitiesExtractor so candidate domains and posting
// domains use the exact same taxonomy (consistent in both directions).
export function detectDomains(text: string): string[] {
  return matchesCanonicalEntries(domainVocabulary, text);
}

export function extractPostingRequirements(posting: RawPosting): PostingRequirements {
  const searchableText = `${posting.companyName} ${posting.roleTitle} ${posting.description}`;
  return {
    requiredSkills: extractRequiredSkills(posting.description, posting.roleTitle),
    requiredYearsOfExperience: extractRequiredYearsOfExperience(posting.description),
    requiredDomains: detectDomains(searchableText),
  };
}