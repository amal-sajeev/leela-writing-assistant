import { beforeEach, describe, expect, it } from "vitest";

import {
  buildDigestPrompt,
  MAX_CHAPTER_CHARACTERS,
  mergeFacts,
  parseChapterFacts,
  splitChapter,
  type ChapterFacts,
} from "../src/story/facts";
import { QUIET_BEFORE_READING_MS, StoryKeeper, UNASKED_CHAPTERS } from "../src/story/keeper";
import { correctionsIn, emptyState, relevantNotes, renderNote, type StoryState } from "../src/story/notes";
import { inReadingOrder, isChapterOf, isStoryNote, novelFor } from "../src/story/novel";
import {
  buildOutlinePrompt,
  outlineForReview,
  parseOutline,
  planIn,
  renderOutline,
  type OutlineRecord,
} from "../src/story/outline";
import { mostRelevant, relevantParts, scoreAgainst, terms } from "../src/utils/relevance";
import { ChapterSearch } from "../src/story/search";
import { ManualTimers } from "./support/manual-timers";

/**
 * Her notes on a novel: what makes a folder one, what she records from a
 * chapter, when she reads, and what of it she brings to a passage.
 */

const NOVEL = "Writing/The Quiet Station";
const chapter = (name: string): string => `${NOVEL}/${name}.md`;
const prose = (text: string): string => `${text} `.repeat(Math.ceil(450 / (text.length + 1)));

function facts(overrides: Partial<ChapterFacts> = {}): ChapterFacts {
  return { summary: "", characters: [], places: [], events: [], threads: [], ...overrides };
}

describe("what counts as a novel", () => {
  const briefs = new Set([NOVEL, "Writing"]);
  const hasBrief = (folder: string): boolean => briefs.has(folder);

  it("is the nearest folder above a note with a story brief in it", () => {
    expect(novelFor(chapter("Chapter 1"), hasBrief)).toBe(NOVEL);
    expect(novelFor(`${NOVEL}/Research/Trains.md`, hasBrief)).toBe(NOVEL);
    expect(novelFor("Writing/Essay.md", hasBrief)).toBe("Writing");
    expect(novelFor("Journal/Today.md", hasBrief)).toBeNull();
  });

  it("counts the notes directly in it as chapters, and nothing else", () => {
    expect(isChapterOf(NOVEL, chapter("Chapter 1"))).toBe(true);
    expect(isChapterOf(NOVEL, `${NOVEL}/Lyra brief.md`)).toBe(false);
    expect(isChapterOf(NOVEL, `${NOVEL}/Research/Trains.md`)).toBe(false);
    expect(isChapterOf(NOVEL, `${NOVEL}/Lyra notes/Characters.md`)).toBe(false);
    expect(isChapterOf(NOVEL, `${NOVEL}/cover.png`)).toBe(false);
  });

  it("knows her own notes, wherever the novel is", () => {
    expect(isStoryNote(`${NOVEL}/Lyra notes/Characters.md`)).toBe(true);
    expect(isStoryNote("Lyra notes/Timeline.md")).toBe(true);
    expect(isStoryNote(chapter("Lyra notes"))).toBe(false);
  });

  it("reads chapters in the order their names sort, numbers as numbers", () => {
    expect(
      inReadingOrder([chapter("Chapter 10"), chapter("Chapter 2"), chapter("Prologue"), chapter("Chapter 1")]),
    ).toEqual([chapter("Chapter 1"), chapter("Chapter 2"), chapter("Chapter 10"), chapter("Prologue")]);
  });
});

describe("recording a chapter", () => {
  it("asks only for what the chapter itself establishes, and for existing names to be reused", () => {
    const prompt = buildDigestPrompt({
      novelTitle: "The Quiet Station",
      chapterTitle: "Chapter 3",
      chapterText: "Mara waited.",
      brief: "A quiet ghost story.",
      knownCharacters: ["Mara Vance"],
      knownPlaces: ["Halden Station"],
    });

    expect(prompt.systemPrompt).toContain("Record only what the text of this chapter says");
    expect(prompt.systemPrompt).toContain("You are recording, not reviewing");
    expect(prompt.userPrompt).toContain("Characters: Mara Vance");
    expect(prompt.userPrompt).toContain("Places: Halden Station");
    expect(prompt.userPrompt).toContain("CHAPTER: Chapter 3\nMara waited.");
    expect(prompt.userPrompt).toContain("A quiet ghost story.");
  });

  it("says so when a chapter is too long to read whole", () => {
    const prompt = buildDigestPrompt({
      novelTitle: "N",
      chapterTitle: "Long",
      chapterText: "word ".repeat(20_000),
      knownCharacters: [],
      knownPlaces: [],
    });

    expect(prompt.userPrompt).toContain("only its first part is shown");
    expect(prompt.userPrompt.length).toBeLessThan(50_000);
  });

  it("keeps what is usable from a reply, fenced or not, and drops what is not", () => {
    const record = parseChapterFacts(
      "```json\n" +
        JSON.stringify({
          summary: " Mara waits. ",
          characters: [
            { name: "Mara", notes: [{ fact: "She is 34.", quote: " thirty-four " }, { fact: "", quote: null }] },
            { name: "A porter", notes: [] },
            { notes: [{ fact: "Nameless." }] },
          ],
          places: "the station",
          events: [{ what: "The speaker crackles.", when: null }, { when: "11:17" }],
          threads: [{ what: "Where did the train go?", state: "mysterious" }],
        }) +
        "\n```",
    );

    expect(record.summary).toBe("Mara waits.");
    // One unusable entry costs that entry, not the ones beside it.
    expect(record.characters).toEqual([{ name: "Mara", notes: [{ fact: "She is 34.", quote: "thirty-four" }] }]);
    expect(record.places).toEqual([]);
    expect(record.events).toEqual([{ what: "The speaker crackles." }]);
    expect(record.threads).toEqual([{ what: "Where did the train go?", state: "opened" }]);
  });

  it("reads a long chapter in parts that end where a paragraph does, losing nothing", () => {
    expect(splitChapter("Short.")).toEqual(["Short."]);

    const paragraph = "The rain kept on, and so did she. ".repeat(40).trim();
    const long = Array.from({ length: 90 }, () => paragraph).join("\n\n");
    const parts = splitChapter(long);

    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) {
      expect(part.length).toBeLessThanOrEqual(MAX_CHAPTER_CHARACTERS);
      expect(part.endsWith("so did she.")).toBe(true);
    }
    expect(parts.join("\n\n")).toBe(long);
  });

  it("makes one record of a chapter from the records of its parts", () => {
    const merged = mergeFacts([
      facts({
        summary: "Mara arrives.",
        characters: [{ name: "Mara Vance", notes: [{ fact: "She is 34." }] }],
        events: [{ what: "The clock stops." }],
        threads: [{ what: "Where did the train go?", state: "opened" }],
      }),
      facts({
        summary: "She finds the train.",
        characters: [
          { name: "mara vance", notes: [{ fact: "She is afraid of the dark." }] },
          { name: "Mr Oduya", notes: [{ fact: "He is the stationmaster." }] },
        ],
        events: [{ what: "The train returns." }],
        threads: [{ what: "where did the train go?", state: "resolved" }],
      }),
    ]);

    expect(merged.summary).toBe("Mara arrives. She finds the train.");
    expect(merged.characters).toEqual([
      { name: "Mara Vance", notes: [{ fact: "She is 34." }, { fact: "She is afraid of the dark." }] },
      { name: "Mr Oduya", notes: [{ fact: "He is the stationmaster." }] },
    ]);
    expect(merged.events).toHaveLength(2);
    expect(merged.threads).toEqual([{ what: "Where did the train go?", state: "resolved" }]);
  });

  it("holds a reply to the limits it was asked to keep", () => {
    const many = Array.from({ length: 30 }, (_, index) => ({
      name: `Person ${index}`,
      notes: Array.from({ length: 20 }, (__, at) => ({ fact: `Fact ${at}.`, quote: null })),
    }));

    const record = parseChapterFacts(JSON.stringify({ summary: "s", characters: many }));
    expect(record.characters).toHaveLength(12);
    expect(record.characters[0]!.notes).toHaveLength(6);
  });
});

const state = (): StoryState => ({
  version: 1,
  chapters: {
    [chapter("Chapter 1")]: {
      hash: "h1",
      readAt: 1,
      facts: facts({
        summary: "Mara arrives at the station.",
        characters: [{ name: "Mara Vance", notes: [{ fact: "She is 34.", quote: "thirty-four that spring" }] }],
        places: [{ name: "Halden Station", notes: [{ fact: "Platform 4 is sealed." }] }],
        events: [{ what: "The clock stops.", when: "11:17" }],
        threads: [{ what: "Where did the 11:17 train go?", state: "opened" }],
      }),
    },
    [chapter("Chapter 2")]: {
      hash: "h2",
      readAt: 2,
      facts: facts({
        summary: "She meets the stationmaster.",
        characters: [
          { name: "mara vance", notes: [{ fact: "She does not cry in public." }] },
          { name: "Mr Oduya", notes: [{ fact: "He has worked there forty years." }] },
        ],
        threads: [{ what: "Why is platform 4 sealed?", state: "opened" }],
      }),
    },
    [chapter("Chapter 3")]: {
      hash: "h3",
      readAt: 3,
      facts: facts({
        summary: "The secret of platform 4.",
        characters: [{ name: "Mara Vance", notes: [{ fact: "She learns her brother is alive." }] }],
        threads: [{ what: "Why is platform 4 sealed?", state: "resolved" }],
      }),
    },
  },
});

describe("the notes she writes", () => {
  it("gathers a character from every chapter, under one spelling, with where each fact comes from", () => {
    const note = renderNote("Characters", state(), null);

    expect(note.match(/### Mara Vance/g)).toHaveLength(1);
    expect(note).toContain("- She is 34. (“thirty-four that spring”) [[Chapter 1]]");
    expect(note).toContain("- She does not cry in public. [[Chapter 2]]");
    expect(note).toContain("### Mr Oduya");
  });

  it("writes the timeline, threads and chapter summaries by chapter", () => {
    expect(renderNote("Timeline", state(), null)).toContain("### [[Chapter 1]]\n- **11:17:** The clock stops.");
    expect(renderNote("Threads", state(), null)).toContain("- (resolved) Why is platform 4 sealed?");
    expect(renderNote("Chapters", state(), null)).toContain("### [[Chapter 2]]\nShe meets the stationmaster.");
  });

  it("keeps what the author wrote under Corrections when the note is rewritten", () => {
    const first = renderNote("Characters", state(), null);
    expect(correctionsIn(first)).toBe("");

    const edited = first.replace(/_Nothing yet\.[^\n]*_/, "Mara is 36, not 34. I changed it in the redraft.");
    const rewritten = renderNote("Characters", emptyState(), edited);

    expect(correctionsIn(rewritten)).toBe("Mara is 36, not 34. I changed it in the redraft.");
    expect(rewritten).toContain("_Nothing recorded yet._");
    expect(rewritten).not.toContain("She is 34.");
  });
});

describe("what she brings to a passage", () => {
  const bring = (filePath: string, text: string, corrections = {}) =>
    relevantNotes({ novel: NOVEL, state: state(), filePath, text, corrections });

  it("knows only what a reader knows by this chapter", () => {
    const notes = bring(chapter("Chapter 3"), "Mara stood on the platform.");
    const all = notes.map((entry) => entry.excerpt).join("\n");

    expect(all).toContain("She is 34.");
    expect(all).toContain("She does not cry in public.");
    expect(all).not.toContain("her brother is alive");
    expect(all).toContain("Chapter 2: She meets the stationmaster.");
    expect(all).not.toContain("The secret of platform 4.");
  });

  it("brings the people the passage names, and leaves the rest", () => {
    const withMara = bring(chapter("Chapter 3"), "Mara said nothing.").map((entry) => entry.excerpt).join("\n");
    expect(withMara).toContain("Mara Vance:");
    expect(withMara).not.toContain("Mr Oduya");

    const withBoth = bring(chapter("Chapter 3"), "Mr Oduya looked at her.").map((entry) => entry.excerpt).join("\n");
    expect(withBoth).toContain("He has worked there forty years.");
  });

  it("lists the threads still open, and not the ones a chapter so far has closed", () => {
    const early = bring(chapter("Chapter 3"), "x").find((entry) => entry.filePath.endsWith("Threads.md"))!;
    expect(early.excerpt).toContain("Where did the 11:17 train go? [Chapter 1]");
    expect(early.excerpt).toContain("Why is platform 4 sealed? [Chapter 2]");

    const later = bring(chapter("Chapter 4"), "x").find((entry) => entry.filePath.endsWith("Threads.md"))!;
    expect(later.excerpt).not.toContain("Why is platform 4 sealed?");
  });

  it("puts the author's corrections first, and names each note it draws on", () => {
    const notes = bring(chapter("Chapter 3"), "Mara.", { Characters: "Mara is 36." });

    expect(notes[0]).toMatchObject({ excerpt: "Mara is 36." });
    expect(notes[0]!.filePath).toContain("Corrections");
    expect(notes.some((entry) => entry.filePath === `${NOVEL}/Lyra notes/Characters.md`)).toBe(true);
  });

  it("cuts a long record down to what bears on the passage", () => {
    const long = emptyState();
    for (let index = 1; index <= 30; index += 1) {
      long.chapters[chapter(`Chapter ${index}`)] = {
        hash: `h${index}`,
        readAt: index,
        facts: facts({
          summary: index === 4 ? "Mara finds a brass key in the lamp room." : `Day ${index} passes on the platform.`,
          characters: [
            {
              name: "Mara Vance",
              notes: [{ fact: index === 4 ? "She keeps the brass key on a cord." : `She waits through day ${index}.` }],
            },
            { name: "Mr Oduya", notes: [{ fact: `He sweeps on day ${index}.` }] },
          ],
          threads: [{ what: index === 2 ? "Whose brass key is it?" : `Small question ${index}.`, state: "opened" }],
        }),
      };
    }

    const notes = relevantNotes({
      novel: NOVEL,
      state: long,
      filePath: chapter("Chapter 31"),
      text: "Mara turned the brass key over. Mara said nothing to Mr Oduya.",
      corrections: {},
    });
    const of = (file: string): string => notes.find((entry) => entry.filePath.endsWith(file))!.excerpt;

    // The one fact about the key, out of thirty, and then the most recent.
    expect(of("Characters.md")).toContain("She keeps the brass key on a cord. [Chapter 4]");
    expect(of("Characters.md")).toContain("She waits through day 30.");
    expect(of("Characters.md")).not.toContain("She waits through day 10.");
    expect(of("Characters.md")).toContain("(10 more on record in Characters.md, not shown)");
    // Named twice, she comes before him.
    expect(of("Characters.md").indexOf("Mara Vance:")).toBeLessThan(of("Characters.md").indexOf("Mr Oduya:"));

    // The last eight chapters, and the old one the passage is about.
    expect(of("Chapters.md").startsWith("Chapter 4: Mara finds a brass key in the lamp room.")).toBe(true);
    expect(of("Chapters.md")).toContain("Chapter 23:");
    expect(of("Chapters.md")).not.toContain("Chapter 22:");

    expect(of("Threads.md")).toContain("Whose brass key is it? [Chapter 2]");
    expect(of("Threads.md").split("\n")).toHaveLength(12);
  });

  it("has nothing from the chapters for the first chapter", () => {
    expect(bring(chapter("Chapter 1"), "Mara.")).toEqual([]);
  });
});

describe("finding what bears on a passage", () => {
  it("compares the words that carry meaning", () => {
    expect(terms("The keys were hers, and she was at the Station.")).toEqual(["key", "station"]);
    expect(scoreAgainst("the and but", ["anything"])).toEqual([0]);

    const [common, rare, none] = scoreAgainst("a brass key at the station", [
      "The station at dusk.",
      "The station, and a key.",
      "Nothing shared.",
    ]);
    expect(rare).toBeGreaterThan(common!);
    expect(none).toBe(0);
  });

  it("keeps the nearest few in their own order, and the later of two equally near", () => {
    const items = ["one key", "two", "three", "four key", "five"];
    expect(mostRelevant("the key", items, (item) => item, 3)).toEqual(["one key", "four key", "five"]);
    expect(mostRelevant("the key", items, (item) => item, 9)).toEqual(items);
  });

  it("sends the parts of a long canon note that the passage is about", () => {
    const filler = (about: string): string => `${about} `.repeat(20).trim();
    const note = [
      "# Characters",
      "## Mara Vance",
      filler("Mara grew up inland and distrusts the sea."),
      "## Mr Oduya",
      filler("Oduya has kept the lamp room locked since the accident."),
      "## The porter",
      filler("A porter nobody has asked the name of."),
    ].join("\n\n");

    expect(relevantParts("Short note.", "anything", 500)).toBe("Short note.");

    const parts = relevantParts(note, "He unlocked the lamp room.", 1600);
    expect(parts.startsWith("## Mr Oduya\n\nOduya has kept the lamp room locked")).toBe(true);
    expect(parts).not.toContain("porter");
    expect(parts.length).toBeLessThanOrEqual(1600);

    // Nothing in common: how the note opens.
    expect(relevantParts(note, "Rain.", 300).startsWith("# Characters\n\n## Mara Vance")).toBe(true);
  });
});

describe("finding the earlier scene", () => {
  const dull = (day: number): string =>
    `Mara waited on the platform through the morning of day ${day}, and the rain kept on over the station roof as it had before.`;
  const chapters = [
    {
      path: chapter("Chapter 1"),
      text: [
        "# One",
        ...Array.from({ length: 12 }, (_, index) => dull(index)),
        "Mr Oduya took a brass key from the hook behind the lamp room door and held it out to her without a word. It was warm, as though it had been in a pocket all night, and the cord was frayed.",
        ...Array.from({ length: 12 }, (_, index) => dull(index + 20)),
      ].join("\n\n"),
    },
    { path: chapter("Chapter 2"), text: Array.from({ length: 12 }, (_, index) => dull(index + 40)).join("\n\n") },
  ];

  it("finds the stretch of an earlier chapter the passage is about, as it was written", () => {
    const found = new ChapterSearch().find(chapters, "Mara turned the brass key over. The cord had frayed further.");

    expect(found[0]).toMatchObject({ filePath: chapter("Chapter 1"), reason: "lexical" });
    expect(found[0]!.excerpt).toContain("took a brass key from the hook behind the lamp room door");
    expect(found.length).toBeLessThanOrEqual(3);
  });

  it("shows nothing when all that is shared is on every page", () => {
    const search = new ChapterSearch();
    expect(search.find(chapters, "Mara waited on the platform in the rain.")).toEqual([]);
    expect(search.find(chapters, "The and but.")).toEqual([]);
    expect(search.find([], "Mara turned the brass key over.")).toEqual([]);
  });

  it("reads a changed chapter afresh", () => {
    const search = new ChapterSearch();
    expect(search.find(chapters, "the frayed cord of the brass key")).toHaveLength(1);

    const rewritten = chapters.map((entry) => ({ ...entry, text: entry.text.replace(/Mr Oduya took[^\n]*/, dull(99)) }));
    expect(search.find(rewritten, "the frayed cord of the brass key")).toEqual([]);
  });
});

describe("the outline", () => {
  const record: OutlineRecord = {
    premise: "A woman waits for a train that left without her.",
    movements: [{ title: "Arrival", chapters: "Chapter 1", beats: ["Mara arrives.", "The clock stops."] }],
    owed: ["Where the train went."],
    changed: ["Closes the question of platform 4."],
    after: ["Chapter 3"],
  };

  it("keeps what is usable from a reply", () => {
    const outline = parseOutline(
      JSON.stringify({
        premise: " A story. ",
        movements: [
          { title: "Arrival", chapters: null, beats: ["Mara arrives.", "", 4] },
          { title: "Nothing in it", beats: [] },
          { beats: ["No title."] },
        ],
        owed: "nothing",
      }),
    );

    expect(outline).toEqual({
      premise: "A story.",
      movements: [{ title: "Arrival", chapters: "", beats: ["Mara arrives."] }],
      owed: [],
      changed: [],
    });
  });

  it("is asked for from her record, with the events only of the chapters just read", () => {
    const prompt = buildOutlinePrompt({
      novelTitle: "The Quiet Station",
      plan: "",
      chapters: [
        { name: "Chapter 1", justRead: false, facts: state().chapters[chapter("Chapter 1")]!.facts },
        {
          name: "Chapter 2",
          justRead: true,
          facts: facts({ summary: "She meets him.", events: [{ what: "He hands her a key." }] }),
        },
      ],
    });

    expect(prompt.systemPrompt).toContain("do not predict what will happen next");
    expect(prompt.userPrompt).toContain("Chapter 1: Mara arrives at the station.\n- thread opened: Where did the 11:17 train go?");
    expect(prompt.userPrompt).not.toContain("The clock stops.");
    expect(prompt.userPrompt).toContain("Chapter 2 (just read): She meets him.\n- happens: He hands her a key.");
    expect(prompt.userPrompt).not.toContain("AUTHOR'S PLAN");
  });

  it("is written out with the author's plan kept above it", () => {
    const first = renderOutline(undefined, null);
    expect(planIn(first)).toBe("");
    expect(first).toContain("_Nothing recorded yet._");

    const planned = first.replace(/_Nothing yet\.[^\n]*_/, "She never leaves.\n\nThe brother is the stationmaster.");
    const written = renderOutline(record, planned);

    expect(planIn(written)).toBe("She never leaves.\n\nThe brother is the stationmaster.");
    expect(written).toContain("### 1. Arrival (Chapter 1)\n- Mara arrives.\n- The clock stops.");
    expect(written).toContain("### Still owed\n- Where the train went.");
    expect(written).toContain("_After reading Chapter 3._\n\n- Closes the question of platform 4.");
    expect(renderOutline(record, written)).toBe(written);
  });

  it("travels with a review as the plan, then the story as written, or not at all", () => {
    expect(outlineForReview("", undefined)).toBeUndefined();
    expect(outlineForReview("She never leaves.", undefined)).toBe("THE AUTHOR'S PLAN:\nShe never leaves.");

    const sent = outlineForReview("She never leaves.", record)!;
    expect(sent).toContain("1. Arrival (Chapter 1): Mara arrives. The clock stops.");
    // What the last reading changed is about that reading, not about this passage.
    expect(sent).not.toContain("platform 4");
  });
});

describe("keeping the notes current", () => {
  let notes: Map<string, string>;
  let files: Map<string, string>;
  let sent: string[];
  let mayRead: boolean;
  let failFor: string | null;
  let backlog: Array<{ novel: string; unread: number }>;
  let busy: boolean[];
  let outlined: string[];
  let failOutline: boolean;
  let timers: ManualTimers;
  let keeper: StoryKeeper;

  beforeEach(() => {
    notes = new Map([
      [`${NOVEL}/Lyra brief.md`, "A quiet ghost story."],
      [chapter("Chapter 1"), prose("Mara arrived at Halden Station at dusk.")],
      [chapter("Chapter 2"), prose("Mr Oduya had worked there forty years.")],
      [`${NOVEL}/Research/Trains.md`, prose("Notes on rolling stock.")],
      [chapter("Stub"), "TODO"],
    ]);
    files = new Map();
    sent = [];
    mayRead = true;
    failFor = null;
    backlog = [];
    busy = [];
    outlined = [];
    failOutline = false;
    timers = new ManualTimers();

    keeper = new StoryKeeper({
      hasBrief: (folder) => notes.has(`${folder}/Lyra brief.md`),
      notesIn: (folder) =>
        [...notes.keys()].filter((path) => path.slice(0, path.lastIndexOf("/")) === folder),
      read: (path) => Promise.resolve(notes.get(path) ?? null),
      writeNote: (path, text) => {
        notes.set(path, text);
        return Promise.resolve();
      },
      readState: (path) => Promise.resolve(files.get(path) ?? null),
      writeState: (path, text) => {
        files.set(path, text);
        return Promise.resolve();
      },
      digest: (prompt) => {
        if (prompt.userPrompt.includes("CHAPTERS SO FAR")) {
          outlined.push(prompt.userPrompt);
          if (failOutline) return Promise.reject(new Error("offline"));
          return Promise.resolve(
            JSON.stringify({
              premise: `A story told ${outlined.length} time(s).`,
              movements: [{ title: "Arrival", chapters: "Chapter 1 to Chapter 2", beats: ["Mara arrives."] }],
              owed: ["Where the train went."],
              changed: [`Reading ${outlined.length} moved the mystery on.`],
            }),
          );
        }

        const title = /CHAPTER: (.*)/.exec(prompt.userPrompt)![1]!;
        sent.push(title);
        if (title === failFor) return Promise.reject(new Error("offline"));
        return Promise.resolve(
          JSON.stringify(facts({ summary: `What happens in ${title}.`, characters: [{ name: "Mara", notes: [{ fact: `Seen in ${title}.` }] }] })),
        );
      },
      mayRead: () => mayRead,
      onBacklog: (novel, unread) => backlog.push({ novel, unread }),
      onBusy: (state) => busy.push(state),
      timers,
      now: () => 42,
    });
  });

  it("reads each chapter once, skipping stubs and anything that is not a chapter", async () => {
    expect(await keeper.unread(NOVEL)).toEqual([chapter("Chapter 1"), chapter("Chapter 2")]);

    expect(await keeper.update(NOVEL)).toEqual({ read: 2, failed: 0, waiting: 0 });
    expect(sent).toEqual(["Chapter 1", "Chapter 2"]);
    expect(notes.get(`${NOVEL}/Lyra notes/Chapters.md`)).toContain("What happens in Chapter 2.");
    expect(notes.get(`${NOVEL}/Lyra notes/Characters.md`)).toContain("- Seen in Chapter 1. [[Chapter 1]]");
    expect(files.has(`${NOVEL}/Lyra notes/story.json`)).toBe(true);

    // Nothing changed, so nothing is sent, and her window is left as it is.
    expect(await keeper.update(NOVEL)).toEqual({ read: 0, failed: 0, waiting: 0 });
    expect(sent).toHaveLength(2);
    expect(busy).toEqual([true, false]);
    expect(outlined).toHaveLength(1);
  });

  it("reads a chapter again only when its text has changed", async () => {
    await keeper.update(NOVEL);
    notes.set(chapter("Chapter 2"), prose("Mr Oduya had worked there forty-one years."));

    expect(await keeper.unread(NOVEL)).toEqual([chapter("Chapter 2")]);
    await keeper.update(NOVEL);
    expect(sent).toEqual(["Chapter 1", "Chapter 2", "Chapter 2"]);
  });

  it("follows a renamed chapter without reading it again, and links to its new name", async () => {
    await keeper.update(NOVEL);

    notes.set(chapter("02 The Stationmaster"), notes.get(chapter("Chapter 2"))!);
    notes.delete(chapter("Chapter 2"));

    expect(await keeper.unread(NOVEL)).toEqual([]);
    expect(await keeper.update(NOVEL, { unasked: true })).toEqual({ read: 0, failed: 0, waiting: 0 });
    expect(sent).toHaveLength(2);

    const written = notes.get(`${NOVEL}/Lyra notes/Chapters.md`)!;
    expect(written).toContain("### [[02 The Stationmaster]]\nWhat happens in Chapter 2.");
    expect(written).not.toContain("[[Chapter 2]]");
    expect(files.get(`${NOVEL}/Lyra notes/story.json`)).toContain("02 The Stationmaster");
  });

  it("follows the whole novel when its folder is renamed", async () => {
    await keeper.update(NOVEL);

    const moved = "Writing/Halden";
    for (const [path, text] of [...notes]) {
      notes.delete(path);
      notes.set(path.replace(NOVEL, moved), text);
    }
    files.set(`${moved}/Lyra notes/story.json`, files.get(`${NOVEL}/Lyra notes/story.json`)!);

    expect(await keeper.unread(moved)).toEqual([]);
    await keeper.update(moved);
    expect(sent).toHaveLength(2);

    const context = await keeper.context(`${moved}/Chapter 2.md`, "Mara looked up.");
    expect(context.map((entry) => entry.excerpt).join("\n")).toContain("Seen in Chapter 1.");
  });

  it("reads a long chapter in parts and records it as one chapter", async () => {
    const paragraph = "The rain kept on, and so did she. ".repeat(40).trim();
    notes.set(chapter("Chapter 3"), Array.from({ length: 90 }, () => paragraph).join("\n\n"));
    await keeper.update(NOVEL);

    const parts = sent.filter((title) => title.startsWith("Chapter 3"));
    expect(parts.length).toBeGreaterThan(1);
    expect(parts[0]).toBe(`Chapter 3 (part 1 of ${parts.length})`);

    const written = notes.get(`${NOVEL}/Lyra notes/Chapters.md`)!;
    expect(written.match(/### \[\[Chapter 3\]\]/g)).toHaveLength(1);
    expect(written).toContain(`What happens in Chapter 3 (part ${parts.length} of ${parts.length}).`);
    expect(await keeper.unread(NOVEL)).toEqual([]);
  });

  it("outlines the whole story after reading, and says what the chapters just read changed", async () => {
    await keeper.update(NOVEL);

    expect(outlined).toHaveLength(1);
    expect(outlined[0]).toContain("Chapter 1 (just read): What happens in Chapter 1.");
    expect(outlined[0]).toContain("JUST READ:\nChapter 1, Chapter 2");
    expect(outlined[0]).not.toContain("OUTLINE BEFORE");

    const path = `${NOVEL}/Lyra notes/Outline.md`;
    expect(notes.get(path)).toContain("### 1. Arrival (Chapter 1 to Chapter 2)\n- Mara arrives.");
    expect(notes.get(path)).toContain("_After reading Chapter 1, Chapter 2._\n\n- Reading 1 moved the mystery on.");

    // The author says where it is going; the next reading is made against that.
    notes.set(path, notes.get(path)!.replace(/_Nothing yet\.[^\n]*_/, "Mara never leaves the station."));
    notes.set(chapter("Chapter 2"), prose("Mr Oduya handed her a ticket out."));
    await keeper.update(NOVEL);

    expect(outlined[1]).toContain("AUTHOR'S PLAN (where the author means the story to go):\nMara never leaves the station.");
    expect(outlined[1]).toContain("OUTLINE BEFORE:\nPremise: A story told 1 time(s).");
    expect(outlined[1]).toContain("JUST READ:\nChapter 2");
    expect(outlined[1]).toContain("Chapter 1: What happens in Chapter 1.");
    expect(notes.get(path)).toContain("Mara never leaves the station.");
    expect(notes.get(path)).toContain("_After reading Chapter 2._");
  });

  it("brings the plan and the outline to a review of any note in the novel", async () => {
    expect(await keeper.outline(chapter("Chapter 1"))).toBeUndefined();

    await keeper.update(NOVEL);
    const path = `${NOVEL}/Lyra notes/Outline.md`;
    notes.set(path, notes.get(path)!.replace(/_Nothing yet\.[^\n]*_/, "Mara never leaves the station."));

    const outline = (await keeper.outline(chapter("Chapter 1")))!;
    expect(outline.indexOf("THE AUTHOR'S PLAN:\nMara never leaves the station.")).toBe(0);
    expect(outline).toContain("THE STORY AS WRITTEN SO FAR:\nPremise: A story told 1 time(s).");
    expect(outline).toContain("Still owed: Where the train went.");
    expect(await keeper.outline("Journal/Today.md")).toBeUndefined();
  });

  it("keeps the chapters she read when the outline cannot be written, and writes it when next asked", async () => {
    failOutline = true;
    expect(await keeper.update(NOVEL)).toEqual({ read: 2, failed: 0, waiting: 0 });
    expect(notes.get(`${NOVEL}/Lyra notes/Chapters.md`)).toContain("What happens in Chapter 2.");
    expect(notes.get(`${NOVEL}/Lyra notes/Outline.md`)).toContain("_Nothing recorded yet._");

    // Unasked, with nothing new to read, she sends nothing.
    failOutline = false;
    await keeper.update(NOVEL, { unasked: true });
    expect(outlined).toHaveLength(1);

    await keeper.update(NOVEL);
    expect(outlined).toHaveLength(2);
    expect(sent).toHaveLength(2);
    expect(notes.get(`${NOVEL}/Lyra notes/Outline.md`)).toContain("### 1. Arrival");
  });

  it("shows a review what earlier chapters say, with or without notes on them", async () => {
    for (let index = 3; index <= 12; index += 1) {
      notes.set(chapter(`Chapter ${index}`), prose(`Day ${index} passed on the platform in the rain.`));
    }
    notes.set(
      chapter("Chapter 5"),
      `---\ndraft: 2\n---\n${prose("Day five passed on the platform.")}\n\nShe hid the brass key under the loose tile by the ticket window.\n\n${prose("Night came on.")}`,
    );

    const found = await keeper.earlier(chapter("Chapter 9"), "Mara lifted the loose tile. The brass key was gone.");
    expect(found.map((entry) => entry.filePath)).toEqual([chapter("Chapter 5")]);
    expect(found[0]!.excerpt).toContain("She hid the brass key under the loose tile");
    expect(found[0]!.excerpt).not.toContain("draft: 2");
    expect(sent).toEqual([]);

    // Only what a reader has already read.
    expect(await keeper.earlier(chapter("Chapter 4"), "Mara lifted the loose tile. The brass key was gone.")).toEqual([]);
    expect(await keeper.earlier("Journal/Today.md", "The brass key and the loose tile.")).toEqual([]);
  });

  it("remembers what she read across a restart", async () => {
    await keeper.update(NOVEL);

    const again = new StoryKeeper({
      hasBrief: () => true,
      notesIn: (folder) => [...notes.keys()].filter((path) => path.slice(0, path.lastIndexOf("/")) === folder),
      read: (path) => Promise.resolve(notes.get(path) ?? null),
      writeNote: () => Promise.resolve(),
      readState: (path) => Promise.resolve(files.get(path) ?? null),
      writeState: () => Promise.resolve(),
      digest: () => Promise.reject(new Error("should not be asked")),
      mayRead: () => true,
    });

    expect(await again.unread(NOVEL)).toEqual([]);
  });

  it("reads a changed chapter by herself, once it has been left alone for a while", async () => {
    await keeper.update(NOVEL);
    notes.set(chapter("Chapter 1"), prose("Mara arrived at Halden Station at dawn."));

    keeper.noteChanged(chapter("Chapter 1"));
    timers.advance(QUIET_BEFORE_READING_MS - 1000);
    keeper.noteChanged(chapter("Chapter 1"));
    timers.advance(QUIET_BEFORE_READING_MS - 1000);
    expect(sent).toHaveLength(2);

    timers.advance(2000);
    await flush();
    expect(sent).toEqual(["Chapter 1", "Chapter 2", "Chapter 1"]);
  });

  it("does not start on changes to notes that are not chapters", async () => {
    keeper.noteChanged(`${NOVEL}/Research/Trains.md`);
    keeper.noteChanged("Journal/Today.md");
    keeper.noteChanged(`${NOVEL}/Lyra brief.md`);
    timers.advance(QUIET_BEFORE_READING_MS * 2);
    await flush();

    expect(sent).toEqual([]);
  });

  it("will not read a whole unread novel unasked, and says so once", async () => {
    for (let index = 3; index <= UNASKED_CHAPTERS + 3; index += 1) {
      notes.set(chapter(`Chapter ${index}`), prose(`Something happens in chapter ${index}.`));
    }

    const result = await keeper.update(NOVEL, { unasked: true });
    await keeper.update(NOVEL, { unasked: true });

    expect(result).toEqual({ read: 0, failed: 0, waiting: UNASKED_CHAPTERS + 3 });
    expect(sent).toEqual([]);
    expect(backlog).toEqual([{ novel: NOVEL, unread: UNASKED_CHAPTERS + 3 }]);

    // Asked, she reads all of it.
    expect((await keeper.update(NOVEL)).read).toBe(UNASKED_CHAPTERS + 3);
  });

  it("reads nothing by herself while paused or switched off, and still reads when asked", async () => {
    mayRead = false;

    expect(await keeper.update(NOVEL, { unasked: true })).toEqual({ read: 0, failed: 0, waiting: 0 });
    expect(sent).toEqual([]);

    expect((await keeper.update(NOVEL)).read).toBe(2);
  });

  it("keeps what she has when one chapter cannot be read, and tries it again next time", async () => {
    failFor = "Chapter 2";

    expect(await keeper.update(NOVEL)).toEqual({ read: 1, failed: 1, waiting: 0 });
    expect(notes.get(`${NOVEL}/Lyra notes/Chapters.md`)).toContain("What happens in Chapter 1.");

    failFor = null;
    expect(await keeper.unread(NOVEL)).toEqual([chapter("Chapter 2")]);
    expect((await keeper.update(NOVEL)).read).toBe(1);
  });

  it("forgets a chapter that is gone, and leaves the author's corrections alone", async () => {
    await keeper.update(NOVEL);
    const path = `${NOVEL}/Lyra notes/Characters.md`;
    notes.set(path, notes.get(path)!.replace(/_Nothing yet\.[^\n]*_/, "Mara is 36."));

    notes.delete(chapter("Chapter 2"));
    await keeper.update(NOVEL);

    expect(notes.get(path)).toContain("Mara is 36.");
    expect(notes.get(path)).not.toContain("Seen in Chapter 2.");
    expect(sent).toHaveLength(2);
  });

  it("brings her notes, and the author's corrections, to a review of a later chapter", async () => {
    await keeper.update(NOVEL);
    const path = `${NOVEL}/Lyra notes/Characters.md`;
    notes.set(path, notes.get(path)!.replace(/_Nothing yet\.[^\n]*_/, "Mara is 36."));

    const context = await keeper.context(chapter("Chapter 2"), "Mara looked up.");
    const all = context.map((entry) => entry.excerpt).join("\n");

    expect(all).toContain("Mara is 36.");
    expect(all).toContain("Seen in Chapter 1.");
    expect(all).not.toContain("Seen in Chapter 2.");
    expect(await keeper.context("Journal/Today.md", "Mara.")).toEqual([]);
  });
});

async function flush(): Promise<void> {
  for (let turn = 0; turn < 30; turn += 1) await Promise.resolve();
}
