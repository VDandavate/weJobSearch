// Shared HTML scraping helpers (Phase F): decodeHtmlEntities, stripTags,
// cleanText/trimText, tokenize, and the NEXT DATA script lookup were
// copy-pasted across the six source adapters with two silent divergences.
// One helper owns each shape; adapters parameterize only what their source
// needs, so markup handling cannot drift apart again.

export interface DecodeHtmlEntitiesOptions {
  // Decode decimal (&#233;) and hexadecimal (&#xE9;) character references.
  // Default true (the LinkedIn superset). Adapters that never decoded numeric
  // references keep passing explicit legacy options only where their behavior
  // is preserved byte-for-byte (BuiltIn); hiring.cafe and Welcome to the
  // Jungle adopt the superset so numeric references from those sources stop
  // reaching the fit evaluator undecoded.
  decodeNumericReferences?: boolean;
  // Accept an uppercase hexadecimal marker (&#X41;) alongside &#x41;.
  // Default true (LinkedIn); BuiltIn matched lowercase x only.
  allowUppercaseHexPrefix?: boolean;
  // Map out-of-range code points to '' instead of throwing. Default true
  // (LinkedIn's guarded conversion); BuiltIn passed the raw value straight to
  // String.fromCodePoint, which throws on invalid input.
  clampInvalidCodePoints?: boolean;
}

function numericEntity(codePoint: number, clamp: boolean): string {
  if (clamp) {
    return codePoint >= 0 && codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : '';
  }
  return String.fromCodePoint(codePoint);
}

// Full HTML-entity decode: the five named entities plus, unless disabled,
// decimal and hexadecimal character references with supplementary-plane
// support via fromCodePoint. Default options reproduce the LinkedIn decoder
// exactly (named entities, then numeric references, then nbsp).
export function decodeHtmlEntities(text: string, options: DecodeHtmlEntitiesOptions = {}): string {
  const decodeNumeric = options.decodeNumericReferences !== false;
  const clamp = options.clampInvalidCodePoints !== false;
  let decoded = text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
  if (decodeNumeric) {
    const hexPattern =
      options.allowUppercaseHexPrefix === false ? /&#x([0-9a-fA-F]+);/g : /&#[xX]([0-9a-fA-F]+);/g;
    decoded = decoded
      .replace(/&#(\d+);/g, (match, decimal: string) => numericEntity(parseInt(decimal, 10), clamp))
      .replace(hexPattern, (match, hex: string) => numericEntity(parseInt(hex, 16), clamp));
  }
  return decoded.replace(/&nbsp;/g, ' ');
}

// Tags-only strip: replaces markup with spaces, collapses whitespace, trims.
// Never decodes entities; pair with decodeHtmlEntities via cleanText instead
// of folding decoding in here.
export function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

export interface CleanTextOptions extends DecodeHtmlEntitiesOptions {
  // Strip tags before decoding (LinkedIn cleanHtml / WTTJ decodeText order)
  // instead of the default decode-then-strip order (hiring.cafe / BuiltIn).
  // The orders differ observably on escaped markup such as &lt;div&gt;, so
  // each adapter keeps its historical order explicitly.
  stripBeforeDecode?: boolean;
}

// Unknown-payload text cleaner: non-strings yield '', strings are stripped
// and entity-decoded in the adapter's historical order.
export function cleanText(value: unknown, options: CleanTextOptions = {}): string {
  if (typeof value !== 'string') {
    return '';
  }
  const { stripBeforeDecode, ...decodeOptions } = options;
  if (stripBeforeDecode === true) {
    return decodeHtmlEntities(stripTags(value), decodeOptions);
  }
  return stripTags(decodeHtmlEntities(value, decodeOptions));
}

// Trim-only cleaner for JSON-sourced fields (BuiltIn, FlexJobs, Wellfound):
// whitespace trimmed, entities left untouched, non-strings yield ''.
export function trimText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export interface TokenizeOptions {
  // Minimum token length. Default 2 (flexJobs/WTTJ kept >= 2); BuiltIn kept
  // a strict > 2 (minimum 3) plus a cap.
  minTokenLength?: number;
  // Maximum tokens kept before dedupe. Default uncapped; BuiltIn capped at 5.
  maxTokens?: number;
  // Dedupe preserving first-seen order. Default true; WTTJ kept duplicates.
  dedupe?: boolean;
}

// Lowercase alphanumeric keyword tokens for client-side query matching.
export function tokenize(value: string, options: TokenizeOptions = {}): string[] {
  const minLength = options.minTokenLength ?? 2;
  const tokens = value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= minLength);
  const capped = options.maxTokens !== undefined ? tokens.slice(0, options.maxTokens) : tokens;
  return options.dedupe === false ? capped : [...new Set(capped)];
}

export interface NextDataScriptOptions {
  scriptId?: string;
  // Allow extra attributes on the script tag (Wellfound's tag carries them).
  allowExtraAttributes?: boolean;
  // Case-insensitive tag/attribute matching (FlexJobs' lookup used /i).
  caseInsensitive?: boolean;
}

// Extract and parse the server-rendered JSON island (default __NEXT_DATA__).
// Returns null both when the script tag is absent and when its payload does
// not parse, matching every adapter's historical fallback in both cases.
export function extractNextDataJson(html: string, options: NextDataScriptOptions = {}): unknown {
  const scriptId = options.scriptId ?? '__NEXT_DATA__';
  const escaped = scriptId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const extra = options.allowExtraAttributes === true ? '[^>]*' : '';
  const pattern = `<script id="${escaped}" type="application/json"${extra}>([\\s\\S]*?)<\\/script>`;
  const scriptRe = new RegExp(pattern, options.caseInsensitive === true ? 'i' : undefined);
  const scriptMatch = scriptRe.exec(html);
  if (scriptMatch === null) {
    return null;
  }
  try {
    return JSON.parse(scriptMatch[1]) as unknown;
  } catch {
    return null;
  }
}
