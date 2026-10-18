import { COMMENT_CATEGORIES, type CommentCategory, type ReviewerProfile } from "../types";
import { clamp, clampFraction, clampInt } from "../utils/number";

/** Editable fields of a built-in preset. Stored as a patch so presets stay recoverable. */
export type ReviewerOverride = Partial<Omit<ReviewerProfile, "id">>;

/**
 * Persisted reviewer state. Built-in presets live in code; users add custom
 * profiles, patch presets, or hide presets they never want to see
 * (specification section 82).
 */
export interface ReviewerData {
  custom: ReviewerProfile[];
  overrides: Record<string, ReviewerOverride>;
  hidden: string[];
}

export const EMPTY_REVIEWER_DATA: ReviewerData = { custom: [], overrides: {}, hidden: [] };

export const MAX_COMMENTS_LIMITS = { min: 1, max: 20 } as const;

export function isCommentCategory(value: unknown): value is CommentCategory {
  return typeof value === "string" && (COMMENT_CATEGORIES as readonly string[]).includes(value);
}

/**
 * Merges a patch onto a profile. Always returns a fresh object with a copied
 * category array, so built-in presets can never be mutated through a resolved
 * profile.
 */
export function applyOverride(base: ReviewerProfile, override: ReviewerOverride | undefined): ReviewerProfile {
  return {
    ...base,
    ...override,
    id: base.id,
    enabledCategories: [...(override?.enabledCategories ?? base.enabledCategories)],
  };
}

/** Policy derived from sensitivity. Sensitivity is not temperature (section 38). */
export interface SensitivityPolicy {
  instruction: string;
  minimumConfidence: number;
  maxComments: number;
}

export function sensitivityInstruction(value: number): string {
  if (value <= 0.25) return "Interrupt only for serious, high-confidence problems.";
  if (value <= 0.6) return "Comment on meaningful problems that are likely to help revision.";
  if (value <= 0.85) return "Include smaller actionable problems as well as major ones.";
  return "Perform meticulous review, including minor actionable issues.";
}

export function sensitivityPolicy(sensitivity: number, maxCommentsPerReview: number): SensitivityPolicy {
  const value = clamp(sensitivity, 0, 1);
  const profileMax = clamp(maxCommentsPerReview, MAX_COMMENTS_LIMITS.min, MAX_COMMENTS_LIMITS.max);

  if (value <= 0.25) {
    return {
      instruction: sensitivityInstruction(value),
      minimumConfidence: 0.8,
      maxComments: Math.min(profileMax, 2),
    };
  }
  if (value <= 0.6) {
    return {
      instruction: sensitivityInstruction(value),
      minimumConfidence: 0.6,
      maxComments: Math.min(profileMax, 4),
    };
  }
  if (value <= 0.85) {
    return {
      instruction: sensitivityInstruction(value),
      minimumConfidence: 0.45,
      maxComments: profileMax,
    };
  }
  return {
    instruction: sensitivityInstruction(value),
    minimumConfidence: 0.3,
    maxComments: profileMax,
  };
}

/** Validates an untrusted stored profile. Returns null when it cannot be repaired. */
export function normalizeProfile(raw: unknown, fallback?: ReviewerProfile): ReviewerProfile | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const input = raw as Record<string, unknown>;

  const id = typeof input.id === "string" ? input.id.trim() : "";
  if (id.length === 0) return null;

  const name = typeof input.name === "string" && input.name.trim().length > 0 ? input.name.trim() : id;
  const categories = normalizeCategories(input.enabledCategories, fallback?.enabledCategories);

  return {
    id,
    name,
    description: typeof input.description === "string" ? input.description : (fallback?.description ?? ""),
    systemInstructions:
      typeof input.systemInstructions === "string"
        ? input.systemInstructions
        : (fallback?.systemInstructions ?? ""),
    enabledCategories: categories,
    sensitivity: clampFraction(input.sensitivity, fallback?.sensitivity ?? 0.5),
    maxCommentsPerReview: clampInt(
      input.maxCommentsPerReview,
      MAX_COMMENTS_LIMITS.min,
      MAX_COMMENTS_LIMITS.max,
      fallback?.maxCommentsPerReview ?? 3,
    ),
  };
}

function normalizeCategories(raw: unknown, fallback?: CommentCategory[]): CommentCategory[] {
  if (!Array.isArray(raw)) return [...(fallback ?? [...COMMENT_CATEGORIES])];
  const valid = raw.filter(isCommentCategory);
  const unique = [...new Set(valid)];
  return unique.length > 0 ? unique : [...(fallback ?? [...COMMENT_CATEGORIES])];
}

function normalizeOverride(raw: unknown): ReviewerOverride | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const input = raw as Record<string, unknown>;
  const override: ReviewerOverride = {};

  if (typeof input.name === "string" && input.name.trim().length > 0) override.name = input.name.trim();
  if (typeof input.description === "string") override.description = input.description;
  if (typeof input.systemInstructions === "string") override.systemInstructions = input.systemInstructions;
  if (Array.isArray(input.enabledCategories)) {
    const categories = [...new Set(input.enabledCategories.filter(isCommentCategory))];
    if (categories.length > 0) override.enabledCategories = categories;
  }
  if (typeof input.sensitivity === "number" && Number.isFinite(input.sensitivity)) {
    override.sensitivity = clampFraction(input.sensitivity, 0.5);
  }
  if (typeof input.maxCommentsPerReview === "number" && Number.isFinite(input.maxCommentsPerReview)) {
    override.maxCommentsPerReview = clampInt(
      input.maxCommentsPerReview,
      MAX_COMMENTS_LIMITS.min,
      MAX_COMMENTS_LIMITS.max,
      3,
    );
  }

  return Object.keys(override).length > 0 ? override : null;
}

/** Total function: any stored value yields usable reviewer data. */
export function normalizeReviewerData(raw: unknown): ReviewerData {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { custom: [], overrides: {}, hidden: [] };
  }
  const input = raw as Record<string, unknown>;

  const custom: ReviewerProfile[] = [];
  if (Array.isArray(input.custom)) {
    const seen = new Set<string>();
    for (const entry of input.custom) {
      const profile = normalizeProfile(entry);
      if (profile && !seen.has(profile.id)) {
        seen.add(profile.id);
        custom.push(profile);
      }
    }
  }

  const overrides: Record<string, ReviewerOverride> = {};
  if (typeof input.overrides === "object" && input.overrides !== null && !Array.isArray(input.overrides)) {
    for (const [id, value] of Object.entries(input.overrides as Record<string, unknown>)) {
      const override = normalizeOverride(value);
      if (override) overrides[id] = override;
    }
  }

  const hidden = Array.isArray(input.hidden)
    ? [...new Set(input.hidden.filter((entry): entry is string => typeof entry === "string"))]
    : [];

  return { custom, overrides, hidden };
}
