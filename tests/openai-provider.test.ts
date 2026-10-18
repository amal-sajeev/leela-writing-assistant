import { describe, expect, it } from "vitest";

import type { HttpRequest, HttpResponse, HttpTransport } from "../src/providers/http";
import { THINKING_HEADROOM_TOKENS } from "../src/providers/budgets";
import { OpenAIProvider } from "../src/providers/openai-provider";
import type { ProviderRequestConfig } from "../src/providers/provider";
import { isProviderError } from "../src/providers/provider-errors";

const API_KEY = "sk-openai-000111222333";

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
    model: "gpt-5.6-terra",
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

function reviewResponse(comments: unknown[] = [COMMENT]): HttpResponse {
  return response(200, {
    choices: [{ message: { content: JSON.stringify({ comments }) } }],
    usage: { prompt_tokens: 500, completion_tokens: 80 },
  });
}

function createProvider(
  responses: HttpResponse[],
  overrides: Partial<ProviderRequestConfig> = {},
): { provider: OpenAIProvider; requests: HttpRequest[] } {
  const requests: HttpRequest[] = [];
  let index = 0;

  const transport: HttpTransport = (request) => {
    requests.push(request);
    const next = responses[Math.min(index, responses.length - 1)];
    index += 1;
    return Promise.resolve(next ?? response(200, {}));
  };

  return { provider: new OpenAIProvider({ config: () => config(overrides), transport }), requests };
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

describe("OpenAIProvider request shape", () => {
  it("posts to chat completions with bearer auth", async () => {
    const { provider, requests } = createProvider([reviewResponse()]);
    await provider.review(REVIEW_INPUT);

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("https://api.openai.com/v1/chat/completions");
    expect(requests[0]?.method).toBe("POST");
    expect(requests[0]?.headers.Authorization).toBe(`Bearer ${API_KEY}`);
    expect(requests[0]?.headers["Content-Type"]).toBe("application/json");
  });

  it("sends the prompts as system and user messages", async () => {
    const { provider, requests } = createProvider([reviewResponse()]);
    await provider.review(REVIEW_INPUT);

    const body = bodyOf(requests[0]!);
    expect(body.model).toBe("gpt-5.6-terra");
    expect(body.messages).toEqual([
      { role: "system", content: REVIEW_INPUT.systemPrompt },
      { role: "user", content: REVIEW_INPUT.userPrompt },
    ]);
  });

  // The plugin promises your writing is not kept anywhere central, and this
  // surface retains by default.
  it("opts out of OpenAI's own retention on every request", async () => {
    const { provider, requests } = createProvider([
      reviewResponse(),
      response(200, { choices: [{ message: { content: "A reply." } }] }),
      response(200, {
        choices: [{ message: { content: JSON.stringify({ replacement: "Some studies." }) } }],
      }),
    ]);

    await provider.review(REVIEW_INPUT);
    await provider.replyToComment({ systemPrompt: "s", userPrompt: "u" });
    await provider.generateFix({ systemPrompt: "s", userPrompt: "u" });

    for (const request of requests) expect(bodyOf(request).store).toBe(false);
  });

  it("asks for a strict json schema", async () => {
    const { provider, requests } = createProvider([reviewResponse()]);
    await provider.review(REVIEW_INPUT);

    const body = bodyOf(requests[0]!);
    expect(dig(body, "response_format.type")).toBe("json_schema");
    expect(dig(body, "response_format.json_schema.name")).toBe("review");
    expect(dig(body, "response_format.json_schema.strict")).toBe(true);
    expect(dig(body, "response_format.json_schema.schema.required")).toEqual(["comments"]);
  });

  it("keeps the nullable form OpenAI's strict mode requires", async () => {
    const { provider, requests } = createProvider([reviewResponse()]);
    await provider.review(REVIEW_INPUT);

    const item = dig(
      bodyOf(requests[0]!),
      "response_format.json_schema.schema.properties.comments.items",
    );
    expect(dig(item, "properties.rationale.anyOf")).toEqual([{ type: "string" }, { type: "null" }]);
    expect(dig(item, "required")).toContain("rationale");
  });

  it("budgets output tokens by the number of comments asked for", async () => {
    const { provider, requests } = createProvider([reviewResponse()]);
    await provider.review({ ...REVIEW_INPUT, maxComments: 4 });

    expect(bodyOf(requests[0]!).max_completion_tokens).toBe(1400 + THINKING_HEADROOM_TOKENS);
  });

  it("uses a configured base URL", async () => {
    const { provider, requests } = createProvider([reviewResponse()], {
      baseUrl: "https://proxy.example.com/openai/",
    });
    await provider.review(REVIEW_INPUT);

    expect(requests[0]?.url).toBe("https://proxy.example.com/openai/chat/completions");
  });
});

describe("OpenAIProvider structured output fallback", () => {
  it("retries in JSON mode when the model rejects the schema", async () => {
    const { provider, requests } = createProvider([
      response(400, { error: { message: "Invalid schema for response_format" } }),
      reviewResponse(),
    ]);

    const result = await provider.review(REVIEW_INPUT);

    expect(result.comments).toHaveLength(1);
    expect(requests).toHaveLength(2);
    expect(bodyOf(requests[1]!).response_format).toEqual({ type: "json_object" });
  });

  it("does not retry a failure that has nothing to do with the schema", async () => {
    const { provider, requests } = createProvider([
      response(400, { error: { message: "model gpt-nonsense does not exist" } }),
    ]);

    await expect(provider.review(REVIEW_INPUT)).rejects.toThrow();
    expect(requests).toHaveLength(1);
  });
});

describe("OpenAIProvider configuration", () => {
  it("sends nothing at all without a key", async () => {
    const { provider, requests } = createProvider([reviewResponse()], { apiKey: "  " });

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

    expect(requests[0]?.url).toBe("https://api.openai.com/v1/models");
    expect(requests[0]?.method).toBe("GET");
    expect(requests[1]?.url).toBe("https://api.openai.com/v1/chat/completions");
  });
});
