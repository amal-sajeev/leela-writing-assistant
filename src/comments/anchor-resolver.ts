import { ANCHOR_MIN_CONFIDENCE, ANCHOR_SEARCH_WINDOW_CHARACTERS } from "../constants";
import type { TextAnchor } from "../types";
import { hashAnchorContext } from "../utils/hash";
import { clampSpan } from "./anchor";

/**
 * Finds a comment's passage again after the document has moved on
 * (specification section 18).
 *
 * The order of attempts matters: cheap and certain first, speculative last, and
 * nothing below the confidence bar is accepted at all. Anchoring a comment to the
 * wrong sentence destroys trust far faster than admitting the passage is gone.
 */

/** How the passage was located, for logging and tests. */
export type AnchorStrategy = "offset" | "unique" | "scored" | "normalized" | "none";

export interface AnchorResolution {
  status: "resolved" | "stale";
  start: number;
  end: number;
  /** 0 to 1. Always 0 when the status is `stale`. */
  confidence: number;
  strategy: AnchorStrategy;
}

export interface AnchorResolveOptions {
  /** Characters either side of the old offset searched before widening. */
  windowCharacters?: number;
  minimumConfidence?: number;
}

/**
 * A quote that still exists exactly once is the passage, even when everything
 * around it was rewritten. Scored below a perfect context match, but comfortably
 * above the acceptance bar.
 */
const UNIQUE_MATCH_CONFIDENCE = 0.7;

/** The least `score` gives a candidate whose stored surroundings still match exactly. */
const CONTEXT_MATCH_CONFIDENCE = 0.95;

/** Whitespace-tolerant matches are a fallback, so they can never look certain. */
const NORMALIZED_PENALTY = 0.9;

export function resolveAnchor(
  documentText: string,
  anchor: TextAnchor,
  options: AnchorResolveOptions = {},
): AnchorResolution {
  const window = options.windowCharacters ?? ANCHOR_SEARCH_WINDOW_CHARACTERS;
  const minimumConfidence = options.minimumConfidence ?? ANCHOR_MIN_CONFIDENCE;
  const lost = staleAt(documentText, anchor);

  if (anchor.quote.length === 0) return lost;

  // 1. The offsets are usually still right, and checking is nearly free.
  if (documentText.slice(anchor.start, anchor.end) === anchor.quote) {
    return {
      status: "resolved",
      start: anchor.start,
      end: anchor.end,
      confidence: 1,
      strategy: "offset",
    };
  }

  const exact = resolveExact(documentText, anchor, window);
  if (exact !== undefined && exact.confidence >= minimumConfidence) return exact;

  // Whitespace may simply have been reflowed, which no exact search survives.
  const reflowed = resolveNormalized(documentText, anchor, window);
  if (reflowed !== undefined && reflowed.confidence >= minimumConfidence) return reflowed;

  // A near miss is still a miss: prefer the honest stale state over a guess.
  return lost;
}

/** Steps 3 to 6 of section 18: local search first, then the whole document. */
function resolveExact(
  documentText: string,
  anchor: TextAnchor,
  window: number,
): AnchorResolution | undefined {
  const local = bestOf(
    findOccurrences(documentText, anchor.quote, {
      from: anchor.start - window,
      to: anchor.end + window,
    }),
    documentText,
    anchor,
    window,
    "exact",
    // Alone in the window is not alone in the note: the passage may have moved
    // out of it and left a lookalike behind, so here context has to earn the match.
    false,
  );
  // Only a match with its surroundings intact ends the search here. Nearness
  // alone clears the bar, and must not beat the real passage further away.
  if (local !== undefined && local.confidence >= CONTEXT_MATCH_CONFIDENCE) return local;

  // The passage may have been moved wholesale, for example a section reordered.
  const anywhere = bestOf(
    findOccurrences(documentText, anchor.quote),
    documentText,
    anchor,
    window,
    "exact",
  );

  if (local === undefined) return anywhere;
  if (anywhere === undefined) return local;
  return anywhere.confidence > local.confidence ? anywhere : local;
}

/**
 * Retries with runs of whitespace collapsed, so a paragraph that was rewrapped or
 * re-indented does not orphan its comments.
 */
function resolveNormalized(
  documentText: string,
  anchor: TextAnchor,
  window: number,
): AnchorResolution | undefined {
  const normalizedQuote = collapseWhitespace(anchor.quote).trim();
  if (normalizedQuote.length === 0) return undefined;

  const document = normalizedDocument(documentText);
  const positions = findOccurrences(document.text, normalizedQuote);
  if (positions.length === 0) return undefined;

  const spans = positions.map((position) => ({
    start: document.offsets[position] ?? documentText.length,
    end: (document.offsets[position + normalizedQuote.length - 1] ?? documentText.length - 1) + 1,
  }));

  const best = bestOf(spans, documentText, anchor, window, "normalized");
  return best === undefined ? undefined : { ...best, strategy: "normalized" };
}

interface Candidate {
  start: number;
  end: number;
}

/** Picks the most convincing candidate, or nothing when there are none. */
function bestOf(
  candidates: readonly (number | Candidate)[],
  documentText: string,
  anchor: TextAnchor,
  window: number,
  kind: "exact" | "normalized",
  trustUnique = true,
): AnchorResolution | undefined {
  if (candidates.length === 0) return undefined;

  const spans = candidates.map((candidate) =>
    typeof candidate === "number"
      ? { start: candidate, end: candidate + anchor.quote.length }
      : candidate,
  );

  const penalty = kind === "normalized" ? NORMALIZED_PENALTY : 1;

  // Step 4: a single exact match is the passage, whatever happened around it.
  if (spans.length === 1 && trustUnique) {
    const only = spans[0]!;
    const scored = score(documentText, anchor, only, window);
    return {
      status: "resolved",
      start: only.start,
      end: only.end,
      confidence: Math.min(1, Math.max(scored, UNIQUE_MATCH_CONFIDENCE) * penalty),
      strategy: kind === "normalized" ? "normalized" : "unique",
    };
  }

  // Step 5: several copies of the quote exist, so context has to break the tie.
  let winner = spans[0]!;
  let winningScore = -1;

  for (const span of spans) {
    const value = score(documentText, anchor, span, window);
    if (value > winningScore) {
      winner = span;
      winningScore = value;
    }
  }

  return {
    status: "resolved",
    start: winner.start,
    end: winner.end,
    confidence: Math.min(1, winningScore * penalty),
    strategy: kind === "normalized" ? "normalized" : "scored",
  };
}

/**
 * How much a candidate looks like the original passage.
 *
 * An identical neighbourhood is decisive; otherwise partial prefix and suffix
 * agreement carries most of the weight and closeness to the remembered offset
 * only breaks near-ties.
 */
function score(
  documentText: string,
  anchor: TextAnchor,
  candidate: Candidate,
  window: number,
): number {
  const prefix = documentText.slice(Math.max(0, candidate.start - anchor.prefix.length), candidate.start);
  const suffix = documentText.slice(candidate.end, candidate.end + anchor.suffix.length);
  const quote = documentText.slice(candidate.start, candidate.end);
  const proximity = 1 / (1 + Math.abs(candidate.start - anchor.start) / Math.max(1, window));

  if (hashAnchorContext(prefix, quote, suffix) === anchor.contextHash) {
    return CONTEXT_MATCH_CONFIDENCE + (1 - CONTEXT_MATCH_CONFIDENCE) * proximity;
  }

  const affix =
    (similarityFromEnd(anchor.prefix, prefix) + similarityFromStart(anchor.suffix, suffix)) / 2;

  return 0.35 + 0.45 * affix + 0.2 * proximity;
}

/** Agreement between two prefixes, measured backwards from the anchor. */
function similarityFromEnd(expected: string, actual: string): number {
  if (expected.length === 0) return actual.length === 0 ? 1 : 0.5;

  let shared = 0;
  while (
    shared < expected.length &&
    shared < actual.length &&
    expected[expected.length - 1 - shared] === actual[actual.length - 1 - shared]
  ) {
    shared += 1;
  }

  return shared / expected.length;
}

/** Agreement between two suffixes, measured forwards from the anchor. */
function similarityFromStart(expected: string, actual: string): number {
  if (expected.length === 0) return actual.length === 0 ? 1 : 0.5;

  let shared = 0;
  while (shared < expected.length && shared < actual.length && expected[shared] === actual[shared]) {
    shared += 1;
  }

  return shared / expected.length;
}

/** Every occurrence of `needle`, optionally restricted to a region. */
function findOccurrences(
  text: string,
  needle: string,
  region?: { from: number; to: number },
): number[] {
  if (needle.length === 0) return [];

  const from = Math.max(0, region?.from ?? 0);
  const to = Math.min(text.length, region?.to ?? text.length);
  const found: number[] = [];

  let index = text.indexOf(needle, from);
  while (index >= 0 && index + needle.length <= to) {
    found.push(index);
    index = text.indexOf(needle, index + 1);
  }

  return found;
}

interface NormalizedText {
  text: string;
  /** Raw offset of each character in `text`. */
  offsets: number[];
}

/**
 * Re-anchoring resolves every comment against the same text, so the last
 * normalised document is kept rather than rebuilt once per comment.
 */
let lastNormalized: { raw: string; normalized: NormalizedText } | undefined;

function normalizedDocument(raw: string): NormalizedText {
  if (lastNormalized?.raw !== raw) lastNormalized = { raw, normalized: normalizeWithMap(raw) };
  return lastNormalized.normalized;
}

/** Collapses whitespace runs while remembering where each kept character came from. */
function normalizeWithMap(raw: string): NormalizedText {
  const parts: string[] = [];
  const offsets: number[] = [];
  let runStart = 0;
  let inWhitespace = false;

  for (let index = 0; index < raw.length; index += 1) {
    if (!isWhitespace(raw.charCodeAt(index))) {
      if (inWhitespace) runStart = index;
      inWhitespace = false;
      offsets.push(index);
      continue;
    }

    if (inWhitespace) continue;
    inWhitespace = true;
    parts.push(raw.slice(runStart, index), " ");
    offsets.push(index);
  }

  if (!inWhitespace) parts.push(raw.slice(runStart));

  return { text: parts.join(""), offsets };
}

/** The characters a regular expression's whitespace class matches, tested by code. */
function isWhitespace(code: number): boolean {
  if (code === 32 || (code >= 9 && code <= 13)) return true;
  if (code < 160) return false;
  return (
    code === 160 ||
    code === 0x1680 ||
    (code >= 0x2000 && code <= 0x200a) ||
    code === 0x2028 ||
    code === 0x2029 ||
    code === 0x202f ||
    code === 0x205f ||
    code === 0x3000 ||
    code === 0xfeff
  );
}

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ");
}

function staleAt(documentText: string, anchor: TextAnchor): AnchorResolution {
  const span = clampSpan(documentText, anchor.start, anchor.end);
  return { status: "stale", start: span.start, end: span.end, confidence: 0, strategy: "none" };
}
