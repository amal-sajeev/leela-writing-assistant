import type { ProviderId } from "../types";

export interface ProviderCapabilities {
  maxOutputTokens: number;
  reasoningHeadroomTokens: number;
  structuredOutput: "json-schema-with-fallback" | "json-schema-only-fallback";
  sampling: "temperature" | "none";
  cancellation: "discard-only";
  streaming: false;
}

export function providerCapabilities(id: ProviderId, model: string): ProviderCapabilities {
  const reasoning = id === "openai" && /^(?:o[1-9](?:[-.]|$)|gpt-5(?:[-.]|$))/i.test(model.trim());
  return {
    maxOutputTokens: id === "mistral" ? 4_000 : id === "anthropic" ? 8_000 : 16_000,
    reasoningHeadroomTokens: reasoning ? 6_000 : 0,
    structuredOutput: id === "anthropic" ? "json-schema-only-fallback" : "json-schema-with-fallback",
    sampling: id === "anthropic" || reasoning ? "none" : "temperature",
    cancellation: "discard-only",
    streaming: false,
  };
}

export function outputTokenBudget(id: ProviderId, model: string, visibleBudget: number): number {
  const capability = providerCapabilities(id, model);
  return Math.min(capability.maxOutputTokens, Math.max(1, visibleBudget) + capability.reasoningHeadroomTokens);
}
