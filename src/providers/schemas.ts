import { z } from "zod";

import { ACTIVE_REACTION_IDS, COMMENT_CATEGORIES, COMMENT_KINDS, COMMENT_SEVERITIES, OBSERVATION_TYPES, isActiveReaction } from "../types";

/**
 * Runtime validation of provider output (specification section 12).
 *
 * Unknown keys are stripped rather than rejected, so a model that adds an extra
 * field still produces usable comments. Everything else is strict: an invalid
 * category, an empty body or an out-of-range confidence rejects the comment.
 */
export const proposedCommentSchema = z.object({
  quote: z.string().trim().min(1),
  category: z.enum(COMMENT_CATEGORIES),
  severity: z.enum(COMMENT_SEVERITIES),
  confidence: z.number().min(0).max(1),
  body: z.string().trim().min(1),
  // A kind the model left out, or made up, is no kind at all: the comment is
  // still worth having, and is simply shown without one.
  kind: z
    .unknown()
    .optional()
    .transform((value) =>
      (COMMENT_KINDS as readonly unknown[]).includes(value)
        ? (value as (typeof COMMENT_KINDS)[number])
        : undefined,
    ),
  // Strict structured-output modes require every property to be declared, so
  // models send `null` rather than omitting an empty rationale.
  rationale: z
    .union([z.string(), z.null()])
    .optional()
    .transform((value) => {
      const trimmed = typeof value === "string" ? value.trim() : "";
      return trimmed.length > 0 ? trimmed : undefined;
    }),
  reaction: z.unknown().optional().transform((value) => isActiveReaction(value) ? value : undefined),
});

export const providerUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
});

export const reviewResultSchema = z.object({
  comments: z.array(proposedCommentSchema),
  usage: providerUsageSchema.optional(),
});

/**
 * A remark about the note as a whole. `relatedQuotes` are passages the reader
 * should look at, not anchors: a global problem has no single home.
 */
export const proposedObservationSchema = z.object({
  type: z.enum(OBSERVATION_TYPES),
  title: z.string().trim().min(1),
  body: z.string().trim().min(1),
  relatedQuotes: z
    .union([z.array(z.string()), z.null()])
    .optional()
    .transform((value) => {
      const quotes = (value ?? []).map((quote) => quote.trim()).filter((quote) => quote.length > 0);
      return quotes.length > 0 ? quotes : undefined;
    }),
});

export const documentReviewResultSchema = z.object({
  observations: z.array(proposedObservationSchema),
  usage: providerUsageSchema.optional(),
});

export const suggestedFixResponseSchema = z.object({
  replacement: z.string().min(1),
  explanation: z
    .union([z.string(), z.null()])
    .optional()
    .transform((value) => {
      const trimmed = typeof value === "string" ? value.trim() : "";
      return trimmed.length > 0 ? trimmed : undefined;
    }),
});

export type ParsedProposedComment = z.infer<typeof proposedCommentSchema>;
export type ParsedProposedObservation = z.infer<typeof proposedObservationSchema>;
export type ParsedReviewResult = z.infer<typeof reviewResultSchema>;
export type ParsedSuggestedFix = z.infer<typeof suggestedFixResponseSchema>;

/** Nullable string, the form strict structured-output modes accept for an optional field. */
const nullableString = { anyOf: [{ type: "string" }, { type: "null" }] };

/**
 * JSON Schema handed to providers that support structured output. Kept next to
 * the Zod schema so the two cannot drift apart.
 *
 * Strict mode requires `additionalProperties: false` and every property listed
 * in `required`, so optional fields are declared nullable instead of omitted.
 */
export function reviewJsonSchema(): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: ["comments"],
    properties: {
      comments: {
        type: "array",
        description: "Zero or more criticisms. An empty array is a valid and common answer.",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["quote", "category", "kind", "severity", "confidence", "body", "rationale", "reaction"],
          properties: {
            quote: {
              type: "string",
              description: "An exact substring of REVIEWED TEXT that the comment refers to.",
            },
            category: { type: "string", enum: [...COMMENT_CATEGORIES] },
            kind: {
              anyOf: [{ type: "string", enum: [...COMMENT_KINDS] }, { type: "null" }],
              description: "error: the text shows it is wrong. craft: likely to weaken the effect. taste: possibly deliberate, so put as a question.",
            },
            severity: { type: "string", enum: [...COMMENT_SEVERITIES] },
            confidence: { type: "number", minimum: 0, maximum: 1 },
            body: { type: "string", description: "The criticism, addressed to the author." },
            rationale: nullableString,
            reaction: { anyOf: [{ type: "string", enum: [...ACTIVE_REACTION_IDS] }, { type: "null" }] },
          },
        },
      },
    },
  };
}

export function documentObservationsJsonSchema(): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: ["observations"],
    properties: {
      observations: {
        type: "array",
        description:
          "Problems belonging to the note as a whole. An empty array is a valid answer.",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["type", "title", "body", "relatedQuotes"],
          properties: {
            type: { type: "string", enum: [...OBSERVATION_TYPES] },
            title: { type: "string", description: "A short label, under ten words." },
            body: { type: "string", description: "The problem, addressed to the author." },
            relatedQuotes: {
              anyOf: [{ type: "array", items: { type: "string" } }, { type: "null" }],
              description: "Short exact quotes from the note the author should look at.",
            },
          },
        },
      },
    },
  };
}

export function suggestedFixJsonSchema(): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: ["replacement", "explanation"],
    properties: {
      replacement: { type: "string", description: "Replacement text for the passage only." },
      explanation: nullableString,
    },
  };
}
