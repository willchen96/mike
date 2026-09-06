import type { QuoteVerification } from "./types";
import { normalizeWithMap } from "./tools/documentOps";

// Mirrors the frontend: cross-page quotes join two page segments with this
// sentinel (see expandDocumentQuoteEntry in
// frontend/src/app/components/shared/types.ts).
const PAGE_BREAK_SENTINEL = "[[PAGE_BREAK]]";
const ELLIPSIS_PATTERN = /\.{3}|…/;

// Source-text sentinels returned by readDocumentContent when a document can't
// be read. Treat these as "no source" so every quote falls back to unverified
// rather than false-negative matching against the literal error string.
const UNREADABLE_SOURCES = new Set([
  "Document could not be read.",
  "Document not found.",
]);

type QuoteLocation = { start: number; end: number; excerpt: string };
type QuoteVerificationResult = QuoteVerification & {
  needs_correction: boolean;
};

// An ellipsis attests "contiguous text with a short omission", so the omitted
// span between two located segments is bounded. 500 chars ≈ two long legal
// sentences; beyond that the fragments are being quilted from unrelated parts
// of the document rather than abbreviated from one passage.
const MAX_OMITTED_SPAN_CHARS = 500;

// Omissions that swallow a negator or exception word invert the sentence's
// meaning ("is not permitted" → "is ... permitted"), which a verified badge
// must never endorse. Word-list heuristic, deliberately conservative: a hit
// yields "unverified" (no badge), never "wrong", so a false positive only
// withholds the badge from an abbreviation a human should eyeball anyway.
const MEANING_INVERTING_OMISSION =
  /(?:\b(?:not|no|never|neither|nor|none|cannot|without|except|unless|exclud\w*|prohibit\w*|forbid\w*|denie[sd]|deny(?:ing)?|void)\b|n[''’]t\b)/i;

// Backtracking budget for in-order segment matching. Each attempt is one
// substring search; the cap keeps pathological inputs (many repeated
// segments) from scanning forever and fails CLOSED — an unmatched chain is
// reported unverified, never verified.
const MAX_LOCATE_ATTEMPTS = 64;

// A LEADING or TRAILING ellipsis truncates within a sentence, so the same
// inversion hazard applies to the text it hides ("not permitted to
// terminate" quoted as "... permitted to terminate"). Negators bind within
// their clause, so only the source text between the match and the nearest
// clause boundary is inspected — a negator in a *previous sentence* must not
// veto an unrelated quote.
const CLAUSE_BOUNDARY = /[.;:!?\n]/;
const MAX_CLAUSE_CONTEXT_CHARS = 200;

function clauseBefore(source: string, index: number): string {
  const windowStart = Math.max(0, index - MAX_CLAUSE_CONTEXT_CHARS);
  const window = source.slice(windowStart, index);
  for (let i = window.length - 1; i >= 0; i -= 1) {
    if (CLAUSE_BOUNDARY.test(window[i])) return window.slice(i + 1);
  }
  return window;
}

function clauseAfter(source: string, index: number): string {
  const window = source.slice(index, index + MAX_CLAUSE_CONTEXT_CHARS);
  for (let i = 0; i < window.length; i += 1) {
    if (CLAUSE_BOUNDARY.test(window[i])) return window.slice(0, i);
  }
  return window;
}

/**
 * Locate `quote` inside `source`, returning the exact original substring
 * (`excerpt`) plus its char offsets into `source`. Tries progressively more
 * tolerant matchers and returns the first hit:
 *   1. exact substring
 *   2. whitespace + case normalized
 *   3. whitespace + case + punctuation normalized (tolerant/fuzzy)
 * Offsets index into the EXTRACTED source text, not the raw file bytes.
 */
export function locateQuote(
  source: string,
  quote: string,
): QuoteLocation | null {
  if (!source || !quote) return null;

  // Tier 1: exact.
  const exactIdx = source.indexOf(quote);
  if (exactIdx >= 0) {
    return { start: exactIdx, end: exactIdx + quote.length, excerpt: quote };
  }

  // Tier 2: whitespace + case. Tier 3: also punctuation-tolerant.
  return (
    locateNormalized(source, quote, {}) ??
    locateNormalized(source, quote, { stripPunctuation: true })
  );
}

/**
 * `locateQuote`, but only considering matches at or after `from` (offsets into
 * the original source). Implemented by searching the suffix slice; the
 * normalized tiers therefore renormalize the suffix, which is O(n) per call —
 * acceptable because callers bound their attempt count.
 */
function locateQuoteFrom(
  source: string,
  quote: string,
  from: number,
): QuoteLocation | null {
  if (from <= 0) return locateQuote(source, quote);
  if (from >= source.length) return null;
  const loc = locateQuote(source.slice(from), quote);
  return loc
    ? { start: loc.start + from, end: loc.end + from, excerpt: loc.excerpt }
    : null;
}

/**
 * Locate every segment of an abbreviated quote IN DOCUMENT ORDER, with at most
 * `maxGap` original chars omitted between consecutive segments. Backtracks
 * over earlier segments' candidate positions (a segment may recur, and only a
 * later occurrence may leave room for the rest of the chain). Returns null —
 * unverifiable — when no ordered, gap-bounded chain exists or the attempt
 * budget runs out.
 */
function locateSegmentsInOrder(
  source: string,
  segments: string[],
  maxGap: number,
): QuoteLocation[] | null {
  let attempts = 0;
  const search = (
    index: number,
    from: number,
    prevEnd: number | null,
  ): QuoteLocation[] | null => {
    if (index === segments.length) return [];
    let cursor = from;
    while (attempts < MAX_LOCATE_ATTEMPTS) {
      attempts += 1;
      const loc = locateQuoteFrom(source, segments[index], cursor);
      if (!loc) return null;
      // Every later occurrence of this segment sits even further from the
      // previous one, so a gap violation ends this branch outright.
      if (prevEnd !== null && loc.start - prevEnd > maxGap) return null;
      const rest = search(index + 1, loc.end, loc.end);
      if (rest) return [loc, ...rest];
      // This occurrence strands a later segment; try the next one.
      cursor = loc.start + 1;
    }
    return null;
  };
  return search(0, 0, null);
}

function locateNormalized(
  source: string,
  quote: string,
  opts: { stripPunctuation?: boolean },
): QuoteLocation | null {
  const { norm, origIdx } = normalizeWithMap(source, opts);
  const needle = normalizeWithMap(quote, opts).norm.trim();
  if (!needle) return null;
  const pos = norm.indexOf(needle);
  if (pos < 0) return null;
  const endNormPos = pos + needle.length;
  const start = origIdx[pos] ?? 0;
  const end =
    endNormPos - 1 < origIdx.length
      ? origIdx[endNormPos - 1] + 1
      : source.length;
  return { start, end, excerpt: source.slice(start, end) };
}

/**
 * Verify a single model quote against the source text, returning the
 * per-quote verification record. Cross-page quotes and quotes abbreviated with
 * `...` or `…` are split and each segment verified independently; char offsets
 * are only attached for contiguous single-segment quotes.
 */
export function verifyQuoteAgainstSource(
  source: string,
  quote: string,
): QuoteVerificationResult {
  if (!source || UNREADABLE_SOURCES.has(source)) {
    return { verified: false, needs_correction: false };
  }

  if (quote.includes(PAGE_BREAK_SENTINEL)) {
    const segments = quote
      .split(PAGE_BREAK_SENTINEL)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (!segments.length) return { verified: false, needs_correction: false };
    const verified = segments.map((seg) =>
      verifyQuoteAgainstSource(source, seg),
    );
    if (verified.some((result) => !result.verified)) {
      return { verified: false, needs_correction: false };
    }
    return {
      verified: true,
      needs_correction: verified.some((result) => result.needs_correction),
      source_excerpt: verified
        .map((result, index) => result.source_excerpt ?? segments[index])
        .join(` ${PAGE_BREAK_SENTINEL} `),
    };
  }

  // The document viewers treat ASCII and Unicode ellipses as omission
  // separators and highlight each quoted segment independently. Mirror that
  // tolerance here — but an ellipsis is a claim about the SHAPE of the
  // omission, so the segments must additionally satisfy what the ellipsis
  // asserts to the reader:
  //   1. they appear in document order (no rearranged fragments),
  //   2. the omitted span is short (no quilting distant parts together),
  //   3. the omitted span contains no negator/exception word (an omission
  //      that swallows "not" flips the sentence's meaning).
  // Any violation returns unverified: in a legal product a green badge on a
  // meaning-inverting or rearranged quote is worse than no verification.
  if (ELLIPSIS_PATTERN.test(quote)) {
    const segments = quote
      .split(ELLIPSIS_PATTERN)
      .map((segment) => segment.trim())
      // Match the viewers' normalization: punctuation-only remnants (for
      // example, the fourth dot in "....") do not form quoted segments.
      .filter((segment) => /[\p{L}\p{N}]/u.test(segment));
    if (!segments.length) return { verified: false, needs_correction: false };
    const located = locateSegmentsInOrder(
      source,
      segments,
      MAX_OMITTED_SPAN_CHARS,
    );
    if (!located) return { verified: false, needs_correction: false };
    for (let i = 1; i < located.length; i += 1) {
      const omitted = source.slice(located[i - 1].end, located[i].start);
      if (MEANING_INVERTING_OMISSION.test(omitted)) {
        return { verified: false, needs_correction: false };
      }
    }
    // Edge ellipses hide same-clause context the reader cannot see; refuse
    // the badge when that hidden context negates or carves out the fragment.
    const trimmedQuote = quote.trim();
    if (
      /^(?:\.{3}|…)/.test(trimmedQuote) &&
      MEANING_INVERTING_OMISSION.test(clauseBefore(source, located[0].start))
    ) {
      return { verified: false, needs_correction: false };
    }
    if (
      /(?:\.{3}|…)$/.test(trimmedQuote) &&
      MEANING_INVERTING_OMISSION.test(
        clauseAfter(source, located[located.length - 1].end),
      )
    ) {
      return { verified: false, needs_correction: false };
    }
    return {
      verified: true,
      needs_correction: located.some(
        (location, index) => location.excerpt !== segments[index],
      ),
      source_excerpt: located.map((location) => location.excerpt).join(" ... "),
    };
  }

  const loc = locateQuote(source, quote);
  if (!loc) return { verified: false, needs_correction: false };
  return {
    verified: true,
    needs_correction: loc.excerpt !== quote,
    start_char: loc.start,
    end_char: loc.end,
    source_excerpt: loc.excerpt,
  };
}

type DocQuoteEntry = { page: number | string; quote: string };

export type CaseOpinionSource = {
  opinion_id: number | null;
  text: string;
};

type CaseQuoteEntry = {
  opinionId?: number | null;
  opinion_id?: number | null;
  quote: string;
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function withVerifiedDocumentQuotes(
  documentValue: unknown,
  verifiedQuotes: { quote: string; verification: QuoteVerification }[],
): Record<string, unknown> | undefined {
  const document = record(documentValue);
  if (!document) return undefined;
  const documentQuotes = Array.isArray(document.quotes) ? document.quotes : [];
  return {
    ...document,
    quotes: documentQuotes.map((value, index) => {
      const quote = record(value);
      const verifiedQuote = verifiedQuotes[index];
      return quote && verifiedQuote
        ? {
            ...quote,
            quote: verifiedQuote.quote,
            verification: verifiedQuote.verification,
          }
        : value;
    }),
  };
}

function caseQuoteOpinionId(quote: CaseQuoteEntry): number | null {
  const value = quote.opinionId ?? quote.opinion_id;
  return typeof value === "number" && Number.isFinite(value)
    ? Math.floor(value)
    : null;
}

/**
 * Match each case citation quote against the opinion text cached during the
 * CourtListener read. Quotes with an opinion ID are checked only against that
 * opinion; quotes without one are checked against the complete case text.
 */
export async function verifyCaseCitationAnnotation(
  annotation: unknown,
  getCaseOpinions: (clusterId: number) => Promise<CaseOpinionSource[]>,
): Promise<unknown> {
  const a = record(annotation);
  if (!a || a.kind !== "case") return annotation;
  const clusterId =
    typeof a.cluster_id === "number" && Number.isFinite(a.cluster_id)
      ? Math.floor(a.cluster_id)
      : null;
  if (clusterId === null) return annotation;

  const entries = Array.isArray(a.quotes)
    ? a.quotes
        .map((value) => record(value))
        .filter(
          (value): value is Record<string, unknown> & CaseQuoteEntry =>
            !!value && typeof value.quote === "string" && !!value.quote,
        )
    : [];
  if (!entries.length) return annotation;

  let opinions: CaseOpinionSource[];
  try {
    opinions = await getCaseOpinions(clusterId);
  } catch {
    opinions = [];
  }

  const completeCaseText = opinions.map((opinion) => opinion.text).join("\n");
  const verifiedQuotes = entries.map((entry) => {
    const opinionId = caseQuoteOpinionId(entry);
    const source =
      opinionId === null
        ? completeCaseText
        : (opinions.find((opinion) => opinion.opinion_id === opinionId)?.text ??
          "");
    const result = verifyQuoteAgainstSource(source, entry.quote);
    const { needs_correction, ...verification } = result;
    const quote =
      needs_correction && verification.source_excerpt
        ? verification.source_excerpt
        : entry.quote;
    return { ...entry, quote, verification };
  });

  const verifiedDocument = withVerifiedDocumentQuotes(
    a.document,
    verifiedQuotes,
  );

  return {
    ...a,
    quotes: verifiedQuotes,
    verified: verifiedQuotes.every((quote) => quote.verification.verified),
    ...(verifiedDocument ? { document: verifiedDocument } : {}),
  };
}

/**
 * Attach server-side verification to one document citation annotation.
 * Case-law annotations are handled separately by
 * `verifyCaseCitationAnnotation`. For document annotations, source text is
 * fetched once via `getSourceText(doc_id)` and each quote is located in it;
 * corrected quotes have the exact source excerpt swapped in so the UI never
 * shows drifted text.
 */
export async function verifyDocumentCitationAnnotation(
  annotation: unknown,
  getSourceText: (docId: string) => Promise<string>,
): Promise<unknown> {
  if (!annotation || typeof annotation !== "object") return annotation;
  const a = annotation as Record<string, unknown>;
  if (a.kind === "case") return annotation;
  const docId = typeof a.doc_id === "string" ? a.doc_id : null;
  if (!docId) return annotation;

  const entries: DocQuoteEntry[] = Array.isArray(a.quotes)
    ? (a.quotes as DocQuoteEntry[])
    : typeof a.quote === "string"
      ? [{ page: (a.page as number | string) ?? 1, quote: a.quote }]
      : [];
  if (!entries.length) return annotation;

  let source: string;
  try {
    source = await getSourceText(docId);
  } catch {
    source = "";
  }

  const verifiedQuotes = entries.map((entry) => {
    const result = verifyQuoteAgainstSource(source, entry.quote);
    const { needs_correction, ...verification } = result;
    // Swap the exact source text into the displayed quote when it drifted,
    // so a drifted quote is never surfaced as the source's words.
    const quote =
      needs_correction && verification.source_excerpt
        ? verification.source_excerpt
        : entry.quote;
    return { ...entry, quote, verification };
  });

  const verified = verifiedQuotes.every((q) => q.verification.verified);

  const verifiedDocument = withVerifiedDocumentQuotes(
    a.document,
    verifiedQuotes,
  );

  return {
    ...a,
    quote: verifiedQuotes[0]?.quote ?? a.quote,
    quotes: verifiedQuotes,
    verified,
    ...(verifiedDocument ? { document: verifiedDocument } : {}),
  };
}

/**
 * Verify a batch of citation annotations. Document annotations are verified
 * against extracted file text and case annotations against opinion text read
 * during this turn. Callers must provide both source resolvers so a citation
 * kind can never silently bypass verification.
 */
export async function verifyCitations(
  annotations: unknown[],
  getSourceText: (docId: string) => Promise<string>,
  getCaseOpinions: (clusterId: number) => Promise<CaseOpinionSource[]>,
): Promise<unknown[]> {
  return Promise.all(
    annotations.map((annotation) => {
      const value = record(annotation);
      return value?.kind === "case"
        ? verifyCaseCitationAnnotation(annotation, getCaseOpinions)
        : verifyDocumentCitationAnnotation(annotation, getSourceText);
    }),
  );
}
