import { describe, expect, it } from "vitest";

import { createAnchor } from "../src/comments/anchor";
import {
  collectReviewDecisionFeedback,
  reviewProjectKey,
} from "../src/review/decision-feedback";
import type { ReviewComment } from "../src/types";

const OLD_PASSAGE = "This old manuscript excerpt must never be sent as feedback context.";

function comment(
  filePath: string,
  id: string,
  overrides: Partial<ReviewComment> = {},
): ReviewComment {
  return {
    id,
    filePath,
    reviewerId: "lyra",
    category: "prose",
    kind: "craft",
    severity: "medium",
    confidence: 0.8,
    anchor: createAnchor(OLD_PASSAGE, 0, 9),
    body: `Summary ${id}`,
    rationale: `Rationale ${id}`,
    status: "resolved",
    createdAt: 1,
    updatedAt: 1,
    sourceRevisionHash: "revision",
    thread: [],
    ...overrides,
  };
}

describe("review decision feedback", () => {
  it("groups recognized novels by novel folder and ordinary notes by containing folder", () => {
    expect(reviewProjectKey("Novel/Chapters/Chapter 2.md", "Novel")).toBe(
      reviewProjectKey("Novel/People/Mara.md", "Novel"),
    );
    expect(reviewProjectKey("Novel/Chapter.md", "Novel")).not.toBe(
      reviewProjectKey("Other Novel/Chapter.md", "Other Novel"),
    );
    expect(reviewProjectKey("Drafts/Current.md", null)).toBe(reviewProjectKey("Drafts/Older.md", null));
    expect(reviewProjectKey("Drafts/Current.md", null)).not.toBe(reviewProjectKey("Drafts/Scenes/Older.md", null));
    expect(reviewProjectKey("Drafts\\Current.md", null)).toBe(reviewProjectKey("drafts/Older.md", null));
  });

  it("selects recent resolved and dismissed examples separately, from other notes and enabled categories only", () => {
    const resolved = Array.from({ length: 8 }, (_, index) =>
      comment("Novel/Chapter 1.md", `resolved-${index}`, { updatedAt: index + 1 }),
    );
    const dismissed = Array.from({ length: 8 }, (_, index) =>
      comment("Novel/Chapter 2.md", `dismissed-${index}`, {
        status: "dismissed",
        updatedAt: index + 11,
      }),
    );
    const commentsByNote = new Map<string, readonly ReviewComment[]>([
      ["Novel/Current.md", [comment("Novel/Current.md", "same-note")]],
      ["Novel/Chapter 1.md", [
        ...resolved,
        comment("Novel/Chapter 1.md", "disabled-category", {
          category: "strength",
          updatedAt: 100,
        }),
        comment("Novel/Chapter 1.md", "still-open", { status: "open", updatedAt: 101 }),
        comment("Novel/Chapter 1.md", "stale", { status: "stale", updatedAt: 102 }),
      ]],
      ["Novel/Chapter 2.md", dismissed],
      ["Elsewhere/Chapter.md", [comment("Elsewhere/Chapter.md", "other-project", { updatedAt: 200 })]],
    ]);
    const projectKeyForNote = (path: string) =>
      reviewProjectKey(path, path.toLocaleLowerCase().startsWith("novel/") ? "Novel" : null);

    const feedback = collectReviewDecisionFeedback(
      commentsByNote,
      "Novel/Current.md",
      projectKeyForNote,
      ["prose"],
    );

    expect(feedback?.resolved.map((entry) => entry.body)).toEqual(
      [7, 6, 5, 4, 3, 2].map((index) => `Summary resolved-${index}`),
    );
    expect(feedback?.dismissed.map((entry) => entry.body)).toEqual(
      [7, 6, 5, 4, 3, 2].map((index) => `Summary dismissed-${index}`),
    );
    expect(feedback?.resolved).toHaveLength(6);
    expect(feedback?.dismissed).toHaveLength(6);
    expect(feedback?.resolved[0]).toEqual({
      category: "prose",
      kind: "craft",
      severity: "medium",
      body: "Summary resolved-7",
      rationale: "Rationale resolved-7",
    });
    expect(JSON.stringify(feedback)).not.toContain(OLD_PASSAGE);
    expect(JSON.stringify(feedback)).not.toContain("same-note");
    expect(JSON.stringify(feedback)).not.toContain("disabled-category");
  });

  it("returns no examples when the group has no eligible decisions", () => {
    const comments = new Map<string, readonly ReviewComment[]>([
      ["Drafts/Current.md", [comment("Drafts/Current.md", "self")]],
      ["Drafts/Other.md", [comment("Drafts/Other.md", "disabled", { category: "strength" })]],
    ]);

    expect(
      collectReviewDecisionFeedback(comments, "Drafts/Current.md", (path) => reviewProjectKey(path, null), ["prose"]),
    ).toBeUndefined();
  });
});
