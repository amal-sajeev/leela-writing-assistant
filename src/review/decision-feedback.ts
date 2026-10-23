import { normalizeVaultPath, parentFolder } from "../utils/paths";
import type {
  CommentCategory,
  ReviewComment,
  ReviewDecisionExample,
  ReviewDecisionFeedback,
} from "../types";

const EXAMPLES_PER_STATUS = 6;

/** Recognized novels share feedback across their folder; other notes share only their parent folder. */
export function reviewProjectKey(filePath: string, novelFolder: string | null): string {
  if (novelFolder !== null) return `novel:${normalizedKey(novelFolder)}`;
  return `folder:${normalizedKey(parentFolder(filePath))}`;
}

/** Selects compact examples without exposing anchors or manuscript excerpts. */
export function collectReviewDecisionFeedback(
  commentsByNote: ReadonlyMap<string, readonly ReviewComment[]>,
  currentFilePath: string,
  projectKeyForNote: (filePath: string) => string,
  enabledCategories: readonly CommentCategory[],
): ReviewDecisionFeedback | undefined {
  const currentPath = normalizedKey(currentFilePath);
  const currentProject = projectKeyForNote(currentFilePath);
  const enabled = new Set(enabledCategories);
  const candidates: Record<"resolved" | "dismissed", ReviewComment[]> = {
    resolved: [],
    dismissed: [],
  };

  for (const [filePath, comments] of commentsByNote) {
    if (normalizedKey(filePath) === currentPath || projectKeyForNote(filePath) !== currentProject) continue;

    for (const comment of comments) {
      if (
        (comment.status === "resolved" || comment.status === "dismissed") &&
        enabled.has(comment.category)
      ) {
        candidates[comment.status].push(comment);
      }
    }
  }

  const compact = (status: "resolved" | "dismissed"): ReviewDecisionExample[] =>
    candidates[status]
      .sort((left, right) => right.updatedAt - left.updatedAt || right.createdAt - left.createdAt)
      .slice(0, EXAMPLES_PER_STATUS)
      .map(({ category, kind, severity, body, rationale }) => ({
        category,
        ...(kind === undefined ? {} : { kind }),
        severity,
        body: shorten(body, 400),
        ...(rationale === undefined || rationale.trim().length === 0
          ? {}
          : { rationale: shorten(rationale, 240) }),
      }));

  const resolved = compact("resolved");
  const dismissed = compact("dismissed");
  return resolved.length === 0 && dismissed.length === 0 ? undefined : { resolved, dismissed };
}

function normalizedKey(path: string): string {
  return normalizeVaultPath(path).replace(/\/+$/, "").toLocaleLowerCase();
}

function shorten(text: string, maximum: number): string {
  const trimmed = text.trim();
  return trimmed.length <= maximum ? trimmed : `${trimmed.slice(0, maximum - 1).trimEnd()}…`;
}
