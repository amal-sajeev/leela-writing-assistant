import { describe, expect, it } from "vitest";

import type { HttpRequest, HttpResponse, HttpTransport } from "../src/providers/http";
import { OpenRouterProvider } from "../src/providers/openrouter-provider";
import type { ProviderRequestConfig } from "../src/providers/provider";

function response(body: unknown): HttpResponse {
  return { status: 200, headers: {}, text: JSON.stringify(body) };
}

describe("OpenRouterProvider", () => {
  it("uses the OpenRouter endpoint and the configured free router model", async () => {
    const requests: HttpRequest[] = [];
    const config: ProviderRequestConfig = {
      apiKey: "test-openrouter-key",
      apiKeys: ["test-openrouter-key"],
      model: "openrouter/free",
      timeoutMs: 5_000,
      maxRetries: 0,
      retryInitialDelayMs: 1,
    };
    const transport: HttpTransport = (request) => {
      requests.push(request);
      return Promise.resolve(response({
        choices: [{ message: { content: JSON.stringify({ comments: [] }) } }],
      }));
    };
    const provider = new OpenRouterProvider({ config: () => config, transport });

    await provider.review({ systemPrompt: "Review as JSON.", userPrompt: "Text.", maxComments: 1 });

    expect(provider.id).toBe("openrouter");
    expect(provider.displayName).toBe("OpenRouter");
    expect(requests[0]?.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(requests[0]?.headers.Authorization).toBe("Bearer test-openrouter-key");
    expect(JSON.parse(requests[0]?.body ?? "{}")).toMatchObject({ model: "openrouter/free" });
    expect(JSON.parse(requests[0]?.body ?? "{}")).not.toHaveProperty("store");
  });

  it("allows a configured compatible endpoint override", async () => {
    const requests: HttpRequest[] = [];
    const config: ProviderRequestConfig = {
      apiKey: "test-openrouter-key",
      apiKeys: ["test-openrouter-key"],
      model: "openrouter/free",
      baseUrl: "https://gateway.example.test/v1/",
      timeoutMs: 5_000,
      maxRetries: 0,
      retryInitialDelayMs: 1,
    };
    const transport: HttpTransport = (request) => {
      requests.push(request);
      return Promise.resolve(response({
        choices: [{ message: { content: JSON.stringify({ comments: [] }) } }],
      }));
    };

    await new OpenRouterProvider({ config: () => config, transport }).review({
      systemPrompt: "Review as JSON.",
      userPrompt: "Text.",
      maxComments: 1,
    });

    expect(requests[0]?.url).toBe("https://gateway.example.test/v1/chat/completions");
  });

  it("uses the same endpoint for chat replies", async () => {
    const requests: HttpRequest[] = [];
    const config: ProviderRequestConfig = {
      apiKey: "test-openrouter-key",
      apiKeys: ["test-openrouter-key"],
      model: "openrouter/free",
      timeoutMs: 5_000,
      maxRetries: 0,
      retryInitialDelayMs: 1,
    };
    const transport: HttpTransport = (request) => {
      requests.push(request);
      return Promise.resolve(response({ choices: [{ message: { content: "A fuller reply." } }] }));
    };

    const answer = await new OpenRouterProvider({ config: () => config, transport }).replyToComment({
      systemPrompt: "Answer clearly.",
      userPrompt: "Explain this choice.",
    });

    expect(answer).toBe("A fuller reply.");
    expect(requests[0]?.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(JSON.parse(requests[0]?.body ?? "{}").model).toBe("openrouter/free");
  });
});
