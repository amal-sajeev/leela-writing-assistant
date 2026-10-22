import { DEFAULT_MODELS, DEFAULT_REQUEST_TIMEOUT_MS } from "../constants";
import { COMMENT_CATEGORIES, PROVIDER_IDS, REVIEW_DEPTHS, type CommentCategory, type ProviderId, type ReviewDepth } from "../types";
import { clampFraction, clampInt } from "../utils/number";

/**
 * Everything the author can change, and the handful of fixed values the reused
 * review machinery reads from the same object.
 *
 * Deliberately short. The settings page shows about ten of these; the rest are
 * here because the live-review scheduler and the providers expect to find them,
 * and are kept at values that have already proved themselves.
 */

/** Extra key slots after the primary one. Four keys in all. */
export const MAX_FALLBACK_KEYS = 3;

/** Model slots tried after the primary one. */
export const MAX_FALLBACK_MODELS = 2;

export interface ProviderSettings {
  apiKey: string;
  /** Extra keys tried in order when the first is rate-limited or rejected. */
  fallbackKeys: string[];
  model: string;
  /** Models tried in order when the primary cannot serve the request. */
  fallbackModels: string[];
  baseUrl?: string;
}

/** Every usable key for a provider, primary first, duplicates dropped. */
export function providerApiKeys(provider: ProviderSettings): string[] {
  const seen = new Set<string>();
  const keys: string[] = [];

  for (const raw of [provider.apiKey, ...provider.fallbackKeys]) {
    const key = raw.trim();
    if (key.length === 0 || seen.has(key)) continue;
    seen.add(key);
    keys.push(key);
  }

  return keys;
}

export const WRITING_MODES = ["fiction", "essay"] as const;
export type WritingMode = (typeof WRITING_MODES)[number];

export const TONES = ["gentle", "balanced", "direct"] as const;
export type Tone = (typeof TONES)[number];

export const WINDOW_PLACES = ["sidebar", "editor"] as const;
export type WindowPlace = (typeof WINDOW_PLACES)[number];

export interface LyraSettings {
  /** Always true: there is no master switch, only the live-review one. */
  enabled: boolean;

  provider: ProviderId;
  providers: Record<ProviderId, ProviderSettings>;

  liveReview: {
    /** Whether she reads along as the author writes. */
    enabled: boolean;
    /** How long after the last keystroke she waits before reading. */
    debounceMs: number;
    minimumChangedCharacters: number;
    maximumChangedCharacters: number;
    reviewOnParagraphBreak: boolean;
    reviewWhileCursorInsideParagraph: boolean;
    reviewOnSave: boolean;
  };

  manualReview: {
    depth: ReviewDepth;
    unlimitedFindings: boolean;
    maximumFindings: number;
    factCheck: boolean;
  };

  context: {
    beforeCharacters: number;
    afterCharacters: number;
    includeFencedCode: boolean;
  };

  /** Who she is as a reader. */
  persona: {
    /** What she looks for, in the author's own words. */
    focus: string;
    /** 0 speaks rarely, 1 lets little pass. */
    pickiness: number;
    /** Whether she may point out something that works. */
    praise: boolean;
    /** What kind of writing she is reading, which decides what she looks for. */
    mode: WritingMode;
    /** How she puts things. What she holds a passage to does not change. */
    tone: Tone;
    /** Whether she talks as herself: informal, dry, a little teasing. Off, she is plain. */
    inCharacter: boolean;
  };

  /** Kinds of finding the author has asked not to hear about. */
  ignoredCategories: CommentCategory[];

  companion: {
    /** Where her window stands: over the right sidebar, or in the editor's corner. */
    place: WindowPlace;
    name: string;
    /** Off, she only shows a count and waits to be asked. */
    speakUp: boolean;
    /** Scanlines, a little picture noise, and static when the scene changes. */
    crt: boolean;
    /** How long a line stays up before she leaves again. */
    lingerSeconds: number;
    /**
     * How wide her window is while she is speaking, in pixels, once the author
     * has dragged it to a size. Null leaves it to fit wherever she stands.
     */
    width: number | null;
  };

  /** Her own notes on a novel: a folder with a story brief in it. */
  story: {
    /** Whether she reads chapters as they change and keeps notes on the story. */
    keepNotes: boolean;
    /** Whether story chats are loaded from and saved between sessions. */
    rememberConversations: boolean;
  };

  /** Whether the passages she commented on are underlined in the note. */
  underline: boolean;

  advanced: {
    requestTimeoutMs: number;
    maxRetries: number;
    retryInitialDelayMs: number;
  };
}

/** The name the reused review modules know these settings by. */
export type AIReviewerSettings = LyraSettings;

/** Her brief for an essay, an article or notes, until the author writes their own. */
export const DEFAULT_ESSAY_FOCUS = [
  "Look for claims a reader could not interpret or would not believe as written,",
  "sentences that are harder to follow than they need to be, steps in an argument",
  "that are missing, and terms used in more than one way.",
  "Do not nitpick, and do not comment on harmless matters of style.",
].join(" ");

/** Her brief for fiction. */
export const DEFAULT_FICTION_FOCUS = [
  "Look for the places where a reader may become confused, unconvinced, disengaged or",
  "emotionally left behind: a character acting against what we know of them without cause,",
  "dialogue that explains itself, a beat the scene rushes or lingers on, a slip in point of",
  "view, feeling that is told after it was shown.",
  "Leave deliberate style alone.",
].join(" ");

/**
 * What an empty brief means. Stored as empty rather than as the default text, so
 * switching between fiction and essay changes the brief with it.
 */
export const DEFAULT_FOCUS = "";

export function focusFor(settings: Pick<LyraSettings, "persona">): string {
  if (settings.persona.focus.trim().length > 0) return settings.persona.focus;
  return settings.persona.mode === "fiction" ? DEFAULT_FICTION_FOCUS : DEFAULT_ESSAY_FOCUS;
}

export const DEFAULT_SETTINGS: LyraSettings = {
  enabled: true,

  provider: "mistral",
  providers: {
    mistral: { apiKey: "", fallbackKeys: [], model: DEFAULT_MODELS.mistral, fallbackModels: [] },
    openai: { apiKey: "", fallbackKeys: [], model: DEFAULT_MODELS.openai, fallbackModels: [] },
    anthropic: { apiKey: "", fallbackKeys: [], model: DEFAULT_MODELS.anthropic, fallbackModels: [] },
    gemini: { apiKey: "", fallbackKeys: [], model: DEFAULT_MODELS.gemini, fallbackModels: [] },
  },

  liveReview: {
    // Off until asked for, so nothing leaves the machine by surprise.
    enabled: false,
    debounceMs: 2500,
    minimumChangedCharacters: 40,
    maximumChangedCharacters: 6000,
    reviewOnParagraphBreak: true,
    reviewWhileCursorInsideParagraph: false,
    reviewOnSave: false,
  },

  manualReview: {
    depth: "quick",
    unlimitedFindings: false,
    maximumFindings: 12,
    factCheck: false,
  },

  context: {
    beforeCharacters: 2500,
    afterCharacters: 1500,
    includeFencedCode: false,
  },

  persona: {
    focus: DEFAULT_FOCUS,
    pickiness: 0.4,
    praise: true,
    mode: "fiction",
    tone: "balanced",
    inCharacter: true,
  },

  ignoredCategories: [],

  companion: {
    place: "sidebar",
    name: "Lyra",
    speakUp: true,
    crt: true,
    lingerSeconds: 14,
    width: null,
  },

  story: {
    keepNotes: true,
    rememberConversations: true,
  },

  underline: true,

  advanced: {
    requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
    maxRetries: 1,
    retryInitialDelayMs: 1000,
  },
};

export const SETTING_LIMITS = {
  debounceMs: { min: 1000, max: 15_000 },
  lingerSeconds: { min: 4, max: 60 },
  windowWidth: { min: 200, max: 1200 },
} as const;

const MAX_NAME = 24;
const MAX_FOCUS = 2_000;

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function asText(value: unknown, fallback: string, maxLength: number): string {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim().slice(0, maxLength)
    : fallback;
}

/** Non-empty strings in order, trimmed, duplicates dropped, capped. */
function asList(value: unknown, limit: number, maxLength?: number): string[] {
  if (!Array.isArray(value)) return [];

  const seen = new Set<string>();
  const result: string[] = [];

  for (const entry of value) {
    if (typeof entry !== "string") continue;

    const text = maxLength === undefined ? entry.trim() : entry.trim().slice(0, maxLength);
    if (text.length === 0 || seen.has(text)) continue;

    seen.add(text);
    result.push(text);
    if (result.length === limit) break;
  }

  return result;
}

function normalizeProvider(raw: unknown, fallback: ProviderSettings): ProviderSettings {
  const input = asRecord(raw);
  const baseUrl = typeof input.baseUrl === "string" ? input.baseUrl.trim() : "";

  return {
    apiKey: typeof input.apiKey === "string" ? input.apiKey.trim() : fallback.apiKey,
    fallbackKeys: asList(input.fallbackKeys, MAX_FALLBACK_KEYS),
    model: asText(input.model, fallback.model, 200),
    fallbackModels: asList(input.fallbackModels, MAX_FALLBACK_MODELS, 200),
    ...(baseUrl.length > 0 ? { baseUrl } : {}),
  };
}

/**
 * Rebuilds valid settings from whatever was stored. Total: any input gives
 * usable settings, and only the values the author can actually change are read
 * back, so a stored copy of a fixed value can never drift from the code.
 */
export function normalizeSettings(raw: unknown): LyraSettings {
  const input = asRecord(raw);
  const defaults = DEFAULT_SETTINGS;

  const providers = asRecord(input.providers);
  const liveReview = asRecord(input.liveReview);
  const manualReview = asRecord(input.manualReview);
  const persona = asRecord(input.persona);
  const companion = asRecord(input.companion);

  return {
    ...defaults,

    provider: PROVIDER_IDS.includes(input.provider as ProviderId)
      ? (input.provider as ProviderId)
      : defaults.provider,

    providers: {
      mistral: normalizeProvider(providers.mistral, defaults.providers.mistral),
      openai: normalizeProvider(providers.openai, defaults.providers.openai),
      anthropic: normalizeProvider(providers.anthropic, defaults.providers.anthropic),
      gemini: normalizeProvider(providers.gemini, defaults.providers.gemini),
    },

    liveReview: {
      ...defaults.liveReview,
      enabled: asBoolean(liveReview.enabled, defaults.liveReview.enabled),
      debounceMs: clampInt(
        liveReview.debounceMs,
        SETTING_LIMITS.debounceMs.min,
        SETTING_LIMITS.debounceMs.max,
        defaults.liveReview.debounceMs,
      ),
    },

    manualReview: {
      depth: REVIEW_DEPTHS.includes(manualReview.depth as ReviewDepth)
        ? (manualReview.depth as ReviewDepth)
        : defaults.manualReview.depth,
      unlimitedFindings: asBoolean(manualReview.unlimitedFindings, defaults.manualReview.unlimitedFindings),
      maximumFindings: clampInt(manualReview.maximumFindings, 1, 20, defaults.manualReview.maximumFindings),
      factCheck: asBoolean(manualReview.factCheck, defaults.manualReview.factCheck),
    },

    persona: {
      // Earlier versions saved the default text itself. Left in place it would pass
      // for the author's own instructions, and pin fiction to the essay brief.
      focus:
        typeof persona.focus === "string" && persona.focus.trim() !== DEFAULT_ESSAY_FOCUS
          ? persona.focus.trim().slice(0, MAX_FOCUS)
          : "",
      pickiness: clampFraction(persona.pickiness, defaults.persona.pickiness),
      praise: asBoolean(persona.praise, defaults.persona.praise),
      mode: WRITING_MODES.includes(persona.mode as WritingMode)
        ? (persona.mode as WritingMode)
        : defaults.persona.mode,
      tone: TONES.includes(persona.tone as Tone) ? (persona.tone as Tone) : defaults.persona.tone,
      inCharacter: asBoolean(persona.inCharacter, defaults.persona.inCharacter),
    },

    ignoredCategories: Array.isArray(input.ignoredCategories)
      ? [
          ...new Set(
            input.ignoredCategories.filter((entry): entry is CommentCategory =>
              (COMMENT_CATEGORIES as readonly unknown[]).includes(entry),
            ),
          ),
        ]
      : [],

    companion: {
      place: WINDOW_PLACES.includes(companion.place as WindowPlace)
        ? (companion.place as WindowPlace)
        : defaults.companion.place,
      name: asText(companion.name, defaults.companion.name, MAX_NAME),
      speakUp: asBoolean(companion.speakUp, defaults.companion.speakUp),
      crt: asBoolean(companion.crt, defaults.companion.crt),
      lingerSeconds: clampInt(
        companion.lingerSeconds,
        SETTING_LIMITS.lingerSeconds.min,
        SETTING_LIMITS.lingerSeconds.max,
        defaults.companion.lingerSeconds,
      ),
      width:
        typeof companion.width === "number" && Number.isFinite(companion.width)
          ? clampInt(
              companion.width,
              SETTING_LIMITS.windowWidth.min,
              SETTING_LIMITS.windowWidth.max,
              SETTING_LIMITS.windowWidth.min,
            )
          : null,
    },

    story: {
      keepNotes: asBoolean(asRecord(input.story).keepNotes, defaults.story.keepNotes),
      rememberConversations: asBoolean(asRecord(input.story).rememberConversations, defaults.story.rememberConversations),
    },

    underline: asBoolean(input.underline, defaults.underline),
  };
}
