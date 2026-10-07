import type { RawPosting } from '../scrapers/jobSpyAdapter';
import type { PostingFacts } from './fitEvaluator';

// Derives the PostingFacts input shape fitEvaluator consumes (employerType,
// clearance, locationType) from a RawPosting's existing committed fields
// (companyName, description, location, jobUrl) only — no adapter changes, no
// additional scraping. This module is the single source of this extraction
// logic: the CLI/MCP commands (Steps 5+) call extractPostingFacts once per
// posting before invoking fitEvaluator, and never reimplement these
// detections. jobUrl is consulted only as a company-identity signal for
// employerType, never fetched. Zero underscore identifiers, standard grep.
//
// Honest-default discipline (extending Step 4b's "unknown, not silent
// hard-reject" pattern):
//   - locationType defaults to 'unknown', never a guessed 'onsite'. The
//     remoteOnly nonNegotiable flags fully-onsite postings for manualReview
//     (SDD Requirement 1a), so guessing 'onsite' would falsely flag
//     remote-capable postings whose location text omits a work-mode word.
//   - employerType defaults to 'unknown', never a guessed 'directEmployer'.
//     A false 'directEmployer' would turn the noStaffingAgencies check into
//     a false negative; an honest 'unknown' keeps the outcome honest.
//   - clearance defaults to 'none' only when no clearance language appears
//     at all (a posting that requires no clearance can never exceed the
//     candidate's level), and to 'unknown' when clearance is mentioned but no
//     concrete level is stated, so fitEvaluator routes that to manualReview.

export type PostingLocationType = 'remote' | 'hybrid' | 'onsite' | 'unknown';
export type PostingEmployerType = 'staffingAgency' | 'unknown';
export type PostingClearanceType =
  | 'publicTrust'
  | 'secret'
  | 'topSecret'
  | 'tsSci'
  | 'none'
  | 'unknown';

// Location-work-mode detection. remote is checked first so a location that
// reads "Remote or Hybrid" never settles on the conservative onsite branch,
// and a negated phrasing ("not remote") is deliberately excluded so it cannot
// manufacture a remote classification.
const remoteLocationPatterns = [
  /\bremote\b/i,
  /\bwfh\b/i,
  /\bwork\s+from\s+home\b/i,
  /\btelecommut\w*\b/i,
  /\btelework\b/i,
  /\b100\s*%\s*remote\b/i,
  /\bfully\s+remote\b/i,
];
const hybridLocationPattern = /\bhybrid\b/i;
const onsiteLocationPattern = /\b(?:on[- ]?site|in[- ]office|in\s+the\s+office|on\s+the\s+premises)\b/i;
const negatedRemotePattern = /\b(?:not\s+remote|no\s+remote|no\s+telework\w*)\b/i;

export function classifyLocationType(location: string | null | undefined): PostingLocationType {
  const text = (location ?? '').trim().toLowerCase();
  if (text.length === 0) {
    return 'unknown';
  }
  if (!negatedRemotePattern.test(text) && remoteLocationPatterns.some((pattern) => pattern.test(text))) {
    return 'remote';
  }
  if (hybridLocationPattern.test(text)) {
    return 'hybrid';
  }
  if (onsiteLocationPattern.test(text)) {
    return 'onsite';
  }
  return 'unknown';
}

// Employer-type signals are split by source so description matches stay
// specific to agency language ("recruiting agency", "on behalf of our
// client") and never fire on ordinary employer phrasing such as "we are
// recruiting a senior engineer for our own team" or "direct hire".
const companyNameAgencyPatterns = [
  /\bstaff(?:ing|ers?)?\b/i,
  /\brecruit\w*\b/i,
  /\bheadhunt\w*\b/i,
  /\btalent\s+(?:solutions|acquisition|agency)\b/i,
  /\b(?:temp|temporary)\s*(?:staff|agency|solutions|services)\b/i,
  /\bplacement\b/i,
  /\bemployment\s+agency\b/i,
];

const descriptionAgencyPatterns = [
  /\bon\s+behalf\s+of(?:\s+(?:our|a|the|one\s+of\s+our)\s+)?client\b/i,
  /\bhiring\s+(?:on\s+behalf\s+of|for)\s+(?:a\s+|one\s+of\s+our\s+)?client\b/i,
  /\brecruit\w*\s+(?:agency|firm|partner|company)\b/i,
  /\bstaff\w*\s+(?:agency|firm|partner|solutions|group|services|company)\b/i,
  /\btalent\s+(?:agency|firm|solutions|partner)\b/i,
  /\btemporary\s*(?:staffing)?\s*(?:agency|placement|services)\b/i,
  /\btemp\s*(?:to\s+perm|to\s+hire|staff|agency)\b/i,
  /\bcontract\s*-\s*to\s*hire\b/i,
  /\bplacement\s+agency\b/i,
  /\bemployment\s+agency\b/i,
];

// Company-identity signals are the companyName plus the jobUrl hostname.
// Scraped postings for agency listings are commonly hosted on the agency's own
// careers domain, so "opportunities.staffingcareers.com" carries the same
// evidence as a companyName that mentions staffing.
function companyIdentitySignals(
  companyName: string | null | undefined,
  jobUrl: string | null | undefined,
): string[] {
  const signals = [(companyName ?? '').trim()];
  if (jobUrl !== null && jobUrl !== undefined && jobUrl.length > 0) {
    try {
      const hostname = new URL(jobUrl).hostname.replace(/^www\./i, '').replace(/^jobs\./i, '');
      if (hostname.length > 0) {
        signals.push(hostname);
      }
    } catch {
      // A non-URL jobUrl carries no reliable identity signal; ignored.
    }
  }
  return signals.filter((signal) => signal.length > 0);
}

// Agency names frequently render as a single joined word ("AcmeStaffing").
// Splitting lowercase-to-uppercase transitions recovers the standalone token
// so the word-boundary patterns can fire without turning "Stafford" (which
// merely contains the letters) into a staffing-agency false positive.
function spaceCamelCase(value: string): string {
  return value.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
}

export function classifyEmployerType(
  companyName: string | null | undefined,
  description: string | null | undefined,
  jobUrl: string | null | undefined = undefined,
): PostingEmployerType {
  const descriptionText = description ?? '';
  for (const signal of companyIdentitySignals(companyName, jobUrl)) {
    const normalized = spaceCamelCase(signal).toLowerCase();
    if (companyNameAgencyPatterns.some((pattern) => pattern.test(normalized))) {
      return 'staffingAgency';
    }
  }
  if (descriptionAgencyPatterns.some((pattern) => pattern.test(descriptionText))) {
    return 'staffingAgency';
  }
  return 'unknown';
}

// Clearance is a statement of the highest level the posting demands. The
// tsSci / topSecret / secret / publicTrust ladder is ordered most-specific
// first so "Top Secret/SCI ceiling" classifies as tsSci, and a posting that
// lists both Secret and Top Secret correctly reports the top end.
const clearanceLevelPatterns: ReadonlyArray<readonly [PostingClearanceType, RegExp]> = [
  ['tsSci', /\bts\s*[-\/]*sci\b/i],
  ['topSecret', /\btop\s*[- ]?\s*secret\b/i],
  ['secret', /\bsecret(?:\s+(?:clearance|level|eligibility))\b/i],
  ['publicTrust', /\bpublic\s+trust\b/i],
];

// Clearance language with no concrete level ("security clearance required",
// "must be able to obtain clearance") routes to 'unknown' so fitEvaluator
// surfaces it for manual review instead of guessing a level.
const clearanceAmbiguousPatterns = [
  /\bsecurity\s+clearance\b/i,
  /\bclearance\s+(?:is\s+)?(?:required|preferred|mandatory)\b/i,
  /\b(?:obtain(?:ing)?|hold(?:ing)?|maintain(?:ing)?|transfer(?:ring)?)\s+(?:a\s+|an\s+|the\s+)?(?:security\s+)?clearance\b/i,
  /\beligible\s+to\s+(?:obtain|be\s+(?:approved|cleared)\s+for)\b/i,
  /\bactive\s+clearance\b/i,
  /\bbackground\s+check\s+for\s+(?:security\s+)?clearance\b/i,
];

export function classifyClearanceRequirement(
  description: string | null | undefined,
): PostingClearanceType {
  const text = description ?? '';
  if (text.trim().length === 0) {
    return 'none';
  }
  for (const [level, pattern] of clearanceLevelPatterns) {
    if (pattern.test(text)) {
      return level;
    }
  }
  if (clearanceAmbiguousPatterns.some((pattern) => pattern.test(text))) {
    return 'unknown';
  }
  return 'none';
}

// The single entry point callers (Steps 5+) use once per posting before
// fitEvaluator, so the extraction rules stay in one place.
export function extractPostingFacts(posting: RawPosting): PostingFacts {
  return {
    locationType: classifyLocationType(posting.location),
    employerType: classifyEmployerType(
      posting.companyName,
      posting.description,
      posting.jobUrl,
    ),
    requiredClearanceLevel: classifyClearanceRequirement(posting.description),
  };
}
