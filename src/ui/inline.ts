/** Parses emphasis and code into safe text runs; links and HTML stay plain text. */

export type InlineStyle = "plain" | "em" | "strong" | "code";

export interface InlineRun {
  text: string;
  style: InlineStyle;
}

/**
 * Strong before emphasis, so `**word**` is not read as emphasis around
 * asterisks. Underscores only count at the edge of a word, which leaves
 * `snake_case` and `a_b_c` alone. A marker must hug the text it wraps, so a lone
 * `*` used as a bullet or a multiplication sign is left as it is.
 */
const INLINE =
  /\*\*(?=\S)([^*]*?\S)\*\*|(^|[^\w_])__(?=\S)([^_]*?\S)__(?![\w_])|\*(?=\S)([^*]*?\S)\*|(^|[^\w_])_(?=\S)([^_]*?\S)_(?![\w_])|`([^`\n]+)`/g;

export function parseInline(source: string): InlineRun[] {
  const text = tidy(source);
  const runs: InlineRun[] = [];
  let from = 0;

  for (const match of text.matchAll(INLINE)) {
    const at = match.index;
    const [whole, strongStar, strongUnderPrefix, strongUnder, emStar, emUnderPrefix, emUnder, code] = match;
    const markerAt = at + (strongUnderPrefix ?? emUnderPrefix ?? "").length;
    if (markerAt > from) runs.push({ text: text.slice(from, markerAt), style: "plain" });

    if (strongStar !== undefined || strongUnder !== undefined) {
      runs.push({ text: strongStar ?? strongUnder!, style: "strong" });
    } else if (emStar !== undefined || emUnder !== undefined) {
      runs.push({ text: emStar ?? emUnder!, style: "em" });
    } else {
      runs.push({ text: code!, style: "code" });
    }

    from = at + whole.length;
  }

  if (from < text.length) runs.push({ text: text.slice(from), style: "plain" });
  return runs;
}

/** What a line says with its markers taken out: what is typed out letter by letter. */
export function plainText(source: string): string {
  return parseInline(source)
    .map((run) => run.text)
    .join("");
}

/**
 * Typographic quotes become straight ones. The pixel and Gothic fonts her window
 * uses draw the curly ones a full cell wide, which opens a gap in the middle of
 * every "don't".
 */
function tidy(text: string): string {
  return text.replace(/[‘’‛]/g, "'").replace(/[“”‟]/g, '"');
}
