import { resolveAnchor } from "../comments/anchor-resolver";
import { buildSelectionContext, type HeadingEntry } from "../context/context-builder";
import { redactKnownSecrets } from "../privacy/redaction";
import type { AIProvider } from "../providers/provider";
import { toProviderError, type ProviderError } from "../providers/provider-errors";
import { providerApiKeys, type LyraSettings } from "../settings/settings";
import type { ReviewComment, SuggestedFix } from "../types";
import { normalizeForComparison } from "../utils/text";
import {
  buildExplainPrompt,
  buildFixPrompt,
  buildReplyPrompt,
  type InteractionInput,
} from "./interaction-prompts";
import type { RenderedPrompt } from "./prompt-builder";
import { persona } from "./review";
import { parseReviewerReply, type ReviewerReply } from "./reply";
export { parseReviewerReply } from "./reply";

/**
 * Talking back to her about one comment: asking why, disagreeing, or asking to
 * be shown what she means.
 *
 * Each of these is one request about one passage, built from the note as it is
 * now. None of them touches the note: an example comes back as text for the
 * author to read, and to copy or apply if they like it.
 */

export type InteractionResult<T> =
  | { status: "ok"; value: T; sent: RenderedPrompt }
  /** Nothing was sent, because something the request needs is not there. */
  | { status: "unavailable"; reason: string }
  | { status: "failed"; error: ProviderError };

export interface InteractionRequest {
  comment: ReviewComment;
  documentTitle: string;
  /** The note as its editor has it now. */
  documentText: string;
  bodyStart?: number;
  headings?: readonly HeadingEntry[];
}

/** She unpacks a comment: which words create the problem, and what would count as dealing with it. */
export function explain(
  request: InteractionRequest,
  settings: LyraSettings,
  provider: AIProvider,
): Promise<InteractionResult<ReviewerReply>> {
  return converse(request, settings, (input) => buildExplainPrompt(input), (prompt) =>
    provider.replyToComment(prompt).then(parseReviewerReply),
  );
}

/** The author answers her, and she answers that: conceding when they are right. */
export function reply(
  request: InteractionRequest,
  question: string,
  settings: LyraSettings,
  provider: AIProvider,
): Promise<InteractionResult<ReviewerReply>> {
  const asked = question.trim();
  if (asked.length === 0) {
    return Promise.resolve({ status: "unavailable", reason: "Write something to send." });
  }

  return converse(request, settings, (input) => buildReplyPrompt({ ...input, question: asked }), (prompt) =>
    provider.replyToComment(prompt).then(parseReviewerReply),
  );
}

/**
 * One way the passage could go: an illustration of her point in the author's
 * voice, not the correct version. Asking for one writes nothing to the note.
 */
export async function example(
  request: InteractionRequest,
  settings: LyraSettings,
  provider: AIProvider,
): Promise<InteractionResult<SuggestedFix>> {
  const result = await converse(request, settings, (input) => buildFixPrompt(input), (prompt) =>
    provider.generateFix(prompt),
  );

  if (result.status === "ok" && result.value.replacement.trim().length === 0) {
    return { status: "unavailable", reason: "She had no example to offer for that." };
  }
  return result;
}

/**
 * Where an example may be written: the passage the comment is about, found again
 * in the note as it is now, and only if it still reads as it did when she
 * commented. Null when it does not, in which case nothing is to be replaced: an
 * example written for one sentence must not land on another.
 */
export function exampleSpan(
  documentText: string,
  comment: ReviewComment,
): { start: number; end: number } | null {
  if (comment.suggestedFix === undefined) return null;

  const resolution = resolveAnchor(documentText, comment.anchor);
  if (resolution.status === "stale") return null;

  const current = documentText.slice(resolution.start, resolution.end);
  if (normalizeForComparison(current) !== normalizeForComparison(comment.anchor.quote)) return null;

  return { start: resolution.start, end: resolution.end };
}

async function converse<T>(
  request: InteractionRequest,
  settings: LyraSettings,
  build: (input: InteractionInput) => RenderedPrompt,
  send: (prompt: RenderedPrompt) => Promise<T>,
): Promise<InteractionResult<T>> {
  const resolution = resolveAnchor(request.documentText, request.comment.anchor);
  if (resolution.status === "stale") {
    return {
      status: "unavailable",
      reason: "That passage has changed since she commented on it, so there is nothing left to discuss.",
    };
  }

  // The same surroundings a review sees: a conversation about a paragraph is no
  // use if she can see less of the story than when she first read it.
  const context = buildSelectionContext({
    documentText: request.documentText,
    selectionStart: resolution.start,
    selectionEnd: resolution.end,
    ...(request.bodyStart === undefined ? {} : { bodyStart: request.bodyStart }),
    ...(request.headings === undefined ? {} : { headings: request.headings }),
    budget: {
      beforeCharacters: settings.context.beforeCharacters,
      afterCharacters: settings.context.afterCharacters,
      includeWholeNoteForShortNotes: true,
      shortNoteThreshold: settings.context.beforeCharacters + settings.context.afterCharacters,
    },
  });

  const rendered = build({
    comment: request.comment,
    reviewer: persona(settings),
    documentTitle: request.documentTitle,
    passage: context.changedText,
    beforeContext: context.beforeContext,
    afterContext: context.afterContext,
    ...(context.headingPath.length === 0 ? {} : { headingPath: context.headingPath }),
  });

  // A key pasted into a note is ordinary text, and must not travel with it.
  const keys = Object.values(settings.providers).flatMap((entry) => providerApiKeys(entry));
  const sent: RenderedPrompt = {
    systemPrompt: redactKnownSecrets(rendered.systemPrompt, keys),
    userPrompt: redactKnownSecrets(rendered.userPrompt, keys),
  };

  try {
    return { status: "ok", value: await send(sent), sent };
  } catch (error) {
    return { status: "failed", error: toProviderError(error) };
  }
}
