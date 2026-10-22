import { describe, expect, it } from "vitest";

import { errorFromStatus, send, type HttpRequest, type HttpResponse, type SendOptions } from "../src/providers/http";
import { isProviderError } from "../src/providers/provider-errors";
import { maskKey, redactHeaders, redactSecrets } from "../src/privacy/redaction";

const REQUEST: HttpRequest = {
  url: "https://api.example.test/v1/chat/completions",
  method: "POST",
  headers: { Authorization: "Bearer sk-secret-key-value" },
  body: "{}",
};

function options(overrides: Partial<SendOptions> = {}): SendOptions {
  return {
    transport: () => Promise.resolve({ status: 200, headers: {}, text: "{}" }),
    timeoutMs: 1_000,
    maxRetries: 0,
    retryInitialDelayMs: 1,
    ...overrides,
  };
}

function replay(...responses: HttpResponse[]): { transport: SendOptions["transport"]; calls: number } {
  const state = { calls: 0 };
  const transport: SendOptions["transport"] = () => {
    const next = responses[Math.min(state.calls, responses.length - 1)]!;
    state.calls += 1;
    return Promise.resolve(next);
  };

  return {
    transport,
    get calls() {
      return state.calls;
    },
  };
}

describe("send", () => {
  it("returns a successful response with a request id", async () => {
    const result = await send(REQUEST, options());
    expect(result.status).toBe(200);
    expect(result.requestId).toMatch(/^req/);
  });

  it("retries retryable failures up to the configured limit", async () => {
    const transport = replay({ status: 503, headers: {}, text: "unavailable" });
    await expect(send(REQUEST, options({ transport: transport.transport, maxRetries: 2 }))).rejects.toThrow();
    expect(transport.calls).toBe(3);
  });

  it("stops immediately on a client error", async () => {
    const transport = replay({ status: 400, headers: {}, text: "bad request" });
    await expect(send(REQUEST, options({ transport: transport.transport, maxRetries: 3 }))).rejects.toThrow();
    expect(transport.calls).toBe(1);
  });

  it("maps a transport failure to a retryable network error", async () => {
    const failing = () => Promise.reject(new Error("getaddrinfo ENOTFOUND"));

    await expect(send(REQUEST, options({ transport: failing }))).rejects.toSatisfy((error: unknown) => {
      return isProviderError(error) && error.code === "network" && error.retryable;
    });
  });

  it("maps a slow response to a timeout", async () => {
    const slow = () =>
      new Promise<HttpResponse>((resolve) => {
        setTimeout(() => resolve({ status: 200, headers: {}, text: "{}" }), 50);
      });

    await expect(send(REQUEST, options({ transport: slow, timeoutMs: 5 }))).rejects.toSatisfy(
      (error: unknown) => isProviderError(error) && error.code === "timeout",
    );
  });

  it("does not send an already aborted request", async () => {
    const transport = replay({ status: 200, headers: {}, text: "{}" });
    const controller = new AbortController();
    controller.abort();

    await expect(
      send(REQUEST, options({ transport: transport.transport, signal: controller.signal })),
    ).rejects.toThrow(/abort/i);
    expect(transport.calls).toBe(0);
  });
});

describe("errorFromStatus", () => {
  it("maps the statuses providers actually return", () => {
    const cases: Array<[number, string, string]> = [
      [401, "Unauthorized", "unauthorized"],
      [403, "Forbidden", "unauthorized"],
      [402, "Payment required", "quota"],
      [429, "Rate limit exceeded", "rate_limited"],
      [429, "Monthly quota exceeded", "quota"],
      [404, "Invalid model: nope", "model_not_found"],
      [400, "API key not valid. Please pass a valid API key.", "unauthorized"],
      [400, "Invalid API key provided", "unauthorized"],
      [400, "Invalid schema for response_format", "provider_error"],
      [500, "Internal error", "provider_error"],
    ];

    for (const [status, body, code] of cases) {
      expect(errorFromStatus({ status, headers: {}, text: body }).code).toBe(code);
    }
  });

  it("marks server faults and rate limits as retryable, client errors as not", () => {
    expect(errorFromStatus({ status: 500, headers: {}, text: "" }).retryable).toBe(true);
    expect(errorFromStatus({ status: 429, headers: {}, text: "" }).retryable).toBe(true);
    expect(errorFromStatus({ status: 400, headers: {}, text: "" }).retryable).toBe(false);
    expect(errorFromStatus({ status: 401, headers: {}, text: "" }).retryable).toBe(false);
  });

  it("reads Retry-After in seconds and as a date", () => {
    const seconds = errorFromStatus({ status: 429, headers: { "retry-after": "2" }, text: "" });
    expect(seconds.retryAfterMs).toBe(2000);

    const future = new Date(Date.now() + 3000).toUTCString();
    const asDate = errorFromStatus({ status: 429, headers: { "retry-after": future }, text: "" });
    expect(asDate.retryAfterMs ?? 0).toBeGreaterThan(0);
  });

  it("truncates and redacts the response body it keeps for logs", () => {
    const error = errorFromStatus(
      { status: 400, headers: {}, text: `key sk-secret-key-value failed. ${"x".repeat(500)}` },
      ["sk-secret-key-value"],
    );

    expect(error.message).not.toContain("sk-secret-key-value");
    expect(error.message).toContain("[redacted]");
    expect(error.message.length).toBeLessThan(300);
  });
});

describe("redaction", () => {
  it("replaces authentication headers", () => {
    expect(redactHeaders({ Authorization: "Bearer sk-1234567890", Accept: "application/json" })).toEqual({
      Authorization: "[redacted]",
      Accept: "application/json",
    });
  });

  it("removes known secrets and anything shaped like a bearer token", () => {
    expect(redactSecrets("using sk-abcdefgh1234", ["sk-abcdefgh1234"])).toBe("using [redacted]");
    expect(redactSecrets("Authorization: Bearer abcdefgh12345678")).toBe("Authorization: Bearer [redacted]");
  });

  it("never reveals key material when masking for display", () => {
    expect(maskKey("sk-abcdefgh1234")).not.toContain("abcdefgh");
    expect(maskKey("")).toBe("not set");
  });
});
