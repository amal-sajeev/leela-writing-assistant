import { describe, expect, it } from "vitest";

import {
  isModelFallbackError,
  uniqueModels,
  withModelFallback,
} from "../src/providers/model-fallback";
import { isProviderError, ProviderError } from "../src/providers/provider-errors";

/** Fallback models: when one model cannot serve, try the next configured name. */

const PRIMARY = "model-primary";
const SECOND = "model-second";
const THIRD = "model-third";

function failure(code: ConstructorParameters<typeof ProviderError>[0], status?: number): ProviderError {
  return new ProviderError(code, "failed", false, status);
}

describe("uniqueModels", () => {
  it("drops blanks and exact duplicates while keeping order", () => {
    expect(uniqueModels([" a ", "", "a", "b", " a "])).toEqual(["a", "b"]);
  });
});

describe("isModelFallbackError", () => {
  it("falls back for a missing model, a rate limit, quota and server errors", () => {
    expect(isModelFallbackError(failure("model_not_found", 404))).toBe(true);
    expect(isModelFallbackError(failure("rate_limited", 429))).toBe(true);
    expect(isModelFallbackError(failure("quota", 402))).toBe(true);
    expect(isModelFallbackError(failure("provider_error", 500))).toBe(true);
    expect(isModelFallbackError(failure("provider_error", 503))).toBe(true);
  });

  it("does not fall back for a bad key, a bad request or a bad answer", () => {
    expect(isModelFallbackError(failure("missing_key"))).toBe(false);
    expect(isModelFallbackError(failure("unauthorized", 401))).toBe(false);
    expect(isModelFallbackError(failure("provider_error", 400))).toBe(false);
    expect(isModelFallbackError(failure("invalid_response"))).toBe(false);
    expect(isModelFallbackError(failure("output_truncated"))).toBe(false);
    expect(isModelFallbackError(failure("timeout"))).toBe(false);
    expect(isModelFallbackError(failure("network"))).toBe(false);
  });
});

describe("withModelFallback", () => {
  it("tries the next model after an unknown model", async () => {
    const tried: string[] = [];

    const result = await withModelFallback({
      model: PRIMARY,
      fallbackModels: [SECOND, THIRD],
      run: async (model) => {
        tried.push(model);
        if (model === PRIMARY) throw failure("model_not_found", 404);
        return model;
      },
    });

    expect(result).toBe(SECOND);
    expect(tried).toEqual([PRIMARY, SECOND]);
  });

  it("tries the next model when the provider says the model is unavailable", async () => {
    const tried: string[] = [];

    const result = await withModelFallback({
      model: PRIMARY,
      fallbackModels: [SECOND],
      run: async (model) => {
        tried.push(model);
        if (model === PRIMARY) throw failure("provider_error", 503);
        return model;
      },
    });

    expect(result).toBe(SECOND);
    expect(tried).toEqual([PRIMARY, SECOND]);
  });

  it("tries the next model after a rate limit or quota", async () => {
    const result = await withModelFallback({
      model: PRIMARY,
      fallbackModels: [SECOND],
      run: async (model) => {
        if (model === PRIMARY) throw failure("rate_limited", 429);
        return model;
      },
    });

    expect(result).toBe(SECOND);

    const quota = await withModelFallback({
      model: PRIMARY,
      fallbackModels: [SECOND],
      run: async (model) => {
        if (model === PRIMARY) throw failure("quota", 402);
        return model;
      },
    });

    expect(quota).toBe(SECOND);
  });

  it("does not try another model for a rejected key", async () => {
    const tried: string[] = [];

    await expect(
      withModelFallback({
        model: PRIMARY,
        fallbackModels: [SECOND],
        run: async (model) => {
          tried.push(model);
          throw failure("unauthorized", 401);
        },
      }),
    ).rejects.toSatisfy((error: unknown) => isProviderError(error) && error.code === "unauthorized");

    expect(tried).toEqual([PRIMARY]);
  });

  it("does not try another model for a bad request", async () => {
    const tried: string[] = [];

    await expect(
      withModelFallback({
        model: PRIMARY,
        fallbackModels: [SECOND],
        run: async (model) => {
          tried.push(model);
          throw failure("provider_error", 400);
        },
      }),
    ).rejects.toSatisfy((error: unknown) => isProviderError(error) && error.status === 400);

    expect(tried).toEqual([PRIMARY]);
  });

  it("throws the last model failure when every model is unavailable", async () => {
    const tried: string[] = [];

    await expect(
      withModelFallback({
        model: PRIMARY,
        fallbackModels: [SECOND, THIRD],
        run: async (model) => {
          tried.push(model);
          throw failure("model_not_found", 404);
        },
      }),
    ).rejects.toSatisfy((error: unknown) => isProviderError(error) && error.code === "model_not_found");

    expect(tried).toEqual([PRIMARY, SECOND, THIRD]);
  });

  it("tries each model once, skipping blanks and duplicates", async () => {
    const tried: string[] = [];

    const result = await withModelFallback({
      model: ` ${PRIMARY} `,
      fallbackModels: ["", PRIMARY, SECOND, ` ${SECOND} `],
      run: async (model) => {
        tried.push(model);
        if (model === PRIMARY) throw failure("model_not_found", 404);
        return model;
      },
    });

    expect(result).toBe(SECOND);
    expect(tried).toEqual([PRIMARY, SECOND]);
  });

  it("refuses to run without a model", async () => {
    await expect(
      withModelFallback({
        model: "  ",
        fallbackModels: ["", " "],
        run: async () => "ok",
      }),
    ).rejects.toSatisfy((error: unknown) => isProviderError(error) && error.code === "model_not_found");
  });

  it("passes a cancelled request straight through", async () => {
    const abort = new Error("Request aborted");
    abort.name = "AbortError";

    await expect(
      withModelFallback({
        model: PRIMARY,
        fallbackModels: [SECOND],
        run: async () => {
          throw abort;
        },
      }),
    ).rejects.toBe(abort);
  });
});
