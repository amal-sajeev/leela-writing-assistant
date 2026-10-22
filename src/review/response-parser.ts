import { ProviderError } from "../providers/provider-errors";
import {
  documentReviewResultSchema,
  reviewResultSchema,
  suggestedFixResponseSchema,
} from "../providers/schemas";
import type { ProposedComment, ProposedObservation, ProviderUsage } from "../types";

/**
 * Turns raw model output into validated domain objects (specification section 12).
 *
 * Pure and provider-neutral: providers call it after extracting message content,
 * so JSON handling is written and tested once rather than per vendor.
 *
 * Malformed output raises `invalid_response` and never reaches editor state.
 */

/**
 * Extracts the JSON object from a model response.
 *
 * Models occasionally wrap JSON in a fenced code block or add a sentence before
 * it, even when asked not to. Recovering from that is cheaper than discarding an
 * otherwise good review.
 */
export function extractJsonObject(raw: string): string {
  const text = raw.trim();
  if (text.length === 0) {
    throw new ProviderError("invalid_response", "Provider returned an empty response", false);
  }

  // A bare object is taken as it is: a quote inside it may itself contain a fence.
  const fenced = text.startsWith("{") ? null : /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidate = (fenced?.[1] ?? text).trim();

  if (candidate.startsWith("{")) {
    const end = candidate.lastIndexOf("}");
    if (end > 0) return candidate.slice(0, end + 1);
  }

  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start >= 0 && end > start) return candidate.slice(start, end + 1);

  throw new ProviderError("invalid_response", "Provider response contained no JSON object", false);
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(extractJsonObject(raw));
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    throw new ProviderError("invalid_response", "Provider returned malformed JSON", false);
  }
}

/**
 * Validates a review response. Returns proposed comments only; quote checking,
 * de-duplication and capping happen in the comment filter.
 */
export function parseReviewComments(raw: string): ProposedComment[] {
  const parsed = reviewResultSchema.safeParse(parseJson(raw));

  if (!parsed.success) {
    throw new ProviderError(
      "invalid_response",
      `Provider response did not match the review schema (${parsed.error.issues.length} problems)`,
      false,
    );
  }

  return parsed.data.comments;
}

/**
 * Validates a whole-note observation response. A single malformed observation
 * rejects the response, the same way one malformed comment does: partial
 * guesses about what the model meant belong nowhere near stored state.
 */
export function parseObservations(raw: string): ProposedObservation[] {
  const parsed = documentReviewResultSchema.safeParse(parseJson(raw));

  if (!parsed.success) {
    throw new ProviderError(
      "invalid_response",
      `Provider response did not match the observation schema (${parsed.error.issues.length} problems)`,
      false,
    );
  }

  return parsed.data.observations.map((observation) => ({
    type: observation.type,
    title: observation.title.trim(),
    body: observation.body.trim(),
    ...(observation.relatedQuotes === undefined ? {} : { relatedQuotes: observation.relatedQuotes }),
  }));
}

export function parseSuggestedFix(raw: string): { replacement: string; explanation?: string } {
  const parsed = suggestedFixResponseSchema.safeParse(parseJson(raw));

  if (!parsed.success) {
    throw new ProviderError("invalid_response", "Provider did not return a usable replacement", false);
  }

  return parsed.data.explanation === undefined
    ? { replacement: parsed.data.replacement }
    : { replacement: parsed.data.replacement, explanation: parsed.data.explanation };
}

/**
 * Reads token usage when the provider reports it. Usage is informational, so a
 * missing or malformed field is ignored rather than failing the review.
 */
export function extractUsage(raw: unknown): ProviderUsage | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const usage = raw as Record<string, unknown>;

  const inputTokens = asCount(
    usage.prompt_tokens ?? usage.input_tokens ?? usage.total_input_tokens,
  );
  const outputTokens = asCount(
    usage.completion_tokens ?? usage.output_tokens ?? usage.total_output_tokens,
  );
  if (inputTokens === undefined && outputTokens === undefined) return undefined;

  return {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
  };
}

function asCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : undefined;
}

/**
 * Reads assistant text from an OpenAI-compatible message content field, which
 * may be a plain string or an array of typed parts.
 */
export function extractMessageText(content: unknown): string {
  if (typeof content === "string") return content;

  if (Array.isArray(content)) {
    const parts = content
      .map((part) => {
        if (typeof part === "string") return part;
        if (typeof part === "object" && part !== null) {
          const record = part as Record<string, unknown>;
          if (typeof record.text === "string") return record.text;
        }
        return "";
      })
      .filter((part) => part.length > 0);

    if (parts.length > 0) return parts.join("");
  }

  throw new ProviderError("invalid_response", "Provider response contained no assistant message", false);
}
