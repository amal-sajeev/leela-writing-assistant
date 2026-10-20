import type { ReviewComment } from "../types";
import { normalizeForComparison } from "../utils/text";
import { terms } from "../utils/relevance";

export interface IssueLedgerEntry {
  fingerprint: string;
  evidenceQuote: string;
  category: ReviewComment["category"];
  readerEffect: string;
  confidence: number;
  revisionScope: { start: number; end: number };
  comment: ReviewComment;
}

export function reconcileIssueLedger(comments: readonly ReviewComment[]): {
  comments: ReviewComment[];
  duplicates: number;
} {
  const candidates = comments.map(toLedger).sort(rank);
  const kept: IssueLedgerEntry[] = [];
  let duplicates = 0;

  for (const candidate of candidates) {
    const index = kept.findIndex((entry) => sameIssue(entry, candidate));
    if (index < 0) kept.push(candidate);
    else {
      duplicates += 1;
      if (rank(candidate, kept[index]!) < 0) kept[index] = candidate;
    }
  }

  return { comments: kept.map((entry) => entry.comment), duplicates };
}

function toLedger(comment: ReviewComment): IssueLedgerEntry {
  const evidenceQuote = normalizeForComparison(comment.anchor.quote);
  const readerEffect = comment.rationale?.trim() || comment.body;
  const words = [...new Set(terms(readerEffect))].sort();
  return {
    fingerprint: `${comment.category}:${evidenceQuote}:${words.join(" ")}`,
    evidenceQuote,
    category: comment.category,
    readerEffect,
    confidence: comment.confidence,
    revisionScope: { start: comment.anchor.start, end: comment.anchor.end },
    comment,
  };
}

function sameIssue(left: IssueLedgerEntry, right: IssueLedgerEntry): boolean {
  if (left.category !== right.category) return false;
  if (left.fingerprint === right.fingerprint) return true;
  return tokenOverlap(left.evidenceQuote, right.evidenceQuote) >= 0.5 &&
    tokenOverlap(left.readerEffect, right.readerEffect) >= 0.55;
}

function tokenOverlap(left: string, right: string): number {
  const a = new Set(terms(left));
  const b = new Set(terms(right));
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const word of a) if (b.has(word)) shared += 1;
  return shared / Math.min(a.size, b.size);
}

function rank(left: IssueLedgerEntry, right: IssueLedgerEntry): number {
  const severity = { high: 3, medium: 2, low: 1 } as const;
  return severity[right.comment.severity] - severity[left.comment.severity] ||
    right.confidence - left.confidence ||
    left.revisionScope.start - right.revisionScope.start ||
    left.fingerprint.localeCompare(right.fingerprint);
}
