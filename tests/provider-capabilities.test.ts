import { describe, expect, it } from "vitest";

import { outputTokenBudget, providerCapabilities } from "../src/providers/provider-capabilities";

describe("provider capabilities", () => {
  it("adds reasoning headroom only for recognized reasoning models", () => {
    expect(outputTokenBudget("openai", "gpt-5.6-terra", 1_400)).toBe(7_400);
    expect(outputTokenBudget("openai", "gpt-4.1", 1_400)).toBe(1_400);
  });

  it("keeps each vendor's request ceiling and cancellation limits explicit", () => {
    expect(outputTokenBudget("mistral", "mistral-large-latest", 9_000)).toBe(4_000);
    expect(providerCapabilities("anthropic", "claude-sonnet")).toMatchObject({
      reasoningHeadroomTokens: 0,
      structuredOutput: "json-schema-only-fallback",
      cancellation: "discard-only",
      streaming: false,
    });
  });
});
