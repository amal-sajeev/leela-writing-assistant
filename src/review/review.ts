import { createAnchor } from "../comments/anchor";
import { withoutDashes } from "../utils/text";
import { resolveAnchor } from "../comments/anchor-resolver";
import { isSettled } from "../comments/comment-state";
import { buildSelectionContext } from "../context/context-builder";
import { redactKnownSecrets } from "../privacy/redaction";
import type { AIProvider } from "../providers/provider";
import { sensitivityPolicy } from "../reviewers/reviewer";
import { focusFor, providerApiKeys, type LyraSettings, type Tone } from "../settings/settings";
import type { CommentCategory, RetrievedContext, ReviewComment, ReviewerProfile } from "../types";
import { createId } from "../utils/ids";
import { hashText } from "../utils/hash";
import { normalizeForComparison } from "../utils/text";
import { filterComments, type ExistingCommentSummary } from "./comment-filter";
import { buildFictionPrompt } from "./fiction-prompt";
import { buildReviewPrompt, type RenderedPrompt } from "./prompt-builder";

/**
 * One review of one passage, start to finish: gather the text around it, ask the
 * provider, keep only what points at real text and says something new, and turn
 * the survivors into comments anchored in the note.
 *
 * Pure apart from the provider call, so everything she decides to say, and not
 * to say, can be tested without Obsidian.
 */

/** The reviewer's id on every comment. There is only one reviewer here. */
export const REVIEWER_ID = "lyra";

/** Comments she may make about one passage. */
const MAX_COMMENTS = 3;

/** What she reads fiction for. */
const FICTION_CATEGORIES: readonly CommentCategory[] = [
  "character",
  "dialogue",
  "pacing",
  "pov",
  "exposition",
  "emotion",
  "prose",
  "continuity",
  "clarity",
  "other",
];

/** What she reads an essay, an article or notes for. */
const ESSAY_CATEGORIES: readonly CommentCategory[] = [
  "clarity",
  "reasoning",
  "evidence",
  "fact",
  "consistency",
  "structure",
  "style",
  "grammar",
  "terminology",
  "other",
];

/** Manner only: none of these changes what counts as a finding. */
const TONE: Record<Tone, string> = {
  gentle:
    "Manner: gentle. Be warm and unhurried, and say what you see as an observation, not a verdict. Do not soften what you found into something vaguer than it is.",
  balanced: "Manner: plain and courteous. Say what you see without cushioning it or sharpening it.",
  direct:
    "Manner: direct. Say it in as few words as it takes, with no cushioning. Being brief is not being harsh: stay on the text.",
};

/**
 * Who she is when she talks. Cool, dry and unhurried, after the kind of
 * immortal who has watched a great many people be sure of themselves: faintly
 * amused, never rattled, never gushing, warm only in passing. It changes how a
 * finding is said and nothing about what counts as one.
 */
const VOICE = [
  "HOW YOU TALK. You have been reading over writers' shoulders for a very long time. Nothing much " +
    "impresses you and nothing rattles you. Talk to the author as someone you are faintly amused " +
    "by and quietly on the side of: cool, dry, unhurried, a little teasing, never cruel, never gushing.",
  "- Talk, do not report. Contractions, short sentences, everyday words, first person. Say \"you\", never \"the author\" or \"the writer\".",
  "- You may start with a small reaction of your own when it is earned (\"Hm.\" \"Careful.\" \"Oh, this one again.\"), and not every time. Vary it; never the same opener twice in a row.",
  "- Tease the writing, never the person. One dry aside at most, and none when the point is a serious one.",
  "- When something is good, say so in a few offhand words. That is how they know you mean it.",
  "- When you are wrong, concede in a line and move on. No apology, no fuss.",
  "- No stage directions, no actions written between asterisks, no emoji, no exclamation marks, no catchphrases, no mention of being a character or an AI. It is all in how you phrase things.",
  "- The manner is yours. The substance does not change: be exact about the words on the page and what they do to a reader.",
].join("\n");

/** What makes writing read as machine-made. Held to whether or not she is in character. */
const NO_TROPES = [
  "DO NOT SOUND MACHINE-WRITTEN:",
  "- No em dashes and no en dashes, anywhere. Use a full stop or a comma.",
  "- No \"it's not X, it's Y\" turns. No lists of three for rhythm. No question you then answer yourself.",
  "- None of these words: delve, tapestry, testament, nuanced, resonate, elevate, crucial, pivotal, landscape, underscore, showcase, seamless, robust, compelling, vivid, navigate, journey.",
  "- Do not open with \"I noticed\", \"It's worth noting\", \"Consider\", \"While\" or a compliment before a criticism. Do not close with a summary, an offer of more help, or encouragement.",
  "- Do not stack hedges (\"might perhaps\", \"could potentially\"). Say it once, as sure as you are.",
].join("\n");

/** Below this she speaks only about serious problems, and questions of taste are not those. */
const TASTE_FROM_PICKINESS = 0.25;

/** Existing comments the model is told about, so it does not repeat them. */
const MAX_NEARBY = 12;

export interface PassageReviewInput {
  filePath: string;
  documentTitle: string;
  documentText: string;
  /** Bounds of the passage to read. */
  start: number;
  end: number;
  /** Offset after any frontmatter, which is never sent. */
  bodyStart?: number;
  /** What she has already said about this note. */
  existing: readonly ReviewComment[];
  /** The author's brief for this story, when there is one. */
  brief?: string;
  /** Excerpts of the notes the brief names as canon. */
  canon?: readonly RetrievedContext[];
  /** The shape of the whole story, when she keeps an outline of it. */
  outline?: string;
  /**
   * The most findings wanted from this reading. A passage read in the background
   * yields one: a stream of notes while the author is still composing is noise.
   */
  limit?: number;
}

export interface PassageReviewOutcome {
  /** The passage that was actually read, which may be wider than what was asked. */
  span: { start: number; end: number };
  comments: ReviewComment[];
  /** Exactly what was sent, for the author to look at. Absent when nothing was. */
  sent?: RenderedPrompt;
}

/** How she talks, whatever she is talking about: her manner, and what she never sounds like. */
export function voiceOf(settings: LyraSettings): string {
  return [TONE[settings.persona.tone], ...(settings.persona.inCharacter ? [VOICE] : []), NO_TROPES].join("\n\n");
}

/** Who she is as a reader, built from the three things the author can set. */
export function persona(settings: LyraSettings): ReviewerProfile {
  return {
    id: REVIEWER_ID,
    name: settings.companion.name,
    description: "",
    systemInstructions: `${focusFor(settings)}\n\n${voiceOf(settings)}`,
    enabledCategories: [
      ...(settings.persona.mode === "fiction" ? FICTION_CATEGORIES : ESSAY_CATEGORIES),
      ...(settings.persona.praise ? (["strength"] as const) : []),
    ].filter((category) => !settings.ignoredCategories.includes(category)),
    sensitivity: settings.persona.pickiness,
    maxCommentsPerReview: MAX_COMMENTS,
  };
}

export async function reviewPassage(
  input: PassageReviewInput,
  settings: LyraSettings,
  provider: AIProvider,
  signal?: AbortSignal,
): Promise<PassageReviewOutcome> {
  const who = persona(settings);
  // She can speak about the whole story only with an outline of it in front of her.
  const outline =
    settings.persona.mode === "fiction" && !settings.ignoredCategories.includes("arc")
      ? input.outline?.trim() ?? ""
      : "";
  const reviewer: ReviewerProfile =
    outline.length > 0 ? { ...who, enabledCategories: ["arc", ...who.enabledCategories] } : who;
  const base = sensitivityPolicy(reviewer.sensitivity, reviewer.maxCommentsPerReview);
  const policy =
    input.limit === undefined
      ? base
      : { ...base, maxComments: Math.max(1, Math.min(base.maxComments, Math.floor(input.limit))) };

  const context = buildSelectionContext({
    documentText: input.documentText,
    selectionStart: input.start,
    selectionEnd: input.end,
    ...(input.bodyStart === undefined ? {} : { bodyStart: input.bodyStart }),
    budget: {
      beforeCharacters: settings.context.beforeCharacters,
      afterCharacters: settings.context.afterCharacters,
      includeWholeNoteForShortNotes: true,
      shortNoteThreshold: settings.context.beforeCharacters + settings.context.afterCharacters,
    },
  });

  const span = { start: context.changedStart, end: context.changedEnd };
  if (context.changedText.trim().length === 0) return { span, comments: [] };

  const from = context.changedStart - context.beforeContext.length;
  const to = context.changedEnd + context.afterContext.length;
  const nearby = input.existing
    .filter((comment) => comment.status === "open" || isSettled(comment))
    .filter((comment) => comment.anchor.end >= from && comment.anchor.start <= to)
    .slice(0, MAX_NEARBY);

  const build = settings.persona.mode === "fiction" ? buildFictionPrompt : buildReviewPrompt;
  const prompt = build(
    {
      filePath: input.filePath,
      documentTitle: input.documentTitle,
      changedText: context.changedText,
      changedStart: context.changedStart,
      changedEnd: context.changedEnd,
      beforeContext: context.beforeContext,
      afterContext: context.afterContext,
      ...(nearby.length > 0 ? { existingNearbyComments: nearby } : {}),
      ...(input.brief === undefined ? {} : { projectInstructions: input.brief }),
      ...(input.canon === undefined || input.canon.length === 0
        ? {}
        : { retrievedVaultContext: [...input.canon] }),
      ...(outline.length > 0 ? { storyOutline: outline } : {}),
      reviewer,
    },
    policy,
  );

  // A key pasted into a note is ordinary text, and must not travel with it.
  const keys = Object.values(settings.providers).flatMap((entry) => providerApiKeys(entry));

  const sent: RenderedPrompt = {
    systemPrompt: redactKnownSecrets(prompt.systemPrompt, keys),
    userPrompt: redactKnownSecrets(prompt.userPrompt, keys),
  };

  const result = await provider.review({ ...sent, maxComments: policy.maxComments }, signal);

  const summarize = (keep: (comment: ReviewComment) => boolean): ExistingCommentSummary[] =>
    nearby.filter(keep).map((comment) => ({
      quote: comment.anchor.quote,
      body: comment.body,
      category: comment.category,
    }));

  const filtered = filterComments(result.comments, {
    reviewedText: context.changedText,
    enabledCategories: reviewer.enabledCategories,
    minimumConfidence: policy.minimumConfidence,
    maxComments: policy.maxComments,
    existingComments: summarize((comment) => comment.status === "open"),
    settledComments: summarize(isSettled),
    allowTaste: settings.persona.pickiness > TASTE_FROM_PICKINESS,
  });

  const createdAt = Date.now();
  const revision = hashText(context.changedText);

  const comments = filtered.accepted.map((comment): ReviewComment => ({
    id: createId("comment"),
    filePath: input.filePath,
    reviewerId: REVIEWER_ID,
    category: comment.category,
    severity: comment.severity,
    confidence: comment.confidence,
    ...(comment.kind === undefined ? {} : { kind: comment.kind }),
    ...(comment.reaction === undefined ? {} : { reaction: comment.reaction }),
    anchor: createAnchor(
      input.documentText,
      context.changedStart + comment.quoteStart,
      context.changedStart + comment.quoteEnd,
    ),
    body: withoutDashes(comment.body),
    ...(comment.rationale === undefined ? {} : { rationale: withoutDashes(comment.rationale) }),
    status: "open",
    createdAt,
    updatedAt: createdAt,
    sourceRevisionHash: revision,
    thread: [],
  }));

  return { span, comments, sent };
}

/**
 * What a note carries after a review of one passage.
 *
 * Her open comments on the passage she just re-read are replaced, since the new
 * answer supersedes the old one, including when it is "nothing to say". Whatever
 * the author already settled stays settled, and comments elsewhere are untouched.
 */
export function mergeReview(
  existing: readonly ReviewComment[],
  outcome: PassageReviewOutcome,
  reviewedText: string,
): ReviewComment[] {
  const kept = existing.filter((comment) => {
    if (comment.status !== "open" && comment.status !== "stale") return true;

    // Placed in the text that was reviewed, which later edits may have left behind.
    const placed = resolveAnchor(reviewedText, comment.anchor);
    const at = placed.status === "resolved" ? placed : comment.anchor;
    return !(at.start < outcome.span.end && at.end > outcome.span.start);
  });

  const key = (comment: ReviewComment): string =>
    `${normalizeForComparison(comment.anchor.quote)}::${normalizeForComparison(comment.body).slice(0, 60)}`;
  const seen = new Set(kept.map(key));

  const added = outcome.comments.filter((comment) => {
    if (seen.has(key(comment))) return false;
    seen.add(key(comment));
    return true;
  });

  return [...kept, ...added];
}
