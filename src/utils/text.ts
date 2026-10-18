/**
 * Pure text helpers. Context trimming must never split a Unicode surrogate
 * pair (specification section 50).
 */

export function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function isBlank(text: string): boolean {
  return text.trim().length === 0;
}

/** Keeps the first `maxChars` characters, without splitting a surrogate pair. */
export function keepHead(text: string, maxChars: number): string {
  if (maxChars <= 0) return "";
  if (text.length <= maxChars) return text;

  let end = maxChars;
  if (isHighSurrogate(text.charCodeAt(end - 1))) end -= 1;
  return text.slice(0, end);
}

/** Keeps the last `maxChars` characters, without splitting a surrogate pair. */
export function keepTail(text: string, maxChars: number): string {
  if (maxChars <= 0) return "";
  if (text.length <= maxChars) return text;

  let start = text.length - maxChars;
  if (isLowSurrogate(text.charCodeAt(start))) start += 1;
  return text.slice(start);
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/** Case- and whitespace-insensitive form used for duplicate detection. */
export function normalizeForComparison(text: string): string {
  return normalizeWhitespace(text).toLowerCase();
}

/**
 * Her words with any em or en dash taken out. She is told not to use them; this
 * is for when a model does anyway. A range of numbers becomes "3 to 4", and a
 * dash used as punctuation becomes a comma.
 */
export function withoutDashes(text: string): string {
  return text
    .replace(/(\d)\s*[\u2013\u2014]\s*(\d)/g, "$1 to $2")
    .replace(/\s*[\u2013\u2014]\s*/g, ", ")
    .replace(/,(\s*,)+/g, ",")
    .replace(/,\s*([.!?;:])/g, "$1")
    .replace(/^,\s*/, "");
}
