import { keepHead, keepTail } from "../utils/text";

/**
 * Assembles the text sent with a review (specification sections 49 to 51).
 *
 * Pure over plain data: the caller reads the editor and the metadata cache and
 * passes offsets, so context bounds are unit-testable without Obsidian.
 */

/** Heading as reported by Obsidian's metadata cache, reduced to what we need. */
export interface HeadingEntry {
  level: number;
  heading: string;
  /** Offset of the heading line in the document. */
  offset: number;
}

export interface ContextBudget {
  beforeCharacters: number;
  afterCharacters: number;
  includeWholeNoteForShortNotes: boolean;
  shortNoteThreshold: number;
}

export interface SelectionContextInput {
  documentText: string;
  selectionStart: number;
  selectionEnd: number;
  /**
   * Offset where the note body starts, after any YAML frontmatter. Frontmatter is
   * never sent as context (specification section 54).
   */
  bodyStart?: number;
  headings?: readonly HeadingEntry[];
  budget: ContextBudget;
}

export interface SelectionContext {
  changedText: string;
  changedStart: number;
  changedEnd: number;
  beforeContext: string;
  afterContext: string;
  headingPath: string[];
}

export function buildSelectionContext(input: SelectionContextInput): SelectionContext {
  const text = input.documentText;
  const bodyStart = clampOffset(input.bodyStart ?? 0, 0, text.length);

  const start = clampOffset(Math.min(input.selectionStart, input.selectionEnd), bodyStart, text.length);
  const end = clampOffset(Math.max(input.selectionStart, input.selectionEnd), start, text.length);

  const body = text.slice(bodyStart);
  const wholeNote =
    input.budget.includeWholeNoteForShortNotes && body.length <= input.budget.shortNoteThreshold;

  const beforeRaw = text.slice(bodyStart, start);
  const afterRaw = text.slice(end);

  return {
    changedText: text.slice(start, end),
    changedStart: start,
    changedEnd: end,
    beforeContext: wholeNote ? beforeRaw : boundedBefore(beforeRaw, input.budget.beforeCharacters),
    afterContext: wholeNote ? afterRaw : boundedAfter(afterRaw, input.budget.afterCharacters),
    headingPath: headingPath(input.headings ?? [], start),
  };
}

/** Only a cut edge needs repairing; text that fitted the budget is sent as it is. */
function boundedBefore(text: string, maxChars: number): string {
  const kept = keepTail(text, maxChars);
  return kept.length < text.length ? trimToBoundaryStart(kept) : kept;
}

function boundedAfter(text: string, maxChars: number): string {
  const kept = keepHead(text, maxChars);
  return kept.length < text.length ? trimToBoundaryEnd(kept) : kept;
}

/**
 * Heading trail containing the offset, outermost first. Deeper headings replace
 * any sibling or deeper entry already on the stack.
 */
export function headingPath(headings: readonly HeadingEntry[], offset: number): string[] {
  const stack: HeadingEntry[] = [];

  for (const heading of headings) {
    if (heading.offset > offset) break;
    while (stack.length > 0 && stack[stack.length - 1]!.level >= heading.level) stack.pop();
    stack.push(heading);
  }

  return stack.map((heading) => heading.heading);
}

/**
 * Drops a leading partial line so context does not begin mid-word, unless that
 * would discard almost everything.
 */
function trimToBoundaryStart(text: string): string {
  if (text.length === 0) return text;

  const newline = text.indexOf("\n");
  if (newline >= 0 && newline < text.length / 2) return text.slice(newline + 1);

  const space = text.indexOf(" ");
  return space >= 0 && space < 40 ? text.slice(space + 1) : text;
}

/** Drops a trailing partial line for the same reason. */
function trimToBoundaryEnd(text: string): string {
  if (text.length === 0) return text;

  const newline = text.lastIndexOf("\n");
  if (newline >= 0 && newline > text.length / 2) return text.slice(0, newline);

  const space = text.lastIndexOf(" ");
  return space >= 0 && space > text.length - 40 ? text.slice(0, space) : text;
}

function clampOffset(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(Math.round(value), min), max);
}
