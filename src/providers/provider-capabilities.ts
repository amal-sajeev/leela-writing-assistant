import type { ProviderId } from "../types";
import { THINKING_HEADROOM_TOKENS } from "./budgets";

export interface ProviderCapabilities {
  maxOutputTokens: number;
  reasoningHeadroomTokens: number;
  structuredOutput: "json-schema-with-fallback" | "json-schema-only-fallback";
  sampling: "temperature" | "none";
  cancellation: "discard-only";
  streaming: false;
}

/**
 * Gemini 2.5 and later think before answering, and count that thinking against
 * the output ceiling. Older models do not.
 */
export function geminiThinks(model: string): boolean {
  return /^(?:models\/)?gemini-(?:2\.5|[3-9](?:\.|-|$))/i.test(model.trim());
}

export function providerCapabilities(id: ProviderId, model: string): ProviderCapabilities {
  const reasoning = id === "openai" && /^(?:o[1-9](?:[-.]|$)|gpt-5(?:[-.]|$))/i.test(model.trim());
  const thinking = reasoning || (id === "gemini" && geminiThinks(model));
  return {
    maxOutputTokens:
      id === "mistral" ? 4_000 : id === "anthropic" ? 8_000 : id === "gemini" ? 32_768 : 16_000,
    reasoningHeadroomTokens: thinking ? THINKING_HEADROOM_TOKENS : 0,
    structuredOutput: id === "anthropic" ? "json-schema-only-fallback" : "json-schema-with-fallback",
    sampling: id === "anthropic" || id === "gemini" || reasoning ? "none" : "temperature",
    cancellation: "discard-only",
    streaming: false,
  };
}

export function outputTokenBudget(id: ProviderId, model: string, visibleBudget: number): number {
  const capability = providerCapabilities(id, model);
  return Math.min(capability.maxOutputTokens, Math.max(1, visibleBudget) + capability.reasoningHeadroomTokens);
}
