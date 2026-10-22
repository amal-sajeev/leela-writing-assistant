import { describe, expect, it } from "vitest";

import { THINKING_HEADROOM_TOKENS } from "../src/providers/budgets";
import { GeminiProvider } from "../src/providers/gemini-provider";
import type { HttpRequest, HttpResponse, HttpTransport } from "../src/providers/http";
import type { ProviderRequestConfig } from "../src/providers/provider";
import { isProviderError } from "../src/providers/provider-errors";

const API_KEY = "AIzaSy-test-000111222333";

const REVIEW_INPUT = {
  systemPrompt: "You are a critical reading partner.",
  userPrompt: "REVIEWED TEXT (review only this):\nIt is always more accurate.",
  maxComments: 3,
};

const COMMENT = {
  quote: "always more accurate",
  category: "reasoning",
  severity: "high",
  confidence: 0.9,
  body: "One study cannot support a universal claim.",
  rationale: null,
};

function config(overrides: Partial<ProviderRequestConfig> = {}): ProviderRequestConfig {
  const apiKey = overrides.apiKey ?? API_KEY;
  return {
    model: "gemini-3.6-flash",
    timeoutMs: 5_000,
    maxRetries: 0,
    retryInitialDelayMs: 1,
    ...overrides,
    apiKey,
    apiKeys: overrides.apiKeys ?? (apiKey.trim().length > 0 ? [apiKey.trim()] : []),
  };
}

function response(status: number, body: unknown): HttpResponse {
  return { status, headers: {}, text: typeof body === "string" ? body : JSON.stringify(body) };
}

/** A completed interaction, with a thought step the adapter must not read as prose. */
function interactionResponse(text: string): HttpResponse {
  return response(200, {
    status: "completed",
    steps: [
      { type: "thought", content: [{ type: "text", text: "Thinking it over." }] },
      { type: "model_output", content: [{ type: "text", text }] },
    ],
    usage: { total_input_tokens: 500, total_output_tokens: 80, total_thought_tokens: 1_200 },
  });
}

function reviewResponse(comments: unknown[] = [COMMENT]): HttpResponse {
  return interactionResponse(JSON.stringify({ comments }));
}

function createProvider(
  responses: HttpResponse[],
  overrides: Partial<ProviderRequestConfig> = {},
): { provider: GeminiProvider; requests: HttpRequest[] } {
  const requests: HttpRequest[] = [];
  let index = 0;

  const transport: HttpTransport = (request) => {
    requests.push(request);
    const next = responses[Math.min(index, responses.length - 1)];
    index += 1;
    return Promise.resolve(next ?? response(200, {}));
  };

  return {
    provider: new GeminiProvider({ config: () => config(overrides), transport }),
    requests,
  };
}

function bodyOf(request: HttpRequest): Record<string, unknown> {
  return JSON.parse(request.body ?? "{}") as Record<string, unknown>;
}

/** Reads a nested field without spelling out a type for every level. */
function dig(value: unknown, path: string): unknown {
  return path
    .split(".")
    .reduce<unknown>((current, key) => (current as Record<string, unknown> | undefined)?.[key], value);
}

describe("GeminiProvider request shape", () => {
  it("posts to the interactions endpoint with Google's key header", async () => {
    const { provider, requests } = createProvider([reviewResponse()]);
    await provider.review(REVIEW_INPUT);

    expect(requests[0]?.url).toBe("https://generativelanguage.googleapis.com/v1/interactions");
    expect(requests[0]?.method).toBe("POST");
    expect(requests[0]?.headers["x-goog-api-key"]).toBe(API_KEY);
    expect(requests[0]?.headers.Authorization).toBeUndefined();
    expect(requests[0]?.url).not.toContain(API_KEY);
  });

  it("sends the prompts as input and system_instruction", async () => {
    const { provider, requests } = createProvider([reviewResponse()]);
    await provider.review(REVIEW_INPUT);

    const body = bodyOf(requests[0]!);
    expect(body.model).toBe("gemini-3.6-flash");
    expect(body.input).toBe(REVIEW_INPUT.userPrompt);
    expect(body.system_instruction).toBe(REVIEW_INPUT.systemPrompt);
  });

  // The Interactions API retains requests by default, so this has to be explicit.
  it("opts out of Gemini's own retention on every request", async () => {
    const { provider, requests } = createProvider([
      reviewResponse(),
      interactionResponse("A reply."),
      interactionResponse(JSON.stringify({ replacement: "Some studies." })),
    ]);

    await provider.review(REVIEW_INPUT);
    await provider.replyToComment({ systemPrompt: "s", userPrompt: "u" });
    await provider.generateFix({ systemPrompt: "s", userPrompt: "u" });

    for (const request of requests) expect(bodyOf(request).store).toBe(false);
  });

  it("asks for structured output through response_format", async () => {
    const { provider, requests } = createProvider([reviewResponse()]);
    await provider.review(REVIEW_INPUT);

    const body = bodyOf(requests[0]!);
    expect(dig(body, "response_format.type")).toBe("text");
    expect(dig(body, "response_format.mime_type")).toBe("application/json");
    expect(dig(body, "response_format.schema.required")).toEqual(["comments"]);
  });

  // Gemini takes a standard JSON schema, but the nullable form used for optional
  // fields and the numeric bounds are not worth a failed request.
  it("sends a schema with the nullable unions collapsed", async () => {
    const { provider, requests } = createProvider([reviewResponse()]);
    await provider.review(REVIEW_INPUT);

    const item = dig(
      bodyOf(requests[0]!),
      "response_format.schema.properties.comments.items",
    );

    expect(dig(item, "properties.rationale")).toEqual({ type: "string" });
    expect(dig(item, "required")).not.toContain("rationale");

    const sent = JSON.stringify(bodyOf(requests[0]!));
    expect(sent).not.toContain('"minimum"');
    expect(sent).not.toContain('"maximum"');
  });

  it("reads a review out of the model_output step, skipping thoughts", async () => {
    const { provider } = createProvider([reviewResponse()]);
    const result = await provider.review(REVIEW_INPUT);

    expect(result.comments).toHaveLength(1);
    expect(result.comments[0]?.quote).toBe("always more accurate");
    expect(result.usage).toEqual({ inputTokens: 500, outputTokens: 80 });
  });

  it("joins an answer split across model_output steps", async () => {
    const { provider } = createProvider([
      response(200, {
        status: "completed",
        steps: [
          { type: "model_output", content: [{ type: "text", text: "A " }] },
          { type: "model_output", content: [{ type: "text", text: "reply." }] },
        ],
      }),
    ]);

    await expect(
      provider.replyToComment({ systemPrompt: "s", userPrompt: "u" }),
    ).resolves.toBe("A reply.");
  });

  it("budgets output tokens by comments plus thinking headroom", async () => {
    const { provider, requests } = createProvider([reviewResponse()]);
    await provider.review({ ...REVIEW_INPUT, maxComments: 4 });

    expect(dig(bodyOf(requests[0]!), "generation_config.max_output_tokens")).toBe(
      1_400 + THINKING_HEADROOM_TOKENS,
    );
  });

  it("asks for medium thinking on Gemini 3 and later", async () => {
    const { provider, requests } = createProvider([reviewResponse()]);
    await provider.review(REVIEW_INPUT);

    expect(dig(bodyOf(requests[0]!), "generation_config.thinking_level")).toBe("medium");
  });

  it("does not send a thinking level to a model that has none", async () => {
    const { provider, requests } = createProvider([reviewResponse()], {
      model: "gemini-1.5-pro",
    });
    await provider.review(REVIEW_INPUT);

    expect(dig(bodyOf(requests[0]!), "generation_config.thinking_level")).toBeUndefined();
  });

  it("asks for the observation and fix schemas on their own requests", async () => {
    const { provider, requests } = createProvider([
      interactionResponse(JSON.stringify({ observations: [] })),
      interactionResponse(JSON.stringify({ replacement: "Some studies." })),
    ]);

    await provider.reviewDocument({ systemPrompt: "s", userPrompt: "u", maxObservations: 2 });
    await provider.generateFix({ systemPrompt: "s", userPrompt: "u" });

    expect(dig(bodyOf(requests[0]!), "response_format.schema.required")).toEqual([
      "observations",
    ]);
    expect(dig(bodyOf(requests[1]!), "response_format.schema.required")).toEqual(["replacement"]);
  });

  it("uses a configured base URL", async () => {
    const { provider, requests } = createProvider([reviewResponse()], {
      baseUrl: "https://proxy.example.com/gemini/",
    });
    await provider.review(REVIEW_INPUT);

    expect(requests[0]?.url).toBe("https://proxy.example.com/gemini/v1/interactions");
  });
});

describe("GeminiProvider structured output fallback", () => {
  it("retries in JSON mode when the model rejects the schema", async () => {
    const { provider, requests } = createProvider([
      response(400, { error: { message: "Invalid schema for response_format" } }),
      reviewResponse(),
    ]);

    const result = await provider.review(REVIEW_INPUT);

    expect(result.comments).toHaveLength(1);
    expect(requests).toHaveLength(2);
    expect(bodyOf(requests[1]!).response_format).toEqual({
      type: "text",
      mime_type: "application/json",
    });
  });

  it("does not retry a failure that has nothing to do with the schema", async () => {
    const { provider, requests } = createProvider([
      response(400, { error: { message: "model gemini-nonsense does not exist" } }),
    ]);

    await expect(provider.review(REVIEW_INPUT)).rejects.toThrow();
    expect(requests).toHaveLength(1);
  });

  it("reports an incomplete interaction as truncated", async () => {
    const { provider } = createProvider([
      response(200, {
        status: "incomplete",
        steps: [{ type: "model_output", content: [{ type: "text", text: "Here" }] }],
      }),
    ]);

    await expect(provider.review(REVIEW_INPUT)).rejects.toMatchObject({
      code: "output_truncated",
      completion: { stopReason: "incomplete", requestId: expect.any(String) },
    });
  });

  it("reports a failed interaction as a provider error", async () => {
    const { provider } = createProvider([
      response(200, { status: "failed", errors: [{ message: "blocked" }] }),
    ]);

    await expect(provider.review(REVIEW_INPUT)).rejects.toMatchObject({
      code: "provider_error",
      completion: { stopReason: "failed" },
    });
  });
});

describe("GeminiProvider configuration", () => {
  it("sends nothing at all without a key", async () => {
    const { provider, requests } = createProvider([reviewResponse()], { apiKey: "  " });

    await expect(provider.review(REVIEW_INPUT)).rejects.toSatisfy(
      (error: unknown) => isProviderError(error) && error.code === "missing_key",
    );
    expect(requests).toHaveLength(0);
  });

  it("checks the key and the model when testing the connection", async () => {
    const { provider, requests } = createProvider([
      response(200, { models: [] }),
      reviewResponse([]),
    ]);

    await provider.validateConfiguration();

    expect(requests[0]?.url).toBe("https://generativelanguage.googleapis.com/v1/models");
    expect(requests[0]?.method).toBe("GET");
    expect(requests[1]?.url).toBe("https://generativelanguage.googleapis.com/v1/interactions");
  });
});
