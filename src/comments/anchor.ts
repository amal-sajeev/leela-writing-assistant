import { ANCHOR_CONTEXT_CHARACTERS } from "../constants";
import type { TextAnchor } from "../types";
import { hashAnchorContext } from "../utils/hash";
import { keepHead, keepTail } from "../utils/text";

/**
 * Creates the durable record of where a comment belongs (specification section 18).
 *
 * Offsets alone are useless in a document that is still being written, so the
 * quote and its immediate neighbourhood are stored alongside them. The resolver
 * uses those to find the passage again after the offsets have gone stale.
 */
export function createAnchor(documentText: string, start: number, end: number): TextAnchor {
  const span = clampSpan(documentText, start, end);
  const quote = documentText.slice(span.start, span.end);
  const prefix = keepTail(documentText.slice(0, span.start), ANCHOR_CONTEXT_CHARACTERS);
  const suffix = keepHead(documentText.slice(span.end), ANCHOR_CONTEXT_CHARACTERS);

  return {
    quote,
    prefix,
    suffix,
    start: span.start,
    end: span.end,
    contextHash: hashAnchorContext(prefix, quote, suffix),
  };
}

/** The same anchor with new offsets, keeping the original context evidence. */
export function anchorAt(anchor: TextAnchor, start: number, end: number): TextAnchor {
  if (anchor.start === start && anchor.end === end) return anchor;
  return { ...anchor, start, end };
}

/**
 * Brings offsets inside the document and off surrogate boundaries.
 *
 * Emoji and other astral characters occupy two UTF-16 units; slicing between
 * them produces a lone surrogate that can never be found again.
 */
export function clampSpan(
  text: string,
  start: number,
  end: number,
): { start: number; end: number } {
  const lower = Math.max(0, Math.min(text.length, Math.min(start, end)));
  const upper = Math.max(0, Math.min(text.length, Math.max(start, end)));

  return {
    start: alignStart(text, lower),
    end: alignEnd(text, upper),
  };
}

/** Moves an opening offset back onto a code-point boundary. */
function alignStart(text: string, offset: number): number {
  return offset > 0 && isLowSurrogate(text.charCodeAt(offset)) ? offset - 1 : offset;
}

/** Moves a closing offset forward onto a code-point boundary. */
function alignEnd(text: string, offset: number): number {
  return offset < text.length && isLowSurrogate(text.charCodeAt(offset)) ? offset + 1 : offset;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}
