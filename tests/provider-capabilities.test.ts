import { describe, expect, it } from "vitest";

import { THINKING_HEADROOM_TOKENS } from "../src/providers/budgets";
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

  it("reserves thinking room for Gemini and never sends it a temperature", () => {
    expect(outputTokenBudget("gemini", "gemini-3.6-flash", 1_400)).toBe(
      1_400 + THINKING_HEADROOM_TOKENS,
    );
    expect(outputTokenBudget("gemini", "gemini-1.5-pro", 1_400)).toBe(1_400);
    expect(providerCapabilities("gemini", "gemini-3.6-flash")).toMatchObject({
      maxOutputTokens: 32_768,
      reasoningHeadroomTokens: THINKING_HEADROOM_TOKENS,
      structuredOutput: "json-schema-with-fallback",
      sampling: "none",
    });
  });
});
