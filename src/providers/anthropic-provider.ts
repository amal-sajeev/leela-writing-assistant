import { ANTHROPIC_API_VERSION, ANTHROPIC_DEFAULT_BASE_URL } from "../constants";
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

/** Anthropic Messages adapter. Handles required fields, schema limits, and thinking-token budgets. */

interface AnthropicMessageResponse {
  content?: unknown;
  usage?: unknown;
  stop_reason?: unknown;
}

export interface AnthropicProviderDeps {
  /** Read at call time so settings changes apply without re-registration. */
  config: () => ProviderRequestConfig;
  transport: HttpTransport;
  logger?: Logger;
}

export class AnthropicProvider implements AIProvider {
  readonly id = "anthropic" as const;
  readonly displayName = "Anthropic";

  constructor(private readonly deps: AnthropicProviderDeps) {}

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
      const { data, requestId } = await sendJson<AnthropicMessageResponse>(
        this.messageRequest(config, {
          system: input.systemPrompt,
          messages: [{ role: "user", content: input.userPrompt }],
          max_tokens: outputTokenBudget("anthropic", config.model, input.maxTokens ?? REPLY_TOKEN_BUDGET),
        }),
        this.sendOptions(config, signal),
      );

      const text = assistantText(data, requestId).trim();
      if (text.length === 0) {
        throw new ProviderError("invalid_response", "Provider returned an empty reply", false);
      }
      return text;
    });
  }

  async generateFix(input: FixRequestInput, signal?: AbortSignal): Promise<SuggestedFix> {
    return this.withKeys((config) =>
      withSchemaFallback(async (mode) => {
        const { data, requestId } = await sendJson<AnthropicMessageResponse>(
          this.messageRequest(config, {
            system: input.systemPrompt,
            messages: [{ role: "user", content: input.userPrompt }],
            max_tokens: outputTokenBudget("anthropic", config.model, FIX_TOKEN_BUDGET),
            ...outputConfig(mode, suggestedFixJsonSchema()),
          }),
          this.sendOptions(config, signal),
        );

        return { ...parseSuggestedFix(assistantText(data, requestId)), generatedAt: Date.now() };
      }, this.fallbackOptions(config)),
    );
  }

  /** There is no weaker structured mode here, so the fallback is no schema at all. */
  private fallbackOptions(config: ProviderRequestConfig) {
    return {
      fallback: "none" as const,
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
    const { data, requestId } = await sendJson<AnthropicMessageResponse>(
      this.messageRequest(config, {
        system: input.systemPrompt,
        messages: [{ role: "user", content: input.userPrompt }],
        max_tokens: outputTokenBudget("anthropic", config.model, reviewTokenBudget(input.maxComments)),
        ...outputConfig(mode, reviewJsonSchema()),
      }),
      this.sendOptions(config, signal),
    );

    const comments = parseReviewComments(assistantText(data, requestId));
    const usage = extractUsage(data.usage);
    const stopReason = data.stop_reason;
    const completion = {
      requestId,
      ...(typeof stopReason === "string" ? { stopReason } : {}),
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
    const { data, requestId } = await sendJson<AnthropicMessageResponse>(
      this.messageRequest(config, {
        system: input.systemPrompt,
        messages: [{ role: "user", content: input.userPrompt }],
        max_tokens: outputTokenBudget("anthropic", config.model, observationTokenBudget(input.maxObservations)),
        ...outputConfig(mode, documentObservationsJsonSchema()),
      }),
      this.sendOptions(config, signal),
    );

    const observations = parseObservations(assistantText(data, requestId));
    const usage = extractUsage(data.usage);
    const stopReason = data.stop_reason;
    const completion = {
      requestId,
      ...(typeof stopReason === "string" ? { stopReason } : {}),
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

  private messageRequest(config: ProviderRequestConfig, body: Record<string, unknown>) {
    return {
      url: `${baseUrl(config)}/v1/messages`,
      method: "POST" as const,
      headers: this.headers(config, true),
      body: JSON.stringify({ model: config.model, ...body }),
    };
  }

  private headers(config: ProviderRequestConfig, json: boolean): Record<string, string> {
    return {
      "x-api-key": config.apiKey,
      "anthropic-version": ANTHROPIC_API_VERSION,
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
          missingKeyMessage: "No Anthropic API key is configured",
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
      throw new ProviderError("missing_key", "No Anthropic API key is configured", false);
    }
    if (config.model.trim().length === 0) {
      throw new ProviderError("model_not_found", "No Anthropic model is configured", false);
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
  const base = raw === undefined || raw.length === 0 ? ANTHROPIC_DEFAULT_BASE_URL : raw;
  return base.replace(/\/+$/, "");
}

/**
 * The reply text, once the response is known to be a whole one. A reply cut off
 * at the token limit or declined outright is said to be that, rather than left
 * to fail later as JSON that would not parse.
 */
function assistantText(data: AnthropicMessageResponse, requestId?: string): string {
  if (data.stop_reason === "refusal") {
    throw new ProviderError("provider_error", "The model declined this request", false);
  }
  if (data.stop_reason === "max_tokens") {
    throw new ProviderError("output_truncated", "The reply was cut off at the token limit", false, undefined, undefined, {
      stopReason: "max_tokens",
      ...(requestId === undefined ? {} : { requestId }),
    });
  }

  return extractMessageText(data.content);
}

/** Spread into the body: nothing at all when structured output is not being asked for. */
function outputConfig(mode: StructuredMode, schema: Record<string, unknown>): Record<string, unknown> {
  if (mode !== "schema") return {};
  return {
    output_config: { format: { type: "json_schema", schema: relaxNullableUnions(schema) } },
  };
}
