import { describe, expect, it } from "vitest";

import { anchorAt, clampSpan, createAnchor } from "../src/comments/anchor";
import { ANCHOR_CONTEXT_CHARACTERS } from "../src/constants";
import { hashAnchorContext } from "../src/utils/hash";

describe("createAnchor", () => {
  it("stores the quote with its surrounding context", () => {
    const text = "The claim is bold. Studies show it works. Nobody disagrees.";
    const start = text.indexOf("Studies show it works.");
    const anchor = createAnchor(text, start, start + "Studies show it works.".length);

    expect(anchor.quote).toBe("Studies show it works.");
    expect(anchor.prefix).toBe("The claim is bold. ");
    expect(anchor.suffix).toBe(" Nobody disagrees.");
    expect(anchor.start).toBe(start);
    expect(anchor.contextHash).toBe(
      hashAnchorContext(anchor.prefix, anchor.quote, anchor.suffix),
    );
  });

  it("bounds context to the configured number of characters", () => {
    const filler = "a".repeat(500);
    const text = `${filler}QUOTE${filler}`;
    const anchor = createAnchor(text, 500, 505);

    expect(anchor.prefix).toHaveLength(ANCHOR_CONTEXT_CHARACTERS);
    expect(anchor.suffix).toHaveLength(ANCHOR_CONTEXT_CHARACTERS);
  });

  it("accepts anchors at the very start and end of a document", () => {
    const text = "Opening line.";
    const first = createAnchor(text, 0, 7);
    const last = createAnchor(text, 8, text.length);

    expect(first.prefix).toBe("");
    expect(first.quote).toBe("Opening");
    expect(last.suffix).toBe("");
    expect(last.quote).toBe("line.");
  });

  it("never splits a surrogate pair", () => {
    const text = "before 👍👍 after";
    const anchor = createAnchor(text, 8, 10);

    expect(anchor.quote).toBe("👍👍");
    expect([...anchor.quote]).toHaveLength(2);
  });

  it("normalizes reversed and out-of-range offsets", () => {
    const text = "Short note.";
    const anchor = createAnchor(text, 99, 6);

    expect(anchor.start).toBe(6);
    expect(anchor.end).toBe(text.length);
    expect(anchor.quote).toBe("note.");
  });
});

describe("clampSpan", () => {
  it("keeps a valid span untouched", () => {
    expect(clampSpan("abcdef", 1, 4)).toEqual({ start: 1, end: 4 });
  });

  it("pulls offsets inside the document", () => {
    expect(clampSpan("abc", -5, 90)).toEqual({ start: 0, end: 3 });
  });
});

describe("anchorAt", () => {
  it("returns the same object when the offsets did not move", () => {
    const anchor = createAnchor("Quoted text here.", 0, 6);
    expect(anchorAt(anchor, 0, 6)).toBe(anchor);
  });

  it("keeps the original context evidence when offsets move", () => {
    const anchor = createAnchor("Quoted text here.", 0, 6);
    const moved = anchorAt(anchor, 10, 16);

    expect(moved.start).toBe(10);
    expect(moved.prefix).toBe(anchor.prefix);
    expect(moved.contextHash).toBe(anchor.contextHash);
  });
});
