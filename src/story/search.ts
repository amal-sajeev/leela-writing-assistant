import type { RetrievedContext } from "../types";
import { hashText } from "../utils/hash";
import { terms } from "../utils/relevance";
import { keepHead } from "../utils/text";

/**
 * Finds the places in earlier chapters that a passage has most to do with, so
 * she can be shown what was actually written and not only her note of it.
 *
 * It is a search by shared words over text already on the machine. Nothing is
 * sent to find them, and nothing is kept on disk: each chapter is cut into
 * stretches of a paragraph or so the first time it is needed, and that is
 * remembered only until the chapter changes or Obsidian closes.
 */

/** Stretches of earlier chapters sent with one review, and how long each may be. */
const MOST_PASSAGES = 3;
const PASSAGE_CHARACTERS = 800;

/** Short paragraphs, such as lines of dialogue, are read together up to about this length. */
const STRETCH_CHARACTERS = 400;

/**
 * A word tells two stretches apart only when few stretches have it. A name on
 * every page says nothing about which page is meant.
 */
const DISTINCTIVE_SHARE = 0.2;

/** Distinctive words a stretch must share with the passage to be worth showing. */
const MINIMUM_SHARED = 2;

interface Stretch {
  text: string;
  words: Set<string>;
}

export interface ChapterText {
  path: string;
  /** The chapter's text, without frontmatter. */
  text: string;
}

export class ChapterSearch {
  private readonly cut = new Map<string, { hash: string; stretches: Stretch[] }>();

  /** The stretches of these chapters nearest the passage, best first. Empty when none is near. */
  find(chapters: readonly ChapterText[], passage: string): RetrievedContext[] {
    const wanted = new Set(terms(passage));
    if (wanted.size === 0 || chapters.length === 0) return [];

    const all = chapters.flatMap((chapter) =>
      this.stretchesOf(chapter).map((stretch) => ({ path: chapter.path, stretch })),
    );
    if (all.length === 0) return [];

    const inHowMany = new Map<string, number>();
    for (const { stretch } of all) {
      for (const word of stretch.words) if (wanted.has(word)) inHowMany.set(word, (inHowMany.get(word) ?? 0) + 1);
    }

    const distinctiveBelow = Math.max(2, all.length * DISTINCTIVE_SHARE);

    return all
      .map(({ path, stretch }) => {
        let score = 0;
        let distinctive = 0;
        for (const word of stretch.words) {
          const count = inHowMany.get(word);
          if (count === undefined) continue;
          score += Math.log(1 + all.length / count);
          if (count <= distinctiveBelow) distinctive += 1;
        }
        return { path, stretch, score, distinctive };
      })
      .filter((entry) => entry.distinctive >= MINIMUM_SHARED)
      .sort((left, right) => right.score - left.score)
      .slice(0, MOST_PASSAGES)
      .map((entry) => ({
        filePath: entry.path,
        excerpt: keepHead(entry.stretch.text, PASSAGE_CHARACTERS),
        score: entry.score,
        reason: "lexical" as const,
      }));
  }

  /** Lets go of chapters that are no longer wanted, such as on unload. */
  clear(): void {
    this.cut.clear();
  }

  private stretchesOf(chapter: ChapterText): Stretch[] {
    const hash = hashText(chapter.text);
    const held = this.cut.get(chapter.path);
    if (held !== undefined && held.hash === hash) return held.stretches;

    const stretches: Stretch[] = [];
    let current = "";

    const close = (): void => {
      if (current.length > 0) stretches.push({ text: current, words: new Set(terms(current)) });
      current = "";
    };

    for (const raw of chapter.text.split(/\n+/)) {
      const paragraph = raw.trim();
      // A heading or a scene break ends a stretch: what follows is another moment.
      if (paragraph.length === 0 || /^(#{1,6}\s|\*\s?\*\s?\*|---+$|___+$)/.test(paragraph)) {
        close();
        continue;
      }

      current = current.length === 0 ? paragraph : `${current}\n${paragraph}`;
      if (current.length >= STRETCH_CHARACTERS) close();
    }
    close();

    this.cut.set(chapter.path, { hash, stretches });
    return stretches;
  }
}
