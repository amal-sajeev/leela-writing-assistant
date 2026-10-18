import type { DocumentReviewResult, ProviderId, ReviewResult, SuggestedFix } from "../types";

/**
 * Credentials and endpoint configuration for a single request. Providers read
 * this per call so that changing settings takes effect without re-registering.
 */
export interface ProviderRequestConfig {
  /** The key used for this attempt. */
  apiKey: string;
  /**
   * Every key configured for this provider, primary first. Used to rotate on
   * rate limits and to redact secrets from prompts and logs.
   */
  apiKeys: string[];
  model: string;
  baseUrl?: string;
  timeoutMs: number;
  maxRetries: number;
  retryInitialDelayMs: number;
}

/**
 * Prompts arrive fully rendered. Prompt construction is a domain concern and
 * must not live in provider implementations (specification section 13).
 */
export interface ProviderReviewInput {
  systemPrompt: string;
  userPrompt: string;
  /** Upper bound the provider may communicate to the model as a schema hint. */
  maxComments: number;
}

/**
 * A whole-note pass, asking for problems that belong to the note rather than to
 * one sentence (specification section 24).
 */
export interface ProviderDocumentReviewInput {
  systemPrompt: string;
  userPrompt: string;
  maxObservations: number;
}

export interface CommentReplyInput {
  systemPrompt: string;
  userPrompt: string;
  /** Room for the answer, when it is longer than a line of conversation. */
  maxTokens?: number;
}

export interface FixRequestInput {
  systemPrompt: string;
  userPrompt: string;
}

/**
 * The only surface through which AI calls may be made (specification section 8).
 * Implementations translate these neutral requests into vendor API formats and
 * normalize all failures to ProviderError.
 */
export interface AIProvider {
  readonly id: ProviderId;
  readonly displayName: string;

  /** Rejects with a ProviderError when the current configuration cannot be used. */
  validateConfiguration(): Promise<void>;

  review(input: ProviderReviewInput, signal?: AbortSignal): Promise<ReviewResult>;

  reviewDocument(
    input: ProviderDocumentReviewInput,
    signal?: AbortSignal,
  ): Promise<DocumentReviewResult>;

  replyToComment(input: CommentReplyInput, signal?: AbortSignal): Promise<string>;

  generateFix(input: FixRequestInput, signal?: AbortSignal): Promise<SuggestedFix>;
}

/** Reads live provider configuration from settings at call time. */
export type ProviderConfigSource = (id: ProviderId) => ProviderRequestConfig;
