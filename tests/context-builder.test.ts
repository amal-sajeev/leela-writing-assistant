import { describe, expect, it } from "vitest";

import {
  buildSelectionContext,
  headingPath,
  type ContextBudget,
  type HeadingEntry,
} from "../src/context/context-builder";

const BUDGET: ContextBudget = {
  beforeCharacters: 100,
  afterCharacters: 100,
  includeWholeNoteForShortNotes: false,
  shortNoteThreshold: 0,
};

describe("buildSelectionContext", () => {
  it("returns the exact selection as the reviewed text", () => {
    const text = "One. Two. Three.";
    const context = buildSelectionContext({
      documentText: text,
      selectionStart: 5,
      selectionEnd: 9,
      budget: BUDGET,
    });

    expect(context.changedText).toBe("Two.");
    expect(context.changedStart).toBe(5);
    expect(context.changedEnd).toBe(9);
  });

  it("bounds surrounding context to the configured budget", () => {
    const before = "b".repeat(500);
    const after = "a".repeat(500);
    const context = buildSelectionContext({
      documentText: `${before}SELECTED${after}`,
      selectionStart: before.length,
      selectionEnd: before.length + "SELECTED".length,
      budget: { ...BUDGET, beforeCharacters: 50, afterCharacters: 20 },
    });

    expect(context.changedText).toBe("SELECTED");
    expect(context.beforeContext.length).toBeLessThanOrEqual(50);
    expect(context.afterContext.length).toBeLessThanOrEqual(20);
  });

  it("sends the whole note when it is short and that option is on", () => {
    const text = "Alpha beta. Gamma delta. Epsilon.";
    const context = buildSelectionContext({
      documentText: text,
      selectionStart: 12,
      selectionEnd: 24,
      budget: {
        beforeCharacters: 5,
        afterCharacters: 5,
        includeWholeNoteForShortNotes: true,
        shortNoteThreshold: 1000,
      },
    });

    expect(context.beforeContext).toBe("Alpha beta. ");
    expect(context.afterContext).toBe(" Epsilon.");
  });

  it("never sends frontmatter as context", () => {
    const frontmatter = "---\ntitle: Secret\napi-key: sk-do-not-send\n---\n";
    const body = "The visible body text continues here.";
    const context = buildSelectionContext({
      documentText: `${frontmatter}${body}`,
      selectionStart: frontmatter.length + 4,
      selectionEnd: frontmatter.length + 11,
      bodyStart: frontmatter.length,
      budget: { ...BUDGET, beforeCharacters: 500, afterCharacters: 500 },
    });

    expect(context.changedText).toBe("visible");
    expect(context.beforeContext).not.toContain("sk-do-not-send");
    expect(context.beforeContext).toBe("The ");
  });

  it("handles a selection given backwards, at the start, and past the end", () => {
    const text = "Alpha beta gamma";

    const backwards = buildSelectionContext({
      documentText: text,
      selectionStart: 10,
      selectionEnd: 6,
      budget: BUDGET,
    });
    expect(backwards.changedText).toBe("beta");

    const atStart = buildSelectionContext({
      documentText: text,
      selectionStart: 0,
      selectionEnd: 5,
      budget: BUDGET,
    });
    expect(atStart.beforeContext).toBe("");

    const pastEnd = buildSelectionContext({
      documentText: text,
      selectionStart: 11,
      selectionEnd: 9_999,
      budget: BUDGET,
    });
    expect(pastEnd.changedText).toBe("gamma");
    expect(pastEnd.afterContext).toBe("");
  });

  it("reports the heading trail containing the selection", () => {
    const text = "# Paper\n\n## Method\n\nWe sampled twelve people.\n\n## Results\n\nAll good.";
    const headings: HeadingEntry[] = [
      { level: 1, heading: "Paper", offset: 0 },
      { level: 2, heading: "Method", offset: 9 },
      { level: 2, heading: "Results", offset: 47 },
    ];

    const context = buildSelectionContext({
      documentText: text,
      selectionStart: 20,
      selectionEnd: 45,
      headings,
      budget: BUDGET,
    });

    expect(context.headingPath).toEqual(["Paper", "Method"]);
  });
});

describe("headingPath", () => {
  const headings: HeadingEntry[] = [
    { level: 1, heading: "Book", offset: 0 },
    { level: 2, heading: "Chapter", offset: 10 },
    { level: 3, heading: "Scene", offset: 20 },
    { level: 2, heading: "Next chapter", offset: 30 },
  ];

  it("nests deeper headings", () => {
    expect(headingPath(headings, 25)).toEqual(["Book", "Chapter", "Scene"]);
  });

  it("replaces siblings instead of accumulating them", () => {
    expect(headingPath(headings, 35)).toEqual(["Book", "Next chapter"]);
  });

  it("is empty before the first heading", () => {
    expect(headingPath(headings, 0)).toEqual(["Book"]);
    expect(headingPath([], 5)).toEqual([]);
  });
});
