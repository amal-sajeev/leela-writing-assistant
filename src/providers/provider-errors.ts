import { PROVIDER_DISPLAY_NAMES } from "../constants";
import type { ProviderId } from "../types";

export const PROVIDER_ERROR_CODES = [
  "missing_key",
  "unauthorized",
  "rate_limited",
  "quota",
  "timeout",
  "network",
  "invalid_response",
  "output_truncated",
  "model_not_found",
  "provider_error",
] as const;

export type ProviderErrorCode = (typeof PROVIDER_ERROR_CODES)[number];

/**
 * Every provider failure reaches the rest of the plugin as this type
 * (specification section 11). Raw HTTP bodies must not be surfaced by default.
 */
export class ProviderError extends Error {
  constructor(
    public readonly code: ProviderErrorCode,
    message: string,
    public readonly retryable: boolean,
    public readonly status?: number,
    /** Honoured by the retry backoff when a provider sends `Retry-After`. */
    public readonly retryAfterMs?: number,
    /** Safe provider metadata, never raw response content. */
    public readonly completion?: { finishReason?: string; stopReason?: string; requestId?: string },
  ) {
    super(message);
    this.name = "ProviderError";
  }

  withRetryAfter(retryAfterMs: number): ProviderError {
    return new ProviderError(this.code, this.message, this.retryable, this.status, retryAfterMs, this.completion);
  }
}

export function isProviderError(error: unknown): error is ProviderError {
  return error instanceof ProviderError;
}

const RETRYABLE_CODES: ReadonlySet<ProviderErrorCode> = new Set([
  "rate_limited",
  "timeout",
  "network",
  "provider_error",
]);

export function isRetryableCode(code: ProviderErrorCode): boolean {
  return RETRYABLE_CODES.has(code);
}

/**
 * Compact, recoverable wording for notices and the panel
 * (specification section 36). Never includes response bodies or keys.
 */
export function describeProviderError(error: ProviderError, provider?: ProviderId): string {
  const name = provider ? PROVIDER_DISPLAY_NAMES[provider] : "The AI provider";

  switch (error.code) {
    case "missing_key":
      return `${name} API key is not configured.`;
    case "unauthorized":
      return `${name} API key was rejected.`;
    case "rate_limited":
      return "Rate limited. Review will retry shortly.";
    case "quota":
      return `${name} reported that the account has no remaining quota.`;
    case "timeout":
      return `${name} did not respond in time. No comments were added.`;
    case "network":
      return "Network unavailable. Review will retry when the connection returns.";
    case "invalid_response":
      return "The model returned an invalid review. No comments were added.";
    case "output_truncated":
      return "The provider stopped before the review finished.";
    case "model_not_found":
      return `${name} does not recognise the configured model.`;
    case "provider_error":
      return `${name} returned an error. No comments were added.`;
  }
}

/** Normalizes an unknown thrown value without leaking provider internals. */
export function toProviderError(error: unknown, fallbackMessage = "Provider request failed"): ProviderError {
  if (isProviderError(error)) return error;
  if (error instanceof Error && error.name === "TimeoutError") {
    return new ProviderError("timeout", error.message, true);
  }
  if (error instanceof Error && error.name === "AbortError") {
    return new ProviderError("network", "Request aborted", false);
  }
  return new ProviderError("provider_error", fallbackMessage, true);
}
