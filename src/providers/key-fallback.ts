import { isAbortError } from "../utils/async";
import type { Logger } from "../utils/logger";
import { ProviderError, toProviderError, type ProviderErrorCode } from "./provider-errors";

/**
 * Trying the next configured key when the current one cannot serve the request
 * (rate limit, rejected key, or exhausted quota).
 *
 * Retries inside `send` still cover transient network and server faults on the
 * same key. These codes are different: waiting and trying again with the same
 * credential will not help, and another key often will.
 */

const KEY_ROTATION_CODES: ReadonlySet<ProviderErrorCode> = new Set([
  "rate_limited",
  "unauthorized",
  "quota",
]);

export function isKeyRotationError(error: ProviderError): boolean {
  return KEY_ROTATION_CODES.has(error.code);
}

/**
 * Codes `send` should not retry when another key is waiting. Rate limits are
 * otherwise retryable with backoff; with a spare key it is better to move on
 * than to sit out Retry-After on a key that is already spent.
 */
export const KEY_ROTATION_SKIP_RETRY: readonly ProviderErrorCode[] = ["rate_limited"];

/**
 * `send` options for the key a request is about to use. The last key has nowhere
 * left to rotate to, so it keeps the ordinary backoff: otherwise adding a spare
 * key would make a rate limit shared by both fail faster than having one.
 */
export function rotationSkipRetry(config: {
  apiKey: string;
  apiKeys: readonly string[];
}): { skipRetryFor?: readonly ProviderErrorCode[] } {
  const keys = uniqueKeys(config.apiKeys);
  const isLast = keys.length < 2 || keys[keys.length - 1] === config.apiKey.trim();

  return isLast ? {} : { skipRetryFor: KEY_ROTATION_SKIP_RETRY };
}

export interface WithApiKeyFallbackOptions<T> {
  keys: readonly string[];
  run: (apiKey: string) => Promise<T>;
  /** What to say when no key is configured at all. */
  missingKeyMessage: string;
  logger?: Logger;
}

/**
 * Tries each non-empty key in order. Stops on success, or on any error that is
 * not a rotation candidate. The last rotation error is what the caller sees.
 */
export async function withApiKeyFallback<T>(options: WithApiKeyFallbackOptions<T>): Promise<T> {
  const keys = uniqueKeys(options.keys);
  if (keys.length === 0) {
    throw new ProviderError("missing_key", options.missingKeyMessage, false);
  }

  let lastRotation: ProviderError | undefined;

  for (let index = 0; index < keys.length; index += 1) {
    const apiKey = keys[index]!;
    const remaining = keys.length - index - 1;

    try {
      return await options.run(apiKey);
    } catch (error) {
      // A cancelled request is not a failure of the key, or of anything else.
      if (isAbortError(error)) throw error;

      const providerError = toProviderError(error);

      if (!isKeyRotationError(providerError) || remaining === 0) {
        throw providerError;
      }

      lastRotation = providerError;
      options.logger?.info("trying the next API key", {
        code: providerError.code,
        keysRemaining: remaining,
      });
    }
  }

  throw lastRotation ?? new ProviderError("missing_key", options.missingKeyMessage, false);
}

/** Non-empty keys in order, with exact duplicates dropped. */
export function uniqueKeys(keys: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const raw of keys) {
    const key = raw.trim();
    if (key.length === 0 || seen.has(key)) continue;
    seen.add(key);
    result.push(key);
  }

  return result;
}
