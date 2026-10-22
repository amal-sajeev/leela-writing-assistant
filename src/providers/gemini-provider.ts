import { GEMINI_DEFAULT_BASE_URL } from "../constants";
import {
  extractMessageText,
  extractUsage,
  parseObservations,
  parseReviewComments,
  parseSuggestedFix,
} from "../review/response-parser";
import type { DocumentReviewResult, ReviewResult, SuggestedFix } from "../types";
import type { Logger } from "../utils/logger";
import {
  FIX_TOKEN_BUDGET,
  observationTokenBudget,
  REPLY_TOKEN_BUDGET,
  reviewTokenBudget,
} from "./budgets";
import { outputTokenBudget } from "./provider-capabilities";
import { rotationSkipRetry, withApiKeyFallback } from "./key-fallback";
import { withModelFallback } from "./model-fallback";
import { sendJson, type HttpTransport } from "./http";
import { ProviderError } from "./provider-errors";
import type {
  AIProvider,
  CommentReplyInput,
  FixRequestInput,
  ProviderDocumentReviewInput,
  ProviderRequestConfig,
  ProviderReviewInput,
} from "./provider";
import {
  documentObservationsJsonSchema,
  reviewJsonSchema,
  suggestedFixJsonSchema,
} from "./schemas";
import { relaxNullableUnions, withSchemaFallback, type StructuredMode } from "./structured-output";

/**
 * Gemini Interactions adapter.
 *
 * The Interactions API is Google's current surface; `generateContent` remains
 * supported but is legacy. Every request opts out of storage, because this
 * surface retains interactions by default.
 */

interface GeminiInteractionResponse {
  id?: unknown;
  status?: unknown;
  steps?: unknown;
  usage?: unknown;
  errors?: unknown;
}

export interface GeminiProviderDeps {
  /** Read at call time so settings changes apply without re-registration. */
  config: () => ProviderRequestConfig;
  transport: HttpTransport;
  logger?: Logger;
}

export class GeminiProvider implements AIProvider {
  readonly id = "gemini" as const;
  readonly displayName = "Gemini";

  constructor(private readonly deps: GeminiProviderDeps) {}

  async validateConfiguration(): Promise<void> {
    await this.withKeys(async (config) => {
      // A model listing checks the key and reachability without spending tokens.
      await sendJson<unknown>(
        {
          url: `${baseUrl(config)}/v1/models`,
          method: "GET",
          headers: this.headers(config, false),
        },
        this.sendOptions(config),
      );
    });

    // Then the smallest possible review, which is the only way to know the model
    // name is usable and that the JSON contract round-trips.
    await this.review({
      systemPrompt:
        "You are a JSON API used to verify connectivity. Reply with an empty comments array and nothing else.",
      userPrompt: 'REVIEWED TEXT:\nconnection test\n\nReturn exactly {"comments": []}.',
      maxComments: 1,
    });
  }

  async review(input: ProviderReviewInput, signal?: AbortSignal): Promise<ReviewResult> {
    return this.withKeys((config) =>
      withSchemaFallback(
        (mode) => this.requestReview(config, input, mode, signal),
        this.fallbackOptions(config),
      ),
    );
  }

  async reviewDocument(
    input: ProviderDocumentReviewInput,
    signal?: AbortSignal,
  ): Promise<DocumentReviewResult> {
    return this.withKeys((config) =>
      withSchemaFallback(
        (mode) => this.requestObservations(config, input, mode, signal),
        this.fallbackOptions(config),
      ),
    );
  }

  async replyToComment(input: CommentReplyInput, signal?: AbortSignal): Promise<string> {
    return this.withKeys(async (config) => {
      const { data, requestId } = await this.post(
        config,
        {
          system_instruction: input.systemPrompt,
          input: input.userPrompt,
          generation_config: generationConfig(
            config.model,
            input.maxTokens ?? REPLY_TOKEN_BUDGET,
          ),
        },
        signal,
      );

      const text = interactionText(data, requestId).trim();
      if (text.length === 0) {
        throw new ProviderError("invalid_response", "Provider returned an empty reply", false);
      }
      return text;
    });
  }

  async generateFix(input: FixRequestInput, signal?: AbortSignal): Promise<SuggestedFix> {
    return this.withKeys((config) =>
      withSchemaFallback(async (mode) => {
        const { data, requestId } = await this.post(
          config,
          {
            system_instruction: input.systemPrompt,
            input: input.userPrompt,
            generation_config: generationConfig(config.model, FIX_TOKEN_BUDGET),
            ...responseFormat(mode, suggestedFixJsonSchema()),
          },
          signal,
        );

        return {
          ...parseSuggestedFix(interactionText(data, requestId)),
          generatedAt: Date.now(),
        };
      }, this.fallbackOptions(config)),
    );
  }

  /** A model that will not take a schema still takes plain JSON mode. */
  private fallbackOptions(config: ProviderRequestConfig) {
    return {
      fallback: "json" as const,
      model: config.model,
      ...(this.deps.logger === undefined ? {} : { logger: this.deps.logger }),
    };
  }

  private async requestReview(
    config: ProviderRequestConfig,
    input: ProviderReviewInput,
    mode: StructuredMode,
    signal?: AbortSignal,
  ): Promise<ReviewResult> {
    const { data, requestId } = await this.post(
      config,
      {
        system_instruction: input.systemPrompt,
        input: input.userPrompt,
        generation_config: generationConfig(
          config.model,
          reviewTokenBudget(input.maxComments),
        ),
        ...responseFormat(mode, reviewJsonSchema()),
      },
      signal,
    );

    const comments = parseReviewComments(interactionText(data, requestId));
    const usage = extractUsage(data.usage);
    const completion = {
      requestId,
      ...(typeof data.status === "string" ? { stopReason: data.status } : {}),
    };

    this.deps.logger?.debug("review parsed", {
      requestId,
      mode,
      comments: comments.length,
      inputTokens: usage?.inputTokens,
      outputTokens: usage?.outputTokens,
    });

    return { comments, completion, ...(usage === undefined ? {} : { usage }) };
  }

  private async requestObservations(
    config: ProviderRequestConfig,
    input: ProviderDocumentReviewInput,
    mode: StructuredMode,
    signal?: AbortSignal,
  ): Promise<DocumentReviewResult> {
    const { data, requestId } = await this.post(
      config,
      {
        system_instruction: input.systemPrompt,
        input: input.userPrompt,
        generation_config: generationConfig(
          config.model,
          observationTokenBudget(input.maxObservations),
        ),
        ...responseFormat(mode, documentObservationsJsonSchema()),
      },
      signal,
    );

    const observations = parseObservations(interactionText(data, requestId));
    const usage = extractUsage(data.usage);
    const completion = {
      requestId,
      ...(typeof data.status === "string" ? { stopReason: data.status } : {}),
    };

    this.deps.logger?.debug("observations parsed", {
      requestId,
      mode,
      observations: observations.length,
      inputTokens: usage?.inputTokens,
      outputTokens: usage?.outputTokens,
    });

    return { observations, completion, ...(usage === undefined ? {} : { usage }) };
  }

  private post(
    config: ProviderRequestConfig,
    body: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<{ data: GeminiInteractionResponse; requestId: string }> {
    return sendJson<GeminiInteractionResponse>(
      {
        url: `${baseUrl(config)}/v1/interactions`,
        method: "POST",
        headers: this.headers(config, true),
        // store: false keeps the note out of Gemini's own retained history. It is
        // last so no caller body can accidentally turn storage back on.
        body: JSON.stringify({ model: config.model, ...body, store: false }),
      },
      this.sendOptions(config, signal),
    );
  }

  private headers(config: ProviderRequestConfig, json: boolean): Record<string, string> {
    return {
      "x-goog-api-key": config.apiKey,
      Accept: "application/json",
      ...(json ? { "Content-Type": "application/json" } : {}),
    };
  }

  private sendOptions(config: ProviderRequestConfig, signal?: AbortSignal) {
    return {
      transport: this.deps.transport,
      timeoutMs: config.timeoutMs,
      maxRetries: config.maxRetries,
      retryInitialDelayMs: config.retryInitialDelayMs,
      secrets: config.apiKeys,
      ...rotationSkipRetry(config),
      ...(this.deps.logger === undefined ? {} : { logger: this.deps.logger }),
      ...(signal === undefined ? {} : { signal }),
    };
  }

  private withKeys<T>(run: (config: ProviderRequestConfig) => Promise<T>): Promise<T> {
    const base = this.requireConfig();

    return withModelFallback({
      model: base.model,
      ...(base.fallbackModels === undefined ? {} : { fallbackModels: base.fallbackModels }),
      ...(this.deps.logger === undefined ? {} : { logger: this.deps.logger }),
      run: (model, nextModelWaiting) =>
        withApiKeyFallback({
          keys: base.apiKeys,
          missingKeyMessage: "No Gemini API key is configured",
          ...(this.deps.logger === undefined ? {} : { logger: this.deps.logger }),
          run: (apiKey) =>
            run({
              ...base,
              apiKey,
              model,
              ...(nextModelWaiting ? { skipRateLimitRetry: true } : {}),
            }),
        }),
    });
  }

  private requireConfig(): ProviderRequestConfig {
    const config = this.deps.config();

    if (config.apiKeys.length === 0 && config.apiKey.trim().length === 0) {
      throw new ProviderError("missing_key", "No Gemini API key is configured", false);
    }
    if (config.model.trim().length === 0) {
      throw new ProviderError("model_not_found", "No Gemini model is configured", false);
    }

    const apiKeys =
      config.apiKeys.length > 0
        ? config.apiKeys
        : config.apiKey.trim().length > 0
          ? [config.apiKey.trim()]
          : [];

    return { ...config, apiKey: apiKeys[0] ?? "", apiKeys };
  }
}

function baseUrl(config: ProviderRequestConfig): string {
  const raw = config.baseUrl?.trim();
  const base = raw === undefined || raw.length === 0 ? GEMINI_DEFAULT_BASE_URL : raw;
  return base.replace(/\/+$/, "");
}

/**
 * Gemini counts thinking against the same output ceiling, so medium thinking
 * needs real headroom. Older models have no thinking level to set.
 */
function generationConfig(model: string, visibleBudget: number): Record<string, unknown> {
  const config: Record<string, unknown> = {
    max_output_tokens: outputTokenBudget("gemini", model, visibleBudget),
  };
  if (takesThinkingLevel(model)) config.thinking_level = "medium";
  return config;
}

/** Thinking levels are a Gemini 3 and later option; 2.5 and older use their defaults. */
function takesThinkingLevel(model: string): boolean {
  return /^(?:models\/)?gemini-[3-9](?:\.|-|$)/i.test(model.trim());
}

/** Spread into the body: nothing at all when structured output is not being asked for. */
function responseFormat(
  mode: StructuredMode,
  schema: Record<string, unknown>,
): Record<string, unknown> {
  if (mode === "none") return {};

  const format: Record<string, unknown> = {
    type: "text",
    mime_type: "application/json",
  };
  if (mode === "schema") format.schema = relaxNullableUnions(schema);

  return { response_format: format };
}

/**
 * The answer lives in `model_output` steps; a `thought` step carries thinking
 * rather than prose and must not be joined into the reply. Long answers can be
 * split across more than one model-output step.
 */
function interactionText(data: GeminiInteractionResponse, requestId?: string): string {
  const status = typeof data.status === "string" ? data.status : undefined;

  if (status === "incomplete") {
    throw new ProviderError(
      "output_truncated",
      "The reply was cut off at the token limit",
      false,
      undefined,
      undefined,
      {
        stopReason: "incomplete",
        ...(requestId === undefined ? {} : { requestId }),
      },
    );
  }

  if (
    status === "failed" ||
    status === "cancelled" ||
    status === "requires_action" ||
    status === "in_progress"
  ) {
    throw new ProviderError(
      "provider_error",
      "The model did not complete this request",
      false,
      undefined,
      undefined,
      {
        stopReason: status,
        ...(requestId === undefined ? {} : { requestId }),
      },
    );
  }

  return extractMessageText(modelOutputContent(data.steps));
}

function modelOutputContent(steps: unknown): unknown {
  if (!Array.isArray(steps)) return undefined;

  const parts: unknown[] = [];
  for (const step of steps) {
    if (typeof step !== "object" || step === null) continue;
    const record = step as Record<string, unknown>;
    if (record.type !== "model_output") continue;

    if (typeof record.content === "string") parts.push(record.content);
    else if (Array.isArray(record.content)) parts.push(...record.content);
  }

  return parts;
}
