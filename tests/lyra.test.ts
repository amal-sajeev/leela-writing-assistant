import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createAnchor } from "../src/comments/anchor";
import {
  COMPANION_MOODS,
  companionLines,
  leadComment,
  moodForComment,
  remarkFor,
  sceneFor,
  SCENES,
  seedOf,
  type CompanionLine,
  type CompanionMood,
  type Scene,
} from "../src/companion/lines";
import {
  ACTIVE_SCENES,
  activeSceneOptions,
  IN_PROGRESS_ASSETS,
  PASSIVE_ASSETS,
  PASSIVE_SCENES,
} from "../src/companion/scene-assets";
import type { AIProvider } from "../src/providers/provider";
import { mergeReview, persona, reviewPassage } from "../src/review/review";
import { DEFAULT_SETTINGS, normalizeSettings, type LyraSettings } from "../src/settings/settings";
import { NoteStore, type StorePort } from "../src/store";
import type { ActiveReaction, ReviewComment } from "../src/types";
import { Companion, type Ask } from "../src/ui/window";

const FILE = "Notes/Draft.md";
const TEXT = "Twelve people were interviewed, so the model is always more accurate. It is fast.";

function comment(overrides: Partial<ReviewComment> = {}): ReviewComment {
  return {
    id: "c1",
    filePath: FILE,
    reviewerId: "lyra",
    category: "reasoning",
    severity: "medium",
    confidence: 0.8,
    anchor: createAnchor(TEXT, 35, 68),
    body: "Twelve interviews cannot carry a universal claim.",
    status: "open",
    createdAt: 100,
    updatedAt: 100,
    sourceRevisionHash: "revision",
    thread: [],
    ...overrides,
  };
}

describe("her scenes", () => {
  it("exist on disk for every name the code can ask for, along with the frame", () => {
    const asset = (name: string): string =>
      fileURLToPath(new URL(`../assets/${name}`, import.meta.url));

    for (const scene of [...ACTIVE_SCENES, ...PASSIVE_SCENES, ...IN_PROGRESS_ASSETS]) {
      expect(existsSync(asset(scene.asset)), scene.id).toBe(true);
    }
    expect(existsSync(asset("archive/green-lyra"))).toBe(false);
    expect(existsSync(asset("frame.webp"))).toBe(true);
  });

  it("give every mood something to show, and one line one picture", () => {
    for (const mood of COMPANION_MOODS) expect(SCENES).toContain(sceneFor(mood, 3));

    const seed = seedOf("comment_abc");
    expect(sceneFor("reading", seed)).toBe(sceneFor("reading", seed));
    expect(sceneFor("surprised", 99)).toBe("pondering");
    expect(sceneFor("sad", 1)).toBe("tired");
  });

  it("change slowly while she is left to herself", () => {
    const seen = new Set([0, 1, 2, 3, 4].map((slot) => sceneFor("resting", slot)));
    expect(seen.size).toBe(5);
  });

  it("rotates the ordinary expressions and keeps the worried ones for moments that earn them", () => {
    const shown = (mood: CompanionMood, scene?: Scene): string[] =>
      activeSceneOptions(mood, scene).map((entry) => entry.id);
    const worried = ["idle_concerned", "idle_sad", "idle_shocked_sad"];

    for (const mood of ["resting", "pointed", "asking", "answering", "happy", "greeting"] as const) {
      for (const id of worried) expect(shown(mood)).not.toContain(id);
    }
    for (const scene of SCENES) {
      for (const id of worried) expect(shown("pointed", scene)).not.toContain(id);
    }

    expect(shown("surprised")).toContain("idle_concerned");
    expect(shown("sad")).toContain("idle_sad");

    for (const mood of ["resting", "pointed", "asking", "answering"] as const) {
      expect(shown(mood).length).toBeGreaterThanOrEqual(3);
    }
    expect(shown("pointed")).toEqual(
      expect.arrayContaining(["idle_serious", "idle_teasing", "idle_embarassed"]),
    );
  });

});

describe("what she says", () => {
  it("turns each comment into a line, oldest first, opening with the most serious of a batch", () => {
    const lines = companionLines([
      comment({ id: "new-low", severity: "low", createdAt: 200 }),
      comment({ id: "new-high", severity: "high", createdAt: 200 }),
      comment({ id: "old", createdAt: 100 }),
    ]);

    expect(lines.map((line) => line.id)).toEqual(["old", "new-low", "new-high"]);
    expect(lines.at(-1)?.mood).toBe("surprised");
    expect(lines[0]?.label).toBe("reasoning · medium");
  });

  it("keeps what was resolved in the history and drops what was dismissed", () => {
    const lines = companionLines([
      comment({ id: "resolved", status: "resolved" }),
      comment({ id: "dismissed", status: "dismissed" }),
    ]);

    expect(lines.map((line) => [line.id, line.settled])).toEqual([["resolved", true]]);
  });

  it("delivers a compliment with a smile, and leads with a problem over a compliment", () => {
    expect(moodForComment(comment({ category: "strength" }))).toBe("happy");
    expect(moodForComment(comment())).toBe("pointed");

    const lead = leadComment([
      comment({ id: "praise", category: "strength", severity: "low" }),
      comment({ id: "major", severity: "high" }),
    ]);
    expect(lead?.id).toBe("major");
  });

  it("varies her own remarks from one turn to the next", () => {
    expect(remarkFor("nothing-found", 0).text).not.toBe(remarkFor("nothing-found", 1).text);
    expect(remarkFor("could-not-review", 0).mood).toBe("sad");
  });
});

describe("settings", () => {
  it("come back usable from anything, and only the changeable ones are read", () => {
    expect(normalizeSettings(undefined)).toEqual(DEFAULT_SETTINGS);

    const settings = normalizeSettings({
      provider: "anthropic",
      liveReview: { enabled: true, debounceMs: 99, minimumChangedCharacters: 9999 },
      companion: { name: "  Leela  ", lingerSeconds: 9000 },
      persona: { focus: "   ", pickiness: 7 },
    });

    expect(settings.provider).toBe("anthropic");
    expect(settings.liveReview.enabled).toBe(true);
    expect(settings.liveReview.debounceMs).toBe(1000);
    expect(settings.liveReview.minimumChangedCharacters).toBe(40);
    expect(settings.companion.name).toBe("Leela");
    expect(settings.companion.lingerSeconds).toBe(60);
    expect(settings.persona.focus).toBe(DEFAULT_SETTINGS.persona.focus);
    expect(settings.persona.pickiness).toBe(1);
  });

  it("keep a Gemini key and model when settings are loaded", () => {
    const settings = normalizeSettings({
      providers: { gemini: { apiKey: "  g-key  ", model: "  gemini-4-argon  " } },
    });

    expect(settings.providers.gemini).toEqual({
      apiKey: "g-key",
      fallbackKeys: [],
      model: "gemini-4-argon",
      fallbackModels: [],
    });
    expect(settings.providers.mistral.model).toBe(DEFAULT_SETTINGS.providers.mistral.model);
  });

  it("keeps optional fallback keys and models, in order and within their limits", () => {
    const settings = normalizeSettings({
      providers: {
        gemini: {
          fallbackKeys: ["  key-two  ", "key-two", "", "key-three", "key-four", "key-five"],
          fallbackModels: [
            "  gemini-4-argon  ",
            "gemini-4-argon",
            "gemini-3.7-flash",
            "gemini-3.5-flash",
          ],
        },
      },
    });

    expect(settings.providers.gemini.fallbackKeys).toEqual(["key-two", "key-three", "key-four"]);
    expect(settings.providers.gemini.fallbackModels).toEqual(["gemini-4-argon", "gemini-3.7-flash"]);
  });

  it("keep a dragged window size within limits, and treat anything else as unset", () => {
    expect(normalizeSettings({}).companion.width).toBeNull();
    expect(normalizeSettings({ companion: { width: "wide" } }).companion.width).toBeNull();
    expect(normalizeSettings({ companion: { width: 512.4 } }).companion.width).toBe(512);
    expect(normalizeSettings({ companion: { width: 50 } }).companion.width).toBe(200);
    expect(normalizeSettings({ companion: { width: 99999 } }).companion.width).toBe(1200);
  });

  it("migrates manual review controls without changing older preferences", () => {
    const settings = normalizeSettings({
      persona: { mode: "essay" },
      manualReview: { depth: "exhaustive", unlimitedFindings: true, maximumFindings: 200 },
    });

    expect(settings.manualReview).toEqual({
      depth: "exhaustive",
      unlimitedFindings: true,
      maximumFindings: 20,
      factCheck: false,
    });
    expect(settings.persona.mode).toBe("essay");
    expect(normalizeSettings({}).manualReview).toEqual(DEFAULT_SETTINGS.manualReview);
  });

  it("give her the strength category only when praise is on", () => {
    const quiet = structuredClone(DEFAULT_SETTINGS);
    quiet.persona.praise = false;

    expect(persona(DEFAULT_SETTINGS).enabledCategories).toContain("strength");
    expect(persona(quiet).enabledCategories).not.toContain("strength");
  });
});

function fakeProvider(reply: unknown, seen: string[] = []): AIProvider {
  return {
    id: "mistral",
    displayName: "Mistral",
    validateConfiguration: () => Promise.resolve(),
    review: (input) => {
      seen.push(input.userPrompt);
      return Promise.resolve({ comments: reply as never });
    },
    reviewDocument: () => Promise.resolve({ observations: [] }),
    replyToComment: () => Promise.resolve(""),
    generateFix: () => Promise.resolve({ replacement: "", generatedAt: 0 }),
  };
}

describe("a review of one passage", () => {
  const input = {
    filePath: FILE,
    documentTitle: "Draft",
    documentText: TEXT,
    start: 0,
    end: 68,
    existing: [],
  };

  it("anchors what the model quoted, and drops what it did not quote from the text", async () => {
    const outcome = await reviewPassage(
      input,
      DEFAULT_SETTINGS,
      fakeProvider([
        {
          quote: "always more accurate",
          category: "character",
          kind: "craft",
          severity: "high",
          confidence: 0.9,
          body: "Nothing so far suggests she would speak in absolutes.",
        },
        {
          quote: "a sentence that is not in the note",
          category: "clarity",
          severity: "medium",
          confidence: 0.9,
          body: "This needs to say who it is about.",
        },
      ]),
    );

    expect(outcome.comments).toHaveLength(1);
    const anchor = outcome.comments[0]!.anchor;
    expect(TEXT.slice(anchor.start, anchor.end)).toBe("always more accurate");
    expect(outcome.comments[0]!.reviewerId).toBe("lyra");
  });

  it("never sends one of the author's own keys, even when it is in the note", async () => {
    const settings: LyraSettings = structuredClone(DEFAULT_SETTINGS);
    settings.providers.mistral.apiKey = "sk-secret-key-0123456789";
    const text = `The key is sk-secret-key-0123456789 for now. ${TEXT}`;
    const seen: string[] = [];

    await reviewPassage({ ...input, documentText: text, end: text.length }, settings, fakeProvider([], seen));

    expect(seen[0]).not.toContain("sk-secret-key-0123456789");
    expect(seen[0]).toContain("[redacted]");
  });

  it("replaces her open comments on the passage re-read, and leaves the rest alone", () => {
    const elsewhere = comment({ id: "elsewhere", anchor: createAnchor(TEXT, 70, 80) });
    const settled = comment({ id: "settled", status: "resolved" });
    const superseded = comment({ id: "superseded" });
    const fresh = comment({ id: "fresh", body: "A new point about the same words." });

    const merged = mergeReview(
      [superseded, settled, elsewhere],
      { span: { start: 0, end: 68 }, comments: [fresh] },
      TEXT,
    );

    expect(merged.map((entry) => entry.id).sort()).toEqual(["elsewhere", "fresh", "settled"]);
  });
});

describe("the saved comments", () => {
  function memory(initial: string | null = null): StorePort & { text: string | null; writes: number } {
    const port = {
      text: initial,
      writes: 0,
      read: () => Promise.resolve(port.text),
      write: (contents: string) => {
        port.text = contents;
        port.writes += 1;
        return Promise.resolve();
      },
    };
    return port;
  }

  it("come back after a restart, follow a rename, and go with a deleted note", async () => {
    const port = memory();
    const store = new NoteStore(port);
    await store.load();

    store.set(FILE, [comment()]);
    store.rename(FILE, "Notes/Final.md");
    await store.flush();

    const reopened = new NoteStore(port);
    await reopened.load();
    expect(reopened.comments(FILE)).toEqual([]);
    expect(reopened.comments("Notes/Final.md")[0]).toMatchObject({ id: "c1", filePath: "Notes/Final.md" });

    reopened.delete("Notes/Final.md");
    await reopened.flush();
    expect(JSON.parse(port.text!).notes).toEqual({});
  });

  it("batch their writes", async () => {
    const port = memory();
    const store = new NoteStore(port);
    await store.load();

    store.set(FILE, [comment()]);
    store.set(FILE, [comment(), comment({ id: "c2" })]);
    store.set("Other.md", [comment({ id: "c3" })]);
    await store.flush();

    expect(port.writes).toBe(1);
  });

  it("are never written over when the file could not be understood", async () => {
    const port = memory("{ this is not json");
    const problems: string[] = [];
    const store = new NoteStore(port, (problem) => problems.push(problem));
    await store.load();

    store.set(FILE, [comment()]);
    await store.flush();

    expect(port.text).toBe("{ this is not json");
    expect(problems).toHaveLength(1);
  });

  it("keep the comments that are whole and drop the ones that are not", async () => {
    const port = memory(JSON.stringify({ version: 1, notes: { [FILE]: [comment(), { id: "broken" }] } }));
    const store = new NoteStore(port);
    await store.load();

    expect(store.comments(FILE).map((entry) => entry.id)).toEqual(["c1"]);
  });

  it("reports archive size without exposing comment text", async () => {
    const store = new NoteStore(memory());
    await store.load();
    store.set(FILE, [comment()]);

    expect(store.archiveStats()).toMatchObject({ notes: 1, comments: 1 });
    expect(store.archiveStats().bytes).toBeGreaterThan(0);
    await store.flush();
  });
});

/**
 * Just enough of an element for the window to build itself on: a tree, classes,
 * attributes and listeners. No layout, which the window never asks about.
 */
class FakeElement {
  readonly children: FakeElement[] = [];
  readonly classes = new Set<string>();
  readonly attributes = new Map<string, string>();
  readonly dataset: Record<string, string> = {};
  readonly listeners = new Map<string, Array<(event: unknown) => void>>();
  parent: FakeElement | null = null;
  text = "";
  disabled = false;
  alt = "";
  value = "";
  rows = 0;
  placeholder = "";
  scrollTop = 0;
  focused = 0;
  focus(): void {
    this.focused += 1;
  }
  isConnected = true;
  readonly placed = new Map<string, string>();
  readonly style = {
    setProperty: (name: string, value: string) => void this.placed.set(name, value),
    removeProperty: (name: string) => void this.placed.delete(name),
  };
  /** How wide the element is drawn, for the one thing that measures: a resize. */
  drawnWidth = 0;
  getBoundingClientRect(): { width: number } {
    return { width: this.drawnWidth };
  }

  constructor(readonly tag: string) {}

  private add(tag: string, options: { cls?: string; text?: string } = {}): FakeElement {
    const child = new FakeElement(tag);
    for (const name of (options.cls ?? "").split(" ")) if (name.length > 0) child.classes.add(name);
    child.text = options.text ?? "";
    child.parent = this;
    this.children.push(child);
    return child;
  }

  createDiv(options?: { cls?: string; text?: string }): FakeElement {
    return this.add("div", options);
  }
  createSpan(options?: { cls?: string; text?: string }): FakeElement {
    return this.add("span", options);
  }
  createEl(tag: string, options?: { cls?: string; text?: string }): FakeElement {
    return this.add(tag, options);
  }
  appendText(text: string): void {
    this.add("#text", { text });
  }
  addEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  fire(type: string, event: Record<string, unknown> = {}): void {
    for (const listener of this.listeners.get(type) ?? []) listener({ preventDefault() {}, ...event });
  }
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }
  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }
  setText(text: string): void {
    this.text = text;
  }
  addClass(name: string): void {
    this.classes.add(name);
  }
  removeClass(name: string): void {
    this.classes.delete(name);
  }
  toggleClass(name: string, on: boolean): void {
    if (on) this.classes.add(name);
    else this.classes.delete(name);
  }
  empty(): void {
    this.children.length = 0;
  }
  remove(): void {
    if (this.parent !== null) {
      const index = this.parent.children.indexOf(this);
      if (index >= 0) this.parent.children.splice(index, 1);
    }
    this.isConnected = false;
  }
  querySelector(selector: string): FakeElement | null {
    return this.find(selector.replace(/^\./, "")) ?? null;
  }
  all(): FakeElement[] {
    return this.children.flatMap((child) => [child, ...child.all()]);
  }
  find(cls: string): FakeElement | undefined {
    return this.all().find((element) => element.classes.has(cls));
  }
  content(): string {
    return [this.text, ...this.children.map((child) => child.content())].join(" ");
  }
}

describe("her window", () => {
  let host: FakeElement;
  let settings: LyraSettings;
  let comments: ReviewComment[];
  let shown: CompanionLine[];
  let selection: number;
  let reviews: number;
  let companion: Companion;
  let corner: { right: number; bottom: number; width: number } | null;
  let widths: Array<number | null>;

  /** What she was asked, copied, told to ignore, and so on, for the tests that look. */
  let asked: Array<{ commentId: string; request: Ask }>;
  let answers: boolean;
  let copied: string[];
  let applied: string[];
  let applies: boolean;
  let ignored: string[];
  let scenes: number;
  let paused: boolean;
  let handedBack: number;
  let activeFile: string;
  let talked: Array<{ who: "author" | "lyra"; text: string; at: number }>;
  let talkMemory: string;
  let talkFails: boolean;
  let talkAnswer: Array<{ text: string; mood?: "amused" | "thinking" | "surprised"; reaction?: ActiveReaction }> | null;

  const extras = () => ({
    reviewScene: () => {
      scenes += 1;
    },
    ask: (_filePath: string, commentId: string, request: Ask) => {
      asked.push({ commentId, request });
      return Promise.resolve(answers);
    },
    copy: (text: string) => void copied.push(text),
    applyExample: (_filePath: string, commentId: string) => {
      applied.push(commentId);
      if (!applies) return false;
      // What the plugin does on success: the comment it answered is settled.
      comments = comments.map((entry) => (entry.id === commentId ? { ...entry, status: "resolved" } : entry));
      companion.commentsChanged(FILE);
      return true;
    },
    focusEditor: () => {
      handedBack += 1;
    },
    ignoreCategory: (category: string) => void ignored.push(category),
    eraseComments: () => {
      comments = [];
    },
    isPaused: () => paused,
    talk: {
      scope: () => ({ path: "Novel/Lyra notes/talk.json", title: "Novel" }),
      history: () => Promise.resolve([...talked]),
      memory: () => Promise.resolve(talkMemory),
      saveMemory: (_scope: unknown, text: string) => {
        talkMemory = text;
        return Promise.resolve();
      },
      say: (_scope: unknown, text: string) => {
        if (talkFails) return Promise.resolve({ ok: false as const, reason: "No key." });
        const reply =
          talkAnswer === null
            ? { who: "lyra" as const, text: `You said: ${text}`, at: 2 }
            : { who: "lyra" as const, text: talkAnswer.map((line) => line.text).join(" "), segments: talkAnswer, at: 2 };
        talked.push({ who: "author", text, at: 1 }, reply);
        return Promise.resolve({ ok: true as const, reply });
      },
      clear: () => {
        talked = [];
        return Promise.resolve();
      },
    },
    togglePause: () => {
      paused = !paused;
    },
  });

  const root = (): FakeElement => host.find("lyra")!;
  const isOpen = (): boolean => root().dataset.open === "true";
  const press = (cls: string, nth = 0): void => {
    const matching = root()
      .all()
      .filter((element) => element.classes.has(cls));
    matching[nth]!.fire("click");
  };
  /** Presses one of her keys by what is written on it. */
  const key = (label: string): FakeElement =>
    root()
      .all()
      .find((element) => element.classes.has("lyra__action") && element.text === label)!;
  const control = (label: string): FakeElement =>
    root()
      .all()
      .find((element) => element.attributes.get("aria-label") === label)!;

  /** A review lands. */
  const arrive = (...added: ReviewComment[]): void => {
    comments = [...comments, ...added];
    companion.commentsChanged(FILE);
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    (globalThis as { window?: unknown }).window = globalThis;

    host = new FakeElement("div");
    corner = { right: 300, bottom: 0, width: 1286 };
    widths = [];
    asked = [];
    answers = true;
    copied = [];
    applied = [];
    applies = true;
    ignored = [];
    scenes = 0;
    paused = false;
    handedBack = 0;
    activeFile = FILE;
    talked = [];
    talkMemory = "";
    talkFails = false;
    talkAnswer = null;
    settings = structuredClone(DEFAULT_SETTINGS);
    comments = [comment({ id: "existing" })];
    shown = [];
    selection = 0;
    reviews = 0;

    companion = new Companion({
      host: () => host as unknown as HTMLElement,
      corner: () => corner,
      getSettings: () => settings,
      activePath: () => activeFile,
      getComments: () => comments,
      assetUrl: (relativePath) => `app://lyra/${relativePath}`,
      showPassage: (_filePath, line) => shown.push(line),
      setStatus: (_filePath, commentId, status) => {
        comments = comments.map((entry) => (entry.id === commentId ? { ...entry, status } : entry));
        companion.commentsChanged(FILE);
      },
      selectionLength: () => selection,
      setWidth: (width) => {
        widths.push(width);
        settings.companion.width = width;
      },
      reviewSelection: () => {
        reviews += 1;
      },
      ...extras(),
      // Off, so a line is whole the moment it is shown; one test turns it on.
      reducedMotion: () => true,
    });
    companion.start();
  });

  afterEach(() => {
    companion.stop();
    vi.useRealTimers();
  });

  it("sits folded in the corner over a note that already has comments, showing a count", () => {
    expect(isOpen()).toBe(false);
    expect(root().find("lyra__plaque")?.text).toBe("1");
    expect(root().find("lyra__frame")?.getAttribute("src")).toBe("app://lyra/frame.webp");
    expect(root().find("lyra__scene")?.getAttribute("src")).toMatch(/^app:\/\/lyra\/(?:idle|in_progress)\/[\w-]+\.webp$/);
  });

  // She floats above the whole app, so where the editor's corner is has to be told
  // to her, and told again whenever a sidebar opens or the window is resized.
  it("lines herself up with the editor area, and follows it when it moves", () => {
    expect(Object.fromEntries(root().placed)).toEqual({
      "--lyra-right": "300px",
      "--lyra-bottom": "0px",
      "--lyra-top": "0px",
      "--lyra-room": "1286px",
      "--lyra-reach": "1586px",
    });

    corner = { right: 0.4, bottom: 22.6, width: 1586 };
    companion.place();

    expect(root().placed.get("--lyra-right")).toBe("0px");
    expect(root().placed.get("--lyra-bottom")).toBe("23px");
    expect(root().placed.get("--lyra-room")).toBe("1586px");
  });

  // She is pinned by her bottom-right corner, so the top-left one is the one to
  // pull, and pulling it up and to the left makes her larger.
  it("is resized by dragging her corner, and remembers the size", () => {
    arrive(comment({ id: "fresh", createdAt: 500 }));
    root().drawnWidth = 344;
    const grip = root().find("lyra__grip")!;

    grip.fire("pointerdown", { clientX: 1000, clientY: 600, pointerId: 1 });
    grip.fire("pointermove", { clientX: 900, clientY: 590, pointerId: 1 });
    expect(root().placed.get("--lyra-open")).toBe("444px");
    expect(widths).toEqual([]);

    grip.fire("pointerup", { clientX: 880, clientY: 590, pointerId: 1 });
    expect(widths).toEqual([464]);
    expect(root().dataset.sized).toBe("true");

    // She does not fold away mid-drag, or shrink back when something redraws her.
    companion.commentsChanged(FILE);
    expect(root().placed.get("--lyra-open")).toBe("464px");
  });

  it("takes the larger of the two directions, keeps to sensible limits, and resets", () => {
    arrive(comment({ id: "fresh", createdAt: 500 }));
    root().drawnWidth = 344;
    const grip = root().find("lyra__grip")!;

    // Pulled straight up by 100: the frame is wider than tall, so that is 156 across.
    grip.fire("pointerdown", { clientX: 1000, clientY: 600, pointerId: 1 });
    grip.fire("pointerup", { clientX: 1000, clientY: 500, pointerId: 1 });
    expect(widths.at(-1)).toBe(500);

    grip.fire("pointerdown", { clientX: 1000, clientY: 600, pointerId: 1 });
    grip.fire("pointerup", { clientX: 5000, clientY: 600, pointerId: 1 });
    expect(widths.at(-1)).toBe(200);

    grip.fire("dblclick");
    expect(widths.at(-1)).toBeNull();
    expect(root().dataset.sized).toBe("false");
    expect(root().placed.has("--lyra-open")).toBe(false);
  });

  it("scales a drag made while she is folded away up to her speaking size", () => {
    root().drawnWidth = 176;
    const grip = root().find("lyra__grip")!;

    grip.fire("pointerdown", { clientX: 1000, clientY: 600, pointerId: 1 });
    grip.fire("pointerup", { clientX: 900, clientY: 600, pointerId: 1 });

    // 276 pixels folded is 539 speaking, at the same proportion as the defaults.
    expect(widths).toEqual([539]);
  });

  it("puts the message box above the scene, so it can only grow upward", () => {
    const [first, second] = root().children;
    expect(first?.classes.has("lyra__box")).toBe(true);
    expect(second?.classes.has("lyra__window")).toBe(true);
  });

  it("speaks when a review finds something, in the scene that suits it", () => {
    arrive(comment({ id: "fresh", createdAt: 500, severity: "high", body: "This claim outruns its evidence." }));

    expect(isOpen()).toBe(true);
    expect(root().content()).toContain("This claim outruns its evidence.");
    expect(root().find("lyra__plate")?.text).toBe("Lyra");
    expect([...ACTIVE_SCENES, ...PASSIVE_ASSETS].map(({ id }) => id)).toContain(root().dataset.scene);
  });

  it("waits for a pause rather than talking over typing", () => {
    companion.noteTyped();
    arrive(comment({ id: "fresh", createdAt: 500 }));
    expect(isOpen()).toBe(false);

    vi.advanceTimersByTime(800);
    companion.noteTyped();
    vi.advanceTimersByTime(1_000);
    expect(isOpen()).toBe(false);

    vi.advanceTimersByTime(1_000);
    expect(isOpen()).toBe(true);
  });

  it("folds the box away again by herself, unless the author is pointing at her", () => {
    arrive(comment({ id: "fresh", createdAt: 500 }));
    vi.advanceTimersByTime(settings.companion.lingerSeconds * 1000 + 100);
    expect(isOpen()).toBe(false);

    arrive(comment({ id: "another", createdAt: 600 }));
    root().fire("mouseenter");
    vi.advanceTimersByTime(60_000);
    expect(isOpen()).toBe(true);

    root().fire("mouseleave");
    vi.advanceTimersByTime(settings.companion.lingerSeconds * 1000 + 100);
    expect(isOpen()).toBe(false);
  });

  it("types a line out, and finishes it at once when clicked", () => {
    companion.stop();
    companion = new Companion({
      host: () => host as unknown as HTMLElement,
      corner: () => corner,
      getSettings: () => settings,
      activePath: () => FILE,
      getComments: () => comments,
      assetUrl: () => null,
      showPassage: (_filePath, line) => shown.push(line),
      setStatus: () => undefined,
      selectionLength: () => 0,
      setWidth: () => undefined,
      reviewSelection: () => undefined,
      ...extras(),
      reducedMotion: () => false,
    });
    companion.start();

    const body = "This claim outruns its evidence, and the next sentence leans on it.";
    arrive(comment({ id: "fresh", createdAt: 500, body }));

    const said = (): string => root().find("lyra__say")!.text;
    expect(said()).toBe("");
    expect(root().find("lyra__more")).toBeUndefined();

    vi.advanceTimersByTime(200);
    expect(said().length).toBeGreaterThan(0);
    expect(said().length).toBeLessThan(body.length);

    press("lyra__speech");
    expect(said()).toBe(body);
    expect(root().find("lyra__more")).toBeDefined();
    expect(shown).toHaveLength(1);
  });

  it("changes scene behind a burst of static, like turning the dial on an old set", () => {
    companion.stop();
    companion = new Companion({
      host: () => host as unknown as HTMLElement,
      corner: () => corner,
      getSettings: () => settings,
      activePath: () => FILE,
      getComments: () => comments,
      assetUrl: (relativePath) => `app://lyra/${relativePath}`,
      showPassage: () => undefined,
      setStatus: () => undefined,
      selectionLength: () => 0,
      setWidth: () => undefined,
      reviewSelection: () => undefined,
      ...extras(),
      reducedMotion: () => false,
    });
    companion.start();

    const stage = root().find("lyra__stage")!;
    const picture = (): string | null => root().find("lyra__scene")!.getAttribute("src");
    const before = picture();

    // Two changes in quick succession: one burst of static, landing on the last.
    companion.setActivity("reading");
    companion.setActivity("waiting");

    expect(stage.classes.has("is-switching")).toBe(true);
    expect(picture()).toBe(before);

    vi.advanceTimersByTime(150);
    expect(picture()).toMatch(/^app:\/\/lyra\/in_progress\/in_progress_[1-5]\.webp$/);
    expect(stage.classes.has("is-switching")).toBe(true);

    vi.advanceTimersByTime(400);
    expect(stage.classes.has("is-switching")).toBe(false);

    // Switched off, the picture simply changes.
    settings.companion.crt = false;
    companion.setActivity("idle");
    expect(stage.classes.has("is-switching")).toBe(false);
    expect(picture()).not.toMatch(/^app:\/\/lyra\/in_progress\/in_progress_[1-5]\.webp$/);
  });

  it("shows the passage when her words are clicked, or the frame's play button", () => {
    arrive(comment({ id: "fresh", createdAt: 500 }));

    press("lyra__speech");
    control("Show the passage this is about").fire("click");

    expect(shown.map((line) => line.id)).toEqual(["fresh", "fresh"]);
  });

  it("walks back through what she said with the frame's own arrows", () => {
    arrive(comment({ id: "fresh", createdAt: 500, body: "The newer point." }));
    expect(root().find("lyra__count")?.text).toBe("2/2");
    expect(control("Next thing she said").disabled).toBe(true);

    control("Previous thing she said").fire("click");
    expect(root().find("lyra__count")?.text).toBe("1/2");
    expect(root().content()).toContain("Twelve interviews cannot carry a universal claim.");

    root().all().filter((entry) => entry.classes.has("lyra__note-nav"))[1]!.fire("click");
    expect(root().find("lyra__count")?.text).toBe("2/2");
    root().all().find((entry) => entry.getAttribute("aria-label") === "Previous note")!.fire("click");
    expect(root().find("lyra__count")?.text).toBe("1/2");

    // Browsing is the author's doing, so she does not fold away in the middle of it.
    vi.advanceTimersByTime(120_000);
    expect(isOpen()).toBe(true);

    control("Fold the window away").fire("click");
    expect(isOpen()).toBe(false);
  });

  it("asks before reading a selection, and sends nothing until told to", () => {
    selection = 412;
    press("lyra__stage");

    expect(isOpen()).toBe(true);
    expect(root().content()).toContain("412 characters selected");
    expect(reviews).toBe(0);

    key("Read it").fire("click");
    expect(reviews).toBe(1);
    expect(isOpen()).toBe(false);
  });

  it("only counts, and says nothing, when asked to keep quiet", () => {
    settings.companion.speakUp = false;
    arrive(comment({ id: "fresh", createdAt: 500 }));

    expect(isOpen()).toBe(false);
    expect(root().dataset.unread).toBe("true");
    expect(root().find("lyra__plaque")?.text).toBe("2");

    press("lyra__stage");
    expect(isOpen()).toBe(true);
    expect(root().content()).toContain("Twelve interviews");
    expect(root().dataset.unread).toBe("false");
  });

  it("moves on to the next open comment when one is settled, and remarks on the last", () => {
    arrive(comment({ id: "fresh", createdAt: 500, body: "The newer point." }));
    key("Got it").fire("click");
    expect(root().content()).toContain("Twelve interviews cannot carry a universal claim.");

    key("Got it").fire("click");
    expect(root().dataset.mood).toBe("excited");
    expect(root().find("lyra__plaque")?.classes.has("is-empty")).toBe(true);
  });

  it("lets a settled comment be taken up again, with everything an open one has", () => {
    arrive(comment({ id: "fresh", createdAt: 500, body: "The newer point." }));
    key("Got it").fire("click");
    expect(comments.find((entry) => entry.id === "fresh")?.status).toBe("resolved");

    // Back to the comment that was just settled: it says so, and is not a dead end.
    control("Previous thing she said").fire("click");
    if (key("Reopen") === undefined) {
      control("Next thing she said").fire("click");
      control("Next thing she said").fire("click");
    }
    expect(root().content()).toContain("The newer point.");
    expect(root().content()).toContain("settled");
    expect(key("Got it")).toBeUndefined();

    key("Reopen").fire("click");
    expect(comments.find((entry) => entry.id === "fresh")?.status).toBe("open");
    expect(root().content()).toContain("The newer point.");
    expect(root().content()).not.toContain("settled");
    expect(key("Why?")).toBeDefined();
    expect(key("Got it")).toBeDefined();
  });

  it("opens again on a click after a pinned box follows the author to a note she has said nothing about", () => {
    press("lyra__stage");
    expect(root().dataset.open).toBe("true");

    comments = [];
    activeFile = "Other.md";
    companion.refresh();
    expect(root().dataset.open).toBe("false");

    press("lyra__stage");
    expect(root().dataset.open).toBe("true");
  });

  it("is satisfied, not laughing, once everything she raised is settled", () => {
    for (let seed = 0; seed < 8; seed += 1) {
      expect(["stretching", "sipping", "winking", "strolling"]).toContain(sceneFor("excited", seed));
    }
  });

  it("erases everything she said about the note, but only after asking", () => {
    arrive(comment({ id: "fresh", createdAt: 500, body: "The newer point." }));

    control("Erase everything she has said about this note").fire("click");
    expect(root().content()).toContain("Erase everything I've said about this note? That's 2 comments");
    expect(comments).toHaveLength(2);

    key("Keep them").fire("click");
    expect(comments).toHaveLength(2);
    expect(root().content()).toContain("The newer point.");

    control("Erase everything she has said about this note").fire("click");
    key("Erase them").fire("click");
    expect(comments).toHaveLength(0);
    expect(isOpen()).toBe(false);

    // Nothing is left to go back to: a click finds her with nothing said.
    press("lyra__stage");
    expect(root().content()).toContain("I haven't said a word about this one yet.");
  });

  it("maximizes, restores, and minimizes the note display to a clickable bar", () => {
    press("lyra__stage");
    expect(root().dataset.tall).toBe("false");

    control("Maximize note display").fire("click");
    expect(root().dataset.tall).toBe("true");

    control("Restore note display").fire("click");
    expect(root().dataset.tall).toBe("false");

    control("Minimize note display").fire("click");
    expect(root().dataset.boxMinimized).toBe("true");
    expect(root().find("lyra__box-head")?.getAttribute("role")).toBe("button");
    root().find("lyra__box-head")!.fire("click");
    expect(root().dataset.boxMinimized).toBe("false");
    expect(root().content()).toContain("Twelve interviews cannot carry a universal claim.");
  });

  describe("talking with her about the story", () => {
    const settle = async (): Promise<void> => {
      for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
    };
    const say = (text: string): void => {
      const input = root().find("lyra__talkinput")!;
      input.value = text;
      input.fire("input");
      input.fire("keydown", { key: "Enter", shiftKey: false });
    };
    const dialog = (): FakeElement | undefined => root().find("lyra__dialog");

    it("opens a dialogue box on her picture and a place to type under her window, away from her comments", async () => {
      arrive(comment({ id: "fresh", createdAt: 500, body: "The newer point." }));
      const before = root().find("lyra__box")!.content();

      control("Talk with her about the story, or stop").fire("click");
      await settle();

      expect(root().dataset.talking).toBe("true");
      expect(dialog()!.parent!.classes.has("lyra__window")).toBe(true);
      expect(dialog()!.content()).toContain("What's on your mind?");
      // Under the window: the last thing in her column, after the frame.
      expect(root().children.at(-1)!.classes.has("lyra__talkbox")).toBe(true);
      expect(root().find("lyra__talkhead")!.text).toBe("Talking · Novel");
      expect(root().find("lyra__talkinput")!.focused).toBe(1);
      // What she said about the note is still there, untouched.
      expect(root().find("lyra__box")!.content()).toBe(before);
    });

    it("says what was typed, shows her answer, and pages back through what was said", async () => {
      companion.enterTalk();
      await settle();
      expect(isOpen()).toBe(true);

      say("Is the brother too obvious?");
      expect(dialog()!.content()).toContain("…");
      expect(root().dataset.mood).toBe("answering");
      await settle();

      expect(dialog()!.dataset.who).toBe("lyra");
      expect(dialog()!.content()).toContain("You said: Is the brother too obvious?");
      expect(dialog()!.content()).toContain("2/2");
      expect(root().find("lyra__talkinput")!.value).toBe("");
      // Nothing said here is a comment.
      expect(comments).toHaveLength(1);

      const back = dialog()!
        .all()
        .find((element) => element.getAttribute("aria-label") === "What was said before this")!;
      back.fire("click");
      expect(dialog()!.dataset.who).toBe("author");
      expect(dialog()!.content()).toContain("Is the brother too obvious?");
      expect(dialog()!.content()).toContain("1/2");
    });

    it("keeps to a small box that a click moves on through, and grows when asked", async () => {
      talked = [{ who: "lyra", text: "A long answer.", at: 1 }];
      companion.enterTalk();
      await settle();

      const sized = (): FakeElement & { scrollHeight?: number; clientHeight?: number } =>
        root().find("lyra__dialog-text")!;
      const more = (): FakeElement => root().find("lyra__dialog-more")!;

      // Nothing below what is showing: no mark, and a click does nothing.
      expect(more().classes.has("is-hidden")).toBe(true);
      dialog()!.fire("click");
      expect(sized().scrollTop).toBe(0);

      // Three boxes' worth of text.
      sized().scrollHeight = 300;
      sized().clientHeight = 100;
      sized().fire("scroll");
      expect(more().classes.has("is-hidden")).toBe(false);

      dialog()!.fire("click");
      expect(sized().scrollTop).toBe(80);
      dialog()!.fire("click");
      dialog()!.fire("click");
      expect(sized().scrollTop).toBe(200);
      expect(more().classes.has("is-hidden")).toBe(true);

      expect(dialog()!.dataset.expanded).toBe("false");
      key("▲").fire("click");
      expect(dialog()!.dataset.expanded).toBe("true");
      key("▼").fire("click");
      expect(dialog()!.dataset.expanded).toBe("false");
    });

    it("gives her answer a line at a time, each with her face as she says it, and a click moves on", async () => {
      talkAnswer = [
        { text: "The brother's fine.", mood: "amused", reaction: "idle_welcome" },
        { text: "It's the photograph.", mood: "thinking" },
        { text: "Cut it." },
      ];
      companion.enterTalk();
      await settle();

      say("Is the brother too obvious?");
      await settle();

      const more = (): FakeElement => root().find("lyra__dialog-more")!;

      // Her first line, not her last: what they said is line one, and she has three.
      expect(dialog()!.content()).toContain("The brother's fine.");
      expect(root().dataset.scene).toBe("idle_welcome");
      expect(dialog()!.content()).not.toContain("photograph");
      expect(dialog()!.content()).toContain("2/4");
      expect(ACTIVE_SCENES.map(({ id }) => id)).toContain(root().dataset.scene);
      expect(more().classes.has("is-hidden")).toBe(false);

      dialog()!.fire("click");
      expect(dialog()!.content()).toContain("It's the photograph.");
      expect(ACTIVE_SCENES.map(({ id }) => id)).toContain(root().dataset.scene);

      dialog()!.fire("click");
      expect(dialog()!.content()).toContain("Cut it.");
      expect(dialog()!.content()).toContain("4/4");
      expect(ACTIVE_SCENES.map(({ id }) => id)).toContain(root().dataset.scene);
      expect(more().classes.has("is-hidden")).toBe(true);

      // Nothing after the last line.
      dialog()!.fire("click");
      expect(dialog()!.content()).toContain("4/4");

      // Back on what they said themselves, she is listening.
      root().find("lyra__dialog")!.all().find((element) => element.getAttribute("aria-label") === "What was said before this")!.fire("click");
      expect(dialog()!.content()).toContain("It's the photograph.");
    });

    it("gives back what was typed when she could not answer", async () => {
      companion.enterTalk();
      await settle();
      talkFails = true;

      say("Hello?");
      await settle();

      expect(root().find("lyra__talknote")!.text).toBe("No key.");
      expect(root().find("lyra__talkinput")!.value).toBe("Hello?");
      expect(talked).toEqual([]);
    });

    it("picks the conversation up where it was left, and forgets it only when asked twice", async () => {
      talked = [
        { who: "author", text: "Earlier.", at: 1 },
        { who: "lyra", text: "I remember.", at: 2 },
      ];
      companion.enterTalk();
      await settle();
      expect(dialog()!.content()).toContain("I remember.");

      key("Forget").fire("click");
      await settle();
      expect(talked).toHaveLength(2);

      key("Forget it all?").fire("click");
      await settle();
      expect(talked).toEqual([]);
      expect(dialog()!.content()).toContain("What's on your mind?");
    });

    it("lets the author inspect, edit, save, and clear memory", async () => {
      talkMemory = "Rejected [Chapter 2]: the ghost is not Mara's sister.";
      companion.enterTalk();
      await settle();

      key("Memory").fire("click");
      await settle();
      const input = root().find("lyra__talkmemory-input")!;
      expect(input.value).toBe(talkMemory);

      input.value = "Decision [Chapter 2]: the ghost is Mara's aunt.";
      input.fire("input");
      key("Save memory").fire("click");
      await settle();
      expect(talkMemory).toBe("Decision [Chapter 2]: the ghost is Mara's aunt.");

      key("Clear").fire("click");
      key("Clear it?").fire("click");
      await settle();
      expect(talkMemory).toBe("");
    });

    it("is put away by Esc, and hands the cursor back to the note", async () => {
      companion.enterTalk();
      await settle();

      root().find("lyra__talkinput")!.fire("keydown", { key: "Escape" });

      expect(root().dataset.talking).toBe("false");
      expect(dialog()).toBeUndefined();
      expect(root().find("lyra__talkbox")).toBeUndefined();
      expect(handedBack).toBe(1);
    });
  });

  it("shows what she is doing while she is not speaking", () => {
    companion.setActivity("reading");
    expect(root().dataset.mood).toBe("reading");
    expect(root().dataset.busy).toBe("true");

    companion.setActivity("waiting");
    expect(root().dataset.scene).toMatch(/^in_progress_[1-5]$/);

    companion.setActivity("idle");
    expect(root().dataset.mood).toBe("resting");
  });

  it("explains herself when asked why, and shows what was said underneath", async () => {
    arrive(comment({ id: "fresh", createdAt: 500 }));

    key("Why?").fire("click");
    expect(asked).toEqual([{ commentId: "fresh", request: { kind: "why" } }]);
    // While she works it out: the keys are off, and her window says so.
    expect(key("Why?").disabled).toBe(true);
    expect(root().dataset.mood).toBe("answering");
    expect(root().dataset.busy).toBe("true");

    comments = comments.map((entry) =>
      entry.id === "fresh"
        ? {
            ...entry,
            thread: [{ id: "m1", role: "reviewer", text: "Because nothing prepares it.", createdAt: 1, reaction: "idle_laughing" }],
          }
        : entry,
    );
    await vi.advanceTimersByTimeAsync(0);

    expect(root().content()).toContain("Because nothing prepares it.");
    expect(root().dataset.scene).toBe("idle_laughing");
    expect(key("Why?").disabled).toBe(false);
    expect(root().dataset.busy).toBe("false");
  });

  it("takes the keyboard only when the author asks to write back, and gives it back", async () => {
    arrive(comment({ id: "fresh", createdAt: 500 }));
    expect(root().find("lyra__input")).toBeUndefined();

    key("Discuss").fire("click");
    const input = root().find("lyra__input")!;
    expect(input.focused).toBe(1);

    // She does not fold away while the author is writing to her.
    vi.advanceTimersByTime(120_000);
    expect(isOpen()).toBe(true);

    root().find("lyra__input")!.value = "It is meant to be abrupt.";
    root().find("lyra__input")!.fire("input");
    root().find("lyra__input")!.fire("keydown", { key: "Enter", shiftKey: false });

    expect(asked.at(-1)).toEqual({
      commentId: "fresh",
      request: { kind: "reply", text: "It is meant to be abrupt." },
    });
    expect(handedBack).toBe(1);

    await vi.advanceTimersByTimeAsync(0);
    expect(root().find("lyra__input")).toBeUndefined();
  });

  it("keeps what the author wrote when she could not answer", async () => {
    answers = false;
    arrive(comment({ id: "fresh", createdAt: 500 }));

    key("Discuss").fire("click");
    root().find("lyra__input")!.value = "I disagree.";
    root().find("lyra__input")!.fire("input");
    key("Send").fire("click");
    await vi.advanceTimersByTimeAsync(0);

    expect(root().find("lyra__input")?.value).toBe("I disagree.");
  });

  it("gives the keyboard back on Escape without sending anything", () => {
    arrive(comment({ id: "fresh", createdAt: 500 }));

    key("Discuss").fire("click");
    root().find("lyra__input")!.fire("keydown", { key: "Escape" });

    expect(root().find("lyra__input")).toBeUndefined();
    expect(asked).toEqual([]);
    expect(handedBack).toBe(1);
  });

  it("shows an example as an option that can be copied", () => {
    arrive(
      comment({
        id: "fresh",
        createdAt: 500,
        suggestedFix: { replacement: "She put the cup down.", explanation: "Shorter.", generatedAt: 1 },
      }),
    );

    expect(root().find("lyra__example-label")?.text).toContain("An option, not a correction");
    expect(root().content()).toContain("She put the cup down.");

    key("Copy").fire("click");
    expect(copied).toEqual(["She put the cup down."]);
    expect(key("Copied")).toBeDefined();
  });

  const withExample = (id: string, createdAt: number): ReviewComment =>
    comment({
      id,
      createdAt,
      suggestedFix: { replacement: "She put the cup down.", generatedAt: 1 },
    });

  it("applies an example only when Apply is pressed, then settles the comment and moves on", () => {
    arrive(withExample("fresh", 500));
    expect(applied).toEqual([]);

    key("Apply").fire("click");

    expect(applied).toEqual(["fresh"]);
    expect(comments.find((entry) => entry.id === "fresh")?.status).toBe("resolved");
    // On to the comment that is still open.
    expect(root().content()).toContain("Twelve interviews cannot carry a universal claim.");
  });

  it("stays on the comment when the example could not be applied", () => {
    applies = false;
    arrive(withExample("fresh", 500));

    key("Apply").fire("click");

    expect(applied).toEqual(["fresh"]);
    expect(comments.find((entry) => entry.id === "fresh")?.status).toBe("open");
    expect(root().content()).toContain("She put the cup down.");
  });

  it("does not offer to apply an example for a comment already settled", () => {
    comments = [{ ...withExample("done", 500), status: "resolved" }];
    companion.stop();
    companion.start();
    companion.showComment("done");

    expect(root().content()).toContain("She put the cup down.");
    expect(root().all().some((element) => element.text === "Apply")).toBe(false);
    expect(key("Copy")).toBeDefined();
  });

  it("stops mentioning a kind of finding when told to, and lets that one go", () => {
    arrive(comment({ id: "fresh", createdAt: 500, category: "pov" }));

    key("⋯").fire("click");
    key("Stop mentioning point of view").fire("click");

    expect(ignored).toEqual(["pov"]);
    expect(comments.find((entry) => entry.id === "fresh")?.status).toBe("dismissed");
  });

  it("offers to read the scene when there is nothing to show and nothing selected", () => {
    // A note she has never said anything about.
    companion.stop();
    comments = [];
    companion.start();
    press("lyra__stage");

    expect(isOpen()).toBe(true);
    expect(root().content()).toContain("or I can read the scene you're in.");
    expect(root().all().some((element) => element.text === "Read it")).toBe(false);

    key("Read the scene").fire("click");
    expect(scenes).toBe(1);
    expect(isOpen()).toBe(false);
  });

  it("pauses from the moon in her frame, and says so on the ticker", () => {
    arrive(comment({ id: "fresh", createdAt: 500 }));

    control("Pause or resume reading along").fire("click");
    expect(paused).toBe(true);
    expect(root().dataset.paused).toBe("true");
    expect(root().find("lyra__ticker")?.text).toBe("Paused");

    control("Pause or resume reading along").fire("click");
    expect(root().dataset.paused).toBe("false");
  });

  it("asks a question, in the scene for one, about a choice that may be deliberate", () => {
    arrive(comment({ id: "fresh", createdAt: 500, category: "prose", kind: "taste" }));

    expect(root().find("lyra__meta")?.text).toBe("prose · a question");
    expect([...ACTIVE_SCENES, ...PASSIVE_ASSETS].map(({ id }) => id)).toContain(root().dataset.scene);
  });

  // The author opened her, settled everything, and was left looking at "all
  // settled". Whatever she finds next must replace that, not queue up behind it.
  it("moves on from a finished remark to what a new reading found", () => {
    press("lyra__stage");
    key("Got it").fire("click");
    expect(root().dataset.mood).toBe("excited");
    expect(root().content()).not.toContain("Twelve interviews");

    arrive(comment({ id: "fresh", createdAt: 2_000_000, body: "A new point about the scene." }));

    expect(isOpen()).toBe(true);
    expect(root().content()).toContain("A new point about the scene.");
    expect(root().dataset.mood).not.toBe("excited");
  });

  it("shows the answer to a reading the author asked for, even over a comment still open", () => {
    press("lyra__stage");
    expect(root().content()).toContain("Twelve interviews");

    // Read along: she does not talk over what the author is looking at.
    arrive(comment({ id: "background", createdAt: 2_000_000, body: "Noticed in passing." }));
    expect(root().content()).toContain("Twelve interviews");
    expect(root().dataset.unread).toBe("true");

    // Asked for: the result is what they are waiting to see.
    comments = [...comments, comment({ id: "asked", createdAt: 3_000_000, body: "What you asked about." })];
    companion.commentsChanged(FILE, true);
    expect(root().content()).toContain("What you asked about.");
  });

  it("answers a reading the author asked for even when told to keep quiet, with one remark", () => {
    settings.companion.speakUp = false;

    // The old comment is superseded and nothing new was found.
    comments = [];
    companion.commentsChanged(FILE, true);
    companion.reviewEnded(FILE, "nothing-found");

    expect(isOpen()).toBe(true);
    expect(root().dataset.mood).toBe("happy");
    expect(root().find("lyra__count")?.text).toBe("1/1");
  });

  it("does not interrupt an exchange, whatever arrives", () => {
    press("lyra__stage");
    key("Discuss").fire("click");

    comments = [...comments, comment({ id: "asked", createdAt: 3_000_000, body: "What you asked about." })];
    companion.commentsChanged(FILE, true);

    expect(root().find("lyra__input")).toBeDefined();
    expect(root().content()).toContain("Twelve interviews");
  });

  it("shows the emphasis in what she says as emphasis, not as asterisks", () => {
    arrive(
      comment({
        id: "fresh",
        createdAt: 500,
        body: "The phrase *\u2018tried to force\u2019* is **doing two jobs**; see `focus` and my_var.",
      }),
    );

    const said = root().find("lyra__say")!;
    expect(said.children.map((child) => [child.tag, child.text])).toEqual([
      ["#text", "The phrase "],
      ["em", "'tried to force'"],
      ["#text", " is "],
      ["strong", "doing two jobs"],
      ["#text", "; see "],
      ["code", "focus"],
      ["#text", " and my_var."],
    ]);
    expect(root().content()).not.toContain("*");
  });

  it("types a formatted line out without its marks, then shows it formatted", () => {
    companion.stop();
    companion = new Companion({
      host: () => host as unknown as HTMLElement,
      corner: () => corner,
      getSettings: () => settings,
      activePath: () => FILE,
      getComments: () => comments,
      assetUrl: () => null,
      showPassage: () => undefined,
      setStatus: () => undefined,
      selectionLength: () => 0,
      setWidth: () => undefined,
      reviewSelection: () => undefined,
      ...extras(),
      reducedMotion: () => false,
    });
    companion.start();

    arrive(comment({ id: "fresh", createdAt: 500, body: "*Abrupt*, and the next sentence leans on it rather heavily." }));

    vi.advanceTimersByTime(120);
    const partial = root().find("lyra__say")!.text;
    expect(partial.length).toBeGreaterThan(0);
    expect(partial).not.toContain("*");
    expect("Abrupt, and the next sentence leans on it rather heavily.".startsWith(partial)).toBe(true);

    vi.advanceTimersByTime(2_000);
    expect(root().find("lyra__say")!.children[0]).toMatchObject({ tag: "em", text: "Abrupt" });
  });

  it("opens on what is unread when the count itself is pressed", () => {
    settings.companion.speakUp = false;
    arrive(comment({ id: "fresh", createdAt: 500, body: "The one she has not been heard on." }));
    expect(isOpen()).toBe(false);

    press("lyra__plaque");

    expect(isOpen()).toBe(true);
    expect(root().content()).toContain("The one she has not been heard on.");
    expect(root().dataset.unread).toBe("false");
  });

  it("says so when a review the author asked for finds nothing", () => {
    companion.reviewEnded(FILE, "nothing-found");

    expect(isOpen()).toBe(true);
    expect(root().dataset.mood).toBe("happy");
  });
});
