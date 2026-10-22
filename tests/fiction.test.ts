import { describe, expect, it } from "vitest";

import { createAnchor } from "../src/comments/anchor";
import { isBrief, linkTargets, newBriefPathFor, storyContext, type BriefDeps } from "../src/context/brief";
import type { AIProvider } from "../src/providers/provider";
import { ProviderError } from "../src/providers/provider-errors";
import { proposedCommentSchema } from "../src/providers/schemas";
import { filterComments } from "../src/review/comment-filter";
import { example, exampleSpan, explain, reply } from "../src/review/interactions";
import { persona, reviewPassage } from "../src/review/review";
import { sceneAround } from "../src/review/scene";
import { forSaving, secretId, withStoredKeys, type SecretStore } from "../src/settings/keys";
import { DEFAULT_SETTINGS, focusFor, normalizeSettings, type LyraSettings } from "../src/settings/settings";
import type { ProposedComment, ReviewComment } from "../src/types";

/**
 * What the fiction-focused review asked for: reading fiction as fiction, knowing
 * the story the author described, and being able to be argued with.
 */

const FILE = "Novel/Chapter 08.md";
const SCENE =
  "Mara watched the platform clock. It had stopped at 11:17. " +
  "When the station speaker crackled, Mara felt a sudden surge of grief and knew she had never forgiven him.";

function settings(change: (draft: LyraSettings) => void = () => undefined): LyraSettings {
  const draft = structuredClone(DEFAULT_SETTINGS);
  change(draft);
  return normalizeSettings(draft);
}

function provider(
  options: { comments?: unknown[]; says?: string; fix?: string; seen?: Array<{ system: string; user: string }> } = {},
): AIProvider {
  const record = (input: { systemPrompt: string; userPrompt: string }): void => {
    options.seen?.push({ system: input.systemPrompt, user: input.userPrompt });
  };

  return {
    id: "mistral",
    displayName: "Mistral",
    validateConfiguration: () => Promise.resolve(),
    review: (input) => {
      record(input);
      return Promise.resolve({ comments: (options.comments ?? []) as never });
    },
    reviewDocument: () => Promise.resolve({ observations: [] }),
    replyToComment: (input) => {
      record(input);
      return Promise.resolve(options.says ?? "Because of the two sentences before it.");
    },
    generateFix: (input) => {
      record(input);
      return Promise.resolve({ replacement: options.fix ?? "She did not move.", generatedAt: 1 });
    },
  };
}

const input = {
  filePath: FILE,
  documentTitle: "Chapter 08",
  documentText: SCENE,
  start: 0,
  end: SCENE.length,
  existing: [],
};

describe("reading fiction as fiction", () => {
  it("is the default, with its own categories, and essays keep theirs", () => {
    const fiction = persona(DEFAULT_SETTINGS).enabledCategories;
    const essay = persona(settings((draft) => void (draft.persona.mode = "essay"))).enabledCategories;

    expect(DEFAULT_SETTINGS.persona.mode).toBe("fiction");
    expect(fiction).toEqual(expect.arrayContaining(["character", "dialogue", "pacing", "pov", "emotion"]));
    expect(fiction).not.toContain("evidence");
    expect(essay).toEqual(expect.arrayContaining(["reasoning", "evidence", "clarity"]));
    expect(essay).not.toContain("dialogue");
  });

  it("asks what the passage is for, protects deliberate style, and forbids rewriting", async () => {
    const seen: Array<{ system: string; user: string }> = [];
    await reviewPassage(input, DEFAULT_SETTINGS, provider({ seen }));

    const system = seen[0]!.system;
    expect(system).toContain("fiction reader");
    expect(system).toContain('"taste"');
    expect(system).toContain("unreliable narration");
    expect(system).toContain("do not rewrite or continue the manuscript");
    expect(system).toContain("Do not invent facts about the story");
    expect(system).toContain("Most notes should not look alarmed");
    expect(seen[0]!.user).toContain("PASSAGE (the only text you are reviewing)");
  });

  it("selects a short analysis playbook for the writing mode", async () => {
    const fictionSeen: Array<{ system: string; user: string }> = [];
    await reviewPassage({ ...input, mode: "exhaustive" }, DEFAULT_SETTINGS, provider({ seen: fictionSeen }));
    expect(fictionSeen[0]!.system).toContain("orientation:");
    expect(fictionSeen[0]!.system).toContain("viewpoint-distance:");
    expect(fictionSeen[0]!.system).not.toContain("argument:");

    const essaySeen: Array<{ system: string; user: string }> = [];
    await reviewPassage(
      { ...input, mode: "exhaustive" },
      settings((draft) => void (draft.persona.mode = "essay")),
      provider({ seen: essaySeen }),
    );
    expect(essaySeen[0]!.system).toContain("argument:");
    expect(essaySeen[0]!.system).toContain("factual-precision:");
    expect(essaySeen[0]!.system).not.toContain("orientation:");
  });

  it("uses the essay prompt for essays, and a brief that follows the mode", async () => {
    const essay = settings((draft) => void (draft.persona.mode = "essay"));
    const seen: Array<{ system: string; user: string }> = [];
    await reviewPassage(input, essay, provider({ seen }));

    expect(seen[0]!.system).toContain("critical reading partner");
    expect(seen[0]!.system).toContain("Most notes should not look alarmed");
    expect(seen[0]!.user).toContain("REVIEWED TEXT");
    expect(focusFor(essay)).toContain("steps in an argument");
    expect(focusFor(DEFAULT_SETTINGS)).toContain("point of");

    const own = settings((draft) => void (draft.persona.focus = "Only dialogue."));
    expect(focusFor(own)).toBe("Only dialogue.");
  });

  it("keeps claim checking opt-in and never treats model memory as a source", async () => {
    expect(DEFAULT_SETTINGS.manualReview.factCheck).toBe(false);
    const essay = settings((draft) => {
      draft.persona.mode = "essay";
      draft.manualReview.factCheck = true;
    });
    const seen: Array<{ system: string; user: string }> = [];
    await reviewPassage({ ...input, factCheck: true }, essay, provider({ seen }));

    expect(seen[0]!.system).toContain("FACT-CHECK MODE");
    expect(seen[0]!.system).toContain("do not call it false from memory");
    expect(seen[0]!.system).toContain("Never invent a source, URL, date, or quotation.");
  });

  it("changes her manner with the tone, and nothing else", () => {
    const gentle = persona(settings((draft) => void (draft.persona.tone = "gentle")));
    const direct = persona(settings((draft) => void (draft.persona.tone = "direct")));

    expect(gentle.systemInstructions).toContain("Manner: gentle");
    expect(direct.systemInstructions).toContain("Manner: direct");
    expect(gentle.enabledCategories).toEqual(direct.enabledCategories);
    expect(gentle.sensitivity).toBe(direct.sensitivity);
  });

  it("reads how sure a finding is, and treats nonsense there as no answer", () => {
    const base = { quote: "a", category: "pacing", severity: "low", confidence: 0.7, body: "b" };

    expect(proposedCommentSchema.parse({ ...base, kind: "taste" }).kind).toBe("taste");
    expect(proposedCommentSchema.parse({ ...base, kind: null }).kind).toBeUndefined();
    expect(proposedCommentSchema.parse({ ...base, kind: "vibes" }).kind).toBeUndefined();
    expect(proposedCommentSchema.parse(base).kind).toBeUndefined();
  });

  it("keeps the kind on the comment, and does not raise questions of taste when asked to speak rarely", async () => {
    const taste = {
      quote: "It had stopped at 11:17.",
      category: "prose",
      kind: "taste",
      severity: "low",
      confidence: 0.9,
      body: "Is the exact minute doing work here, or is it colour?",
    };

    const usual = await reviewPassage(input, DEFAULT_SETTINGS, provider({ comments: [taste] }));
    expect(usual.comments[0]?.kind).toBe("taste");

    const sparing = settings((draft) => void (draft.persona.pickiness = 0.1));
    const rare = await reviewPassage(input, sparing, provider({ comments: [{ ...taste, confidence: 0.95 }] }));
    expect(rare.comments).toEqual([]);

    const proposed = taste as unknown as ProposedComment;
    const filtered = filterComments([proposed], {
      reviewedText: SCENE,
      enabledCategories: ["prose"],
      minimumConfidence: 0.5,
      maxComments: 3,
      allowTaste: false,
    });
    expect(filtered.rejected[0]?.reason).toBe("taste");
  });

  it("returns one finding from a passage read in the background, however many came back", async () => {
    const finding = (quote: string, severity: string) => ({
      quote,
      category: "emotion",
      kind: "craft",
      severity,
      confidence: 0.9,
      body: `Something about ${quote.slice(0, 12)} that a reader would feel.`,
    });
    const both = [finding("a sudden surge of grief", "high"), finding("Mara watched the platform clock", "low")];

    const asked = await reviewPassage(input, DEFAULT_SETTINGS, provider({ comments: both }));
    const live = await reviewPassage({ ...input, limit: 1 }, DEFAULT_SETTINGS, provider({ comments: both }));

    expect(asked.comments).toHaveLength(2);
    expect(live.comments.map((comment) => comment.anchor.quote)).toEqual(["a sudden surge of grief"]);
  });

  it("lets an unlimited manual review use its response budget without a finding-count target", async () => {
    const seen: Array<{ system: string; user: string }> = [];
    const outcome = await reviewPassage(
      { ...input, mode: "quick", unlimitedFindings: true },
      DEFAULT_SETTINGS,
      provider({ seen }),
    );

    expect(seen[0]!.system).toContain("Return every distinct, well-supported finding");
    expect(seen[0]!.system).not.toContain("Return at most 20 finding");
    expect(outcome.complete).toBe(true);
  });

  it("does not raise what the author asked her to stop mentioning", () => {
    const quiet = settings((draft) => void (draft.ignoredCategories = ["pacing", "pacing", "nonsense" as never]));

    expect(quiet.ignoredCategories).toEqual(["pacing"]);
    expect(persona(quiet).enabledCategories).not.toContain("pacing");
    expect(persona(quiet).enabledCategories).toContain("dialogue");
  });
});

describe("the story brief and its canon", () => {
  const notes: Record<string, string> = {
    "Lyra brief.md": "House style: British spelling.",
    "Novel/Lyra brief.md":
      "---\nlyra: false\n---\nA quiet ghost story, close third on Mara. Canon: [[Mara]] and [[Timeline|the timeline]].\n[[Chapter 08]] [[Missing]]",
    "Novel/People/Mara.md": "---\ntags: [character]\n---\nMara is 34. Her brother vanished in 2011. She does not cry in public.",
    "Novel/Timeline.md": "2011: the 11:17 train. 2023: the platform is sealed.",
    [FILE]: SCENE,
  };

  const deps: BriefDeps = {
    read: (path) => Promise.resolve(notes[path] ?? null),
    resolveLink: (target) =>
      Object.keys(notes).find((path) => path.endsWith(`/${target}.md`) || path === `${target}.md`) ?? null,
  };

  it("knows a brief by its name, and where a new one would go", () => {
    expect(isBrief("Novel/Lyra brief.md")).toBe(true);
    expect(isBrief("Novel/lyra brief.md")).toBe(true);
    expect(isBrief("Novel/Brief.md")).toBe(false);
    expect(newBriefPathFor(FILE)).toBe("Novel/Lyra brief.md");
    expect(newBriefPathFor("Loose.md")).toBe("Lyra brief.md");
  });

  it("reads links without their aliases, headings or table escapes", () => {
    expect(linkTargets("[[Mara]] [[Timeline|when]] [[Town#The station]] | [[Ada\\|her sister]] |")).toEqual([
      "Mara",
      "Timeline",
      "Town",
      "Ada",
    ]);
  });

  it("merges the briefs above a note, nearest last, without their frontmatter", async () => {
    const context = await storyContext(FILE, deps);

    expect(context.brief).toContain("British spelling");
    expect(context.brief).toContain("quiet ghost story");
    expect(context.brief!.indexOf("British")).toBeLessThan(context.brief!.indexOf("ghost"));
    expect(context.brief).not.toContain("lyra: false");
  });

  it("follows the brief's links to canon, skipping the note being read and links to nowhere", async () => {
    const context = await storyContext(FILE, deps);

    expect(context.canon.map((entry) => entry.filePath)).toEqual(["Novel/People/Mara.md", "Novel/Timeline.md"]);
    expect(context.canon[0]!.excerpt).toBe("Mara is 34. Her brother vanished in 2011. She does not cry in public.");
  });

  it("has nothing to say where there is no brief", async () => {
    expect(await storyContext("Elsewhere/Note.md", { ...deps, read: () => Promise.resolve(null) })).toEqual({
      canon: [],
    });
  });

  it("sends the brief and canon with the passage, and holds continuity to them", async () => {
    const story = await storyContext(FILE, deps);
    const seen: Array<{ system: string; user: string }> = [];

    await reviewPassage(
      { ...input, ...(story.brief === undefined ? {} : { brief: story.brief }), canon: story.canon },
      DEFAULT_SETTINGS,
      provider({ seen }),
    );

    expect(seen[0]!.user).toContain("STORY BRIEF");
    expect(seen[0]!.user).toContain("[Novel/Timeline.md]");
    expect(seen[0]!.user).toContain("She does not cry in public.");
    expect(seen[0]!.system).toContain("must rest on STORY BRIEF or a CANON NOTE");

    const without: typeof seen = [];
    await reviewPassage(input, DEFAULT_SETTINGS, provider({ seen: without }));
    expect(without[0]!.user).not.toContain("STORY BRIEF");
    expect(without[0]!.system).toContain("only for a contradiction inside the text you were shown");
  });

  it("talks in character unless asked not to, and never in dashes", async () => {
    const dashed = {
      quote: "It had stopped at 11:17.",
      category: "prose",
      kind: "craft",
      severity: "medium",
      confidence: 0.9,
      body: "Hm \u2014 the clock again. You did this on pages 3\u20134 \u2014 and it landed harder there \u2014.",
    };

    const seen: Array<{ system: string; user: string }> = [];
    const outcome = await reviewPassage(input, DEFAULT_SETTINGS, provider({ seen, comments: [dashed] }));

    expect(seen[0]!.system).toContain("HOW YOU TALK.");
    expect(seen[0]!.system).toContain("No em dashes and no en dashes");
    expect(outcome.comments[0]!.body).toBe(
      "Hm, the clock again. You did this on pages 3 to 4, and it landed harder there.",
    );

    const plain: typeof seen = [];
    await reviewPassage(input, settings((draft) => (draft.persona.inCharacter = false)), provider({ seen: plain }));
    expect(plain[0]!.system).not.toContain("HOW YOU TALK.");
    expect(plain[0]!.system).toContain("DO NOT SOUND MACHINE-WRITTEN");

    expect(normalizeSettings({}).persona.inCharacter).toBe(true);
    expect(normalizeSettings({ persona: { inCharacter: false } }).persona.inCharacter).toBe(false);
  });

  it("speaks about the whole story only with an outline of it, and only in fiction", async () => {
    const outline = "THE AUTHOR'S PLAN:\nMara never leaves the station.";
    const arc = {
      quote: "It had stopped at 11:17.",
      category: "arc",
      kind: "taste",
      severity: "low",
      confidence: 0.9,
      body: "The plan has the clock running until the last chapter. Is the plan changing?",
    };

    const seen: Array<{ system: string; user: string }> = [];
    const withOutline = await reviewPassage({ ...input, outline }, DEFAULT_SETTINGS, provider({ seen, comments: [arc] }));
    expect(seen[0]!.user).toContain("STORY OUTLINE");
    expect(seen[0]!.user).toContain("Mara never leaves the station.");
    expect(seen[0]!.system).toContain("- arc: how this passage bears on the shape of the whole story");
    expect(seen[0]!.system).toContain("must rest on STORY OUTLINE");
    expect(withOutline.comments.map((comment) => comment.category)).toEqual(["arc"]);

    // Without one she has nothing to rest it on, so it is neither offered nor accepted.
    const bare: typeof seen = [];
    const without = await reviewPassage(input, DEFAULT_SETTINGS, provider({ seen: bare, comments: [arc] }));
    expect(bare[0]!.system).not.toContain("arc");
    expect(without.comments).toEqual([]);

    const essay: typeof seen = [];
    await reviewPassage({ ...input, outline }, settings((draft) => (draft.persona.mode = "essay")), provider({ seen: essay }));
    expect(essay[0]!.user).not.toContain("STORY OUTLINE");

    const ignored: typeof seen = [];
    await reviewPassage(
      { ...input, outline },
      settings((draft) => (draft.ignoredCategories = ["arc"])),
      provider({ seen: ignored }),
    );
    expect(ignored[0]!.user).not.toContain("STORY OUTLINE");
  });
});

describe("talking back to her", () => {
  const comment: ReviewComment = {
    id: "c1",
    filePath: FILE,
    reviewerId: "lyra",
    category: "emotion",
    kind: "craft",
    severity: "medium",
    confidence: 0.8,
    anchor: createAnchor(SCENE, SCENE.indexOf("a sudden surge"), SCENE.indexOf(" and knew")),
    body: "The grief arrives with nothing leading to it.",
    status: "open",
    createdAt: 1,
    updatedAt: 1,
    sourceRevisionHash: "r",
    thread: [],
  };
  const about = { comment, documentTitle: "Chapter 08", documentText: SCENE };

  it("explains a comment from the passage as it is now", async () => {
    const seen: Array<{ system: string; user: string }> = [];
    const result = await explain(about, DEFAULT_SETTINGS, provider({ seen }));

    expect(result).toMatchObject({ status: "ok", value: { text: "Because of the two sentences before it." } });
    expect(seen[0]!.user).toContain("a sudden surge of grief");
    expect(seen[0]!.user).toContain("The grief arrives with nothing leading to it.");
    expect(seen[0]!.system).toContain("idle_laughing: amused, laughing");
    expect(seen[0]!.system).toContain('{"response": string, "reaction": string|null}');
    expect(result.status === "ok" && result.sent.userPrompt).toBe(seen[0]!.user);
  });

  it("parses a follow-up reaction while retaining text for invalid choices", async () => {
    const chosen = await explain(about, DEFAULT_SETTINGS, provider({ says: JSON.stringify({ response: "That lands well.", reaction: "idle_laughing" }) }));
    expect(chosen).toMatchObject({ status: "ok", value: { text: "That lands well.", reaction: "idle_laughing" } });
    const invalid = await explain(about, DEFAULT_SETTINGS, provider({ says: JSON.stringify({ response: "Try a different example.", reaction: "passive_reading_lying_down" }) }));
    expect(invalid).toMatchObject({ status: "ok", value: { text: "Try a different example." } });
  });

  it("answers a reply, and sends nothing for an empty one", async () => {
    const seen: Array<{ system: string; user: string }> = [];
    await reply(about, "  It is meant to be abrupt.  ", DEFAULT_SETTINGS, provider({ seen }));

    expect(seen[0]!.user).toContain("THE AUTHOR SAYS:\nIt is meant to be abrupt.");
    expect(seen[0]!.system).toContain("say so in a line and drop it");

    const empty = await reply(about, "   ", DEFAULT_SETTINGS, provider({ seen }));
    expect(empty.status).toBe("unavailable");
    expect(seen).toHaveLength(1);
  });

  it("offers an example in the author's voice, and says when it has none", async () => {
    const seen: Array<{ system: string; user: string }> = [];
    const shown = await example(about, DEFAULT_SETTINGS, provider({ seen, fix: "Her hand found the bench." }));

    expect(shown).toMatchObject({ status: "ok", value: { replacement: "Her hand found the bench." } });
    expect(seen[0]!.system).toContain("Preserve the author's voice");

    expect((await example(about, DEFAULT_SETTINGS, provider({ fix: "   " }))).status).toBe("unavailable");
  });

  it("will not discuss a passage that is no longer there", async () => {
    const seen: Array<{ system: string; user: string }> = [];
    const result = await explain(
      { ...about, documentText: "An entirely different scene now." },
      DEFAULT_SETTINGS,
      provider({ seen }),
    );

    expect(result.status).toBe("unavailable");
    expect(seen).toEqual([]);
  });

  it("lets an example be applied only where the passage still stands as it was", () => {
    const withExample = { ...comment, suggestedFix: { replacement: "Her hand found the bench.", generatedAt: 1 } };
    const at = SCENE.indexOf("a sudden surge");

    expect(exampleSpan(SCENE, withExample)).toEqual({ start: at, end: SCENE.indexOf(" and knew") });

    // The author wrote more above it: the passage is found where it now is.
    const moved = `A new opening line. ${SCENE}`;
    expect(exampleSpan(moved, withExample)?.start).toBe(at + "A new opening line. ".length);

    // The author rewrote the passage: there is nothing left for it to replace.
    expect(exampleSpan(SCENE.replace("a sudden surge of grief", "a slow ache"), withExample)).toBeNull();
    // And with no example, nothing to write at all.
    expect(exampleSpan(SCENE, comment)).toBeNull();
  });

  it("reports a provider failure as one, without throwing", async () => {
    const failing = {
      ...provider(),
      replyToComment: () => Promise.reject(new ProviderError("unauthorized", "no", false, 401)),
    };

    expect(await explain(about, DEFAULT_SETTINGS, failing)).toMatchObject({
      status: "failed",
      error: { code: "unauthorized" },
    });
  });
});

describe("the scene around the cursor", () => {
  const text = [
    "# One",
    "",
    "First scene, first paragraph.",
    "",
    "First scene, second paragraph.",
    "",
    "***",
    "",
    "Second scene, only paragraph.",
    "",
    "## Two",
    "",
    "Third scene.",
  ].join("\n");

  const scene = (needle: string, maxCharacters = 8000): string => {
    const bounds = sceneAround(text, text.indexOf(needle) + 3, { maxCharacters });
    return text.slice(bounds.start, bounds.end);
  };

  it("runs between scene breaks and headings, and a heading belongs to the scene it opens", () => {
    expect(scene("First scene, second")).toBe(
      "# One\n\nFirst scene, first paragraph.\n\nFirst scene, second paragraph.",
    );
    expect(scene("Second scene")).toBe("Second scene, only paragraph.");
    expect(scene("Third scene")).toBe("## Two\n\nThird scene.");
  });

  it("is the whole note when nothing divides it, minus the frontmatter", () => {
    const plain = "---\ntitle: x\n---\nJust one scene.\n\nStill the same scene.";
    const bounds = sceneAround(plain, plain.length - 2, { bodyStart: 17, maxCharacters: 8000 });

    expect(plain.slice(bounds.start, bounds.end)).toBe("Just one scene.\n\nStill the same scene.");
  });

  it("keeps to the limit around the cursor when a scene is too long, and says so", () => {
    const long = Array.from({ length: 60 }, (_, index) => `Paragraph ${index} of a very long scene.`).join("\n\n");
    const at = long.indexOf("Paragraph 30");
    const bounds = sceneAround(long, at, { maxCharacters: 400 });

    expect(bounds.truncated).toBe(true);
    expect(bounds.end - bounds.start).toBeLessThanOrEqual(400);
    expect(bounds.start).toBeLessThanOrEqual(at);
    expect(bounds.end).toBeGreaterThan(at);
  });
});

describe("where the API keys are kept", () => {
  function store(initial: Record<string, string> = {}): SecretStore & { secrets: Record<string, string> } {
    const secrets = { ...initial };
    return {
      secrets,
      getSecret: (id) => secrets[id] ?? null,
      setSecret: (id, secret) => {
        secrets[id] = secret;
      },
    };
  }

  it("moves a key found in the data file into the secret store, and reports that it did", () => {
    const secrets = store();
    const onDisk = settings((draft) => void (draft.providers.mistral.apiKey = "sk-from-the-data-file"));

    const loaded = withStoredKeys(onDisk, secrets);

    expect(loaded.migrated).toBe(true);
    expect(secrets.secrets[secretId("mistral")]).toBe("sk-from-the-data-file");
    expect(loaded.settings.providers.mistral.apiKey).toBe("sk-from-the-data-file");
  });

  it("moves fallback keys found in the data file into the secret store", () => {
    const secrets = store();
    const onDisk = settings((draft) => {
      draft.providers.gemini.fallbackKeys = ["g-second", "g-third"];
    });

    const loaded = withStoredKeys(onDisk, secrets);

    expect(loaded.migrated).toBe(true);
    expect(secrets.secrets[secretId("gemini", 1)]).toBe("g-second");
    expect(secrets.secrets[secretId("gemini", 2)]).toBe("g-third");
    expect(loaded.settings.providers.gemini.fallbackKeys).toEqual(["g-second", "g-third"]);
  });

  it("fills fallback keys in from the store, and clears unused slots when saving", () => {
    const secrets = store({
      [secretId("openai", 1)]: "sk-second",
      [secretId("openai", 2)]: "sk-third",
    });

    const loaded = withStoredKeys(DEFAULT_SETTINGS, secrets);
    expect(loaded.migrated).toBe(false);
    expect(loaded.settings.providers.openai.apiKey).toBe("");
    expect(loaded.settings.providers.openai.fallbackKeys).toEqual(["sk-second", "sk-third"]);

    const changed = settings((draft) => {
      draft.providers.openai.fallbackKeys = ["sk-new-second"];
    });
    const saved = forSaving(changed, secrets);

    expect(saved.providers.openai.fallbackKeys).toEqual([]);
    expect(secrets.secrets[secretId("openai", 1)]).toBe("sk-new-second");
    expect(secrets.secrets[secretId("openai", 2)]).toBe("");
    expect(secrets.secrets[secretId("openai", 3)]).toBe("");
  });

  it("fills keys in from the store, and saves the data file without them", () => {
    const secrets = store({ [secretId("anthropic")]: "sk-ant-stored" });

    const loaded = withStoredKeys(DEFAULT_SETTINGS, secrets);
    expect(loaded.migrated).toBe(false);
    expect(loaded.settings.providers.anthropic.apiKey).toBe("sk-ant-stored");

    const changed = settings((draft) => void (draft.providers.openai.apiKey = "sk-new"));
    const saved = forSaving(changed, secrets);

    expect(saved.providers.openai.apiKey).toBe("");
    expect(secrets.secrets[secretId("openai")]).toBe("sk-new");
    expect(changed.providers.openai.apiKey).toBe("sk-new");
  });

  it("leaves everything as it was where there is no secret store", () => {
    const withKey = settings((draft) => void (draft.providers.mistral.apiKey = "sk-plain"));

    expect(withStoredKeys(withKey, null)).toEqual({ settings: withKey, migrated: false });
    expect(forSaving(withKey, null)).toBe(withKey);
  });
});

describe("settings saved by an earlier version", () => {
  it("do not pin fiction to the old default instructions, which were saved as text", async () => {
    const { DEFAULT_ESSAY_FOCUS } = await import("../src/settings/settings");
    const old = normalizeSettings({ persona: { focus: DEFAULT_ESSAY_FOCUS } });

    expect(old.persona.focus).toBe("");
    expect(focusFor(old)).toContain("point of");
  });
});
