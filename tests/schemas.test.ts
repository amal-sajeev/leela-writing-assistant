import { describe, expect, it } from "vitest";

import { describeProviderError, ProviderError, toProviderError } from "../src/providers/provider-errors";
import { reviewResultSchema, suggestedFixResponseSchema } from "../src/providers/schemas";
import { TimeoutError } from "../src/utils/async";

const validComment = {
  quote: "proves that retrieval augmented generation is always more accurate",
  category: "reasoning",
  severity: "high",
  confidence: 0.97,
  body: 'One experiment cannot support the universal claim "always more accurate".',
};

describe("reviewResultSchema", () => {
  it("accepts zero comments, which is the expected common case", () => {
    const parsed = reviewResultSchema.safeParse({ comments: [] });
    expect(parsed.success).toBe(true);
  });

  it("accepts a well-formed comment", () => {
    const parsed = reviewResultSchema.safeParse({ comments: [validComment] });
    expect(parsed.success).toBe(true);
    expect(parsed.data?.comments[0]?.category).toBe("reasoning");
  });

  it("strips unknown fields instead of rejecting the response", () => {
    const parsed = reviewResultSchema.safeParse({
      comments: [{ ...validComment, unexpected: "ignore me" }],
      alsoUnexpected: 1,
    });

    expect(parsed.success).toBe(true);
    expect(parsed.data?.comments[0]).not.toHaveProperty("unexpected");
    expect(parsed.data).not.toHaveProperty("alsoUnexpected");
  });

  it("rejects a missing comments array", () => {
    expect(reviewResultSchema.safeParse({}).success).toBe(false);
    expect(reviewResultSchema.safeParse({ comments: "none" }).success).toBe(false);
  });

  it("rejects an invalid category", () => {
    const parsed = reviewResultSchema.safeParse({
      comments: [{ ...validComment, category: "vibes" }],
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects an invalid severity", () => {
    const parsed = reviewResultSchema.safeParse({
      comments: [{ ...validComment, severity: "critical" }],
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects confidence outside 0 to 1", () => {
    for (const confidence of [-0.1, 1.5, Number.NaN]) {
      const parsed = reviewResultSchema.safeParse({ comments: [{ ...validComment, confidence }] });
      expect(parsed.success).toBe(false);
    }
  });

  it("rejects an empty quote or body", () => {
    expect(reviewResultSchema.safeParse({ comments: [{ ...validComment, quote: "   " }] }).success).toBe(
      false,
    );
    expect(reviewResultSchema.safeParse({ comments: [{ ...validComment, body: "" }] }).success).toBe(
      false,
    );
  });

  it("accepts optional usage when a provider reports it", () => {
    const parsed = reviewResultSchema.safeParse({
      comments: [],
      usage: { inputTokens: 1200, outputTokens: 48 },
    });
    expect(parsed.success).toBe(true);
    expect(parsed.data?.usage?.inputTokens).toBe(1200);
  });
});

describe("suggestedFixResponseSchema", () => {
  it("requires a replacement", () => {
    expect(suggestedFixResponseSchema.safeParse({ explanation: "why" }).success).toBe(false);
    expect(suggestedFixResponseSchema.safeParse({ replacement: "new text" }).success).toBe(true);
  });
});

describe("provider errors", () => {
  it("passes through an existing ProviderError", () => {
    const original = new ProviderError("unauthorized", "bad key", false, 401);
    expect(toProviderError(original)).toBe(original);
  });

  it("maps a timeout to a retryable timeout error", () => {
    const error = toProviderError(new TimeoutError());
    expect(error.code).toBe("timeout");
    expect(error.retryable).toBe(true);
  });

  it("maps an unknown throw to a generic provider error", () => {
    expect(toProviderError("kaboom").code).toBe("provider_error");
  });

  it("describes errors without leaking response bodies", () => {
    const error = new ProviderError("unauthorized", "HTTP 401 {\"key\":\"sk-secret\"}", false, 401);
    const message = describeProviderError(error, "mistral");

    expect(message).toBe("Mistral API key was rejected.");
    expect(message).not.toContain("sk-secret");
  });

  it("has a message for every error code", () => {
    const codes = [
      "missing_key",
      "unauthorized",
      "rate_limited",
      "quota",
      "timeout",
      "network",
      "invalid_response",
      "model_not_found",
      "provider_error",
    ] as const;

    for (const code of codes) {
      const message = describeProviderError(new ProviderError(code, "raw", false));
      expect(message.length).toBeGreaterThan(0);
    }
  });
});
