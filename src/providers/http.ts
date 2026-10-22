import { sanitizeErrorDetail } from "../privacy/redaction";
import { isAbortError, sleep, TimeoutError, withTimeout } from "../utils/async";
import { createId } from "../utils/ids";
import type { Logger } from "../utils/logger";
import { ProviderError, type ProviderErrorCode } from "./provider-errors";

/**
 * Centralized HTTP behaviour for providers (specification section 68).
 *
 * Providers own their endpoint shapes; this module owns timeouts, retries,
 * status mapping, request ids and making sure no secret or response body
 * escapes into a user-visible message.
 */

export interface HttpRequest {
  url: string;
  method: "GET" | "POST";
  headers: Record<string, string>;
  body?: string;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  text: string;
}

/**
 * Pluggable transport. The Obsidian implementation lives in `transport.ts`;
 * tests supply a fake so no network or app instance is required.
 */
export type HttpTransport = (request: HttpRequest) => Promise<HttpResponse>;

export interface SendOptions {
  transport: HttpTransport;
  timeoutMs: number;
  maxRetries: number;
  retryInitialDelayMs: number;
  /** Values that must never appear in an error message or log. */
  secrets?: readonly string[];
  /**
   * Codes that must not be retried even when they are ordinarily retryable.
   * Used when another API key is waiting: sitting out a rate-limit backoff on
   * a spent key is slower than trying the next one.
   */
  skipRetryFor?: readonly ProviderErrorCode[];
  logger?: Logger;
  /**
   * Cooperative cancellation. `requestUrl` cannot abort an in-flight request,
   * so an aborted call still completes on the wire and its result is discarded.
   */
  signal?: AbortSignal;
}

export interface SendResult {
  status: number;
  headers: Record<string, string>;
  text: string;
  requestId: string;
}

/** Sends a request, retrying retryable failures with exponential backoff. */
export async function send(request: HttpRequest, options: SendOptions): Promise<SendResult> {
  const requestId = createId("req");
  const attempts = Math.max(0, options.maxRetries) + 1;
  let lastError: ProviderError | undefined;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    throwIfAborted(options.signal);

    const startedAt = Date.now();
    try {
      const response = await withTimeout(options.transport(request), options.timeoutMs);
      throwIfAborted(options.signal);

      options.logger?.debug("provider response", {
        requestId,
        attempt: attempt + 1,
        status: response.status,
        durationMs: Date.now() - startedAt,
        bytes: response.text.length,
      });

      if (response.status >= 200 && response.status < 300) {
        return { ...response, requestId };
      }

      lastError = errorFromStatus(response, options.secrets);
    } catch (error) {
      if (isAbortError(error)) throw error;
      lastError = errorFromException(error);

      options.logger?.debug("provider request failed", {
        requestId,
        attempt: attempt + 1,
        code: lastError.code,
        durationMs: Date.now() - startedAt,
      });
    }

    const isLastAttempt = attempt === attempts - 1;
    const skipRetry = options.skipRetryFor?.includes(lastError.code) === true;
    if (!lastError.retryable || isLastAttempt || skipRetry) break;

    await sleep(backoffDelay(attempt, options.retryInitialDelayMs, lastError), options.signal);
  }

  throw lastError ?? new ProviderError("provider_error", "Request failed", true);
}

/** Sends JSON and parses a JSON response, mapping malformed bodies. */
export async function sendJson<T>(request: HttpRequest, options: SendOptions): Promise<{ data: T; requestId: string }> {
  const result = await send(request, options);

  try {
    return { data: JSON.parse(result.text) as T, requestId: result.requestId };
  } catch {
    throw new ProviderError("invalid_response", "Provider returned a body that was not JSON", false, result.status);
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const error = new Error("Request aborted");
  error.name = "AbortError";
  throw error;
}

function backoffDelay(attempt: number, initialDelayMs: number, error: ProviderError): number {
  const retryAfterMs = error.retryAfterMs ?? 0;
  const exponential = initialDelayMs * 2 ** attempt;
  const jitter = Math.random() * initialDelayMs * 0.5;
  return Math.max(retryAfterMs, exponential + jitter);
}

function errorFromException(error: unknown): ProviderError {
  if (error instanceof TimeoutError) {
    // Not retried: the request cannot be cancelled, so it is still running and
    // still billed. Sending it again would pay for the same answer twice over.
    return new ProviderError("timeout", "Provider did not respond in time", false);
  }
  if (error instanceof ProviderError) return error;
  // A transport rejection at this level means the request never completed.
  return new ProviderError("network", "Could not reach the provider", true);
}

/**
 * Maps an HTTP status to a normalized error. The response body is sanitized and
 * kept only for logs; user-facing wording comes from `describeProviderError`.
 */
export function errorFromStatus(response: HttpResponse, secrets: readonly string[] = []): ProviderError {
  const detail = sanitizeErrorDetail(response.text, secrets);
  // Classified on the whole body: the telling word may sit past where the detail is cut.
  const code = codeFromStatus(response.status, response.text);

  // Rate limits and server faults are worth retrying. Client errors are not:
  // the same request will fail the same way.
  const retryable = code === "rate_limited" || (code === "provider_error" && response.status >= 500);

  const error = new ProviderError(
    code,
    `Provider responded with ${response.status}: ${detail}`,
    retryable,
    response.status,
  );

  const retryAfterMs = parseRetryAfter(response.headers);
  return retryAfterMs === undefined ? error : error.withRetryAfter(retryAfterMs);
}

function codeFromStatus(status: number, detail: string): ProviderErrorCode {
  if (status === 401 || status === 403) return "unauthorized";
  if (status === 402) return "quota";
  if (status === 404) return /model/i.test(detail) ? "model_not_found" : "provider_error";
  if (status === 429) {
    return /quota|credit|billing/i.test(detail) ? "quota" : "rate_limited";
  }
  if (status === 400 || status === 422) {
    // Anthropic reports an exhausted balance as a plain bad request.
    if (/credit balance/i.test(detail)) return "quota";
    // Gemini reports an invalid key as 400 rather than 401.
    if (/api[_ ]key (?:is )?not valid|invalid api[_ ]key|incorrect api[_ ]key|api_key_invalid/i.test(detail)) {
      return "unauthorized";
    }
    return /model/i.test(detail) && /not found|does not exist|invalid model/i.test(detail)
      ? "model_not_found"
      : "provider_error";
  }
  return "provider_error";
}

function parseRetryAfter(headers: Record<string, string>): number | undefined {
  const raw = headers["retry-after"] ?? headers["Retry-After"];
  if (!raw) return undefined;

  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 60_000);

  const date = Date.parse(raw);
  if (!Number.isNaN(date)) return Math.max(0, Math.min(date - Date.now(), 60_000));

  return undefined;
}
