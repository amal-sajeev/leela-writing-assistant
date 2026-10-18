/**
 * Provider-neutral domain types (specification section 6).
 *
 * Nothing in this file may reference a vendor SDK, an Obsidian API, or a
 * rendering concern. Every layer of the plugin speaks these types.
 */

export const PROVIDER_IDS = ["mistral", "openai", "anthropic"] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

/** Stable IDs the model may choose for Lyra's active expressions. */
export const ACTIVE_REACTION_CATALOG = {
  idle_concerned: "concerned, attentive",
  idle_goodbye: "playful, teasing",
  idle_laughing: "amused, laughing",
  idle_serious: "thoughtful, focused",
  idle_shocked_happy: "delighted, pleasantly surprised",
  idle_shocked_sad: "worried, sympathetic",
  idle_welcome: "warm, welcoming",
} as const;
export type ActiveReaction = keyof typeof ACTIVE_REACTION_CATALOG;
export const ACTIVE_REACTION_IDS = Object.keys(ACTIVE_REACTION_CATALOG) as ActiveReaction[];

export function isActiveReaction(value: unknown): value is ActiveReaction {
  return (ACTIVE_REACTION_IDS as readonly unknown[]).includes(value);
}

export const COMMENT_CATEGORIES = [
  "clarity",
  "reasoning",
  "evidence",
  "fact",
  "consistency",
  "structure",
  "style",
  "grammar",
  "continuity",
  "terminology",
  // What a reader of fiction notices.
  "character",
  "dialogue",
  "pacing",
  "pov",
  "exposition",
  "emotion",
  "prose",
  /** How a passage bears on the shape of the whole story. Only with an outline to rest on. */
  "arc",
  /** Something that works, said because knowing why is useful. Never a courtesy. */
  "strength",
  "other",
] as const;
export type CommentCategory = (typeof COMMENT_CATEGORIES)[number];

/**
 * How sure a finding is, which decides how it is put: an error is stated, a
 * craft problem is explained by its effect on a reader, and a matter of taste is
 * asked as a question.
 */
export const COMMENT_KINDS = ["error", "craft", "taste"] as const;
export type CommentKind = (typeof COMMENT_KINDS)[number];

export const COMMENT_SEVERITIES = ["low", "medium", "high"] as const;
export type CommentSeverity = (typeof COMMENT_SEVERITIES)[number];

export const COMMENT_STATUSES = ["open", "resolved", "dismissed", "stale"] as const;
export type CommentStatus = (typeof COMMENT_STATUSES)[number];

export const OBSERVATION_TYPES = [
  "structure",
  "consistency",
  "argument",
  "repetition",
  "other",
] as const;
export type ObservationType = (typeof OBSERVATION_TYPES)[number];

/**
 * Locates a comment in a document. Offsets are hints only; `quote`, `prefix`,
 * `suffix` and `contextHash` are what make re-anchoring possible after edits.
 */
export interface TextAnchor {
  quote: string;
  prefix: string;
  suffix: string;

  /** Last known offsets. Hints, not permanent identity. */
  start: number;
  end: number;

  /** Hash of normalized nearby text at creation time. */
  contextHash: string;
}

export interface CommentMessage {
  id: string;
  role: "user" | "reviewer";
  text: string;
  createdAt: number;
  reaction?: ActiveReaction;
}

export interface SuggestedFix {
  replacement: string;
  explanation?: string;
  generatedAt: number;
}

export interface ReviewComment {
  id: string;
  filePath: string;
  reviewerId: string;
  category: CommentCategory;
  severity: CommentSeverity;
  confidence: number;
  /** Absent on comments made before kinds existed, or when the model gave none. */
  kind?: CommentKind;

  anchor: TextAnchor;

  body: string;
  reaction?: ActiveReaction;
  rationale?: string;

  status: CommentStatus;
  createdAt: number;
  updatedAt: number;

  sourceRevisionHash: string;

  thread: CommentMessage[];

  suggestedFix?: SuggestedFix;
}

/** A global remark about a document that should not be pinned to one sentence. */
export interface DocumentObservation {
  id: string;
  type: ObservationType;
  title: string;
  body: string;
  relatedQuotes?: string[];
  createdAt: number;
  status: "open" | "resolved" | "dismissed";
  /** Which reviewer said it, so the panel can colour it like a comment. */
  reviewerId?: string;
}

/** An observation as proposed by a model, before validation and storage. */
export interface ProposedObservation {
  type: ObservationType;
  title: string;
  body: string;
  relatedQuotes?: string[];
}

export interface ReviewerProfile {
  id: string;
  name: string;
  description: string;
  systemInstructions: string;
  enabledCategories: CommentCategory[];
  /** 0.0 (interrupt rarely) to 1.0 (meticulous). */
  sensitivity: number;
  maxCommentsPerReview: number;
}

export interface RetrievedContext {
  filePath: string;
  excerpt: string;
  score: number;
  reason: "wikilink" | "lexical" | "manual";
}

export interface ReviewRequest {
  filePath: string;
  documentTitle: string;
  changedText: string;
  changedStart: number;
  changedEnd: number;

  beforeContext: string;
  afterContext: string;

  /** Heading path of the reviewed block, outermost first (section 51). */
  headingPath?: string[];

  projectInstructions?: string;
  retrievedVaultContext?: RetrievedContext[];
  /** The shape of the whole story: the author's plan, and the outline kept from the chapters. */
  storyOutline?: string;
  existingNearbyComments?: ReviewComment[];
  reviewer: ReviewerProfile;
}

/** A comment as proposed by a model, before validation and anchoring. */
export interface ProposedComment {
  quote: string;
  category: CommentCategory;
  severity: CommentSeverity;
  confidence: number;
  body: string;
  rationale?: string;
  kind?: CommentKind;
  reaction?: ActiveReaction;
}

/** Reported by providers when the vendor returns usage; used for cost visibility only. */
export interface ProviderUsage {
  inputTokens?: number;
  outputTokens?: number;
}

export interface ReviewResult {
  comments: ProposedComment[];
  usage?: ProviderUsage;
}

/** What a whole-note pass returns beyond its anchored comments (section 24). */
export interface DocumentReviewResult {
  observations: ProposedObservation[];
  usage?: ProviderUsage;
}

/** What the plugin is currently doing, for the status bar (section 22). */
export type ReviewActivity = "off" | "idle" | "waiting" | "reviewing" | "error";
