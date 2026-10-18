import type { CommentCategory, CommentSeverity, ProposedComment } from "../types";
import { normalizeForComparison } from "../utils/text";

/**
 * Quality gate between the model and the editor (specification section 39).
 *
 * Every proposed comment must earn its place: it has to point at text that
 * actually exists, say something the author does not already know, and clear the
 * confidence bar for the current sensitivity. Comments that fail are dropped with
 * a reason so the rejection rate stays observable.
 */

export const REJECTION_REASONS = [
  "quote-not-found",
  "quote-too-broad",
  "low-confidence",
  "disabled-category",
  "duplicate",
  "settled",
  "praise",
  "restatement",
  "taste",
  "over-limit",
] as const;
export type RejectionReason = (typeof REJECTION_REASONS)[number];

/** A comment whose quote has been matched to an exact span of the reviewed text. */
export interface LocatedComment extends ProposedComment {
  /** Offset of the quote within the reviewed text. */
  quoteStart: number;
  quoteEnd: number;
}

export interface ExistingCommentSummary {
  quote: string;
  body: string;
  category?: CommentCategory;
}

export interface CommentFilterOptions {
  reviewedText: string;
  enabledCategories: readonly CommentCategory[];
  minimumConfidence: number;
  maxComments: number;
  existingComments?: readonly ExistingCommentSummary[];
  /**
   * Points the author has already resolved or dismissed. Raising one of these
   * again is the fastest way to become noise (specification sections 30 and 100).
   */
  settledComments?: readonly ExistingCommentSummary[];
  /**
   * False drops findings the model itself called a matter of taste. A reader
   * asked to speak only about serious problems should not be raising questions
   * about choices that may be deliberate.
   */
  allowTaste?: boolean;
}

export interface FilterOutcome {
  accepted: LocatedComment[];
  rejected: Array<{ comment: ProposedComment; reason: RejectionReason }>;
}

const SEVERITY_RANK: Record<CommentSeverity, number> = { high: 3, medium: 2, low: 1 };

/** Compliments kept from one review. */
const MAX_STRENGTHS = 1;

/**
 * Body that only compliments the passage. Praise is not criticism and the author
 * did not ask for it (specification section 39).
 */
const PRAISE_OPENING =
  /^(?:this|that|it|the \w+)?\s*(?:is|reads|looks|feels|works)?\s*(?:a|an|the)?\s*(?:very|really|quite|nicely|well|especially|extremely)?\s*(?:great|excellent|good|strong|clear|clean|nice|solid|effective|compelling|concise|well[- ]written|well[- ]structured|elegant)\b/i;

/** Any hint that the comment identifies a problem or asks for a change. */
const PROBLEM_HINT =
  /\b(but|however|although|unclear|vague|missing|contradict\w*|inconsist\w*|assum\w*|unsupported|ambiguous|confus\w*|instead|consider|why|weak\w*|overstat\w*|understat\w*|repeat\w*|redundant|wrong|incorrect|imprecise|needs?|lacks?|should|could|fails?|risks?|buried|jargon|circular|conflat\w*|undefined)\b/i;

export function filterComments(
  comments: readonly ProposedComment[],
  options: CommentFilterOptions,
): FilterOutcome {
  const accepted: LocatedComment[] = [];
  const rejected: FilterOutcome["rejected"] = [];

  // Two levels of de-duplication: within this response, and against comments the
  // author already has on the passage.
  const seen = new Set<string>();
  const existing = new Set(
    (options.existingComments ?? []).map((comment) => topicKey(comment.quote, comment.body)),
  );

  // A settled point is matched by passage and category rather than by wording:
  // the author dismissed the objection, not one phrasing of it.
  const settled = new Set(
    (options.settledComments ?? []).map((comment) => settledKey(comment.quote, comment.category)),
  );

  const quoteLimit = maximumQuoteLength(options.reviewedText);
  let strengths = 0;

  for (const comment of comments) {
    const reason = staticRejection(comment, options, quoteLimit);
    if (reason !== undefined) {
      rejected.push({ comment, reason });
      continue;
    }

    const span = findQuoteSpan(options.reviewedText, comment.quote);
    if (span === undefined) {
      rejected.push({ comment, reason: "quote-not-found" });
      continue;
    }

    // Adopt the document's exact text, so later anchoring works even when the
    // model normalized whitespace inside the quote.
    const exactQuote = options.reviewedText.slice(span.start, span.end);

    if (
      settled.has(settledKey(exactQuote, comment.category)) ||
      settled.has(settledKey(exactQuote, undefined))
    ) {
      rejected.push({ comment, reason: "settled" });
      continue;
    }

    const key = `${comment.category}::${topicKey(exactQuote, comment.body)}`;
    if (seen.has(key) || existing.has(topicKey(exactQuote, comment.body))) {
      rejected.push({ comment, reason: "duplicate" });
      continue;
    }
    seen.add(key);

    // One compliment a review, so that getting one still means something.
    if (comment.category === "strength") {
      if (strengths >= MAX_STRENGTHS) {
        rejected.push({ comment, reason: "over-limit" });
        continue;
      }
      strengths += 1;
    }

    accepted.push({
      ...comment,
      // Nothing is wrong, so nothing is severe: it must never outrank a problem.
      ...(comment.category === "strength" ? { severity: "low" as const } : {}),
      quote: exactQuote,
      quoteStart: span.start,
      quoteEnd: span.end,
    });
  }

  accepted.sort(byImportance);

  const kept = accepted.slice(0, Math.max(0, options.maxComments));
  for (const extra of accepted.slice(kept.length)) {
    rejected.push({ comment: extra, reason: "over-limit" });
  }

  return { accepted: kept, rejected };
}

function staticRejection(
  comment: ProposedComment,
  options: CommentFilterOptions,
  quoteLimit: number,
): RejectionReason | undefined {
  if (!options.enabledCategories.includes(comment.category)) return "disabled-category";
  if (comment.confidence < options.minimumConfidence) return "low-confidence";
  if (comment.quote.trim().length > quoteLimit) return "quote-too-broad";
  if (options.allowTaste === false && comment.kind === "taste") return "taste";
  // Praise is welcome under its own name, where the reviewer allows it. Anywhere
  // else it is a compliment dressed as a criticism, and is dropped as before.
  if (comment.category !== "strength" && isPraiseOnly(comment.body)) return "praise";
  if (isRestatement(comment.quote, comment.body)) return "restatement";
  return undefined;
}

/**
 * A quote should locate a problem, not re-send the passage. Short selections are
 * exempt, since there the whole selection may be the smallest useful span.
 */
function maximumQuoteLength(reviewedText: string): number {
  return Math.max(400, Math.floor(reviewedText.length * 0.6));
}

export function isPraiseOnly(body: string): boolean {
  const text = body.trim();
  return PRAISE_OPENING.test(text) && !PROBLEM_HINT.test(text);
}

/** A body that merely echoes the quote tells the author nothing. */
export function isRestatement(quote: string, body: string): boolean {
  const normalizedQuote = normalizeForComparison(quote);
  const normalizedBody = normalizeForComparison(body);
  if (normalizedQuote.length === 0) return false;

  if (normalizedBody === normalizedQuote) return true;
  return normalizedBody.includes(normalizedQuote) && normalizedBody.length <= normalizedQuote.length + 40;
}

/**
 * Locates the quote in the reviewed text, tolerating differences in whitespace
 * only. Any other mismatch means the model did not quote the document.
 */
export function findQuoteSpan(
  reviewedText: string,
  quote: string,
): { start: number; end: number } | undefined {
  const trimmed = quote.trim();
  if (trimmed.length === 0) return undefined;

  const direct = reviewedText.indexOf(trimmed);
  if (direct >= 0) return { start: direct, end: direct + trimmed.length };

  const flexible = new RegExp(trimmed.split(/\s+/).map(escapeRegExp).join("\\s+"));
  const match = flexible.exec(reviewedText);
  return match === null ? undefined : { start: match.index, end: match.index + match[0].length };
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Identity of "the same point about the same text". The body prefix is enough:
 * two comments that open identically about one quote are the same complaint.
 */
function topicKey(quote: string, body: string): string {
  return `${normalizeForComparison(quote)}::${normalizeForComparison(body).slice(0, 60)}`;
}

/** Identity of "this objection about this passage", regardless of how it is put. */
function settledKey(quote: string, category: CommentCategory | undefined): string {
  return `${category ?? "any"}::${normalizeForComparison(quote)}`;
}

function byImportance(a: LocatedComment, b: LocatedComment): number {
  // Problems first: when the limit bites, it is the compliment that goes.
  const byKind = Number(a.category === "strength") - Number(b.category === "strength");
  if (byKind !== 0) return byKind;

  const bySeverity = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
  if (bySeverity !== 0) return bySeverity;

  const byConfidence = b.confidence - a.confidence;
  if (byConfidence !== 0) return byConfidence;

  return a.quoteStart - b.quoteStart;
}
