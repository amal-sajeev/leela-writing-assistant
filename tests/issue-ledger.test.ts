import { describe, expect, it } from "vitest";

import { reconcileIssueLedger } from "../src/review/issue-ledger";
import type { ReviewComment } from "../src/types";

function comment({ id, ...overrides }: Partial<ReviewComment> & { id: string }): ReviewComment {
  return {
    id,
    filePath: "Chapter.md",
    reviewerId: "lyra",
    category: "continuity",
    severity: "medium",
    confidence: 0.8,
    anchor: {
      quote: "The door was already locked",
      prefix: "",
      suffix: "",
      start: 10,
      end: 37,
      contextHash: "hash",
    },
    body: "This creates a mismatch for the reader.",
    status: "open",
    createdAt: 1,
    updatedAt: 1,
    sourceRevisionHash: "revision",
    thread: [],
    ...overrides,
  };
}

describe("issue ledger", () => {
  it("merges repeated root causes and keeps the stronger finding", () => {
    const first = comment({ id: "first", rationale: "The lock state changes without an explanation." });
    const second = comment({
      id: "second",
      severity: "high",
      confidence: 0.9,
      anchor: { ...first.anchor, quote: "door was already locked", start: 12, end: 36 },
      rationale: "The lock state changes without an explanation, so the reader cannot follow the action.",
    });

    const result = reconcileIssueLedger([first, second]);
    expect(result.comments.map((entry) => entry.id)).toEqual(["second"]);
    expect(result.duplicates).toBe(1);
  });

  it("keeps independent findings on the same quote", () => {
    const cause = comment({ id: "cause", rationale: "The lock state changes without an explanation." });
    const viewpoint = comment({
      id: "viewpoint",
      category: "pov",
      rationale: "The viewpoint character cannot know what happens in another room.",
    });

    expect(reconcileIssueLedger([cause, viewpoint]).comments).toHaveLength(2);
  });

  it("keeps same-category issues when their effects differ", () => {
    const cause = comment({ id: "cause", rationale: "The lock state changes without an explanation." });
    const chronology = comment({
      id: "chronology",
      rationale: "The event occurs before the character arrives at the station.",
    });

    expect(reconcileIssueLedger([cause, chronology]).comments).toHaveLength(2);
  });
});
