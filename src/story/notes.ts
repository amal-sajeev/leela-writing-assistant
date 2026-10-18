import type { RetrievedContext } from "../types";
import { joinVaultPath } from "../utils/paths";
import { mostRelevant, scoreAgainst } from "../utils/relevance";
import { keepHead } from "../utils/text";
import type { ChapterFacts, Fact } from "./facts";
import { chapterName, inReadingOrder, notesFolderOf } from "./novel";
import type { OutlineRecord } from "./outline";

/** Builds readable story notes from the stored chapter facts and author corrections. */

export interface ChapterRecord {
  /** Hash of the chapter's text when it was read, so an unchanged chapter is not read again. */
  hash: string;
  readAt: number;
  facts: ChapterFacts;
}

export interface StoryState {
  version: number;
  /** Chapter path to what she recorded from it. */
  chapters: Record<string, ChapterRecord>;
  /** The shape of the whole story, as of the last chapter she read. */
  outline?: OutlineRecord;
}

export const STORY_STATE_VERSION = 1;

export function emptyState(): StoryState {
  return { version: STORY_STATE_VERSION, chapters: {} };
}

/** The notes she writes, by file name. */
export const NOTE_FILES = ["Characters", "Places", "Timeline", "Threads", "Chapters"] as const;
export type NoteFile = (typeof NOTE_FILES)[number];

const CORRECTIONS_HEADING = "## Corrections";
const RECORD_HEADING = "## What the chapters say";

const INTRO: Record<NoteFile, string> = {
  Characters: "Who is in the story, and what each chapter establishes about them.",
  Places: "Where the story happens, and what each chapter establishes about it.",
  Timeline: "What happens, chapter by chapter, in the order it is told.",
  Threads: "Questions raised, promises made to the reader, and things planted for later.",
  Chapters: "What happens in each chapter, in brief.",
};

/**
 * What the author wrote under Corrections in one of her notes. It is theirs:
 * kept exactly as it is when the note is rewritten, and treated as fact.
 */
export function correctionsIn(existing: string | null): string {
  if (existing === null) return "";

  const start = existing.indexOf(CORRECTIONS_HEADING);
  if (start < 0) return "";

  const from = start + CORRECTIONS_HEADING.length;
  const end = existing.indexOf(RECORD_HEADING, from);
  const body = (end < 0 ? existing.slice(from) : existing.slice(from, end)).trim();

  return body === CORRECTIONS_PLACEHOLDER ? "" : body;
}

const CORRECTIONS_PLACEHOLDER =
  "_Nothing yet. Anything you write here is kept when this note is rewritten, and she takes it as fact over what is below._";

/** One of her notes, written out from the record, with the author's corrections kept. */
export function renderNote(file: NoteFile, state: StoryState, existing: string | null): string {
  const corrections = correctionsIn(existing);
  const record = renderRecord(file, state);

  return [
    `> Kept by Lyra. ${INTRO[file]}`,
    "> Everything under “What the chapters say” is rewritten whenever a chapter changes, so edits there are lost. To correct her, write under Corrections.",
    "",
    CORRECTIONS_HEADING,
    "",
    corrections.length > 0 ? corrections : CORRECTIONS_PLACEHOLDER,
    "",
    RECORD_HEADING,
    "",
    record.length > 0 ? record : "_Nothing recorded yet._",
    "",
  ].join("\n");
}

function renderRecord(file: NoteFile, state: StoryState): string {
  const chapters = inReadingOrder(Object.keys(state.chapters));
  const recordOf = (path: string): ChapterFacts => state.chapters[path]!.facts;
  const link = (path: string): string => `[[${chapterName(path)}]]`;

  if (file === "Characters" || file === "Places") {
    const key = file === "Characters" ? "characters" : "places";
    return [...gather(state, chapters, key).entries()]
      .map(([name, entries]) =>
        [`### ${name}`, ...entries.map((entry) => `- ${line(entry.fact)} ${link(entry.chapter)}`)].join("\n"),
      )
      .join("\n\n");
  }

  if (file === "Chapters") {
    return chapters
      .filter((path) => recordOf(path).summary.length > 0)
      .map((path) => `### ${link(path)}\n${recordOf(path).summary}`)
      .join("\n\n");
  }

  if (file === "Timeline") {
    return chapters
      .filter((path) => recordOf(path).events.length > 0)
      .map((path) =>
        [
          `### ${link(path)}`,
          ...recordOf(path).events.map(
            (event) => `- ${event.when === undefined ? "" : `**${event.when}:** `}${event.what}`,
          ),
        ].join("\n"),
      )
      .join("\n\n");
  }

  return chapters
    .filter((path) => recordOf(path).threads.length > 0)
    .map((path) =>
      [
        `### ${link(path)}`,
        ...recordOf(path).threads.map((thread) => `- (${thread.state}) ${thread.what}`),
      ].join("\n"),
    )
    .join("\n\n");
}

function line(fact: Fact): string {
  return fact.quote === undefined ? fact.fact : `${fact.fact} (“${fact.quote}”)`;
}

/**
 * Everyone, or everywhere, on record, with what each chapter said of them, in
 * reading order. Names are matched without regard to case, and the first
 * spelling met is the one kept.
 */
function gather(
  state: StoryState,
  chapters: readonly string[],
  key: "characters" | "places",
): Map<string, Array<{ chapter: string; fact: Fact }>> {
  const byName = new Map<string, Array<{ chapter: string; fact: Fact }>>();
  const spelling = new Map<string, string>();

  for (const chapter of chapters) {
    for (const entry of state.chapters[chapter]!.facts[key]) {
      const lower = entry.name.toLowerCase();
      const name = spelling.get(lower) ?? entry.name;
      spelling.set(lower, name);

      const facts = byName.get(name) ?? [];
      for (const fact of entry.notes) facts.push({ chapter, fact });
      byName.set(name, facts);
    }
  }

  return byName;
}

/** Every name on record, for telling the next chapter's reading which spellings exist. */
export function knownNames(state: StoryState, key: "characters" | "places"): string[] {
  return [...gather(state, inReadingOrder(Object.keys(state.chapters)), key).keys()];
}

/** How much of her notes may travel with one review. */
const NOTES_BUDGET = 6_000;

/** Earlier chapters whose summaries are always sent: the ones just before this one. */
const RECENT_CHAPTERS = 8;

/** Older chapters whose summaries are sent as well, when they share most with the passage. */
const RECALLED_CHAPTERS = 3;

/**
 * Facts sent about the people, or the places, a passage names. With more on
 * record, the ones nearest the passage. Shared out among those named, so a
 * scene with one person in it carries a great deal about that one.
 */
const FACTS_IN_ALL = 40;
const FACTS_PER_NAME = 8;

/** Open threads sent. With more open, the ones nearest the passage. */
const OPEN_THREADS = 12;

export interface RelevantInput {
  novel: string;
  state: StoryState;
  /** The note being read. When it is a chapter, only chapters before it are drawn on. */
  filePath: string;
  /** The passage and its surroundings, which decide who and where is relevant. */
  text: string;
  /** What the author wrote under Corrections, by note. */
  corrections: Partial<Record<NoteFile, string>>;
}

/** Selects earlier story facts relevant to a passage, within the prompt budget. */
export function relevantNotes(input: RelevantInput): RetrievedContext[] {
  const ordered = inReadingOrder(Object.keys(input.state.chapters));
  const at = ordered.indexOf(input.filePath);
  const earlier = at < 0 ? ordered : ordered.slice(0, at);
  const notes = notesFolderOf(input.novel);
  const link = (path: string): string => chapterName(path);

  const out: RetrievedContext[] = [];
  let remaining = NOTES_BUDGET;

  const add = (file: NoteFile | "Corrections", body: string): void => {
    const text = body.trim();
    if (text.length === 0 || remaining < 120) return;

    const excerpt = keepHead(text, remaining);
    remaining -= excerpt.length;
    out.push({
      filePath: joinVaultPath(notes, file === "Corrections" ? "Corrections (from the author)" : `${file}.md`),
      excerpt,
      score: 1,
      reason: "manual",
    });
  };

  add(
    "Corrections",
    NOTE_FILES.map((file) => input.corrections[file]?.trim() ?? "")
      .filter((text) => text.length > 0)
      .join("\n"),
  );

  if (earlier.length === 0) return out;

  const earlierState: StoryState = {
    version: input.state.version,
    chapters: Object.fromEntries(earlier.map((path) => [path, input.state.chapters[path]!])),
  };

  for (const [file, key] of [
    ["Characters", "characters"],
    ["Places", "places"],
  ] as const) {
    // Whoever the passage names most comes first, so the budget goes to them.
    const mentioned = [...gather(earlierState, earlier, key).entries()]
      .map(([name, entries]) => ({ name, entries, times: mentions(input.text, name) }))
      .filter((entry) => entry.times > 0)
      .sort((left, right) => right.times - left.times);

    const each = Math.max(FACTS_PER_NAME, Math.floor(FACTS_IN_ALL / Math.max(1, mentioned.length)));

    add(
      file,
      mentioned
        .map(({ name, entries }) => {
          const kept = mostRelevant(input.text, entries, (entry) => line(entry.fact), each);
          const left = entries.length - kept.length;
          return [
            `${name}:`,
            ...kept.map((entry) => `- ${line(entry.fact)} [${link(entry.chapter)}]`),
            ...(left > 0 ? [`- (${left} more on record in ${file}.md, not shown)`] : []),
          ].join("\n");
        })
        .join("\n\n"),
    );
  }

  const summaryOf = (path: string): string => input.state.chapters[path]!.facts.summary;
  const summarised = earlier.filter((path) => summaryOf(path).length > 0);
  const recent = summarised.slice(-RECENT_CHAPTERS);
  const older = summarised.slice(0, -RECENT_CHAPTERS);
  const olderScores = scoreAgainst(input.text, older.map(summaryOf));
  const recalled = mostRelevant(
    input.text,
    older.filter((_, index) => olderScores[index]! > 0),
    summaryOf,
    RECALLED_CHAPTERS,
  );

  add("Chapters", [...recalled, ...recent].map((path) => `${link(path)}: ${summaryOf(path)}`).join("\n"));

  add(
    "Threads",
    mostRelevant(input.text, openThreads(earlierState, earlier), (thread) => thread, OPEN_THREADS).join("\n"),
  );

  return out;
}

/** Threads raised and not yet marked resolved by a later chapter that names them the same way. */
function openThreads(state: StoryState, chapters: readonly string[]): string[] {
  const resolved = new Set<string>();
  for (const chapter of chapters) {
    for (const thread of state.chapters[chapter]!.facts.threads) {
      if (thread.state === "resolved") resolved.add(thread.what.toLowerCase());
    }
  }

  const open: string[] = [];
  for (const chapter of chapters) {
    for (const thread of state.chapters[chapter]!.facts.threads) {
      if (thread.state === "resolved" || resolved.has(thread.what.toLowerCase())) continue;
      open.push(`- ${thread.what} [${chapterName(chapter)}]`);
    }
  }

  return open;
}

/**
 * How often a passage names someone. The whole name, or its first word when
 * that is long enough to be a name: "Mara Vance" is found by "Mara", and "the
 * stationmaster" is not found by "the".
 */
function mentions(text: string, name: string): number {
  const first = name.split(/\s+/)[0] ?? "";
  // The first word is inside the whole name, so it finds both; the name alone is the fallback.
  const candidate = first.length >= 4 && !ARTICLES.has(first.toLowerCase()) ? first : name;

  return [...text.matchAll(new RegExp(`(?<![\\p{L}\\p{N}])${escape(candidate)}(?![\\p{L}\\p{N}])`, "giu"))]
    .length;
}

const ARTICLES = new Set(["the", "this", "that", "their", "some"]);

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
