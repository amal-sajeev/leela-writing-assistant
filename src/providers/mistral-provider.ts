import { MISTRAL_DEFAULT_BASE_URL, REPLY_TEMPERATURE, REVIEW_TEMPERATURE } from "../constants";
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
import { withSchemaFallback, type StructuredMode } from "./structured-output";

/** Mistral chat adapter. Keeps vendor request details behind the shared provider interface. */

interface MistralChatResponse {
  choices?: Array<{ message?: { content?: unknown }; finish_reason?: unknown }>;
  usage?: unknown;
}

export interface MistralProviderDeps {
  /** Read at call time so settings changes apply without re-registration. */
  config: () => ProviderRequestConfig;
  transport: HttpTransport;
  logger?: Logger;
}

export class MistralProvider implements AIProvider {
  readonly id = "mistral" as const;
  readonly displayName = "Mistral";

  constructor(private readonly deps: MistralProviderDeps) {}

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
      const { data, requestId } = await sendJson<MistralChatResponse>(
        this.chatRequest(config, {
          messages: messages(input.systemPrompt, input.userPrompt),
          temperature: REPLY_TEMPERATURE,
          max_tokens: outputTokenBudget("mistral", config.model, input.maxTokens ?? REPLY_TOKEN_BUDGET),
        }),
        this.sendOptions(config, signal),
      );

      const text = extractMessageText(messageContent(data, requestId)).trim();
      if (text.length === 0) {
        throw new ProviderError("invalid_response", "Provider returned an empty reply", false);
      }
      return text;
    });
  }

  async generateFix(input: FixRequestInput, signal?: AbortSignal): Promise<SuggestedFix> {
    return this.withKeys((config) =>
      withSchemaFallback(async (mode) => {
        const { data, requestId } = await sendJson<MistralChatResponse>(
          this.chatRequest(config, {
            messages: messages(input.systemPrompt, input.userPrompt),
            temperature: REPLY_TEMPERATURE,
            max_tokens: outputTokenBudget("mistral", config.model, FIX_TOKEN_BUDGET),
            response_format: responseFormat(mode, "suggested_fix", suggestedFixJsonSchema()),
          }),
          this.sendOptions(config, signal),
        );

        return {
          ...parseSuggestedFix(extractMessageText(messageContent(data, requestId))),
          generatedAt: Date.now(),
        };
      }, this.fallbackOptions(config)),
    );
  }

  /** A model that will not take a schema still takes Mistral's JSON mode. */
  private fallbackOptions(config: ProviderRequestConfig) {
    return {
      fallback: "json" as const,
      model: config.model,
      ...(this.deps.logger === undefined ? {} : { logger: this.deps.logger }),
    };
  }

  private async requestObservations(
    config: ProviderRequestConfig,
    input: ProviderDocumentReviewInput,
    mode: StructuredMode,
    signal?: AbortSignal,
  ): Promise<DocumentReviewResult> {
    const { data, requestId } = await sendJson<MistralChatResponse>(
      this.chatRequest(config, {
        messages: messages(input.systemPrompt, input.userPrompt),
        temperature: REVIEW_TEMPERATURE,
        max_tokens: outputTokenBudget("mistral", config.model, observationTokenBudget(input.maxObservations)),
        response_format: responseFormat(
          mode,
          "document_observations",
          documentObservationsJsonSchema(),
        ),
      }),
      this.sendOptions(config, signal),
    );

    const observations = parseObservations(extractMessageText(messageContent(data, requestId)));
    const usage = extractUsage(data.usage);
    const finishReason = data.choices?.[0]?.finish_reason;
    const completion = {
      requestId,
      ...(typeof finishReason === "string" ? { finishReason } : {}),
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

  private async requestReview(
    config: ProviderRequestConfig,
    input: ProviderReviewInput,
    mode: StructuredMode,
    signal?: AbortSignal,
  ): Promise<ReviewResult> {
    const { data, requestId } = await sendJson<MistralChatResponse>(
      this.chatRequest(config, {
        messages: messages(input.systemPrompt, input.userPrompt),
        temperature: REVIEW_TEMPERATURE,
        max_tokens: outputTokenBudget("mistral", config.model, reviewTokenBudget(input.maxComments)),
        response_format: responseFormat(mode, "review", reviewJsonSchema()),
      }),
      this.sendOptions(config, signal),
    );

    const comments = parseReviewComments(extractMessageText(messageContent(data, requestId)));
    const usage = extractUsage(data.usage);
    const finishReason = data.choices?.[0]?.finish_reason;
    const completion = {
      requestId,
      ...(typeof finishReason === "string" ? { finishReason } : {}),
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

  private chatRequest(config: ProviderRequestConfig, body: Record<string, unknown>) {
    return {
      url: `${baseUrl(config)}/chat/completions`,
      method: "POST" as const,
      headers: this.headers(config, true),
      body: JSON.stringify({ model: config.model, ...body }),
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

  /**
   * Runs a request under each configured key until one succeeds, or until an
   * error that another key cannot fix.
   */
  private withKeys<T>(run: (config: ProviderRequestConfig) => Promise<T>): Promise<T> {
    const base = this.requireConfig();

    return withApiKeyFallback({
      keys: base.apiKeys,
      missingKeyMessage: "No Mistral API key is configured",
      ...(this.deps.logger === undefined ? {} : { logger: this.deps.logger }),
      run: (apiKey) => run({ ...base, apiKey }),
    });
  }

  private requireConfig(): ProviderRequestConfig {
    const config = this.deps.config();

    if (config.apiKeys.length === 0 && config.apiKey.trim().length === 0) {
      throw new ProviderError("missing_key", "No Mistral API key is configured", false);
    }
    if (config.model.trim().length === 0) {
      throw new ProviderError("model_not_found", "No Mistral model is configured", false);
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
  const base = raw === undefined || raw.length === 0 ? MISTRAL_DEFAULT_BASE_URL : raw;
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

function messageContent(data: MistralChatResponse, requestId?: string): unknown {
  const choice = data.choices?.[0];

  // Said plainly rather than left to fail as JSON that would not parse.
  if (choice?.finish_reason === "length") {
    throw new ProviderError("output_truncated", "The reply was cut off at the token limit", false, undefined, undefined, {
      finishReason: "length",
      ...(requestId === undefined ? {} : { requestId }),
    });
  }

  return choice?.message?.content;
}
