import { OPENAI_DEFAULT_BASE_URL, REPLY_TEMPERATURE, REVIEW_TEMPERATURE } from "../constants";
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
  THINKING_HEADROOM_TOKENS,
} from "./budgets";
import { rotationSkipRetry, withApiKeyFallback } from "./key-fallback";
import { sendJson, type HttpTransport } from "./http";
import { isProviderError, ProviderError } from "./provider-errors";
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
import { withSchemaFallback, type StructuredMode } from "./structured-output";

/** OpenAI Chat Completions adapter. Disables storage and handles reasoning-model limits. */

interface OpenAIChatResponse {
  choices?: Array<{ message?: { content?: unknown; refusal?: unknown }; finish_reason?: unknown }>;
  usage?: unknown;
}

export interface OpenAIProviderDeps {
  /** Read at call time so settings changes apply without re-registration. */
  config: () => ProviderRequestConfig;
  transport: HttpTransport;
  logger?: Logger;
}

export class OpenAIProvider implements AIProvider {
  readonly id = "openai" as const;

  /** Models that turned down a `temperature`, for as long as the plugin is loaded. */
  private readonly fixedSampling = new Set<string>();
  readonly displayName = "OpenAI";

  constructor(private readonly deps: OpenAIProviderDeps) {}

  async validateConfiguration(): Promise<void> {
    await this.withKeys(async (config) => {
      // A model listing checks the key and reachability without spending tokens.
      await sendJson<unknown>(
        {
          url: `${baseUrl(config)}/models`,
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
      const { data } = await this.post(
        config,
        {
          messages: messages(input.systemPrompt, input.userPrompt),
          temperature: REPLY_TEMPERATURE,
          max_completion_tokens: withHeadroom(input.maxTokens ?? REPLY_TOKEN_BUDGET),
        },
        signal,
      );

      const text = extractMessageText(messageContent(data)).trim();
      if (text.length === 0) {
        throw new ProviderError("invalid_response", "Provider returned an empty reply", false);
      }
      return text;
    });
  }

  async generateFix(input: FixRequestInput, signal?: AbortSignal): Promise<SuggestedFix> {
    return this.withKeys((config) =>
      withSchemaFallback(async (mode) => {
        const { data } = await this.post(
          config,
          {
            messages: messages(input.systemPrompt, input.userPrompt),
            temperature: REPLY_TEMPERATURE,
            max_completion_tokens: withHeadroom(FIX_TOKEN_BUDGET),
            response_format: responseFormat(mode, "suggested_fix", suggestedFixJsonSchema()),
          },
          signal,
        );

        return {
          ...parseSuggestedFix(extractMessageText(messageContent(data))),
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
        messages: messages(input.systemPrompt, input.userPrompt),
        temperature: REVIEW_TEMPERATURE,
        max_completion_tokens: withHeadroom(reviewTokenBudget(input.maxComments)),
        response_format: responseFormat(mode, "review", reviewJsonSchema()),
      },
      signal,
    );

    const comments = parseReviewComments(extractMessageText(messageContent(data)));
    const usage = extractUsage(data.usage);

    this.deps.logger?.debug("review parsed", {
      requestId,
      mode,
      comments: comments.length,
      inputTokens: usage?.inputTokens,
      outputTokens: usage?.outputTokens,
    });

    return usage === undefined ? { comments } : { comments, usage };
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
        messages: messages(input.systemPrompt, input.userPrompt),
        temperature: REVIEW_TEMPERATURE,
        max_completion_tokens: withHeadroom(observationTokenBudget(input.maxObservations)),
        response_format: responseFormat(
          mode,
          "document_observations",
          documentObservationsJsonSchema(),
        ),
      },
      signal,
    );

    const observations = parseObservations(extractMessageText(messageContent(data)));
    const usage = extractUsage(data.usage);

    this.deps.logger?.debug("observations parsed", {
      requestId,
      mode,
      observations: observations.length,
      inputTokens: usage?.inputTokens,
      outputTokens: usage?.outputTokens,
    });

    return usage === undefined ? { observations } : { observations, usage };
  }

  /**
   * Sends a chat request, dropping `temperature` for a model that will not take
   * one. The refusal costs one extra request the first time and none after.
   */
  private async post(
    config: ProviderRequestConfig,
    body: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<{ data: OpenAIChatResponse; requestId: string }> {
    const send = (payload: Record<string, unknown>) =>
      sendJson<OpenAIChatResponse>(
        this.chatRequest(config, payload),
        this.sendOptions(config, signal),
      );

    const withoutTemperature = Object.fromEntries(
      Object.entries(body).filter(([key]) => key !== "temperature"),
    );
    if (this.fixedSampling.has(config.model)) return send(withoutTemperature);

    try {
      return await send(body);
    } catch (error) {
      if (!isTemperatureRejection(error)) throw error;

      this.fixedSampling.add(config.model);
      this.deps.logger?.info("model takes no temperature, sending without one", {
        model: config.model,
      });
      return send(withoutTemperature);
    }
  }

  private chatRequest(config: ProviderRequestConfig, body: Record<string, unknown>) {
    return {
      url: `${baseUrl(config)}/chat/completions`,
      method: "POST" as const,
      headers: this.headers(config, true),
      // store: false keeps the note out of OpenAI's own retained history.
      body: JSON.stringify({ model: config.model, store: false, ...body }),
    };
  }

  private headers(config: ProviderRequestConfig, json: boolean): Record<string, string> {
    return {
      Authorization: `Bearer ${config.apiKey}`,
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

    return withApiKeyFallback({
      keys: base.apiKeys,
      missingKeyMessage: "No OpenAI API key is configured",
      ...(this.deps.logger === undefined ? {} : { logger: this.deps.logger }),
      run: (apiKey) => run({ ...base, apiKey }),
    });
  }

  private requireConfig(): ProviderRequestConfig {
    const config = this.deps.config();

    if (config.apiKeys.length === 0 && config.apiKey.trim().length === 0) {
      throw new ProviderError("missing_key", "No OpenAI API key is configured", false);
    }
    if (config.model.trim().length === 0) {
      throw new ProviderError("model_not_found", "No OpenAI model is configured", false);
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
  const base = raw === undefined || raw.length === 0 ? OPENAI_DEFAULT_BASE_URL : raw;
  return base.replace(/\/+$/, "");
}

function messages(systemPrompt: string, userPrompt: string): Array<Record<string, string>> {
  return [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ];
}

function responseFormat(
  mode: StructuredMode,
  name: string,
  schema: Record<string, unknown>,
): Record<string, unknown> {
  if (mode !== "schema") return { type: "json_object" };
  return {
    type: "json_schema",
    json_schema: { name, strict: true, schema },
  };
}

function withHeadroom(budget: number): number {
  return budget + THINKING_HEADROOM_TOKENS;
}

/** A 400 that is about the `temperature` we sent rather than anything else. */
function isTemperatureRejection(error: unknown): boolean {
  return isProviderError(error) && error.status === 400 && /temperature/i.test(error.message);
}

/**
 * The reply's content, once it is known to be a whole one: a reply cut off at
 * the token limit or declined is said to be that, not left to fail as bad JSON.
 */
function messageContent(data: OpenAIChatResponse): unknown {
  const choice = data.choices?.[0];

  if (choice?.finish_reason === "length") {
    throw new ProviderError("invalid_response", "The reply was cut off at the token limit", false);
  }
  if (typeof choice?.message?.refusal === "string" && choice.message.refusal.length > 0) {
    throw new ProviderError("provider_error", "The model declined this request", false);
  }

  return choice?.message?.content;
}
