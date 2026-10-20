import { describe, expect, it } from "vitest";

import { AnthropicProvider } from "../src/providers/anthropic-provider";
import type { HttpRequest, HttpResponse, HttpTransport } from "../src/providers/http";
import type { ProviderRequestConfig } from "../src/providers/provider";
import { isProviderError } from "../src/providers/provider-errors";

const API_KEY = "sk-ant-000111222333";

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
    model: "claude-sonnet-5",
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

/** Anthropic returns content as an array of typed parts. */
function textResponse(text: string): HttpResponse {
  return response(200, { content: [{ type: "text", text }] });
}

function reviewResponse(comments: unknown[] = [COMMENT]): HttpResponse {
  return response(200, {
    content: [{ type: "text", text: JSON.stringify({ comments }) }],
    usage: { input_tokens: 500, output_tokens: 80 },
  });
}

function createProvider(
  responses: HttpResponse[],
  overrides: Partial<ProviderRequestConfig> = {},
): { provider: AnthropicProvider; requests: HttpRequest[] } {
  const requests: HttpRequest[] = [];
  let index = 0;

  const transport: HttpTransport = (request) => {
    requests.push(request);
    const next = responses[Math.min(index, responses.length - 1)];
    index += 1;
    return Promise.resolve(next ?? response(200, {}));
  };

  return {
    provider: new AnthropicProvider({ config: () => config(overrides), transport }),
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

describe("AnthropicProvider request shape", () => {
  it("posts to the messages endpoint with the vendor's own headers", async () => {
    const { provider, requests } = createProvider([reviewResponse()]);
    await provider.review(REVIEW_INPUT);

    expect(requests[0]?.url).toBe("https://api.anthropic.com/v1/messages");
    expect(requests[0]?.method).toBe("POST");
    expect(requests[0]?.headers["x-api-key"]).toBe(API_KEY);
    expect(requests[0]?.headers["anthropic-version"]).toBe("2023-06-01");
    expect(requests[0]?.headers.Authorization).toBeUndefined();
  });

  // Anthropic takes the system prompt as its own field, not as a message.
  it("sends the system prompt at the top level", async () => {
    const { provider, requests } = createProvider([reviewResponse()]);
    await provider.review(REVIEW_INPUT);

    const body = bodyOf(requests[0]!);
    expect(body.system).toBe(REVIEW_INPUT.systemPrompt);
    expect(body.messages).toEqual([{ role: "user", content: REVIEW_INPUT.userPrompt }]);
  });

  it("always sends max_tokens, which this vendor requires", async () => {
    const { provider, requests } = createProvider([
      reviewResponse(),
      textResponse(JSON.stringify({ observations: [] })),
      textResponse("A reply."),
      textResponse(JSON.stringify({ replacement: "Some studies." })),
    ]);

    await provider.review({ ...REVIEW_INPUT, maxComments: 4 });
    await provider.reviewDocument({ systemPrompt: "s", userPrompt: "u", maxObservations: 2 });
    await provider.replyToComment({ systemPrompt: "s", userPrompt: "u" });
    await provider.generateFix({ systemPrompt: "s", userPrompt: "u" });

    for (const request of requests) {
      expect(typeof bodyOf(request).max_tokens).toBe("number");
    }
    expect(bodyOf(requests[0]!).max_tokens).toBe(1400);
  });

  it("asks for structured output through output_config", async () => {
    const { provider, requests } = createProvider([reviewResponse()]);
    await provider.review(REVIEW_INPUT);

    const body = bodyOf(requests[0]!);
    expect(dig(body, "output_config.format.type")).toBe("json_schema");
    expect(dig(body, "output_config.format.schema.required")).toEqual(["comments"]);
  });

  // The documented schema subset does not include the anyOf form our schemas
  // use for optional fields, so the null branch is removed for this vendor.
  it("sends a schema with the nullable unions collapsed", async () => {
    const { provider, requests } = createProvider([reviewResponse()]);
    await provider.review(REVIEW_INPUT);

    const item = dig(
      bodyOf(requests[0]!),
      "output_config.format.schema.properties.comments.items",
    );

    expect(dig(item, "properties.rationale")).toEqual({ type: "string" });
    expect(dig(item, "required")).not.toContain("rationale");
  });

  it("reads a review out of the array of content parts", async () => {
    const { provider } = createProvider([reviewResponse()]);
    const result = await provider.review(REVIEW_INPUT);

    expect(result.comments).toHaveLength(1);
    expect(result.comments[0]?.quote).toBe("always more accurate");
    expect(result.usage).toEqual({ inputTokens: 500, outputTokens: 80 });
  });

  it("uses a configured base URL", async () => {
    const { provider, requests } = createProvider([reviewResponse()], {
      baseUrl: "https://proxy.example.com/anthropic/",
    });
    await provider.review(REVIEW_INPUT);

    expect(requests[0]?.url).toBe("https://proxy.example.com/anthropic/v1/messages");
  });
});

describe("AnthropicProvider structured output fallback", () => {
  // Current models answer a sampling parameter with a 400, and their structured
  // output refuses numeric bounds, which would cost a second, schema-less request.
  it("sends neither sampling parameters nor schema constraints the API refuses", async () => {
    const { provider, requests } = createProvider([reviewResponse()]);

    await provider.review(REVIEW_INPUT);

    const sent = JSON.stringify(bodyOf(requests[0]!));
    expect(bodyOf(requests[0]!).temperature).toBeUndefined();
    expect(sent).not.toContain('"minimum"');
    expect(sent).not.toContain('"maximum"');
  });

  it("says so when the reply was cut off or declined, rather than failing to parse it", async () => {
    const { provider } = createProvider([
      response(200, { content: [{ type: "text", text: '{"comments": [' }], stop_reason: "max_tokens" }),
      response(200, { content: [], stop_reason: "refusal" }),
    ]);

    await expect(provider.review(REVIEW_INPUT)).rejects.toMatchObject({
      code: "output_truncated",
      message: expect.stringContaining("cut off"),
    });
    await expect(provider.review(REVIEW_INPUT)).rejects.toMatchObject({ code: "provider_error" });
  });

  it("asks for a fix again without the schema when the schema is refused", async () => {
    const { provider, requests } = createProvider([
      response(400, { error: { message: "output_config is not supported for this model" } }),
      textResponse(JSON.stringify({ replacement: "Some studies." })),
    ]);

    const fix = await provider.generateFix({ systemPrompt: "s", userPrompt: "u" });

    expect(fix.replacement).toBe("Some studies.");
    expect(bodyOf(requests[1]!).output_config).toBeUndefined();
  });

  // There is no weaker structured mode here, so the retry carries no schema at
  // all and the shared parser recovers the JSON.
  it("drops structured output entirely when the schema is refused", async () => {
    const { provider, requests } = createProvider([
      response(400, { error: { message: "output_config is not supported for this model" } }),
      response(200, {
        content: [{ type: "text", text: '```json\n{"comments": []}\n```' }],
      }),
    ]);

    const result = await provider.review(REVIEW_INPUT);

    expect(result.comments).toEqual([]);
    expect(requests).toHaveLength(2);
    expect(bodyOf(requests[1]!).output_config).toBeUndefined();
    expect(bodyOf(requests[1]!).max_tokens).toBe(1150);
  });

  it("does not retry a failure that has nothing to do with the schema", async () => {
    const { provider, requests } = createProvider([
      response(400, { error: { message: "model claude-nonsense does not exist" } }),
    ]);

    await expect(provider.review(REVIEW_INPUT)).rejects.toThrow();
    expect(requests).toHaveLength(1);
  });
});

describe("AnthropicProvider configuration", () => {
  it("sends nothing at all without a key", async () => {
    const { provider, requests } = createProvider([reviewResponse()], { apiKey: "" });

    await expect(provider.review(REVIEW_INPUT)).rejects.toSatisfy(
      (error: unknown) => isProviderError(error) && error.code === "missing_key",
    );
    expect(requests).toHaveLength(0);
  });

  it("checks the key and the model when testing the connection", async () => {
    const { provider, requests } = createProvider([
      response(200, { data: [] }),
      reviewResponse([]),
    ]);

    await provider.validateConfiguration();

    expect(requests[0]?.url).toBe("https://api.anthropic.com/v1/models");
    expect(requests[0]?.method).toBe("GET");
    expect(requests[1]?.url).toBe("https://api.anthropic.com/v1/messages");
  });
});
