import { describe, expect, it } from "vitest";

import {
  filterComments,
  findQuoteSpan,
  isPraiseOnly,
  isRestatement,
  type CommentFilterOptions,
} from "../src/review/comment-filter";
import { COMMENT_CATEGORIES, type ProposedComment } from "../src/types";

const REVIEWED_TEXT =
  "The study of twelve participants proves that retrieval augmented generation is always more accurate. " +
  "We therefore recommend it for every deployment.";

function options(overrides: Partial<CommentFilterOptions> = {}): CommentFilterOptions {
  return {
    reviewedText: REVIEWED_TEXT,
    enabledCategories: [...COMMENT_CATEGORIES],
    minimumConfidence: 0.5,
    maxComments: 3,
    ...overrides,
  };
}

function comment(overrides: Partial<ProposedComment> = {}): ProposedComment {
  return {
    quote: "always more accurate",
    category: "reasoning",
    severity: "high",
    confidence: 0.9,
    body: "Twelve participants cannot support a universal claim; soften it or cite more evidence.",
    ...overrides,
  };
}

describe("filterComments", () => {
  it("accepts a well-formed comment and records where the quote sits", () => {
    const { accepted, rejected } = filterComments([comment()], options());

    expect(rejected).toHaveLength(0);
    expect(accepted).toHaveLength(1);
    expect(REVIEWED_TEXT.slice(accepted[0]!.quoteStart, accepted[0]!.quoteEnd)).toBe(
      "always more accurate",
    );
  });

  it("rejects a quote that is not in the reviewed text", () => {
    const { accepted, rejected } = filterComments(
      [comment({ quote: "a sentence the author never wrote" })],
      options(),
    );

    expect(accepted).toHaveLength(0);
    expect(rejected[0]?.reason).toBe("quote-not-found");
  });

  it("recovers a quote whose whitespace the model normalized", () => {
    const text = "The claim is\nspread across two lines.";
    const { accepted } = filterComments([comment({ quote: "claim is spread across" })], options({ reviewedText: text }));

    expect(accepted).toHaveLength(1);
    // The document's exact text wins, so later anchoring can find it.
    expect(accepted[0]?.quote).toBe("claim is\nspread across");
  });

  it("drops comments below the confidence floor for the current sensitivity", () => {
    const { accepted, rejected } = filterComments(
      [comment({ confidence: 0.3 })],
      options({ minimumConfidence: 0.6 }),
    );

    expect(accepted).toHaveLength(0);
    expect(rejected[0]?.reason).toBe("low-confidence");
  });

  it("drops categories the reviewer has turned off", () => {
    const { rejected } = filterComments(
      [comment({ category: "style" })],
      options({ enabledCategories: ["reasoning", "evidence"] }),
    );

    expect(rejected[0]?.reason).toBe("disabled-category");
  });

  it("drops a second comment making the same point about the same text", () => {
    const { accepted, rejected } = filterComments([comment(), comment()], options());

    expect(accepted).toHaveLength(1);
    expect(rejected[0]?.reason).toBe("duplicate");
  });

  it("drops a point the author already has a comment about", () => {
    const existing = [{ quote: "always more accurate", body: comment().body }];
    const { accepted, rejected } = filterComments([comment()], options({ existingComments: existing }));

    expect(accepted).toHaveLength(0);
    expect(rejected[0]?.reason).toBe("duplicate");
  });

  it("drops a point the author dismissed, however it is worded this time", () => {
    const settled = [
      { quote: "always more accurate", body: "Twelve participants is a thin basis.", category: "reasoning" as const },
    ];

    const { accepted, rejected } = filterComments(
      [comment({ body: "This generalizes far beyond what the sample can carry." })],
      options({ settledComments: settled }),
    );

    expect(accepted).toHaveLength(0);
    expect(rejected[0]?.reason).toBe("settled");
  });

  it("still allows a different kind of objection to a settled passage", () => {
    const settled = [
      { quote: "always more accurate", body: "Twelve participants is a thin basis.", category: "reasoning" as const },
    ];

    const { accepted } = filterComments(
      [comment({ category: "clarity", body: "\"Accurate\" is undefined here; accurate at what?" })],
      options({ settledComments: settled }),
    );

    expect(accepted).toHaveLength(1);
  });

  it("drops praise, which is not criticism", () => {
    const { rejected } = filterComments(
      [comment({ body: "This is a very clear and compelling summary." })],
      options(),
    );

    expect(rejected[0]?.reason).toBe("praise");
  });

  it("drops a body that only restates the quote", () => {
    const { rejected } = filterComments(
      [comment({ quote: "always more accurate", body: "Always more accurate." })],
      options(),
    );

    expect(rejected[0]?.reason).toBe("restatement");
  });

  it("drops a quote that covers most of the passage", () => {
    const longText = "x".repeat(2000);
    const { rejected } = filterComments(
      [comment({ quote: "x".repeat(1500) })],
      options({ reviewedText: longText }),
    );

    expect(rejected[0]?.reason).toBe("quote-too-broad");
  });

  it("keeps the most severe and most confident comments when over the limit", () => {
    const comments = [
      comment({ quote: "twelve participants", severity: "low", confidence: 0.6 }),
      comment({ quote: "always more accurate", severity: "high", confidence: 0.8 }),
      comment({ quote: "every deployment", severity: "medium", confidence: 0.95 }),
    ];

    const { accepted, rejected } = filterComments(comments, options({ maxComments: 2 }));

    expect(accepted.map((entry) => entry.severity)).toEqual(["high", "medium"]);
    expect(rejected).toEqual([expect.objectContaining({ reason: "over-limit" })]);
  });
});

describe("quality predicates", () => {
  it("treats praise with a criticism as criticism", () => {
    expect(isPraiseOnly("This is clear, but the second claim is unsupported.")).toBe(false);
    expect(isPraiseOnly("Excellent work here.")).toBe(true);
  });

  it("recognizes a body that adds nothing to the quote", () => {
    expect(isRestatement("always more accurate", "Always more accurate")).toBe(true);
    expect(isRestatement("always more accurate", "This overstates what one study can show.")).toBe(false);
  });
});

describe("findQuoteSpan", () => {
  it("prefers an exact match", () => {
    expect(findQuoteSpan("alpha beta gamma", "beta")).toEqual({ start: 6, end: 10 });
  });

  it("returns nothing when the text differs by more than whitespace", () => {
    expect(findQuoteSpan("alpha beta gamma", "beta delta")).toBeUndefined();
  });

  it("does not treat a quote as a regular expression", () => {
    expect(findQuoteSpan("costs (roughly) $5.00", "(roughly) $5.00")).toEqual({ start: 6, end: 21 });
  });
});
