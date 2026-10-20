import { createAnchor } from "../comments/anchor";
import { withoutDashes } from "../utils/text";
import { resolveAnchor } from "../comments/anchor-resolver";
import { isSettled } from "../comments/comment-state";
import { buildSelectionContext, type HeadingEntry } from "../context/context-builder";
import { redactKnownSecrets } from "../privacy/redaction";
import type { AIProvider } from "../providers/provider";
import { sensitivityPolicy } from "../reviewers/reviewer";
import { focusFor, providerApiKeys, type LyraSettings, type Tone } from "../settings/settings";
import type { CommentCategory, RetrievedContext, ReviewComment, ReviewerProfile, ReviewDepth } from "../types";
import { createId } from "../utils/ids";
import { hashText } from "../utils/hash";
import { normalizeForComparison } from "../utils/text";
import { scoreAgainst } from "../utils/relevance";
import { filterComments, type ExistingCommentSummary } from "./comment-filter";
import { selectAnalysisTechniques } from "./analysis-techniques";
import { reconcileIssueLedger } from "./issue-ledger";
import { buildFictionPrompt } from "./fiction-prompt";
import { buildReviewPrompt, type RenderedPrompt } from "./prompt-builder";
import { planReviewJobs, ReviewOrchestrator, type ReviewProgress, type ReviewSpan } from "./review-orchestrator";

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
const MAX_COMMENTS = 20;
const UNLIMITED_RESPONSE_CEILING = 1_000;

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
  headings?: readonly HeadingEntry[];
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
  /** Depth is set for manual reviews; live review keeps the single-pass path. */
  mode?: ReviewDepth;
  /** Removes the application finding-count target for this manual run. */
  unlimitedFindings?: boolean;
  /** Per-request ceiling. The run-level limit is applied after the passes merge. */
  maxCommentsPerRequest?: number;
  /** Focus for a bounded analysis pass. */
  analysisFocus?: string;
  factCheck?: boolean;
  onProgress?: (progress: ReviewProgress) => void;
}

export interface PassageReviewOutcome {
  /** The passage that was actually read, which may be wider than what was asked. */
  span: { start: number; end: number };
  comments: ReviewComment[];
  /** Parts that completed every required pass; failed parts keep old comments. */
  coveredSpans?: ReviewSpan[];
  complete?: boolean;
  warnings?: string[];
  requests?: number;
  diagnostics?: ReviewDiagnostics;
  /** Exactly what was sent, for the author to look at. Absent when nothing was. */
  sent?: RenderedPrompt;
}

export interface ReviewDiagnostics {
  accepted: number;
  duplicate: number;
  unsupported: number;
  lowConfidence: number;
  settled: number;
  otherRejected: number;
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
  if (input.mode === undefined) return reviewSinglePassage(input, settings, provider, signal);

  const jobs = planReviewJobs(input.documentText, input.start, input.end, input.mode);
  if (jobs.length === 0) {
    return { span: { start: input.start, end: input.end }, comments: [], coveredSpans: [], complete: true, requests: 0 };
  }

  const orchestrator = new ReviewOrchestrator();
  const run = await orchestrator.run<PassageReviewOutcome>({
    text: input.documentText,
    jobs,
    mode: input.mode,
    signal,
    onProgress: input.onProgress,
    countFindings: (outcome) => outcome.comments.length,
    coverageOf: (outcome) => outcome.span,
    runJob: (job) =>
      reviewSinglePassage(
        {
          ...input,
          start: job.start,
          end: job.end,
          ...(input.unlimitedFindings
            ? {}
            : { maxCommentsPerRequest: input.maxCommentsPerRequest ?? input.limit ?? MAX_COMMENTS }),
          analysisFocus: job.instruction,
          onProgress: undefined,
        },
        settings,
        provider,
        signal,
      ),
  });

  const ledger = reconcileIssueLedger(run.results.flatMap(({ value }) => value.comments));
  const candidates = ledger.comments;
  const ranked = candidates.sort(byImportance);
  const comments = input.limit === undefined ? ranked : ranked.slice(0, Math.max(0, Math.floor(input.limit)));
  const lastSent = run.results.at(-1)?.value.sent;
  const diagnostics = run.results
    .map(({ value }) => value.diagnostics)
    .filter((value): value is ReviewDiagnostics => value !== undefined)
    .reduce(addDiagnostics, emptyDiagnostics());
  diagnostics.accepted = comments.length;
  diagnostics.duplicate += ledger.duplicates;

  return {
    span: { start: input.start, end: input.end },
    comments,
    coveredSpans: run.coveredSpans,
    complete: run.complete,
    warnings: run.warnings,
    requests: run.requests,
    diagnostics,
    ...(lastSent === undefined ? {} : { sent: lastSent }),
  };
}

async function reviewSinglePassage(
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
  const requestedLimit = input.maxCommentsPerRequest ?? input.limit;
  const policy = input.unlimitedFindings
    ? { ...base, maxComments: UNLIMITED_RESPONSE_CEILING, unlimitedFindings: true }
    : requestedLimit === undefined
      ? base
      : { ...base, maxComments: Math.max(1, Math.min(MAX_COMMENTS, Math.floor(requestedLimit))) };

  const context = buildSelectionContext({
    documentText: input.documentText,
    selectionStart: input.start,
    selectionEnd: input.end,
    ...(input.bodyStart === undefined ? {} : { bodyStart: input.bodyStart }),
    ...(input.headings === undefined ? {} : { headings: input.headings }),
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
  const nearbyCandidates = input.existing
    .filter((comment) => comment.status === "open" || isSettled(comment))
    .filter((comment) => comment.anchor.end >= from && comment.anchor.start <= to);
  const nearby = rankNearbyComments(nearbyCandidates, context.changedText, context.changedStart, context.changedEnd, reviewer.enabledCategories)
    .slice(0, MAX_NEARBY);
  const settledInRange = input.existing.filter((comment) =>
    isSettled(comment) && comment.anchor.end >= context.changedStart && comment.anchor.start <= context.changedEnd,
  );

  const build = settings.persona.mode === "fiction" ? buildFictionPrompt : buildReviewPrompt;
  const builtPrompt = build(
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
      ...(context.headingPath.length === 0 ? {} : { headingPath: context.headingPath }),
      analysisTechniques: selectAnalysisTechniques(settings.persona.mode, reviewer.enabledCategories, input.mode ?? "quick"),
      ...(input.factCheck === true && settings.persona.mode === "essay" ? { factCheckMode: true } : {}),
      ...(outline.length > 0 ? { storyOutline: outline } : {}),
      reviewer,
    },
    policy,
  );
  const prompt: RenderedPrompt = input.analysisFocus === undefined
    ? builtPrompt
    : {
        ...builtPrompt,
        systemPrompt: `${builtPrompt.systemPrompt}\n\nFOCUSED PASS\n${input.analysisFocus}\nOnly report issues this pass can support. Do not invent findings to fill a category.`,
      };

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
    settledComments: settledInRange.map((comment) => ({
      quote: comment.anchor.quote,
      body: comment.body,
      category: comment.category,
    })),
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

  return { span, comments, diagnostics: diagnosticsFor(filtered), sent };
}

function emptyDiagnostics(): ReviewDiagnostics {
  return { accepted: 0, duplicate: 0, unsupported: 0, lowConfidence: 0, settled: 0, otherRejected: 0 };
}

function addDiagnostics(total: ReviewDiagnostics, next: ReviewDiagnostics): ReviewDiagnostics {
  total.accepted += next.accepted;
  total.duplicate += next.duplicate;
  total.unsupported += next.unsupported;
  total.lowConfidence += next.lowConfidence;
  total.settled += next.settled;
  total.otherRejected += next.otherRejected;
  return total;
}

function diagnosticsFor(outcome: ReturnType<typeof filterComments>): ReviewDiagnostics {
  const diagnostics = emptyDiagnostics();
  diagnostics.accepted = outcome.accepted.length;
  for (const { reason } of outcome.rejected) {
    if (reason === "duplicate") diagnostics.duplicate += 1;
    else if (reason === "quote-not-found" || reason === "quote-too-broad") diagnostics.unsupported += 1;
    else if (reason === "low-confidence") diagnostics.lowConfidence += 1;
    else if (reason === "settled") diagnostics.settled += 1;
    else diagnostics.otherRejected += 1;
  }
  return diagnostics;
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
  const coveredSpans = outcome.coveredSpans ?? [outcome.span];
  const kept = existing.filter((comment) => {
    if (comment.status !== "open" && comment.status !== "stale") return true;

    // Placed in the text that was reviewed, which later edits may have left behind.
    const placed = resolveAnchor(reviewedText, comment.anchor);
    const at = placed.status === "resolved" ? placed : comment.anchor;
    return !coveredSpans.some((span) => at.start < span.end && at.end > span.start);
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

function rankNearbyComments(
  comments: readonly ReviewComment[],
  passage: string,
  start: number,
  end: number,
  enabledCategories: readonly CommentCategory[],
): ReviewComment[] {
  const similarity = scoreAgainst(passage, comments.map((comment) => `${comment.anchor.quote}\n${comment.body}`));
  return comments
    .map((comment, index) => {
      const distance = comment.anchor.end < start
        ? start - comment.anchor.end
        : comment.anchor.start > end
          ? comment.anchor.start - end
          : 0;
      const proximity = distance === 0 ? 4 : 2 / (1 + distance / 500);
      const settledPriority = isSettled(comment) ? 1 : 0;
      const categoryPriority = enabledCategories.includes(comment.category) ? 0.25 : 0;
      return { comment, score: proximity + (similarity[index] ?? 0) + settledPriority + categoryPriority };
    })
    .sort((a, b) => b.score - a.score || a.comment.anchor.start - b.comment.anchor.start)
    .map(({ comment }) => comment);
}

function byImportance(a: ReviewComment, b: ReviewComment): number {
  const rank = { high: 3, medium: 2, low: 1 } as const;
  if (a.category === "strength" !== (b.category === "strength")) return a.category === "strength" ? 1 : -1;
  return rank[b.severity] - rank[a.severity] || b.confidence - a.confidence || a.anchor.start - b.anchor.start;
}
