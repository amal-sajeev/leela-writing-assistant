import { describe, expect, it } from "vitest";

import { isProviderError } from "../src/providers/provider-errors";
import {
  extractJsonObject,
  extractMessageText,
  extractUsage,
  parseObservations,
  parseReviewComments,
  parseSuggestedFix,
} from "../src/review/response-parser";

const comment = {
  quote: "always more accurate",
  category: "reasoning",
  severity: "high",
  confidence: 0.9,
  body: "One experiment cannot support a universal claim.",
};

function expectInvalidResponse(action: () => unknown): void {
  try {
    action();
    expect.unreachable("should have thrown");
  } catch (error) {
    expect(isProviderError(error)).toBe(true);
    if (isProviderError(error)) expect(error.code).toBe("invalid_response");
  }
}

describe("extractJsonObject", () => {
  it("returns a bare JSON object unchanged", () => {
    expect(extractJsonObject('{"comments": []}')).toBe('{"comments": []}');
  });

  it("unwraps a fenced code block", () => {
    expect(extractJsonObject('```json\n{"comments": []}\n```')).toBe('{"comments": []}');
  });

  it("keeps a bare object whole when a quote inside it contains code fences", () => {
    const raw = JSON.stringify({ comments: [{ quote: "```js\nrun()\n```" }] });
    expect(extractJsonObject(raw)).toBe(raw);
  });

  it("ignores prose before and after the object", () => {
    const raw = 'Here is my review:\n{"comments": []}\nLet me know if you want more.';
    expect(extractJsonObject(raw)).toBe('{"comments": []}');
  });

  it("rejects empty and object-free responses", () => {
    expectInvalidResponse(() => extractJsonObject("   "));
    expectInvalidResponse(() => extractJsonObject("I have no comments."));
  });
});

describe("parseReviewComments", () => {
  it("parses an empty review", () => {
    expect(parseReviewComments('{"comments": []}')).toEqual([]);
  });

  it("parses a well-formed comment", () => {
    const parsed = parseReviewComments(JSON.stringify({ comments: [comment] }));
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.category).toBe("reasoning");
  });

  it("treats a null rationale as absent, since strict schemas require the field", () => {
    const parsed = parseReviewComments(JSON.stringify({ comments: [{ ...comment, rationale: null }] }));
    expect(parsed[0]?.rationale).toBeUndefined();
  });

  it("keeps a rationale when the model supplies one", () => {
    const parsed = parseReviewComments(
      JSON.stringify({ comments: [{ ...comment, rationale: " overgeneralization " }] }),
    );
    expect(parsed[0]?.rationale).toBe("overgeneralization");
  });

  it("keeps a valid reaction and ignores an invalid one without losing comments", () => {
    const parsed = parseReviewComments(JSON.stringify({ comments: [
      { ...comment, reaction: "idle_laughing" },
      { ...comment, quote: "different words", reaction: "passive_gaming" },
    ] }));
    expect(parsed.map(({ reaction }) => reaction)).toEqual(["idle_laughing", undefined]);
  });

  it("rejects malformed JSON rather than guessing", () => {
    expectInvalidResponse(() => parseReviewComments('{"comments": [}'));
  });

  it("rejects a response that does not match the schema", () => {
    expectInvalidResponse(() => parseReviewComments('{"comments": [{"quote": "x"}]}'));
    expectInvalidResponse(() => parseReviewComments('{"notes": []}'));
  });
});

describe("parseObservations", () => {
  const observation = {
    type: "structure",
    title: "The conclusion arrives before its evidence",
    body: "The recommendation in section one rests on the study described in section three.",
  };

  it("parses a note with nothing global to say", () => {
    expect(parseObservations('{"observations": []}')).toEqual([]);
  });

  it("parses a well-formed observation", () => {
    const parsed = parseObservations(JSON.stringify({ observations: [observation] }));

    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.type).toBe("structure");
    expect(parsed[0]?.relatedQuotes).toBeUndefined();
  });

  it("keeps related quotes, dropping the empty ones", () => {
    const parsed = parseObservations(
      JSON.stringify({
        observations: [{ ...observation, relatedQuotes: [" we recommend it ", "", "   "] }],
      }),
    );

    expect(parsed[0]?.relatedQuotes).toEqual(["we recommend it"]);
  });

  it("treats null related quotes as absent, since strict schemas require the field", () => {
    const parsed = parseObservations(
      JSON.stringify({ observations: [{ ...observation, relatedQuotes: null }] }),
    );

    expect(parsed[0]?.relatedQuotes).toBeUndefined();
  });

  it("rejects an observation type it does not know", () => {
    expectInvalidResponse(() =>
      parseObservations(JSON.stringify({ observations: [{ ...observation, type: "vibes" }] })),
    );
  });

  it("rejects an observation with an empty title or body", () => {
    expectInvalidResponse(() =>
      parseObservations(JSON.stringify({ observations: [{ ...observation, title: "  " }] })),
    );
    expectInvalidResponse(() =>
      parseObservations(JSON.stringify({ observations: [{ ...observation, body: "" }] })),
    );
  });

  it("rejects a response of the wrong shape", () => {
    expectInvalidResponse(() => parseObservations('{"comments": []}'));
  });
});

describe("parseSuggestedFix", () => {
  it("reads a replacement and drops an empty explanation", () => {
    const fix = parseSuggestedFix('{"replacement": "Rewritten sentence.", "explanation": null}');
    expect(fix.replacement).toBe("Rewritten sentence.");
    expect(fix.explanation).toBeUndefined();
  });

  it("rejects a fix with no replacement", () => {
    expectInvalidResponse(() => parseSuggestedFix('{"explanation": "because"}'));
  });
});

describe("extractUsage", () => {
  it("reads OpenAI-compatible token counts", () => {
    expect(extractUsage({ prompt_tokens: 1200, completion_tokens: 48, total_tokens: 1248 })).toEqual({
      inputTokens: 1200,
      outputTokens: 48,
    });
  });

  it("reads Gemini interaction token counts", () => {
    expect(
      extractUsage({
        total_input_tokens: 36,
        total_output_tokens: 133,
        total_thought_tokens: 658,
      }),
    ).toEqual({ inputTokens: 36, outputTokens: 133 });
  });

  it("ignores missing or unusable usage instead of failing the review", () => {
    expect(extractUsage(undefined)).toBeUndefined();
    expect(extractUsage({})).toBeUndefined();
    expect(extractUsage({ prompt_tokens: "many" })).toBeUndefined();
    expect(extractUsage({ prompt_tokens: -5 })).toBeUndefined();
  });
});

describe("extractMessageText", () => {
  it("reads plain string content", () => {
    expect(extractMessageText("hello")).toBe("hello");
  });

  it("joins typed content parts", () => {
    expect(extractMessageText([{ type: "text", text: "a" }, { type: "text", text: "b" }])).toBe("ab");
  });

  it("rejects content it cannot read", () => {
    expectInvalidResponse(() => extractMessageText(undefined));
    expectInvalidResponse(() => extractMessageText([]));
  });
});
