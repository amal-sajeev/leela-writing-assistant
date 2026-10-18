import { describe, expect, it } from "vitest";

import { createAnchor, anchorAt } from "../src/comments/anchor";
import { resolveAnchor } from "../src/comments/anchor-resolver";
import { ANCHOR_MIN_CONFIDENCE } from "../src/constants";

const QUOTE = "Studies show that readers skim.";

const DOCUMENT = [
  "# Chapter",
  "",
  `The evidence is thin. ${QUOTE} Therefore we must simplify.`,
  "",
  "A closing paragraph.",
].join("\n");

/** An anchor on the sentence under review, as a real review would create it. */
function anchorOnQuote(text = DOCUMENT, quote = QUOTE) {
  const start = text.indexOf(quote);
  expect(start).toBeGreaterThanOrEqual(0);
  return createAnchor(text, start, start + quote.length);
}

describe("resolveAnchor", () => {
  it("uses the stored offsets when the text there is unchanged", () => {
    const anchor = anchorOnQuote();
    const resolution = resolveAnchor(DOCUMENT, anchor);

    expect(resolution).toEqual({
      status: "resolved",
      start: anchor.start,
      end: anchor.end,
      confidence: 1,
      strategy: "offset",
    });
  });

  it("recovers after text is inserted before the anchor", () => {
    const anchor = anchorOnQuote();
    const edited = `A brand new opening paragraph appears first.\n\n${DOCUMENT}`;
    const resolution = resolveAnchor(edited, anchor);

    expect(resolution.status).toBe("resolved");
    expect(edited.slice(resolution.start, resolution.end)).toBe(QUOTE);
    expect(resolution.confidence).toBeGreaterThan(0.9);
  });

  it("recovers after text is deleted before the anchor", () => {
    const anchor = anchorOnQuote();
    const edited = DOCUMENT.replace("# Chapter\n\n", "");
    const resolution = resolveAnchor(edited, anchor);

    expect(resolution.status).toBe("resolved");
    expect(edited.slice(resolution.start, resolution.end)).toBe(QUOTE);
  });

  it("finds a passage that moved beyond the local search window", () => {
    const anchor = anchorOnQuote();
    const edited = `${"filler sentence. ".repeat(200)}${DOCUMENT}`;
    const resolution = resolveAnchor(edited, anchor, { windowCharacters: 40 });

    expect(resolution.status).toBe("resolved");
    expect(edited.slice(resolution.start, resolution.end)).toBe(QUOTE);
  });

  it("keeps a unique quote even when everything around it was rewritten", () => {
    const anchor = anchorOnQuote();
    const edited = `Completely different framing now.\n\n${QUOTE}\n\nAnd a different ending.`;
    const resolution = resolveAnchor(edited, anchor);

    expect(resolution.status).toBe("resolved");
    expect(resolution.strategy).toBe("unique");
    expect(edited.slice(resolution.start, resolution.end)).toBe(QUOTE);
  });

  it("disambiguates duplicate quotes using prefix and suffix", () => {
    const duplicated = [
      "Intro. The results are unclear. We continue.",
      "",
      "Later. The results are unclear. We stop.",
    ].join("\n");

    const second = duplicated.lastIndexOf("The results are unclear.");
    const anchor = createAnchor(duplicated, second, second + "The results are unclear.".length);

    const edited = `Preamble added on top.\n\n${duplicated}`;
    const resolution = resolveAnchor(edited, anchor);

    expect(resolution.status).toBe("resolved");
    expect(resolution.start).toBe(edited.lastIndexOf("The results are unclear."));
    expect(edited.slice(resolution.end, resolution.end + 8)).toBe(" We stop");
  });

  it("prefers the nearer copy when both copies have identical context", () => {
    const line = "Prefix here. Same sentence twice. Suffix here.";
    const twice = `${line}\n\n${line}`;
    const first = twice.indexOf("Same sentence twice.");
    const anchor = createAnchor(twice, first, first + "Same sentence twice.".length);

    const resolution = resolveAnchor(twice.replace("Prefix here.", "Prefix here!"), anchor);

    expect(resolution.status).toBe("resolved");
    expect(resolution.start).toBe(first);
  });

  it("marks the comment stale when the quote was edited", () => {
    const anchor = anchorOnQuote();
    const edited = DOCUMENT.replace(QUOTE, "Studies suggest that most readers wander off.");
    const resolution = resolveAnchor(edited, anchor);

    expect(resolution.status).toBe("stale");
    expect(resolution.confidence).toBe(0);
    expect(resolution.strategy).toBe("none");
  });

  it("marks the comment stale when the passage was deleted", () => {
    const anchor = anchorOnQuote();
    const edited = DOCUMENT.replace(`${QUOTE} `, "");
    const resolution = resolveAnchor(edited, anchor);

    expect(resolution.status).toBe("stale");
  });

  it("keeps stale offsets inside an emptied document", () => {
    const anchor = anchorOnQuote();
    const resolution = resolveAnchor("", anchor);

    expect(resolution).toMatchObject({ status: "stale", start: 0, end: 0 });
  });

  it("recovers a stale comment when the deletion is undone", () => {
    const anchor = anchorOnQuote();
    const deleted = DOCUMENT.replace(`${QUOTE} `, "");

    const lost = resolveAnchor(deleted, anchor);
    expect(lost.status).toBe("stale");

    // The stored anchor follows the failed resolution, as the service does.
    const afterUndo = resolveAnchor(DOCUMENT, anchorAt(anchor, lost.start, lost.end));

    expect(afterUndo.status).toBe("resolved");
    expect(DOCUMENT.slice(afterUndo.start, afterUndo.end)).toBe(QUOTE);
  });

  it("survives Markdown formatting added around the quote", () => {
    const anchor = anchorOnQuote();
    const edited = DOCUMENT.replace(QUOTE, `**${QUOTE}**`);
    const resolution = resolveAnchor(edited, anchor);

    expect(resolution.status).toBe("resolved");
    expect(edited.slice(resolution.start, resolution.end)).toBe(QUOTE);
  });

  it("survives a rewrapped paragraph", () => {
    const anchor = anchorOnQuote();
    const edited = DOCUMENT.replace(QUOTE, "Studies show that\nreaders skim.");
    const resolution = resolveAnchor(edited, anchor);

    expect(resolution.status).toBe("resolved");
    expect(resolution.strategy).toBe("normalized");
    expect(edited.slice(resolution.start, resolution.end)).toBe("Studies show that\nreaders skim.");
  });

  it("handles Unicode quotes without splitting characters", () => {
    const unicodeQuote = "Les résultats sont clairs 👍 selon l'étude.";
    const text = `Avant. ${unicodeQuote} Après.`;
    const anchor = anchorOnQuote(text, unicodeQuote);

    const edited = `Nouvelle introduction 🙂.\n\n${text}`;
    const resolution = resolveAnchor(edited, anchor);

    expect(resolution.status).toBe("resolved");
    expect(edited.slice(resolution.start, resolution.end)).toBe(unicodeQuote);
  });

  it("refuses matches below the confidence threshold", () => {
    const anchor = anchorOnQuote();
    const edited = `Completely different framing now.\n\n${QUOTE}\n\nAnother ending.`;

    expect(resolveAnchor(edited, anchor, { minimumConfidence: 0.99 }).status).toBe("stale");
    expect(resolveAnchor(edited, anchor).status).toBe("resolved");
  });

  it("never resolves an empty quote", () => {
    const anchor = { ...anchorOnQuote(), quote: "" };
    expect(resolveAnchor(DOCUMENT, anchor).status).toBe("stale");
  });

  it("scores an untouched neighbourhood above the acceptance bar", () => {
    const anchor = anchorOnQuote();
    const edited = DOCUMENT.replace("# Chapter", "# Chapter one");
    const resolution = resolveAnchor(edited, anchor);

    expect(resolution.confidence).toBeGreaterThan(ANCHOR_MIN_CONFIDENCE);
  });
});

describe("resolveAnchor with a lookalike left behind", () => {
  it("follows a passage that moved far away rather than settling for a nearby copy of its words", () => {
    const moved = "The first claim stands; however, the data disagree with it entirely.";
    const stays = "A second point is made here: however, nothing else about it changed.";
    const original = `${moved}\n\n${stays}`;

    const anchor = anchorOnQuote(original, "however,");
    const filler = "Unrelated material fills the space between the two. ".repeat(120);
    const edited = `${stays}\n\n${filler}\n\n${moved}`;

    const resolution = resolveAnchor(edited, anchor);

    expect(resolution.status).toBe("resolved");
    expect(resolution.start).toBe(edited.lastIndexOf("however,"));
  });
});
