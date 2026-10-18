import { DIRTY_RANGE_MERGE_GAP } from "../constants";

/**
 * What changed in a note, and whether it is worth reviewing yet
 * (specification section 16).
 *
 * Pure over plain offsets and text: the editor reports ranges, this module
 * decides what they add up to. Nothing here reads a document more than once, so
 * it can run on the far side of the debounce without a second thought.
 */

export interface DirtyRange {
  from: number;
  to: number;
}

/**
 * Adds a changed range to a set, merging anything within
 * {@link DIRTY_RANGE_MERGE_GAP} characters of it. The result stays sorted and
 * non-overlapping, so it never grows beyond the number of passages touched.
 */
export function addDirtyRange(
  ranges: readonly DirtyRange[],
  range: DirtyRange,
  mergeGap: number = DIRTY_RANGE_MERGE_GAP,
): DirtyRange[] {
  const incoming = normalize(range);
  const merged: DirtyRange[] = [];
  let current = incoming;

  for (const existing of [...ranges].sort((a, b) => a.from - b.from)) {
    const candidate = normalize(existing);

    if (touches(candidate, current, mergeGap)) {
      current = {
        from: Math.min(current.from, candidate.from),
        to: Math.max(current.to, candidate.to),
      };
      continue;
    }

    merged.push(candidate);
  }

  merged.push(current);
  merged.sort((a, b) => a.from - b.from);

  return merged;
}

/** Moves recorded ranges onto a newer revision of the note. */
export function mapDirtyRanges(
  ranges: readonly DirtyRange[],
  mapPosition: (position: number) => number,
): DirtyRange[] {
  const mapped: DirtyRange[] = [];

  for (const range of ranges) {
    const from = mapPosition(range.from);
    const to = mapPosition(range.to);
    if (to >= from) mapped.push({ from, to });
  }

  return mapped;
}

/** Smallest range covering every dirty range. */
export function unionOf(ranges: readonly DirtyRange[]): DirtyRange | null {
  if (ranges.length === 0) return null;

  return {
    from: Math.min(...ranges.map((range) => range.from)),
    to: Math.max(...ranges.map((range) => range.to)),
  };
}

export function totalLength(ranges: readonly DirtyRange[]): number {
  return ranges.reduce((sum, range) => sum + (range.to - range.from), 0);
}

/**
 * Grows a range to whole paragraphs, since a reviewer needs the sentence the
 * author was editing rather than the four words they retyped.
 *
 * Blank lines and headings are the boundaries: a heading belongs to the section
 * it opens, so a change in one section never drags the previous one along.
 */
export function expandToBlocks(text: string, range: DirtyRange, bodyStart = 0): DirtyRange {
  const floor = clamp(bodyStart, 0, text.length);
  const start = clamp(range.from, floor, text.length);
  const end = clamp(Math.max(range.to, start), start, text.length);

  return { from: blockStart(text, start, floor), to: blockEnd(text, end) };
}

/** Why a changed passage is not being sent, when it is not. */
export type SkipReason =
  | "empty"
  | "whitespace"
  | "partial-word"
  | "too-small"
  | "frontmatter"
  | "fenced-code";

export type Reviewability = { ok: true } | { ok: false; reason: SkipReason };

export interface ReviewabilityInput {
  text: string;
  range: DirtyRange;
  minimumCharacters: number;
  /**
   * True when the author finished a paragraph or moved on from the one they
   * changed. A finished paragraph is reviewed however short it is; an unfinished
   * one waits, because half a sentence is not an error (section 16).
   */
  paragraphCompleted: boolean;
  includeFencedCode: boolean;
  bodyStart?: number;
}

export function reviewability(input: ReviewabilityInput): Reviewability {
  const { text, range } = input;
  const bodyStart = clamp(input.bodyStart ?? 0, 0, text.length);

  if (range.to <= range.from) return { ok: false, reason: "empty" };
  if (range.to <= bodyStart) return { ok: false, reason: "frontmatter" };

  const passage = text.slice(clamp(range.from, 0, text.length), clamp(range.to, 0, text.length));
  const trimmed = passage.trim();

  if (trimmed.length === 0) return { ok: false, reason: "whitespace" };

  if (!input.includeFencedCode && insideFence(text, range.from)) {
    return { ok: false, reason: "fenced-code" };
  }

  if (input.paragraphCompleted) return { ok: true };

  // A single unfinished word tells a reviewer nothing, whatever the threshold is.
  if (!/\s/.test(trimmed)) return { ok: false, reason: "partial-word" };
  if (trimmed.length < input.minimumCharacters) return { ok: false, reason: "too-small" };

  return { ok: true };
}

export interface ReviewRangeInput {
  text: string;
  ranges: readonly DirtyRange[];
  maximumCharacters: number;
  bodyStart?: number;
  /** The passage edited most recently, preferred when the union is too large. */
  preferred?: DirtyRange | null;
}

/**
 * The passage to send for a set of dirty ranges.
 *
 * Scattered edits are reviewed together while they fit the budget, because their
 * paragraphs read as one piece of writing. When they do not fit, the passage the
 * author touched last wins: it is the one they are still thinking about.
 */
export function selectReviewRange(input: ReviewRangeInput): DirtyRange | null {
  const union = unionOf(input.ranges);
  if (union === null) return null;

  const expanded = expandToBlocks(input.text, union, input.bodyStart);
  if (expanded.to - expanded.from <= input.maximumCharacters) return expanded;

  const preferred = input.preferred ?? input.ranges[input.ranges.length - 1] ?? null;
  if (preferred === null) return null;

  const fallback = expandToBlocks(input.text, preferred, input.bodyStart);
  if (fallback.to - fallback.from <= input.maximumCharacters) return fallback;

  // A single paragraph over the budget: review its end, where the author is.
  return { from: Math.max(fallback.to - input.maximumCharacters, fallback.from), to: fallback.to };
}

function blockStart(text: string, offset: number, floor: number): number {
  let lineStart = startOfLine(text, offset);

  while (lineStart > floor) {
    const previousStart = startOfLine(text, lineStart - 1);
    const previousLine = text.slice(previousStart, lineStart - 1);

    if (previousLine.trim().length === 0) break;
    if (isHeading(previousLine)) break;
    // The changed line is itself a heading: its section starts here.
    if (isHeading(text.slice(lineStart, endOfLine(text, lineStart)))) break;

    lineStart = previousStart;
  }

  return Math.max(lineStart, floor);
}

function blockEnd(text: string, offset: number): number {
  let lineEnd = endOfLine(text, offset);

  while (lineEnd < text.length) {
    const nextStart = lineEnd + 1;
    const nextEnd = endOfLine(text, nextStart);
    const nextLine = text.slice(nextStart, nextEnd);

    if (nextLine.trim().length === 0) break;
    if (isHeading(nextLine)) break;

    lineEnd = nextEnd;
  }

  return lineEnd;
}

function startOfLine(text: string, offset: number): number {
  const newline = text.lastIndexOf("\n", Math.max(offset - 1, 0));
  return newline === -1 ? 0 : newline + 1;
}

function endOfLine(text: string, offset: number): number {
  const newline = text.indexOf("\n", offset);
  return newline === -1 ? text.length : newline;
}

function isHeading(line: string): boolean {
  return /^ {0,3}#{1,6}\s/.test(line);
}

/** Odd number of fences before an offset means it sits inside a code block. */
function insideFence(text: string, offset: number): boolean {
  const before = text.slice(0, clamp(offset, 0, text.length));
  const fences = before.match(/^ {0,3}(```|~~~)/gm);
  return fences !== null && fences.length % 2 === 1;
}

function touches(a: DirtyRange, b: DirtyRange, mergeGap: number): boolean {
  const gap = a.from > b.to ? a.from - b.to : b.from - a.to;
  return gap <= mergeGap;
}

function normalize(range: DirtyRange): DirtyRange {
  const from = Math.max(0, Math.min(range.from, range.to));
  const to = Math.max(0, Math.max(range.from, range.to));
  return { from, to };
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(Math.round(value), min), max);
}
