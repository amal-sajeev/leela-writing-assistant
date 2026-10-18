/**
 * The scene around the cursor, for "read this scene".
 *
 * A scene is what lies between two breaks: a heading, or a line that is nothing
 * but a scene break (`***`, `---`, `* * *`, `###`, `~~~`). Fiction in Markdown
 * marks scenes one of those ways or not at all, in which case the scene is the
 * note. Pure over text and offsets.
 */

export interface SceneBounds {
  start: number;
  end: number;
  /** True when the scene was longer than the limit and only part of it is covered. */
  truncated: boolean;
}

export function sceneAround(
  text: string,
  cursor: number,
  options: { bodyStart?: number; maxCharacters: number },
): SceneBounds {
  const floor = clamp(options.bodyStart ?? 0, 0, text.length);
  const at = clamp(cursor, floor, text.length);

  let start = floor;
  let end = text.length;
  let offset = floor;

  for (const line of text.slice(floor).split("\n")) {
    const lineStart = offset;
    const lineEnd = offset + line.length;
    offset = lineEnd + 1;

    if (!isBreak(line)) continue;

    // A heading opens the scene under it, so it belongs to that scene; a rule
    // belongs to neither side.
    if (lineEnd <= at || (isHeading(line) && lineStart <= at)) {
      start = isHeading(line) ? lineStart : Math.min(offset, text.length);
    } else if (lineStart > at) {
      end = lineStart;
      break;
    }
  }

  // Trim the blank lines either side, without moving any text.
  while (start < end && /\s/.test(text[start]!)) start += 1;
  while (end > start && /\s/.test(text[end - 1]!)) end -= 1;

  const limit = Math.max(1, Math.floor(options.maxCharacters));
  if (end - start <= limit) return { start, end, truncated: false };

  // Too long to read whole: the stretch around the cursor, cut at paragraph ends.
  let from = Math.max(start, at - Math.floor(limit / 2));
  let to = Math.min(end, from + limit);
  from = Math.max(start, to - limit);

  const paragraphAfter = text.indexOf("\n\n", from);
  if (from > start && paragraphAfter >= 0 && paragraphAfter + 2 < at) from = paragraphAfter + 2;

  const paragraphBefore = text.lastIndexOf("\n\n", to);
  if (to < end && paragraphBefore > at) to = paragraphBefore;

  return { start: from, end: to, truncated: true };
}

function isHeading(line: string): boolean {
  return /^ {0,3}#{1,6}\s+\S/.test(line);
}

function isBreak(line: string): boolean {
  if (isHeading(line)) return true;
  // Three or more of one mark and nothing else, spaced or not.
  return /^\s*(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,}|(?:~\s*){3,}|#{3,})\s*$/.test(line);
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(Math.round(value), min), max);
}
