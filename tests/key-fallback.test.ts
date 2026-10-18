import { describe, expect, it } from "vitest";

import { send, type HttpRequest, type HttpResponse } from "../src/providers/http";
import {
  isKeyRotationError,
  uniqueKeys,
  withApiKeyFallback,
  rotationSkipRetry,
} from "../src/providers/key-fallback";
import { MistralProvider } from "../src/providers/mistral-provider";
import type { ProviderRequestConfig } from "../src/providers/provider";
import { isProviderError, ProviderError } from "../src/providers/provider-errors";
import { providerApiKeys } from "../src/settings/settings";

/**
 * Multiple keys for one provider: when the first is spent, try the next
 * rather than waiting out a rate-limit backoff on a key that cannot serve.
 */

const PRIMARY = "sk-primary-000111222333444";
const FALLBACK = "sk-fallback-555666777888999";

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

function reviewBody(): HttpResponse {
  return {
    status: 200,
    headers: {},
    text: JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ comments: [COMMENT] }) } }],
    }),
  };
}

function limited(): HttpResponse {
  return { status: 429, headers: { "retry-after": "60" }, text: "rate limit exceeded" };
}

function unauthorized(): HttpResponse {
  return { status: 401, headers: {}, text: "invalid api key" };
}

describe("uniqueKeys", () => {
  it("drops blanks and exact duplicates while keeping order", () => {
    expect(uniqueKeys([" a ", "", "a", "b", " a "])).toEqual(["a", "b"]);
  });
});

describe("providerApiKeys", () => {
  it("lists the primary key then the fallbacks", () => {
    expect(
      providerApiKeys({ apiKey: PRIMARY, fallbackKeys: [FALLBACK, PRIMARY, ""], model: "m" }),
    ).toEqual([PRIMARY, FALLBACK]);
  });

  it("treats an empty primary as absent", () => {
    expect(providerApiKeys({ apiKey: "  ", fallbackKeys: [FALLBACK], model: "m" })).toEqual([
      FALLBACK,
    ]);
  });
});

describe("isKeyRotationError", () => {
  it("rotates on rate limits, rejected keys and quota, not on model errors", () => {
    expect(isKeyRotationError(new ProviderError("rate_limited", "", true, 429))).toBe(true);
    expect(isKeyRotationError(new ProviderError("unauthorized", "", false, 401))).toBe(true);
    expect(isKeyRotationError(new ProviderError("quota", "", false, 402))).toBe(true);
    expect(isKeyRotationError(new ProviderError("model_not_found", "", false, 404))).toBe(false);
    expect(isKeyRotationError(new ProviderError("network", "", true))).toBe(false);
  });
});

describe("withApiKeyFallback", () => {
  it("tries the next key after a rate limit", async () => {
    const tried: string[] = [];

    const result = await withApiKeyFallback({
      keys: [PRIMARY, FALLBACK],
      missingKeyMessage: "missing",
      run: async (apiKey) => {
        tried.push(apiKey);
        if (apiKey === PRIMARY) {
          throw new ProviderError("rate_limited", "slow down", true, 429);
        }
        return "ok";
      },
    });

    expect(result).toBe("ok");
    expect(tried).toEqual([PRIMARY, FALLBACK]);
  });

  it("does not rotate on a model error", async () => {
    const tried: string[] = [];

    await expect(
      withApiKeyFallback({
        keys: [PRIMARY, FALLBACK],
        missingKeyMessage: "missing",
        run: async (apiKey) => {
          tried.push(apiKey);
          throw new ProviderError("model_not_found", "unknown model", false, 404);
        },
      }),
    ).rejects.toSatisfy((error: unknown) => isProviderError(error) && error.code === "model_not_found");

    expect(tried).toEqual([PRIMARY]);
  });

  it("surfaces missing_key when nothing is configured", async () => {
    await expect(
      withApiKeyFallback({
        keys: ["", "  "],
        missingKeyMessage: "No key",
        run: async () => "ok",
      }),
    ).rejects.toSatisfy((error: unknown) => isProviderError(error) && error.code === "missing_key");
  });
});

describe("rotationSkipRetry", () => {
  it("skips the rate-limit backoff only while another key is waiting", () => {
    const apiKeys = [PRIMARY, FALLBACK];

    expect(rotationSkipRetry({ apiKey: PRIMARY, apiKeys })).toEqual({ skipRetryFor: ["rate_limited"] });
    expect(rotationSkipRetry({ apiKey: FALLBACK, apiKeys })).toEqual({});
    expect(rotationSkipRetry({ apiKey: PRIMARY, apiKeys: [PRIMARY] })).toEqual({});
  });
});

describe("send skipRetryFor", () => {
  it("throws a rate limit on the first attempt when asked not to retry it", async () => {
    let calls = 0;
    const request: HttpRequest = {
      url: "https://api.example.test/v1",
      method: "POST",
      headers: {},
      body: "{}",
    };

    await expect(
      send(request, {
        transport: () => {
          calls += 1;
          return Promise.resolve(limited());
        },
        timeoutMs: 1_000,
        maxRetries: 3,
        retryInitialDelayMs: 1,
        skipRetryFor: ["rate_limited"],
      }),
    ).rejects.toSatisfy((error: unknown) => isProviderError(error) && error.code === "rate_limited");

    expect(calls).toBe(1);
  });
});

describe("MistralProvider key rotation", () => {
  it("uses the fallback key after the primary is rate-limited", async () => {
    const requests: HttpRequest[] = [];
    const queue = [limited(), reviewBody()];

    const config = (): ProviderRequestConfig => ({
      apiKey: PRIMARY,
      apiKeys: [PRIMARY, FALLBACK],
      model: "mistral-large-latest",
      timeoutMs: 5_000,
      maxRetries: 2,
      retryInitialDelayMs: 1,
    });

    const provider = new MistralProvider({
      config,
      transport: (request) => {
        requests.push(request);
        return Promise.resolve(queue.shift() ?? reviewBody());
      },
    });

    const result = await provider.review(REVIEW_INPUT);

    expect(result.comments).toHaveLength(1);
    expect(requests).toHaveLength(2);
    expect(requests[0]?.headers.Authorization).toBe(`Bearer ${PRIMARY}`);
    expect(requests[1]?.headers.Authorization).toBe(`Bearer ${FALLBACK}`);
  });

  it("uses the fallback key after the primary is rejected", async () => {
    const requests: HttpRequest[] = [];
    const queue = [unauthorized(), reviewBody()];

    const provider = new MistralProvider({
      config: () => ({
        apiKey: PRIMARY,
        apiKeys: [PRIMARY, FALLBACK],
        model: "mistral-large-latest",
        timeoutMs: 5_000,
        maxRetries: 0,
        retryInitialDelayMs: 1,
      }),
      transport: (request) => {
        requests.push(request);
        return Promise.resolve(queue.shift() ?? reviewBody());
      },
    });

    await provider.review(REVIEW_INPUT);

    expect(requests.map((request) => request.headers.Authorization)).toEqual([
      `Bearer ${PRIMARY}`,
      `Bearer ${FALLBACK}`,
    ]);
  });

  it("fails with the last rotation error when every key is rate-limited", async () => {
    const provider = new MistralProvider({
      config: () => ({
        apiKey: PRIMARY,
        apiKeys: [PRIMARY, FALLBACK],
        model: "mistral-large-latest",
        timeoutMs: 5_000,
        maxRetries: 0,
        retryInitialDelayMs: 1,
      }),
      transport: () => Promise.resolve(limited()),
    });

    await expect(provider.review(REVIEW_INPUT)).rejects.toSatisfy(
      (error: unknown) => isProviderError(error) && error.code === "rate_limited",
    );
  });
});
