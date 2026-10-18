import type { CommentSeverity, CommentStatus, ReviewComment } from "../types";
import { anchorAt } from "./anchor";
import type { AnchorResolution } from "./anchor-resolver";

/**
 * Comment lifecycle rules, kept pure so both the editor and the panel can agree
 * on what a comment currently is (specification sections 18 to 20).
 */

/** Where a comment belongs in the panel. Dismissed comments are shown nowhere. */
export type PanelGroup = "open" | "stale" | "resolved" | "hidden";

const SEVERITY_RANK: Record<CommentSeverity, number> = { high: 3, medium: 2, low: 1 };

/**
 * Moves a comment onto its newly resolved position.
 *
 * A lost anchor makes an open comment stale rather than deleting it, and a
 * recovered anchor makes a stale comment open again: undoing a deletion should
 * bring the criticism back. Comments the author already dealt with keep their
 * status and only follow the text.
 */
export function applyResolution(comment: ReviewComment, resolution: AnchorResolution): ReviewComment {
  const status = nextStatus(comment.status, resolution.status);
  const anchor = anchorAt(comment.anchor, resolution.start, resolution.end);

  if (status === comment.status && anchor === comment.anchor) return comment;

  // Following the text is not a change to the comment: only a change of status
  // is something the author would recognise as it having been updated.
  const updatedAt = status === comment.status ? comment.updatedAt : Date.now();

  return { ...comment, anchor, status, updatedAt };
}

function nextStatus(current: CommentStatus, resolved: AnchorResolution["status"]): CommentStatus {
  if (current === "open" && resolved === "stale") return "stale";
  if (current === "stale" && resolved === "resolved") return "open";
  return current;
}

export function withStatus(comment: ReviewComment, status: CommentStatus): ReviewComment {
  if (comment.status === status) return comment;
  return { ...comment, status, updatedAt: Date.now() };
}

/**
 * Only open comments are decorated. Resolved comments disappear from the editor
 * and stale ones have nowhere to be drawn (specification section 19).
 */
export function isEditorVisible(comment: ReviewComment): boolean {
  return comment.status === "open";
}

/**
 * A point the author has already dealt with, by fixing it or by deciding it was
 * not a problem. Raising it again is noise (specification sections 30 and 100).
 */
export function isSettled(comment: ReviewComment): boolean {
  return comment.status === "resolved" || comment.status === "dismissed";
}

export function panelGroup(comment: ReviewComment): PanelGroup {
  switch (comment.status) {
    case "open":
      return "open";
    case "stale":
      return "stale";
    case "resolved":
      return "resolved";
    case "dismissed":
      return "hidden";
  }
}

export function countOpen(comments: readonly ReviewComment[]): number {
  // A strength asks nothing of the author, so it is not counted as outstanding.
  return comments.reduce(
    (total, comment) =>
      comment.status === "open" && comment.category !== "strength" ? total + 1 : total,
    0,
  );
}

/**
 * Document order, with the more severe comment first when two start together, so
 * the panel reads top to bottom like the note does.
 */
export function byDocumentPosition(a: ReviewComment, b: ReviewComment): number {
  if (a.anchor.start !== b.anchor.start) return a.anchor.start - b.anchor.start;

  const bySeverity = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
  return bySeverity === 0 ? a.createdAt - b.createdAt : bySeverity;
}
