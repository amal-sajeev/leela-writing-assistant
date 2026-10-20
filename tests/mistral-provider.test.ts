import { describe, expect, it } from "vitest";

import type { HttpRequest, HttpResponse, HttpTransport } from "../src/providers/http";
import { MistralProvider } from "../src/providers/mistral-provider";
import { isProviderError, type ProviderErrorCode } from "../src/providers/provider-errors";
import type { ProviderRequestConfig } from "../src/providers/provider";

const API_KEY = "sk-test-000111222333444";

const REVIEW_INPUT = {
  systemPrompt: "You are a critical reading partner.",
  userPrompt: "REVIEWED TEXT (review only this):\nIt is always more accurate.",
  maxComments: 3,
};

const DOCUMENT_INPUT = {
  systemPrompt: "You are reading a whole draft.",
  userPrompt: "NOTE:\n# Findings\n\nIt is always more accurate.",
  maxObservations: 4,
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
    model: "mistral-large-latest",
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

function chatResponse(content: unknown, usage?: unknown): HttpResponse {
  return response(200, { choices: [{ message: { content } }], ...(usage === undefined ? {} : { usage }) });
}

function reviewResponse(comments: unknown[] = [COMMENT], usage?: unknown): HttpResponse {
  return response(200, {
    choices: [{ message: { content: JSON.stringify({ comments }) }, finish_reason: "stop" }],
    ...(usage === undefined ? {} : { usage }),
  });
}

/** Replays the given responses in order and records every request. */
function fakeTransport(...responses: HttpResponse[]): {
  transport: HttpTransport;
  requests: HttpRequest[];
} {
  const requests: HttpRequest[] = [];
  let index = 0;

  const transport: HttpTransport = (request) => {
    requests.push(request);
    const next = responses[Math.min(index, responses.length - 1)];
    index += 1;
    return Promise.resolve(next ?? response(200, {}));
  };

  return { transport, requests };
}

function createProvider(
  responses: HttpResponse[],
  overrides: Partial<ProviderRequestConfig> = {},
): { provider: MistralProvider; requests: HttpRequest[] } {
  const { transport, requests } = fakeTransport(...responses);
  return {
    provider: new MistralProvider({ config: () => config(overrides), transport }),
    requests,
  };
}

async function expectProviderError(action: () => Promise<unknown>, code: ProviderErrorCode): Promise<void> {
  await expect(action()).rejects.toSatisfy((error: unknown) => {
    return isProviderError(error) && error.code === code;
  });
}

function bodyOf(request: HttpRequest): Record<string, unknown> {
  return JSON.parse(request.body ?? "{}") as Record<string, unknown>;
}

describe("MistralProvider request shape", () => {
  it("posts to the chat completions endpoint with bearer auth", async () => {
    const { provider, requests } = createProvider([reviewResponse()]);
    await provider.review(REVIEW_INPUT);

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("https://api.mistral.ai/v1/chat/completions");
    expect(requests[0]?.method).toBe("POST");
    expect(requests[0]?.headers.Authorization).toBe(`Bearer ${API_KEY}`);
    expect(requests[0]?.headers["Content-Type"]).toBe("application/json");
  });

  it("sends the rendered prompts as system and user messages", async () => {
    const { provider, requests } = createProvider([reviewResponse()]);
    await provider.review(REVIEW_INPUT);

    const body = bodyOf(requests[0]!);
    expect(body.model).toBe("mistral-large-latest");
    expect(body.messages).toEqual([
      { role: "system", content: REVIEW_INPUT.systemPrompt },
      { role: "user", content: REVIEW_INPUT.userPrompt },
    ]);
    expect(body.temperature).toBe(0.2);
    expect(body.max_tokens).toBeGreaterThan(0);
  });

  it("asks for structured output with a strict schema", async () => {
    const { provider, requests } = createProvider([reviewResponse()]);
    await provider.review(REVIEW_INPUT);

    const format = bodyOf(requests[0]!).response_format as Record<string, unknown>;
    expect(format.type).toBe("json_schema");

    const schema = format.json_schema as Record<string, unknown>;
    expect(schema.name).toBe("review");
    expect(schema.strict).toBe(true);
    expect(schema.schema).toMatchObject({ type: "object", required: ["comments"] });
  });

  it("honours a custom base URL and trims a trailing slash", async () => {
    const { provider, requests } = createProvider([reviewResponse()], {
      baseUrl: "https://gateway.internal/v1/",
    });
    await provider.review(REVIEW_INPUT);

    expect(requests[0]?.url).toBe("https://gateway.internal/v1/chat/completions");
  });
});

describe("MistralProvider results", () => {
  it("returns validated comments and reported usage", async () => {
    const { provider } = createProvider([
      reviewResponse([COMMENT], { prompt_tokens: 900, completion_tokens: 60 }),
    ]);

    const result = await provider.review(REVIEW_INPUT);

    expect(result.comments).toHaveLength(1);
    expect(result.comments[0]?.quote).toBe("always more accurate");
    expect(result.usage).toEqual({ inputTokens: 900, outputTokens: 60 });
    expect(result.completion).toMatchObject({ finishReason: "stop", requestId: expect.any(String) });
  });

  it("treats an empty review as a normal result", async () => {
    const { provider } = createProvider([reviewResponse([])]);
    await expect(provider.review(REVIEW_INPUT)).resolves.toMatchObject({
      comments: [],
      completion: { finishReason: "stop", requestId: expect.any(String) },
    });
  });

  it("rejects content that is not the agreed JSON", async () => {
    const { provider } = createProvider([chatResponse("I would rather write an essay.")]);
    await expectProviderError(() => provider.review(REVIEW_INPUT), "invalid_response");
  });

  it("rejects a response with no message at all", async () => {
    const { provider } = createProvider([response(200, { choices: [] })]);
    await expectProviderError(() => provider.review(REVIEW_INPUT), "invalid_response");
  });

  it("reports token-limit termination separately with safe metadata", async () => {
    const { provider } = createProvider([response(200, {
      choices: [{ message: { content: '{"comments": [' }, finish_reason: "length" }],
    })]);

    await expect(provider.review(REVIEW_INPUT)).rejects.toMatchObject({
      code: "output_truncated",
      completion: { finishReason: "length", requestId: expect.any(String) },
    });
  });
});

describe("MistralProvider configuration failures", () => {
  it("does not send anything when no key is configured", async () => {
    const { provider, requests } = createProvider([reviewResponse()], { apiKey: "  " });

    await expectProviderError(() => provider.review(REVIEW_INPUT), "missing_key");
    expect(requests).toHaveLength(0);
  });

  it("does not send anything when no model is configured", async () => {
    const { provider, requests } = createProvider([reviewResponse()], { model: "" });

    await expectProviderError(() => provider.review(REVIEW_INPUT), "model_not_found");
    expect(requests).toHaveLength(0);
  });
});

describe("MistralProvider error mapping", () => {
  it("maps a rejected key and does not retry it", async () => {
    const { provider, requests } = createProvider([response(401, { message: "Unauthorized" })], {
      maxRetries: 3,
    });

    await expectProviderError(() => provider.review(REVIEW_INPUT), "unauthorized");
    expect(requests).toHaveLength(1);
  });

  it("retries a rate limit and succeeds", async () => {
    const { provider, requests } = createProvider(
      [response(429, { message: "Requests rate limit exceeded" }), reviewResponse()],
      { maxRetries: 2 },
    );

    const result = await provider.review(REVIEW_INPUT);
    expect(result.comments).toHaveLength(1);
    expect(requests).toHaveLength(2);
  });

  it("maps an unknown model", async () => {
    const { provider } = createProvider([response(404, { message: "Invalid model: nope" })]);
    await expectProviderError(() => provider.review(REVIEW_INPUT), "model_not_found");
  });

  it("never puts the API key in an error message", async () => {
    const { provider } = createProvider([
      response(401, { message: `Invalid api key: ${API_KEY}`, authorization: `Bearer ${API_KEY}` }),
    ]);

    await expect(provider.review(REVIEW_INPUT)).rejects.toSatisfy((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      return !message.includes(API_KEY) && message.includes("[redacted]");
    });
  });
});

describe("MistralProvider structured output fallback", () => {
  it("retries in JSON mode when the model rejects the strict schema", async () => {
    const { provider, requests } = createProvider([
      response(422, { message: "response_format.json_schema is not supported for this model" }),
      reviewResponse(),
    ]);

    const result = await provider.review(REVIEW_INPUT);

    expect(result.comments).toHaveLength(1);
    expect(requests).toHaveLength(2);
    expect(bodyOf(requests[1]!).response_format).toEqual({ type: "json_object" });
  });

  it("does not downgrade for unrelated client errors", async () => {
    const { provider, requests } = createProvider([response(422, { message: "temperature must be <= 1.5" })]);

    await expectProviderError(() => provider.review(REVIEW_INPUT), "provider_error");
    expect(requests).toHaveLength(1);
  });
});

describe("MistralProvider whole-note observations", () => {
  const OBSERVATION = {
    type: "structure",
    title: "The recommendation precedes its evidence",
    body: "Section one recommends the method; the study supporting it appears in section three.",
    relatedQuotes: ["We recommend it for every deployment."],
  };

  function observationResponse(observations: unknown[] = [OBSERVATION]): HttpResponse {
    return chatResponse(JSON.stringify({ observations }));
  }

  it("asks for observations under their own strict schema", async () => {
    const { provider, requests } = createProvider([observationResponse()]);
    await provider.reviewDocument({ ...DOCUMENT_INPUT });

    const format = bodyOf(requests[0]!).response_format as Record<string, unknown>;
    const schema = format.json_schema as Record<string, unknown>;

    expect(schema.name).toBe("document_observations");
    expect(schema.strict).toBe(true);
    expect(schema.schema).toMatchObject({ type: "object", required: ["observations"] });
  });

  it("returns validated observations", async () => {
    const { provider } = createProvider([observationResponse()]);

    const result = await provider.reviewDocument(DOCUMENT_INPUT);

    expect(result.observations).toHaveLength(1);
    expect(result.observations[0]?.title).toBe("The recommendation precedes its evidence");
    expect(result.observations[0]?.relatedQuotes).toEqual([
      "We recommend it for every deployment.",
    ]);
  });

  it("treats a note with nothing global wrong as a normal result", async () => {
    const { provider } = createProvider([observationResponse([])]);
    await expect(provider.reviewDocument(DOCUMENT_INPUT)).resolves.toMatchObject({
      observations: [],
      completion: { requestId: expect.any(String) },
    });
  });

  it("falls back to JSON mode when the model rejects the strict schema", async () => {
    const { provider, requests } = createProvider([
      response(422, { message: "response_format.json_schema is not supported for this model" }),
      observationResponse(),
    ]);

    const result = await provider.reviewDocument(DOCUMENT_INPUT);

    expect(result.observations).toHaveLength(1);
    expect(bodyOf(requests[1]!).response_format).toEqual({ type: "json_object" });
  });

  it("rejects observations it cannot validate", async () => {
    const { provider } = createProvider([observationResponse([{ type: "vibes", title: "x", body: "y" }])]);
    await expectProviderError(() => provider.reviewDocument(DOCUMENT_INPUT), "invalid_response");
  });
});

describe("MistralProvider connection test", () => {
  it("checks the key against the model list and then runs a minimal review", async () => {
    const { provider, requests } = createProvider([
      response(200, { data: [{ id: "mistral-large-latest" }] }),
      reviewResponse([]),
    ]);

    await expect(provider.validateConfiguration()).resolves.toBeUndefined();

    expect(requests).toHaveLength(2);
    expect(requests[0]?.url).toBe("https://api.mistral.ai/v1/models");
    expect(requests[0]?.method).toBe("GET");
    expect(requests[1]?.url).toBe("https://api.mistral.ai/v1/chat/completions");
  });

  it("reports a rejected key from the first call", async () => {
    const { provider, requests } = createProvider([response(401, { message: "Unauthorized" })]);

    await expectProviderError(() => provider.validateConfiguration(), "unauthorized");
    expect(requests).toHaveLength(1);
  });
});

describe("MistralProvider replies and fixes", () => {
  it("returns reply text", async () => {
    const { provider } = createProvider([chatResponse("Because the sample was small.")]);
    await expect(
      provider.replyToComment({ systemPrompt: "s", userPrompt: "u" }),
    ).resolves.toBe("Because the sample was small.");
  });

  it("returns a validated fix with a timestamp", async () => {
    const { provider } = createProvider([
      chatResponse(JSON.stringify({ replacement: "was more accurate in this study", explanation: null })),
    ]);

    const fix = await provider.generateFix({ systemPrompt: "s", userPrompt: "u" });
    expect(fix.replacement).toBe("was more accurate in this study");
    expect(fix.generatedAt).toBeGreaterThan(0);
  });
});

describe("MistralProvider cancellation", () => {
  it("does not send a request that was already aborted", async () => {
    const { provider, requests } = createProvider([reviewResponse()]);
    const controller = new AbortController();
    controller.abort();

    await expect(provider.review(REVIEW_INPUT, controller.signal)).rejects.toThrow(/abort/i);
    expect(requests).toHaveLength(0);
  });
});
