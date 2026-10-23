// Shared posting-identity normalization (SDD Requirement 7). Home to the
// company/role/location normal forms used both by computePostingHash
// (utils/jobFunnelTracker) and the fuzzy matcher (dedup/postingDeduplicator),
// so hashing and matching can never disagree on what "same posting" means.
// Neutral leaf: imports nothing project-local, creating no import cycles.

const legalSuffixTokens = new Set([
  'inc',
  'llc',
  'ltd',
  'corp',
  'co',
  'corporation',
  'incorporated',
  'gmbh',
  'plc',
  'pvt',
  'limited',
  'l.l.c',
  's.a',
  'b.v',
  'l.p',
  'company',
]);

const roleTitleAbbreviations: Record<string, string> = {
  sr: 'senior',
  jr: 'junior',
  mgr: 'manager',
  eng: 'engineer',
  dev: 'developer',
  asst: 'assistant',
  assoc: 'associate',
  dept: 'department',
};

export function normalizeCompanyName(companyName: string): string {
  const tokens = companyName.toLowerCase().split(/\s+/).filter((token) => token.length > 0);
  let end = tokens.length;
  while (end > 0) {
    const token = tokens[end - 1].replace(/[.,;:!?]+$/, '');
    if (legalSuffixTokens.has(token)) {
      end -= 1;
    } else {
      break;
    }
  }
  return tokens
    .slice(0, end)
    .join(' ')
    .replace(/[^a-z0-9]/g, '');
}

export function normalizeRoleTitle(roleTitle: string): string {
  const tokens = roleTitle.toLowerCase().split(/\s+/).filter((token) => token.length > 0);
  const expanded = tokens.map((token) => {
    const clean = token.replace(/[^a-z0-9]/g, '');
    return roleTitleAbbreviations[clean] ?? clean;
  });
  return expanded.join(' ');
}

export function normalizeLocation(location: string): string {
  return location.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function escapeRegExpToken(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Whole-token matching shared by the ATS checker, the hallucination guards,
// and the requirements extractor (U41/B1-B2/R1): a plain substring lets
// excluded 'java' hit 'javascript', while \b word boundaries can never match
// tokens ending in non-word characters ('C#', 'C++', '.NET'). `#` and `+` are
// token characters on both sides so C never matches C# or C++, and a leading
// `.` belongs to the token so NET never matches .NET. A trailing `.` stays a
// sentence boundary (Java. still matches Java), so ordinary words are
// unaffected. Whitespace collapsing keeps multi-word terms working across
// line breaks.
export function tokenPattern(term: string): RegExp {
  const normalized = term.toLowerCase().replace(/\s+/g, ' ').trim();
  return new RegExp(`(?<![A-Za-z0-9+#.])${escapeRegExpToken(normalized)}(?![A-Za-z0-9+#])`, 'i');
}

export function matchesWholeToken(text: string, keyword: string): boolean {
  const normalizedKeyword = keyword.toLowerCase().replace(/\s+/g, ' ').trim();
  if (normalizedKeyword.length === 0) {
    return false;
  }
  const normalizedText = text.toLowerCase().replace(/\s+/g, ' ');
  return tokenPattern(normalizedKeyword).test(normalizedText);
}

// Token-set variant of the shared whole-token matcher (Phase E): the resume
// claimable filter works over a pre-tokenized profile set rather than raw
// text, so it cannot call matchesWholeToken directly. Every alphanumeric
// token of the keyword must be present in the set, using the same token
// definition (lowercase [a-z0-9]+ runs) as summarizeTokenSet. A substring
// check here lets excluded 'java' ride on profile token 'javascript'; set
// membership keeps the claimable path consistent with the ATS checker, the
// hallucination guards, and the density policy.
export function keywordClaimableByTokens(profileTokens: ReadonlySet<string>, keyword: string): boolean {
  const parts = keyword.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  if (parts.length === 0) {
    return false;
  }
  return parts.every((part) => profileTokens.has(part));
}

// Non-compositional metro aliases: normalized forms that name the same labor
// market without containing the canonical spelling. Compositional variants
// ("New York, NY" vs "New York") are handled by the contains rule below, so
// only genuinely different spellings are listed here.
const locationAliases: Record<string, string> = {
  nyc: 'newyork',
  sf: 'sanfrancisco',
  bayarea: 'sanfrancisco',
  la: 'losangeles',
  dc: 'washingtondc',
};

export function canonicalLocationName(location: string): string {
  const normalized = normalizeLocation(location);
  return locationAliases[normalized] ?? normalized;
}

const minLocationContainsLength = 5;

export function locationsMatch(left: string | undefined, right: string | undefined): boolean {
  // Narrowed undefined rule: unknown matches unknown, and either side being
  // remote (location-agnostic) still merges. A defined non-remote city never
  // merges on missing data.
  if (left === undefined) {
    return right === undefined || canonicalLocationName(right) === 'remote';
  }
  if (right === undefined) {
    return canonicalLocationName(left) === 'remote';
  }
  const first = canonicalLocationName(left);
  const second = canonicalLocationName(right);
  if (first === second) {
    return true;
  }
  // Contains rule for metro-area phrasing ("Austin" inside "Austin, TX",
  // "Boston" inside "Greater Boston Area"). The shorter side must carry enough
  // characters to be a real place name, so "York" never merges into "New York".
  const shorter = first.length <= second.length ? first : second;
  const longer = first.length <= second.length ? second : first;
  return shorter.length >= minLocationContainsLength && longer.includes(shorter);
}
