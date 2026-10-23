import { describe, expect, it } from "vitest";

import { voiceOf } from "../src/review/review";
import { DEFAULT_SETTINGS } from "../src/settings/settings";
import {
  buildTalkPrompt,
  lookupText,
  MAX_KEPT_MESSAGES,
  parseTalkReply,
  parseTalkResponse,
  segmentsOf,
  recentHistory,
  TalkStore,
  type TalkMessage,
} from "../src/talk/talk";

/**
 * Talking with her about the story: what she is told, and that the
 * conversation is kept by itself.
 */

const said = (who: TalkMessage["who"], text: string, at = 0): TalkMessage => ({ who, text, at });

describe("what she is told when the author talks to her", () => {
  it("is a conversation in her own voice, resting on what she has been shown", () => {
    const prompt = buildTalkPrompt({
      name: "Lyra",
      voice: voiceOf(DEFAULT_SETTINGS),
      novelTitle: "The Quiet Station",
      brief: "A quiet ghost story.",
      outline: "THE AUTHOR'S PLAN:\nMara never leaves.",
      notes: [
        {
          filePath: "Novel/Lyra notes/Characters.md",
          excerpt: "Mara Vance:\n- She is 34.",
          score: 1,
          reason: "manual",
        },
      ],
      memory: "Preference: Mara stays.\nRejected [chat 2026-10-20]: She was adopted.\nTentative: the photograph may be a red herring.",
      open: { title: "Chapter 9", text: "Mara lifted the tile.", selected: true },
      history: [said("author", "Is the brother too obvious?"), said("lyra", "A little.")],
      message: "  So should I cut the photograph?  ",
    });

    expect(prompt.systemPrompt).toContain("It is not a review");
    expect(prompt.systemPrompt).toContain("HOW YOU TALK.");
    expect(prompt.systemPrompt).toContain("No em dashes and no en dashes");
    expect(prompt.systemPrompt).toContain("say you have not read it");
    expect(prompt.systemPrompt).toContain("point to the chapter and concrete detail");
    expect(prompt.systemPrompt).toContain("Quote a few exact words");
    expect(prompt.systemPrompt).toContain("up to two useful next-step choices");
    // She is not told what to look for in a passage: nothing here is being reviewed.
    expect(prompt.systemPrompt).not.toContain("Look for the places where a reader");

    expect(prompt.userPrompt).toContain("NOVEL:\nThe Quiet Station");
    expect(prompt.userPrompt).toContain("AUTHOR-EDITED MEMORY (labels and sources are the author's)");
    expect(prompt.userPrompt).toContain("Rejected [chat 2026-10-20]: She was adopted.");
    expect(prompt.systemPrompt).toContain("Rejected ideas stay rejected; tentative ideas are not canon.");
    expect(prompt.userPrompt).toContain("STORY OUTLINE:\nTHE AUTHOR'S PLAN:");
    expect(prompt.userPrompt).toContain("[Novel/Lyra notes/Characters.md]\nMara Vance:");
    expect(prompt.userPrompt).toContain(
      "OPEN IN FRONT OF THEM: Chapter 9 (the text they have selected):\nMara lifted the tile.",
    );
    expect(prompt.userPrompt).toContain("Author: Is the brother too obvious?\n\nLyra: A little.");
    expect(prompt.userPrompt).toContain("THE AUTHOR SAYS:\nSo should I cut the photograph?");
  });

  it("works with nothing but what was said", () => {
    const prompt = buildTalkPrompt({ name: "Lyra", voice: "", notes: [], history: [], message: "Hello." });

    expect(prompt.userPrompt).toBe("THE AUTHOR SAYS:\nHello.\n\nAnswer as Lyra, with the JSON object only.");
  });

  it("carries the end of a long conversation, whole messages only, in order", () => {
    const history = Array.from({ length: 60 }, (_, index) =>
      said(index % 2 === 0 ? "author" : "lyra", `Message ${index}.`),
    );
    const kept = recentHistory(history);

    expect(kept).toHaveLength(24);
    expect(kept[0]!.text).toBe("Message 36.");
    expect(kept.at(-1)!.text).toBe("Message 59.");

    const long = [said("author", "x".repeat(8000)), said("lyra", "y".repeat(2000)), said("author", "Short.")];
    expect(recentHistory(long).map((entry) => entry.text.length)).toEqual([2000, 6]);
  });

  it("looks the story up by the last exchange as well, so a follow-up finds its subject", () => {
    const history = [said("author", "Old."), said("author", "Tell me about Mara."), said("lyra", "She waits.")];
    expect(lookupText(history, "And her brother?")).toBe("Tell me about Mara.\nShe waits.\nAnd her brother?");
  });
});

describe("her answer, as lines of dialogue", () => {
  it("asks for nothing but a list of short lines, each with an expression", () => {
    const prompt = buildTalkPrompt({ name: "Lyra", voice: "", notes: [], history: [], message: "Hello." });

    expect(prompt.systemPrompt).toContain("you answer only as a list of lines");
    expect(prompt.systemPrompt).toContain("at most 160 characters");
    expect(prompt.systemPrompt).toContain('{"lines": [{"say": string, "mood": string, "reaction": string|null}], "followUps": string[]}');
    expect(prompt.systemPrompt).toContain("idle_laughing: amused, laughing");
    expect(prompt.systemPrompt).not.toContain("passive_gaming");
    expect(prompt.systemPrompt).toContain("neutral, amused, laughing, thinking, surprised, weary, unbothered");
  });

  it("reads the lines she gave, with the expressions it knows", () => {
    const reply = JSON.stringify({
      lines: [
        { say: " The brother's fine. ", mood: "unbothered" },
        { say: "It's the *photograph* that gives him away.", mood: "smug" },
        { say: "" },
        "Cut the second showing.",
        7,
      ],
    });

    expect(parseTalkReply("```json\n" + reply + "\n```")).toEqual([
      { text: "The brother's fine.", mood: "unbothered" },
      { text: "It's the *photograph* that gives him away." },
      { text: "Cut the second showing." },
    ]);
    expect(parseTalkReply('[{"say": "Hm.", "mood": "thinking"}]')).toEqual([{ text: "Hm.", mood: "thinking" }]);
  });

  it("parses optional follow-up choices, limits them, and ignores malformed choices", () => {
    expect(parseTalkResponse(JSON.stringify({
      lines: [{ say: "The quiet in Chapter 2 is doing real work.", mood: "thinking" }],
      followUps: ["Show me the exact moment.", "Explore the alternative.", "A third choice", 7],
    }))).toEqual({
      segments: [{ text: "The quiet in Chapter 2 is doing real work.", mood: "thinking" }],
      followUps: ["Show me the exact moment.", "Explore the alternative."],
    });
    expect(parseTalkResponse(JSON.stringify({ lines: ["Still fine."], followUps: "not a list" }))).toEqual({
      segments: [{ text: "Still fine." }],
      followUps: [],
    });
    expect(parseTalkResponse('{"lines":[{"say":"Cut off"}')).toEqual({
      segments: [{ text: "Cut off" }],
      followUps: [],
    });
  });

  it("retains only allowed reaction IDs per dialogue line", () => {
    expect(parseTalkReply(JSON.stringify({ lines: [
      { say: "Good.", reaction: "idle_welcome" },
      { say: "Still good.", reaction: "in_progress_1" },
    ] }))).toEqual([
      { text: "Good.", reaction: "idle_welcome" },
      { text: "Still good." },
    ]);
  });

  it("makes lines of a reply that just talks, and of a line that runs on, between sentences", () => {
    const talk =
      "The brother's fine. It's the photograph that gives him away. You show it in chapter two, then again in four, " +
      "and by the time Mara finds it under the tile I've been waiting thirty pages. Cut the second showing.";

    const lines = parseTalkReply(talk);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.map((line) => line.text).join(" ")).toBe(talk);
    for (const line of lines) expect(/[.!?]$/.test(line.text)).toBe(true);

    const long = parseTalkReply(JSON.stringify({ lines: [{ say: talk, mood: "weary" }] }));
    expect(long.length).toBeGreaterThan(1);
    expect(long.every((line) => line.mood === "weary")).toBe(true);

    expect(parseTalkReply("   ")).toEqual([]);
    expect(
      parseTalkReply(JSON.stringify({ lines: Array.from({ length: 20 }, () => ({ say: "More." })) })),
    ).toHaveLength(16);
  });

  it("shows an older reply, kept before she spoke in lines, as lines too", () => {
    expect(segmentsOf(said("lyra", "Short."))).toEqual([{ text: "Short." }]);
    expect(
      segmentsOf({ ...said("lyra", "Whole."), segments: [{ text: "One.", mood: "amused" }, { text: "Two." }] }),
    ).toEqual([{ text: "One.", mood: "amused" }, { text: "Two." }]);
  });
});

describe("where a conversation is kept", () => {
  const files = (): { map: Map<string, string>; store: TalkStore } => {
    const map = new Map<string, string>();
    const store = new TalkStore({
      read: (path) => Promise.resolve(map.get(path) ?? null),
      write: (path, text) => {
        map.set(path, text);
        return Promise.resolve();
      },
    });
    return { map, store };
  };

  it("keeps each conversation in its own file, and reads it back", async () => {
    const { map, store } = files();

    await store.add("Novel/Lyra notes/talk.json", said("author", "Hello.", 1), said("lyra", "Hm.", 2));
    await store.add("plugin/talk.json", said("author", "Elsewhere.", 3));

    expect([...map.keys()]).toEqual(["Novel/Lyra notes/talk.json", "plugin/talk.json"]);

    const again = new TalkStore({
      read: (path) => Promise.resolve(map.get(path) ?? null),
      write: () => Promise.resolve(),
    });
    expect(await again.load("Novel/Lyra notes/talk.json")).toEqual([
      said("author", "Hello.", 1),
      said("lyra", "Hm.", 2),
    ]);
    expect(await again.load("nowhere.json")).toEqual([]);
  });

  it("keeps the lines of her replies, and drops what is not a line", async () => {
    const { map, store } = files();
    await store.add("t.json", {
      ...said("lyra", "One. Two.", 1),
      segments: [{ text: "One.", mood: "amused" }, { text: "Two." }],
    });

    const again = new TalkStore({
      read: (path) => Promise.resolve(map.get(path) ?? null),
      write: () => Promise.resolve(),
    });
    expect((await again.load("t.json"))[0]!.segments).toEqual([{ text: "One.", mood: "amused" }, { text: "Two." }]);

    map.set(
      "u.json",
      JSON.stringify({ messages: [{ ...said("lyra", "Kept.", 1), segments: [{ text: "" }, 4, { mood: "x" }] }] }),
    );
    expect(await again.load("u.json")).toEqual([said("lyra", "Kept.", 1)]);
  });

  it("keeps follow-up choices on a reply and still reads older messages without them", async () => {
    const { map, store } = files();
    await store.add("t.json", {
      ...said("lyra", "A considered answer.", 1),
      segments: [{ text: "A considered answer." }],
      followUps: ["Show me the passage.", "What else could work?"],
    });

    const again = new TalkStore({
      read: (path) => Promise.resolve(map.get(path) ?? null),
      write: () => Promise.resolve(),
    });
    expect((await again.load("t.json"))[0]!.followUps).toEqual(["Show me the passage.", "What else could work?"]);

    map.set("old.json", JSON.stringify({ messages: [said("lyra", "An older reply.", 2)] }));
    expect(await again.load("old.json")).toEqual([said("lyra", "An older reply.", 2)]);
  });

  it("starts again from a file it cannot read, keeping only what is a message", async () => {
    const { map, store } = files();
    map.set("a.json", "not json");
    map.set(
      "b.json",
      JSON.stringify({ messages: [said("lyra", "Kept.", 1), { who: "nobody", text: "x", at: 1 }, "junk"] }),
    );

    expect(await store.load("a.json")).toEqual([]);
    expect(await store.load("b.json")).toEqual([said("lyra", "Kept.", 1)]);
  });

  it("forgets the oldest of a very long conversation, and all of it when cleared", async () => {
    const { map, store } = files();
    await store.add(
      "t.json",
      ...Array.from({ length: MAX_KEPT_MESSAGES + 5 }, (_, index) => said("author", `${index}`)),
    );

    const kept = await store.load("t.json");
    expect(kept).toHaveLength(MAX_KEPT_MESSAGES);
    expect(kept[0]!.text).toBe("5");

    await store.clear("t.json");
    expect(await store.load("t.json")).toEqual([]);
    expect(JSON.parse(map.get("t.json")!)).toEqual({ version: 1, messages: [] });
  });

  it("keeps disabled chat memory in the session and leaves saved files alone until Forget", async () => {
    const map = new Map([["t.json", JSON.stringify({ version: 1, messages: [said("author", "Old.")] })]]);
    const store = new TalkStore({
      remember: () => false,
      read: (path) => Promise.resolve(map.get(path) ?? null),
      write: (path, text) => {
        map.set(path, text);
        return Promise.resolve();
      },
    });

    expect(await store.load("t.json")).toEqual([]);
    await store.add("t.json", said("author", "New."));
    expect(await store.load("t.json")).toEqual([said("author", "New.")]);
    expect(JSON.parse(map.get("t.json")!).messages).toEqual([said("author", "Old.")]);

    await store.clear("t.json");
    expect(JSON.parse(map.get("t.json")!).messages).toEqual([]);
  });

  it("keeps novel memory separate, bounded, editable, and off when saved memory is disabled", async () => {
    const map = new Map([[
      "novel/memory.json",
      JSON.stringify({ version: 1, memory: "Decision: Mara stays." }),
    ]]);
    let remember = true;
    const store = new TalkStore({
      remember: () => remember,
      read: (path) => Promise.resolve(map.get(path) ?? null),
      write: (path, text) => {
        map.set(path, text);
        return Promise.resolve();
      },
    });

    expect(await store.loadMemory("novel/memory.json")).toBe("Decision: Mara stays.");
    await store.saveMemory("novel/memory.json", "Rejected [Chapter 4]: the adoption reveal.");
    expect(JSON.parse(map.get("novel/memory.json")!).memory).toBe("Rejected [Chapter 4]: the adoption reveal.");

    remember = false;
    const fresh = new TalkStore({
      remember: () => remember,
      read: (path) => Promise.resolve(map.get(path) ?? null),
      write: (path, text) => {
        map.set(path, text);
        return Promise.resolve();
      },
    });
    expect(await fresh.loadMemory("novel/memory.json")).toBe("");
    await fresh.saveMemory("novel/memory.json", "Preference: terse answers.");
    expect(await fresh.loadMemory("novel/memory.json")).toBe("Preference: terse answers.");
    expect(JSON.parse(map.get("novel/memory.json")!).memory).toBe("Rejected [Chapter 4]: the adoption reveal.");
  });
});

describe("a reply in a broken format", () => {
  it("reads lines whose mood was left unquoted, inside a fence", () => {
    const raw =
      '```json { "lines": [ {"say": "Shambhu\'s not a hero-in-waiting. He\'s a kid who ran.", "mood": neutral}, {"say": "So?", "mood": amused} ] }```';
    expect(parseTalkReply(raw)).toEqual([
      { text: "Shambhu's not a hero-in-waiting. He's a kid who ran.", mood: "neutral" },
      { text: "So?", mood: "amused" },
    ]);
  });

  it("reads an answer that was cut off", () => {
    const raw = '{"lines": [{"say": "One.", "mood": "weary"}, {"say": "Two is unfin';
    expect(parseTalkReply(raw)).toEqual([{ text: "One.", mood: "weary" }, { text: "Two is unfin" }]);
  });

  it("reads again a reply that was kept as raw text", () => {
    const text = '```json { "lines": [ {"say": "Fine.", "mood": neutral} ] }```';
    expect(segmentsOf({ who: "lyra", text, at: 1, segments: [{ text }] })).toEqual([
      { text: "Fine.", mood: "neutral" },
    ]);
  });
});
