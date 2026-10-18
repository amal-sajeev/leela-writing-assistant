import { keepHead } from "./text";

/**
 * Which of several pieces of text bear on a passage, judged by the words they
 * share with it.
 *
 * Nothing is sent anywhere and nothing is stored: this is counting, done each
 * time from text already in hand. A word counts for more the fewer pieces it
 * appears in, so a shared "station" in notes that are all about the station
 * says little, and a shared "ticket" says a good deal.
 */

const STOPWORDS = new Set(
  (
    "the and but for nor not you your yours she her hers him his they them their theirs its was were been being " +
    "are has had have having does did doing will would shall should can could may might must that this these those " +
    "there here then than when where which while who whom whose what why how with without from into onto over under " +
    "about after before again once only just very too also some any all each every both few more most other such " +
    "own same out off down upon said says say still even ever never now well back away through because until " +
    "one two like got get went come came going know knew think thought made make way"
  ).split(" "),
);

/** The words of a text that carry meaning, lowercased, plurals folded onto their singular. */
export function terms(text: string): string[] {
  const out: string[] = [];

  for (const match of text.toLowerCase().matchAll(/[\p{L}\p{N}]+/gu)) {
    let word = match[0];
    if (word.length > 3 && word.endsWith("s") && !word.endsWith("ss")) word = word.slice(0, -1);
    if (word.length >= 3 && !STOPWORDS.has(word)) out.push(word);
  }

  return out;
}

/** A score for each candidate: higher shares more, and rarer, words with the passage. Zero shares none. */
export function scoreAgainst(passage: string, candidates: readonly string[]): number[] {
  const wanted = new Set(terms(passage));
  if (wanted.size === 0) return candidates.map(() => 0);

  const sets = candidates.map((candidate) => new Set(terms(candidate)));
  const found = new Map<string, number>();
  for (const set of sets) {
    for (const term of set) if (wanted.has(term)) found.set(term, (found.get(term) ?? 0) + 1);
  }

  return sets.map((set) => {
    let score = 0;
    for (const term of set) {
      const inHowMany = found.get(term);
      if (inHowMany !== undefined) score += Math.log(1 + candidates.length / inHowMany);
    }
    return score;
  });
}

/**
 * The most relevant of several items, at most `most`, in the order they were
 * given. Ties go to the later item: of two facts equally near the passage, the
 * one from the later chapter is the one more likely to be current.
 */
export function mostRelevant<Item>(
  passage: string,
  items: readonly Item[],
  textOf: (item: Item) => string,
  most: number,
): Item[] {
  if (items.length <= most) return [...items];

  const scores = scoreAgainst(passage, items.map(textOf));
  const chosen = items
    .map((_, index) => index)
    .sort((left, right) => scores[right]! - scores[left]! || right - left)
    .slice(0, most)
    .sort((left, right) => left - right);

  return chosen.map((index) => items[index]!);
}

interface Block {
  heading: string;
  text: string;
}

/**
 * The parts of a note that bear on a passage, within a budget.
 *
 * A note that fits is returned whole. A longer one is taken paragraph by
 * paragraph, the ones nearest the passage first, each under the heading it sits
 * beneath, in the note's own order. With nothing in common it falls back to how
 * the note opens, which is where a note usually says what it is.
 */
export function relevantParts(text: string, passage: string, budget: number): string {
  if (text.length <= budget) return text;

  const blocks = blocksOf(text);
  const scores = scoreAgainst(
    passage,
    blocks.map((block) => `${block.heading}\n${block.text}`),
  );
  if (scores.every((score) => score === 0)) return keepHead(text, budget);

  const order = blocks
    .map((_, index) => index)
    .filter((index) => scores[index]! > 0)
    .sort((left, right) => scores[right]! - scores[left]! || left - right);

  const taken = new Set<number>();
  let remaining = budget;
  for (const index of order) {
    const block = blocks[index]!;
    const cost = block.text.length + block.heading.length + 4;
    if (cost > remaining) {
      // The best match alone is too long: take its start rather than nothing.
      if (taken.size === 0) return keepHead(`${block.heading}\n\n${block.text}`.trim(), budget);
      continue;
    }
    taken.add(index);
    remaining -= cost;
  }

  const out: string[] = [];
  let heading = "";
  let last = -1;
  for (const index of [...taken].sort((left, right) => left - right)) {
    const block = blocks[index]!;
    if (last >= 0 && index !== last + 1) out.push("[…]");
    if (block.heading !== heading && block.heading.length > 0) out.push(block.heading);
    heading = block.heading;
    out.push(block.text);
    last = index;
  }

  return out.join("\n\n");
}

/** A note as paragraphs, each knowing the heading it is under. */
function blocksOf(text: string): Block[] {
  const blocks: Block[] = [];
  let heading = "";

  for (const raw of text.split(/\n\s*\n/)) {
    let body = raw.trim();
    if (body.length === 0) continue;

    // A heading may sit directly on top of its first paragraph, with no blank line.
    const first = body.split("\n", 1)[0]!;
    if (/^#{1,6}\s/.test(first)) {
      heading = first.trim();
      body = body.slice(first.length).trim();
      if (body.length === 0) continue;
    }

    blocks.push({ heading, text: body });
  }

  return blocks;
}
