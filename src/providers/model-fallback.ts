import { isAbortError } from "../utils/async";
import type { Logger } from "../utils/logger";
import { ProviderError, toProviderError, type ProviderErrorCode } from "./provider-errors";

/**
 * Trying the next configured model when the current one cannot serve the
 * request: an unknown model, an exhausted limit, or the provider saying the
 * model is unavailable.
 *
 * A bad key, a bad prompt, a timeout or an unparseable answer are not model
 * faults, so another model name would not help. They are left to the caller.
 */

const MODEL_FALLBACK_CODES: ReadonlySet<ProviderErrorCode> = new Set([
  "model_not_found",
  "rate_limited",
  "quota",
]);

export function isModelFallbackError(error: ProviderError): boolean {
  if (MODEL_FALLBACK_CODES.has(error.code)) return true;

  return error.code === "provider_error" && (error.status ?? 0) >= 500;
}

export interface WithModelFallbackOptions<T> {
  model: string;
  fallbackModels?: readonly string[];
  /** `nextModelWaiting` is true while another configured model can still be tried. */
  run: (model: string, nextModelWaiting: boolean) => Promise<T>;
  logger?: Logger;
}

/**
 * Tries each non-empty model in order. The next model is only tried for a
 * model-level failure; any other failure is thrown immediately. The last
 * model-level error is what the caller sees when every model fails.
 */
export async function withModelFallback<T>(options: WithModelFallbackOptions<T>): Promise<T> {
  const models = uniqueModels([options.model, ...(options.fallbackModels ?? [])]);
  if (models.length === 0) {
    throw new ProviderError("model_not_found", "No model is configured", false);
  }

  let lastFailure: ProviderError | undefined;

  for (let index = 0; index < models.length; index += 1) {
    const model = models[index]!;
    const remaining = models.length - index - 1;

    try {
      return await options.run(model, remaining > 0);
    } catch (error) {
      // A cancelled request is not a failure of the model, or of anything else.
      if (isAbortError(error)) throw error;

      const providerError = toProviderError(error);

      if (!isModelFallbackError(providerError) || remaining === 0) {
        throw providerError;
      }

      lastFailure = providerError;
      options.logger?.info("trying the next model", {
        code: providerError.code,
        model,
        modelsRemaining: remaining,
      });
    }
  }

  throw lastFailure ?? new ProviderError("model_not_found", "No model is configured", false);
}

/** Non-empty model names in order, with exact duplicates dropped. */
export function uniqueModels(models: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const raw of models) {
    const model = raw.trim();
    if (model.length === 0 || seen.has(model)) continue;
    seen.add(model);
    result.push(model);
  }

  return result;
}
