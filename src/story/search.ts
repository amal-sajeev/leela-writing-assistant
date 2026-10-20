import type { RetrievedContext } from "../types";
import { hashText } from "../utils/hash";
import { terms } from "../utils/relevance";
import { keepHead } from "../utils/text";

const MOST_PASSAGES = 3;
const PASSAGE_CHARACTERS = 800;
const STRETCH_CHARACTERS = 400;
const MINIMUM_SHARED = 2;

interface Stretch {
  text: string;
  words: string[];
  heading?: string;
  start: number;
  end: number;
}

export interface ChapterText {
  path: string;
  text: string;
}

export class ChapterSearch {
  private readonly cut = new Map<string, { hash: string; stretches: Stretch[] }>();

  find(chapters: readonly ChapterText[], passage: string): RetrievedContext[] {
    const wanted = new Set(terms(passage));
    if (wanted.size === 0 || chapters.length === 0) return [];

    const all = chapters.flatMap((chapter, chapterIndex) =>
      this.stretchesOf(chapter).map((stretch) => ({
        path: chapter.path,
        chapterIndex,
        chapterCount: chapters.length,
        titleWords: new Set(terms(pathTitle(chapter.path))),
        stretch,
      })),
    );
    if (all.length === 0) return [];

    const documentFrequency = new Map<string, number>();
    for (const { stretch } of all) {
      for (const word of new Set(stretch.words)) {
        if (wanted.has(word)) documentFrequency.set(word, (documentFrequency.get(word) ?? 0) + 1);
      }
    }

    return all
      .map((entry) => {
        const counts = new Map<string, number>();
        for (const word of entry.stretch.words) counts.set(word, (counts.get(word) ?? 0) + 1);
        let lexical = 0;
        let distinctive = 0;
        for (const [word, count] of counts) {
          const frequency = documentFrequency.get(word);
          if (frequency === undefined) continue;
          const idf = Math.log(1 + (all.length - frequency + 0.5) / (frequency + 0.5));
          lexical += idf * ((count * 2.2) / (count + 1.2));
          if (frequency <= Math.max(2, all.length * 0.2)) distinctive += 1;
        }

        const headingWords = new Set(terms(entry.stretch.heading ?? ""));
        const titleMatches = overlapCount(wanted, entry.titleWords);
        const headingMatches = overlapCount(wanted, headingWords);
        const entityMatches = sharedEntities(passage, entry.stretch.text);
        const recency = entry.chapterCount <= 1 ? 0 : entry.chapterIndex / (entry.chapterCount - 1);
        const score = lexical + titleMatches * 1.2 + headingMatches * 1.6 + entityMatches * 2 + recency * 0.25;

        return { ...entry, score, distinctive, titleMatches, headingMatches, entityMatches };
      })
      .filter((entry) =>
        entry.distinctive >= MINIMUM_SHARED || entry.titleMatches > 0 || entry.headingMatches > 0 || entry.entityMatches > 0,
      )
      .sort((left, right) => right.score - left.score || right.chapterIndex - left.chapterIndex)
      .slice(0, MOST_PASSAGES)
      .map((entry) => ({
        filePath: entry.path,
        excerpt: keepHead(entry.stretch.text, PASSAGE_CHARACTERS),
        score: entry.score,
        reason: "lexical" as const,
        start: entry.stretch.start,
        end: entry.stretch.end,
        ...(entry.stretch.heading === undefined ? {} : { heading: entry.stretch.heading }),
      }));
  }

  clear(): void {
    this.cut.clear();
  }

  private stretchesOf(chapter: ChapterText): Stretch[] {
    const hash = hashText(chapter.text);
    const held = this.cut.get(chapter.path);
    if (held !== undefined && held.hash === hash) return held.stretches;

    const stretches: Stretch[] = [];
    let current = "";
    let currentStart = 0;
    let currentEnd = 0;
    let activeHeading: string | undefined;

    const close = (): void => {
      if (current.length > 0) {
        stretches.push({
          text: current,
          words: terms(current),
          start: currentStart,
          end: currentEnd,
          ...(activeHeading === undefined ? {} : { heading: activeHeading }),
        });
      }
      current = "";
    };

    let offset = 0;
    for (const match of chapter.text.matchAll(/[^\n]*(?:\n|$)/g)) {
      const raw = match[0];
      if (raw.length === 0) break;
      const line = raw.replace(/[\r\n]+$/, "");
      const trimmed = line.trim();
      const lineStart = offset;
      offset += raw.length;

      if (trimmed.length === 0 || /^(\*\s?\*\s?\*|---+$|___+$)/.test(trimmed)) {
        close();
        continue;
      }
      if (/^#{1,6}\s/.test(trimmed)) {
        close();
        activeHeading = trimmed.replace(/^#{1,6}\s+/, "").trim();
        continue;
      }

      if (current.length === 0) currentStart = lineStart + line.indexOf(trimmed);
      current = current.length === 0 ? trimmed : `${current}\n${trimmed}`;
      currentEnd = lineStart + line.lastIndexOf(trimmed) + trimmed.length;
      if (current.length >= STRETCH_CHARACTERS) close();
    }
    close();

    this.cut.set(chapter.path, { hash, stretches });
    return stretches;
  }
}

function pathTitle(path: string): string {
  const name = path.split("/").at(-1) ?? path;
  return name.replace(/\.md$/i, "").replace(/[-_]+/g, " ");
}

function overlapCount(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
  let count = 0;
  for (const word of left) if (right.has(word)) count += 1;
  return count;
}

function sharedEntities(left: string, right: string): number {
  const entities = (text: string): Set<string> =>
    new Set(
      [...text.matchAll(/\b[A-Z][\p{L}\p{N}'-]*(?:\s+[A-Z][\p{L}\p{N}'-]*)*/gu)]
        .map((match) => match[0].toLowerCase())
        .filter((value) => value.trim().split(/\s+/).length > 1),
    );
  return overlapCount(entities(left), entities(right));
}
