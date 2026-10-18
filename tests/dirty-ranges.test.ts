import { describe, expect, it } from "vitest";

import {
  addDirtyRange,
  expandToBlocks,
  mapDirtyRanges,
  reviewability,
  selectReviewRange,
  totalLength,
  unionOf,
  type DirtyRange,
} from "../src/review/dirty-ranges";

const PARAGRAPHS = [
  "The first paragraph says something plain and finishes here.",
  "The second paragraph carries the argument a little further along.",
  "The third paragraph ends the note.",
].join("\n\n");

function reviewable(overrides: Partial<Parameters<typeof reviewability>[0]> = {}) {
  return reviewability({
    text: PARAGRAPHS,
    range: { from: 0, to: PARAGRAPHS.indexOf("\n\n") },
    minimumCharacters: 40,
    paragraphCompleted: false,
    includeFencedCode: false,
    ...overrides,
  });
}

describe("addDirtyRange", () => {
  it("keeps a single range as it is", () => {
    expect(addDirtyRange([], { from: 10, to: 20 })).toEqual([{ from: 10, to: 20 }]);
  });

  it("merges ranges closer than the gap", () => {
    const ranges = addDirtyRange([{ from: 0, to: 10 }], { from: 60, to: 70 }, 200);

    expect(ranges).toEqual([{ from: 0, to: 70 }]);
  });

  it("keeps ranges further apart than the gap separate", () => {
    const ranges = addDirtyRange([{ from: 0, to: 10 }], { from: 400, to: 410 }, 200);

    expect(ranges).toEqual([
      { from: 0, to: 10 },
      { from: 400, to: 410 },
    ]);
  });

  it("merges a range that bridges two existing ones", () => {
    const ranges = addDirtyRange(
      [
        { from: 0, to: 10 },
        { from: 500, to: 510 },
      ],
      { from: 200, to: 400 },
      200,
    );

    expect(ranges).toEqual([{ from: 0, to: 510 }]);
  });

  it("orders the result by position however it was given", () => {
    let ranges: DirtyRange[] = [];
    ranges = addDirtyRange(ranges, { from: 900, to: 910 });
    ranges = addDirtyRange(ranges, { from: 10, to: 20 });
    ranges = addDirtyRange(ranges, { from: 500, to: 505 });

    expect(ranges.map((range) => range.from)).toEqual([10, 500, 900]);
  });

  it("accepts a backwards range", () => {
    expect(addDirtyRange([], { from: 30, to: 10 })).toEqual([{ from: 10, to: 30 }]);
  });

  it("treats a caret with no width as a change at that point", () => {
    expect(addDirtyRange([], { from: 5, to: 5 })).toEqual([{ from: 5, to: 5 }]);
  });
});

describe("mapDirtyRanges", () => {
  it("moves ranges onto a newer revision", () => {
    const mapped = mapDirtyRanges([{ from: 10, to: 20 }], (position) => position + 13);

    expect(mapped).toEqual([{ from: 23, to: 33 }]);
  });

  it("drops a range whose text is gone", () => {
    const mapped = mapDirtyRanges([{ from: 10, to: 20 }], (position) => (position > 15 ? 5 : 10));

    expect(mapped).toEqual([]);
  });
});

describe("unionOf and totalLength", () => {
  it("covers every range", () => {
    expect(
      unionOf([
        { from: 40, to: 50 },
        { from: 10, to: 20 },
      ]),
    ).toEqual({ from: 10, to: 50 });
  });

  it("has no union without ranges", () => {
    expect(unionOf([])).toBeNull();
  });

  it("counts only changed characters", () => {
    expect(
      totalLength([
        { from: 0, to: 10 },
        { from: 40, to: 45 },
      ]),
    ).toBe(15);
  });
});

describe("expandToBlocks", () => {
  it("grows a few characters into the whole paragraph", () => {
    const inside = PARAGRAPHS.indexOf("argument");
    const expanded = expandToBlocks(PARAGRAPHS, { from: inside, to: inside + 4 });

    expect(PARAGRAPHS.slice(expanded.from, expanded.to)).toBe(
      "The second paragraph carries the argument a little further along.",
    );
  });

  it("stops at a blank line rather than swallowing the note", () => {
    const expanded = expandToBlocks(PARAGRAPHS, { from: 5, to: 8 });

    expect(expanded.from).toBe(0);
    expect(PARAGRAPHS.slice(expanded.from, expanded.to)).not.toContain("second");
  });

  it("keeps a heading with the section it opens", () => {
    const text = "# First heading\nBody of the first.\n## Second heading\nBody of the second.";
    const inside = text.indexOf("Body of the second");

    const expanded = expandToBlocks(text, { from: inside, to: inside + 4 });

    expect(text.slice(expanded.from, expanded.to)).toBe("Body of the second.");
  });

  it("never reaches back into frontmatter", () => {
    const text = "---\ntitle: Note\n---\nThe body starts here and continues.";
    const bodyStart = text.indexOf("The body");

    const expanded = expandToBlocks(text, { from: bodyStart + 4, to: bodyStart + 8 }, bodyStart);

    expect(expanded.from).toBe(bodyStart);
  });

  it("covers a multi-line paragraph in both directions", () => {
    const text = "One line.\nSecond line of the same paragraph.\nThird line.\n\nNext paragraph.";
    const inside = text.indexOf("Second");

    const expanded = expandToBlocks(text, { from: inside, to: inside + 3 });

    expect(text.slice(expanded.from, expanded.to)).toBe(
      "One line.\nSecond line of the same paragraph.\nThird line.",
    );
  });
});

describe("reviewability", () => {
  it("accepts a finished paragraph", () => {
    expect(reviewable()).toEqual({ ok: true });
  });

  it("refuses whitespace", () => {
    const text = "Words.\n\n   \n\nMore words.";
    expect(
      reviewability({
        text,
        range: { from: 8, to: 11 },
        minimumCharacters: 40,
        paragraphCompleted: false,
        includeFencedCode: false,
      }),
    ).toEqual({ ok: false, reason: "whitespace" });
  });

  it("refuses an empty range", () => {
    expect(reviewable({ range: { from: 5, to: 5 } })).toEqual({ ok: false, reason: "empty" });
  });

  it("refuses a single half-typed word", () => {
    expect(reviewable({ range: { from: 0, to: 3 } })).toEqual({
      ok: false,
      reason: "partial-word",
    });
  });

  it("refuses a passage below the minimum", () => {
    expect(reviewable({ range: { from: 0, to: 12 }, minimumCharacters: 40 })).toEqual({
      ok: false,
      reason: "too-small",
    });
  });

  it("accepts a short passage once the paragraph is finished", () => {
    expect(reviewable({ range: { from: 0, to: 12 }, paragraphCompleted: true })).toEqual({
      ok: true,
    });
  });

  it("refuses frontmatter", () => {
    const text = "---\ntitle: Note\n---\nBody.";
    expect(
      reviewability({
        text,
        range: { from: 4, to: 15 },
        minimumCharacters: 5,
        paragraphCompleted: true,
        includeFencedCode: false,
        bodyStart: 20,
      }),
    ).toEqual({ ok: false, reason: "frontmatter" });
  });

  it("refuses fenced code unless it was asked for", () => {
    const text = "Intro paragraph.\n\n```js\nconst x = somethingLongEnoughToPass();\n```\n";
    const inside = text.indexOf("const");
    const range = { from: inside, to: inside + 30 };

    expect(
      reviewability({
        text,
        range,
        minimumCharacters: 10,
        paragraphCompleted: true,
        includeFencedCode: false,
      }),
    ).toEqual({ ok: false, reason: "fenced-code" });

    expect(
      reviewability({
        text,
        range,
        minimumCharacters: 10,
        paragraphCompleted: true,
        includeFencedCode: true,
      }),
    ).toEqual({ ok: true });
  });

  it("reviews prose after a closed code block", () => {
    const text = "```js\nconst x = 1;\n```\n\nProse after the block, long enough to review.";
    const inside = text.indexOf("Prose");

    expect(
      reviewability({
        text,
        range: { from: inside, to: text.length },
        minimumCharacters: 10,
        paragraphCompleted: false,
        includeFencedCode: false,
      }),
    ).toEqual({ ok: true });
  });
});

describe("selectReviewRange", () => {
  it("has nothing to review without dirty ranges", () => {
    expect(
      selectReviewRange({ text: PARAGRAPHS, ranges: [], maximumCharacters: 6000 }),
    ).toBeNull();
  });

  it("reviews scattered edits together while they fit", () => {
    const first = PARAGRAPHS.indexOf("first");
    const third = PARAGRAPHS.indexOf("third");

    const range = selectReviewRange({
      text: PARAGRAPHS,
      ranges: [
        { from: first, to: first + 5 },
        { from: third, to: third + 5 },
      ],
      maximumCharacters: 6000,
    });

    expect(range).toEqual({ from: 0, to: PARAGRAPHS.length });
  });

  it("falls back to the passage edited last when the union is too large", () => {
    const first = PARAGRAPHS.indexOf("first");
    const third = PARAGRAPHS.indexOf("third");
    const preferred = { from: third, to: third + 5 };

    const range = selectReviewRange({
      text: PARAGRAPHS,
      ranges: [{ from: first, to: first + 5 }, preferred],
      maximumCharacters: 80,
      preferred,
    });

    expect(PARAGRAPHS.slice(range!.from, range!.to)).toBe("The third paragraph ends the note.");
  });

  it("reviews the end of a paragraph that is over the budget on its own", () => {
    const text = "a".repeat(500);

    const range = selectReviewRange({
      text,
      ranges: [{ from: 400, to: 500 }],
      maximumCharacters: 200,
    });

    expect(range).toEqual({ from: 300, to: 500 });
  });
});
