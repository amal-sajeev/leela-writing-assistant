import type { ProviderId } from "./types";

export const PLUGIN_ID = "lyra-companion";
export const PLUGIN_NAME = "Lyra";

/** The file, beside the plugin, that holds what she has said about each note. */
export const COMMENTS_FILE_NAME = "comments.json";
export const COMMENTS_SCHEMA_VERSION = 1;

/**
 * The note that tells her about a story, in the story's folder or one above it.
 * An ordinary visible note: Obsidian keeps no record of files that start with a dot.
 */
export const BRIEF_FILE_NAME = "Lyra brief.md";

/**
 * Where she keeps her own notes on a novel, inside the novel's folder. A visible
 * folder on purpose: the author has to be able to read what she believes about
 * the story, and correct it.
 */
export const STORY_NOTES_FOLDER = "Lyra notes";

/** A note opts out with `lyra: false` in its frontmatter. */
export const FRONTMATTER_OPT_OUT_KEY = "lyra";

/** The largest selection she will read in one go. */
export const MAX_SELECTION_CHARACTERS = 8_000;

/** Long manual ranges are chunked, and stop at this run-level safety bound. */
export const MAX_EXHAUSTIVE_REVIEW_CHARACTERS = 50_000;

/** Characters of surrounding text stored with each anchor. */
export const ANCHOR_CONTEXT_CHARACTERS = 100;

/**
 * How far either side of the remembered offset the resolver looks before it
 * gives up on locality and scans the whole document.
 */
export const ANCHOR_SEARCH_WINDOW_CHARACTERS = 2_000;

/**
 * Below this score an anchor is treated as lost rather than guessed at. A comment
 * pinned to the wrong sentence is worse than one marked stale.
 */
export const ANCHOR_MIN_CONFIDENCE = 0.55;

/** Two dirty ranges closer than this are treated as one changed passage. */
export const DIRTY_RANGE_MERGE_GAP = 200;

/** Provider requests in flight at once, across every note. */
export const MAX_CONCURRENT_PROVIDER_REQUESTS = 2;

/**
 * How long live review stands down for a note after a provider failure, so a bad
 * key or a dead network cannot produce a request every time the author pauses.
 */
export const LIVE_REVIEW_FAILURE_COOLDOWN_MS = 60_000;

export const PROVIDER_DISPLAY_NAMES: Record<ProviderId, string> = {
  mistral: "Mistral",
  openai: "OpenAI",
  anthropic: "Anthropic",
  gemini: "Gemini",
  openrouter: "OpenRouter",
};

/**
 * Starting points only. Model identifiers change often, so the field is free
 * text and these are never treated as an allow-list.
 */
export const DEFAULT_MODELS: Record<ProviderId, string> = {
  mistral: "mistral-large-latest",
  openai: "gpt-5.6-terra",
  anthropic: "claude-sonnet-5-5",
  gemini: "gemini-3.6-flash",
  openrouter: "openrouter/free",
};

export const DEFAULT_REQUEST_TIMEOUT_MS = 45_000;

export const MISTRAL_DEFAULT_BASE_URL = "https://api.mistral.ai/v1";
export const OPENAI_DEFAULT_BASE_URL = "https://api.openai.com/v1";
export const OPENROUTER_DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";

/** Anthropic's paths carry their own version segment, so this stops at the host. */
export const ANTHROPIC_DEFAULT_BASE_URL = "https://api.anthropic.com";

/** Gemini's version is a path segment too: the adapter appends `/v1/...`. */
export const GEMINI_DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com";

/** Required on every Anthropic request; not a beta flag. */
export const ANTHROPIC_API_VERSION = "2023-06-01";

/**
 * Close to deterministic, so the same passage does not draw a different set of
 * complaints on each pass.
 */
export const REVIEW_TEMPERATURE = 0.2;
export const REPLY_TEMPERATURE = 0.3;
