import { MarkdownView, normalizePath, Notice, Plugin, requireApiVersion, TFile, type Editor } from "obsidian";

import {
  buildTalkPrompt,
  clip,
  lookupText,
  parseTalkReply,
  TALK_TOKEN_BUDGET,
  TalkStore,
  type TalkMessage,
  type TalkOutcome,
  type TalkScope,
} from "./talk/talk";
import { withoutDashes } from "./utils/text";

import { resolveAnchor } from "./comments/anchor-resolver";
import { applyResolution, withStatus } from "./comments/comment-state";
import type { CompanionLine } from "./companion/lines";
import { EMBEDDED_ASSETS } from "./companion/embedded-assets";
import {
  BRIEF_FILE_NAME,
  COMMENTS_FILE_NAME,
  FRONTMATTER_OPT_OUT_KEY,
  MAX_SELECTION_CHARACTERS,
  PLUGIN_ID,
} from "./constants";
import { BRIEF_TEMPLATE, briefPathsFor, isBrief, newBriefPathFor, storyContext } from "./context/brief";
import { EditorMarks } from "./editor/marks";
import { AnthropicProvider } from "./providers/anthropic-provider";
import { MistralProvider } from "./providers/mistral-provider";
import { OpenAIProvider } from "./providers/openai-provider";
import type { ProviderRequestConfig } from "./providers/provider";
import { describeProviderError, toProviderError } from "./providers/provider-errors";
import { ProviderRegistry } from "./providers/provider-registry";
import { obsidianTransport } from "./providers/transport";
import { example, exampleSpan, explain, reply, type InteractionResult } from "./review/interactions";
import type { RenderedPrompt } from "./review/prompt-builder";
import { mergeReview, reviewPassage, voiceOf } from "./review/review";
import { sceneAround } from "./review/scene";
import {
  ReviewScheduler,
  type LiveReviewJob,
  type LiveReviewResult,
  type SchedulerState,
} from "./review/review-scheduler";
import { redactKnownSecrets } from "./privacy/redaction";
import { forSaving, withStoredKeys, type SecretStore } from "./settings/keys";
import { normalizeSettings, providerApiKeys, type LyraSettings } from "./settings/settings";
import { LyraSettingTab } from "./settings/settings-tab";
import { NoteStore } from "./store";
import type { CommentCategory, ProviderId, ReviewComment } from "./types";
import { DIGEST_TOKEN_BUDGET } from "./story/facts";
import { StoryKeeper } from "./story/keeper";
import { briefPathOf, isStoryNote, notesFolderOf } from "./story/novel";
import { showSent, type SentRecord } from "./ui/sent-modal";
import { Companion, type Ask, type CompanionActivity } from "./ui/window";
import { debounce } from "./utils/debounce";
import { createId } from "./utils/ids";
import { Logger } from "./utils/logger";
import { hashText } from "./utils/hash";

/** How long after the last save stored anchors are checked against the text. */
const REANCHOR_DELAY_MS = 1_500;

/** The canon excerpts a review may carry. */
type ReviewContextNotes = NonNullable<Parameters<typeof reviewPassage>[0]["canon"]>;

/** Findings from a passage read in the background, as opposed to one she was asked about. */
const LIVE_FINDINGS = 1;

/** A sidebar narrower than this is closed, or too small for her to stand in. */
const MINIMUM_SIDEBAR_WIDTH = 200;

/** Failures the author has to act on. A background review reports nothing else. */
const ACTIONABLE = new Set(["missing_key", "unauthorized", "quota", "model_not_found"]);

export default class LyraPlugin extends Plugin {
  private readonly logger = new Logger(PLUGIN_ID, "warn");

  /** Named `prefs` because the base class keeps `settings` for itself. */
  prefs!: LyraSettings;
  providers!: ProviderRegistry;
  companion!: Companion;

  private store!: NoteStore;
  private keeper!: StoryKeeper;
  private talks!: TalkStore;
  /** The note the author was last writing in, kept for when another pane has the focus. */
  private lastNotePath: string | null = null;
  private marks!: EditorMarks;
  private scheduler!: ReviewScheduler;
  /** True while a review the author asked for is running. */
  private asking = false;
  /** She has been told to stop reading along for now. Not remembered across restarts. */
  private paused = false;
  /** The last thing sent to a provider, kept so the author can look at it. */
  private lastSent: SentRecord | null = null;

  private readonly reanchorSoon = debounce((filePath: string) => this.reanchor(filePath), REANCHOR_DELAY_MS);

  override async onload(): Promise<void> {
    const loaded = withStoredKeys(normalizeSettings(await this.loadData()), this.secretStore());
    this.prefs = loaded.settings;
    // A key found in the data file has just been moved to the secret store, so
    // the file is written again without it.
    if (loaded.migrated) await this.saveData(forSaving(this.prefs, this.secretStore()));

    const adapter = this.app.vault.adapter;
    const commentsPath = normalizePath(`${this.pluginDirectory()}/${COMMENTS_FILE_NAME}`);
    this.store = new NoteStore(
      {
        read: async () => ((await adapter.exists(commentsPath)) ? adapter.read(commentsPath) : null),
        write: (contents) => adapter.write(commentsPath, contents),
      },
      (problem) => this.logger.warn(problem),
    );
    await this.store.load();

    this.providers = new ProviderRegistry(() => this.prefs.provider);
    const deps = (id: ProviderId) => ({
      config: () => this.providerConfig(id),
      transport: obsidianTransport,
      logger: this.logger,
    });
    this.providers.register(new MistralProvider(deps("mistral")));
    this.providers.register(new OpenAIProvider(deps("openai")));
    this.providers.register(new AnthropicProvider(deps("anthropic")));

    this.keeper = new StoryKeeper({
      hasBrief: (folder) =>
        this.app.vault.getAbstractFileByPath(
          normalizePath(`${folder}/${BRIEF_FILE_NAME}`).replace(/^\//, ""),
        ) instanceof TFile,
      notesIn: (folder) =>
        this.app.vault
          .getMarkdownFiles()
          .filter((note) => (note.parent?.path === "/" ? "" : (note.parent?.path ?? "")) === folder)
          // A chapter marked to be left alone is not read into her notes either.
          .filter((note) => !this.optedOut(note))
          .map((note) => note.path),
      read: async (path) => {
        const note = this.app.vault.getAbstractFileByPath(path);
        return note instanceof TFile ? this.app.vault.cachedRead(note) : null;
      },
      writeNote: (path, text) => this.writeNote(path, text),
      readState: async (path) => ((await adapter.exists(path)) ? adapter.read(path) : null),
      writeState: async (path, text) => {
        await this.ensureFolder(path.slice(0, path.lastIndexOf("/")));
        await adapter.write(path, text);
      },
      digest: async (prompt) => {
        const sent = this.withoutKeys(prompt);
        this.remember(
          sent.userPrompt.includes("CHAPTERS SO FAR")
            ? "Her record of the chapters, for the outline"
            : "A chapter, for her story notes",
          sent,
        );
        return this.providers.require(this.prefs.provider).replyToComment({ ...sent, maxTokens: DIGEST_TOKEN_BUDGET });
      },
      mayRead: () => this.prefs.story.keepNotes && !this.paused && this.hasKey(),
      onBusy: (busy) => this.companion.setActivity(busy ? "reading" : "idle"),
      onBacklog: (novel, unread) =>
        new Notice(
          `${this.prefs.companion.name} has not read ${unread} chapters of ${novel.split("/").pop() || "this novel"}. Run “Lyra: Read the whole novel into her notes” to have her read them (${unread} requests).`,
          12000,
        ),
      onProblem: (what) => this.logger.warn(what),
    });
    this.register(() => this.keeper.stop());

    this.talks = new TalkStore({
      read: async (path) => ((await adapter.exists(path)) ? adapter.read(path) : null),
      write: async (path, text) => {
        await this.ensureFolder(path.slice(0, path.lastIndexOf("/")));
        await adapter.write(path, text);
      },
    });
    this.scheduler = new ReviewScheduler({
      getSettings: () => this.prefs,
      snapshot: (filePath) => this.snapshot(filePath),
      runReview: (job) => this.reviewChangedPassage(job),
      logger: this.logger,
      onState: (state) => this.companion.setActivity(activityOf(state)),
    });

    this.marks = new EditorMarks({
      getComments: (filePath) => this.store.comments(filePath),
      underline: () => this.prefs.underline,
      onSelect: (_filePath, commentId) => this.companion.showComment(commentId),
      onEdit: (report) => {
        this.companion.noteTyped();
        this.scheduler.noteChanged(report);
      },
      onCursor: (report) => this.scheduler.cursorMoved(report),
    });
    this.registerEditorExtension(this.marks.extension());

    this.companion = new Companion({
      host: () => this.companionHost(),
      corner: () => this.editorCorner(),
      getSettings: () => this.prefs,
      activePath: () => this.activeFile()?.path ?? null,
      getComments: (filePath) => this.store.comments(filePath),
      assetUrl: (relativePath) => this.assetUrl(relativePath),
      showPassage: (filePath, line) => this.showPassage(filePath, line),
      setStatus: (filePath, commentId, status) => this.setStatus(filePath, commentId, status),
      eraseComments: (filePath) => {
        this.store.set(filePath, []);
        this.marks.refresh();
      },
      selectionLength: () => this.activeEditor()?.getSelection().trim().length ?? 0,
      setWidth: (width) =>
        void this.updateSettings((draft) => {
          draft.companion.width = width;
        }),
      reviewSelection: () => void this.reviewSelection(),
      reviewScene: () => void this.reviewScene(),
      ask: (filePath, commentId, request) => this.ask(filePath, commentId, request),
      copy: (text) => {
        void navigator.clipboard.writeText(text);
      },
      applyExample: (filePath, commentId) => this.applyExample(filePath, commentId),
      focusEditor: () => this.activeEditor()?.focus(),
      ignoreCategory: (category) => this.ignoreCategory(category as CommentCategory),
      isPaused: () => this.paused,
      togglePause: () => this.togglePause(),
      talk: {
        scope: () => this.talkScope(),
        history: (scope) => this.talks.load(scope.path),
        say: (scope, text) => this.say(scope, text),
        clear: (scope) => this.talks.clear(scope.path),
      },
      reducedMotion: () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    });

    this.addSettingTab(new LyraSettingTab(this.app, this));
    this.registerCommands();
    this.registerEvents();

    this.app.workspace.onLayoutReady(() => {
      this.companion.start();
      this.followEditorArea();
    });

    this.register(() => this.companion.stop());
    this.register(() => this.scheduler.cancelAll());
    this.register(() => this.reanchorSoon.cancel());
  }

  override onunload(): void {
    void this.store?.flush();
  }

  /** Changes settings, saves them, and lets everything that reads them catch up. */
  async updateSettings(mutate: (draft: LyraSettings) => void): Promise<void> {
    const draft = structuredClone(this.prefs);
    mutate(draft);
    this.prefs = normalizeSettings(draft);
    await this.saveData(forSaving(this.prefs, this.secretStore()));

    this.scheduler.settingsChanged();
    this.marks.refresh();
    this.companion.refresh();
  }

  providerConfig(id: ProviderId): ProviderRequestConfig {
    const provider = this.prefs.providers[id];
    const apiKeys = providerApiKeys(provider);

    return {
      apiKey: apiKeys[0] ?? "",
      apiKeys,
      model: provider.model,
      ...(provider.baseUrl === undefined ? {} : { baseUrl: provider.baseUrl }),
      timeoutMs: this.prefs.advanced.requestTimeoutMs,
      maxRetries: this.prefs.advanced.maxRetries,
      retryInitialDelayMs: this.prefs.advanced.retryInitialDelayMs,
    };
  }

  /** Reads the selection because the author asked. Called by the command and by her window. */
  async reviewSelection(): Promise<void> {
    const view = this.activeView();
    const file = view?.file ?? null;
    const name = this.prefs.companion.name;

    if (view === null || file === null) {
      new Notice("Open a note first.");
      return;
    }

    const editor = view.editor;
    const selection = editor.getSelection();
    if (selection.trim().length === 0) {
      new Notice(`Select the text you want ${name} to read.`);
      return;
    }
    if (selection.length > MAX_SELECTION_CHARACTERS) {
      new Notice(
        `That is ${selection.length.toLocaleString()} characters. ${name} reads up to ${MAX_SELECTION_CHARACTERS.toLocaleString()} at a time.`,
      );
      return;
    }
    await this.readAloud(
      file,
      editor.getValue(),
      editor.posToOffset(editor.getCursor("from")),
      editor.posToOffset(editor.getCursor("to")),
      "A selection",
    );
  }

  /**
   * Reads the scene the cursor is in: what lies between the nearest headings or
   * scene breaks. For when the author wants a wider look than one passage.
   */
  async reviewScene(): Promise<void> {
    const view = this.activeView();
    const file = view?.file ?? null;
    if (view === null || file === null) {
      new Notice("Open a note first.");
      return;
    }

    const editor = view.editor;
    const text = editor.getValue();
    const scene = sceneAround(text, editor.posToOffset(editor.getCursor("head")), {
      ...this.bodyStart(file),
      maxCharacters: MAX_SELECTION_CHARACTERS,
    });

    if (scene.end <= scene.start) {
      new Notice("There is nothing in this scene to read yet.");
      return;
    }
    if (scene.truncated) {
      new Notice(
        `This scene is long, so ${this.prefs.companion.name} is reading the ${MAX_SELECTION_CHARACTERS.toLocaleString()} characters around your cursor.`,
        6000,
      );
    }

    await this.readAloud(file, text, scene.start, scene.end, "A scene");
  }

  /** One reading the author asked for, of one stretch of a note. */
  private async readAloud(file: TFile, text: string, start: number, end: number, purpose: string): Promise<void> {
    if (this.optedOut(file)) {
      new Notice(
        isBrief(file.path)
          ? "This is a story brief. It tells her about the story, and is not itself read."
          : `This note has ${FRONTMATTER_OPT_OUT_KEY}: false in its frontmatter.`,
      );
      return;
    }
    if (this.asking) return;

    this.asking = true;
    this.scheduler.manualReviewStarted(file.path);
    this.companion.setActivity("reading");

    try {
      const outcome = await reviewPassage(
        {
          filePath: file.path,
          documentTitle: file.basename,
          documentText: text,
          start,
          end,
          ...this.bodyStart(file),
          existing: this.store.comments(file.path),
          ...(await this.story(file, around(text, start, end))),
        },
        this.prefs,
        this.providers.require(this.prefs.provider),
      );

      this.remember(purpose, outcome.sent);
      this.companion.setActivity("idle");
      this.applyReview(file.path, text, outcome, true);
      if (outcome.comments.length === 0) this.companion.reviewEnded(file.path, "nothing-found");
    } catch (error) {
      const providerError = toProviderError(error);
      this.logger.warn("review failed", {
        code: providerError.code,
        status: providerError.status,
      });

      this.companion.setActivity("error");
      this.companion.reviewEnded(file.path, "could-not-review");
      new Notice(describeProviderError(providerError, this.prefs.provider), 8000);
      window.setTimeout(() => this.companion.setActivity("idle"), 6000);
    } finally {
      this.asking = false;
      this.scheduler.manualReviewFinished(file.path);
    }
  }

  /** Reads a passage the author changed, on the scheduler's word. Silent throughout. */
  private async reviewChangedPassage(job: LiveReviewJob): Promise<LiveReviewResult> {
    if (!this.prefs.liveReview.enabled || this.paused) return "skipped";
    if (job.signal.aborted) return "cancelled";

    const file = this.app.vault.getAbstractFileByPath(job.filePath);
    if (!(file instanceof TFile) || file.extension !== "md" || this.optedOut(file)) return "skipped";

    try {
      const outcome = await reviewPassage(
        {
          filePath: file.path,
          documentTitle: file.basename,
          documentText: job.documentText,
          start: job.range.from,
          end: job.range.to,
          ...this.bodyStart(file),
          existing: this.store.comments(file.path),
          limit: LIVE_FINDINGS,
          ...(await this.story(file, around(job.documentText, job.range.from, job.range.to))),
        },
        this.prefs,
        this.providers.require(this.prefs.provider),
        job.signal,
      );

      // The author edited the passage while it was being read: what came back
      // describes text that no longer exists, so it is dropped, not placed.
      if (job.signal.aborted) return "cancelled";

      this.remember("A passage you had just written", outcome.sent);
      this.applyReview(file.path, job.documentText, outcome);
      return "reviewed";
    } catch (error) {
      if (job.signal.aborted) return "cancelled";

      const providerError = toProviderError(error);
      this.logger.warn("live review failed", {
        code: providerError.code,
        status: providerError.status,
      });

      if (ACTIONABLE.has(providerError.code)) {
        new Notice(describeProviderError(providerError, this.prefs.provider), 8000);
      }
      return "failed";
    }
  }

  /** Stores what a review found and shows it, in the note and in her window. */
  private applyReview(
    filePath: string,
    reviewedText: string,
    outcome: Awaited<ReturnType<typeof reviewPassage>>,
    /** True for a reading the author asked for, whose result they are waiting to see. */
    asked = false,
  ): void {
    let comments = mergeReview(this.store.comments(filePath), outcome, reviewedText);

    // The author may have kept writing while the request was out.
    const current = this.marks.text(filePath);
    if (current !== null && current !== reviewedText) comments = reanchored(comments, current);

    this.store.set(filePath, comments);
    this.marks.refresh();
    this.companion.commentsChanged(filePath, asked);
  }

  private setStatus(filePath: string, commentId: string, status: "open" | "resolved" | "dismissed"): void {
    this.store.set(
      filePath,
      this.store
        .comments(filePath)
        .map((comment) => (comment.id === commentId ? withStatus(comment, status) : comment)),
    );
    this.marks.refresh();
    this.companion.commentsChanged(filePath);
  }

  /**
   * The brief for a note's story, and the canon notes that brief links to. Read
   * fresh each time: they are small, and the author may have just changed them.
   */
  private async story(
    file: TFile,
    passage: string,
  ): Promise<{ brief?: string; canon?: ReviewContextNotes; outline?: string }> {
    try {
      const context = await storyContext(
        file.path,
        {
          read: async (path) => {
            const note = this.app.vault.getAbstractFileByPath(path);
            return note instanceof TFile ? this.app.vault.cachedRead(note) : null;
          },
          resolveLink: (target, fromPath) =>
            this.app.metadataCache.getFirstLinkpathDest(target, fromPath)?.path ?? null,
        },
        passage,
      );

      // The author's canon first, then what she has recorded from earlier chapters.
      const canon = [
        ...context.canon,
        ...(this.prefs.story.keepNotes ? await this.keeper.context(file.path, passage) : []),
        // And what those chapters actually say, where it bears on this passage.
        ...(await this.keeper.earlier(file.path, passage)),
      ];

      const outline = this.prefs.story.keepNotes ? await this.keeper.outline(file.path) : undefined;

      return {
        ...(context.brief === undefined ? {} : { brief: context.brief }),
        ...(canon.length === 0 ? {} : { canon }),
        ...(outline === undefined ? {} : { outline }),
      };
    } catch {
      // A brief that cannot be read must not cost the author their review.
      return {};
    }
  }

  /** Reads every chapter of the current novel that has changed since she last read it. */
  async readNovel(): Promise<void> {
    const file = this.activeFile();
    const novel = file === null ? null : this.keeper.novelOf(file.path);
    const name = this.prefs.companion.name;

    if (novel === null) {
      new Notice("This note is not in a novel. A novel is a folder with a story brief in it.");
      return;
    }
    if (!this.hasKey()) {
      new Notice(`Add an API key in ${name}'s settings first.`);
      return;
    }

    const unread = await this.keeper.unread(novel);
    if (unread.length === 0) {
      // Nothing to send, but a renamed or removed chapter may still need writing up.
      await this.keeper.update(novel);
      new Notice(`${name}'s notes on this novel are up to date.`);
      return;
    }

    const progress = new Notice(`${name} is reading ${unread.length} chapter${unread.length === 1 ? "" : "s"}…`, 0);
    const result = await this.keeper.update(novel, {
      onProgress: (done, total) => progress.setMessage(`${name} is reading chapter ${done + 1} of ${total}…`),
    });
    progress.hide();

    new Notice(
      result.failed === 0
        ? `${name} read ${result.read} chapter${result.read === 1 ? "" : "s"}. Her notes are in “${notesFolderOf(novel)}”.`
        : `${name} read ${result.read} and could not read ${result.failed}. Run this again to retry those.`,
      8000,
    );
  }

  /** The note the author was last in, remembered for when no note has the focus. */
  private noteInHand(): string | null {
    const path = this.activeView()?.file?.path;
    if (path !== undefined) this.lastNotePath = path;
    return this.lastNotePath;
  }

  /**
   * Which conversation the author is in. Each note has its own, so what was said
   * about one chapter is not carried into talk about another.
   */
  private talkScope(): TalkScope {
    const note = this.noteInHand();
    if (note === null) return { path: normalizePath(`${this.pluginDirectory()}/talk.json`), title: "No note open" };

    return { path: this.talkPathOf(note), title: note.split("/").pop()?.replace(/[.]md$/i, "") || "This note" };
  }

  /** Where a note's conversation is kept: with her notes for a novel, beside the plugin otherwise. */
  private talkPathOf(note: string): string {
    const novel = this.keeper.novelOf(note);
    const folder = novel === null ? `${this.pluginDirectory()}/talks` : `${notesFolderOf(novel)}/talks`;
    return normalizePath(`${folder}/${hashText(note)}.json`);
  }

  /** A renamed note keeps its conversation. */
  private async moveTalk(oldPath: string, newPath: string): Promise<void> {
    const from = this.talkPathOf(oldPath);
    const to = this.talkPathOf(newPath);
    if (from === to) return;

    const history = await this.talks.load(from);
    if (history.length === 0) return;

    await this.talks.add(to, ...history);
    this.talks.forget(from);
    await this.app.vault.adapter.remove(from);
  }

  /**
   * Says something to her about the story and keeps both sides of it. What she
   * is given is what a review would give her, looked up by what was said, but
   * for the whole novel: this is the author's view of it, not a reader's.
   */
  private async say(scope: TalkScope, text: string): Promise<TalkOutcome> {
    if (!this.hasKey())
      return { ok: false, reason: `Add an API key in ${this.prefs.companion.name}'s settings first.` };

    const note = this.noteInHand();
    const novel = note === null ? null : this.keeper.novelOf(note);
    const history = await this.talks.load(scope.path);
    const lookup = lookupText(history, text);

    // Seen from the brief, every chapter is an earlier one.
    const from = novel === null ? note : briefPathOf(novel);
    const file = from === null ? null : this.app.vault.getAbstractFileByPath(note ?? from);
    const story = file instanceof TFile ? await this.story(file, lookup) : {};
    const whole =
      novel === null || from === null
        ? (story.canon ?? [])
        : [
            ...(story.canon ?? []).filter((entry) => entry.reason === "wikilink"),
            ...(this.prefs.story.keepNotes ? await this.keeper.context(from, lookup) : []),
            ...(await this.keeper.earlier(from, lookup)),
          ];

    const prompt = this.withoutKeys(
      buildTalkPrompt({
        name: this.prefs.companion.name,
        voice: voiceOf(this.prefs),
        ...(novel === null ? {} : { novelTitle: novel.split("/").pop() || "Untitled" }),
        ...(story.brief === undefined ? {} : { brief: story.brief }),
        ...(story.outline === undefined ? {} : { outline: story.outline }),
        notes: whole,
        ...this.openInFront(note),
        history,
        message: text,
      }),
    );
    this.remember("Talking with her about the story", prompt);

    try {
      const raw = await this.providers
        .require(this.prefs.provider)
        .replyToComment({ ...prompt, maxTokens: TALK_TOKEN_BUDGET });
      // Lines of dialogue, each held to the same rule as anything else she says.
      const segments = parseTalkReply(raw).map((line) => ({ ...line, text: withoutDashes(line.text) }));
      if (segments.length === 0) return { ok: false, reason: "She had nothing to say to that. Try again." };

      const mine: TalkMessage = { who: "author", text: clip(text), at: Date.now() };
      const reply: TalkMessage = {
        who: "lyra",
        text: segments.map((line) => line.text).join(" "),
        segments,
        at: Date.now(),
      };
      await this.talks.add(scope.path, mine, reply);
      return { ok: true, reply };
    } catch (error) {
      return { ok: false, reason: describeProviderError(toProviderError(error)) };
    }
  }

  /** What the author has in front of them: what they selected, or the text around the cursor. */
  private openInFront(note: string | null): { open?: { title: string; text: string; selected: boolean } } {
    const editor = note === null ? null : this.editorFor(note);
    const file = note === null ? null : this.app.vault.getAbstractFileByPath(note);
    if (editor === null || !(file instanceof TFile) || this.optedOut(file)) return {};

    const selection = editor.getSelection();
    if (selection.trim().length > 0) return { open: { title: file.basename, text: selection, selected: true } };

    const all = editor.getValue();
    // Frontmatter is never sent.
    const body = /^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/.exec(all)?.[0].length ?? 0;
    const at = editor.posToOffset(editor.getCursor());
    const text = all.slice(Math.max(body, at - 3500), Math.max(body, at + 1500));

    return text.trim().length === 0 ? {} : { open: { title: file.basename, text, selected: false } };
  }

  /** Opens the notes she keeps on the current novel, at the outline. */
  async openStoryNotes(): Promise<void> {
    const file = this.activeFile();
    const novel = file === null ? null : this.keeper.novelOf(file.path);
    const note = novel === null ? null : this.app.vault.getAbstractFileByPath(`${notesFolderOf(novel)}/Outline.md`);

    if (note instanceof TFile) await this.app.workspace.getLeaf("tab").openFile(note);
    else new Notice("She has no notes on this novel yet. Run “Lyra: Read the whole novel into her notes”.");
  }

  /** Writes one of her own notes, creating it and its folder as needed. */
  private async writeNote(path: string, text: string): Promise<void> {
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing instanceof TFile) {
      await this.app.vault.modify(existing, text);
      return;
    }

    await this.ensureFolder(path.slice(0, path.lastIndexOf("/")));
    await this.app.vault.create(path, text);
  }

  private async ensureFolder(folder: string): Promise<void> {
    if (folder.length === 0 || this.app.vault.getAbstractFileByPath(folder) !== null) return;
    try {
      await this.app.vault.createFolder(folder);
    } catch {
      // Made by someone else in the meantime, which is all that was wanted.
    }
  }

  private hasKey(): boolean {
    return providerApiKeys(this.prefs.providers[this.prefs.provider]).length > 0;
  }

  /** A prompt with any of the author's own API keys taken out of it. */
  private withoutKeys(prompt: RenderedPrompt): RenderedPrompt {
    const keys = Object.values(this.prefs.providers).flatMap((entry) => providerApiKeys(entry));
    return {
      systemPrompt: redactKnownSecrets(prompt.systemPrompt, keys),
      userPrompt: redactKnownSecrets(prompt.userPrompt, keys),
    };
  }

  /** Opens the brief that applies to the current note, starting one beside it if there is none. */
  async openBrief(): Promise<void> {
    const file = this.activeFile();
    if (file === null) {
      new Notice("Open a note in the story first.");
      return;
    }

    const existing = briefPathsFor(file.path)
      .reverse()
      .map((path) => this.app.vault.getAbstractFileByPath(path))
      .find((note): note is TFile => note instanceof TFile);

    try {
      const brief = existing ?? (await this.app.vault.create(newBriefPathFor(file.path), BRIEF_TEMPLATE));
      await this.app.workspace.getLeaf("tab").openFile(brief);
      if (existing === undefined) new Notice(`Started ${BRIEF_FILE_NAME} beside this note.`);
    } catch {
      new Notice("Could not create the brief.");
    }
  }

  /** Why?, Discuss and Example: one question about one comment, and what comes of it. */
  private async ask(filePath: string, commentId: string, request: Ask): Promise<boolean> {
    const comment = this.store.comments(filePath).find((entry) => entry.id === commentId);
    const text = this.marks.text(filePath);
    const file = this.app.vault.getAbstractFileByPath(filePath);

    if (comment === undefined || text === null || !(file instanceof TFile)) {
      new Notice("Open the note to talk about that comment.");
      return false;
    }

    const about = {
      comment,
      documentTitle: file.basename,
      documentText: text,
      ...this.bodyStart(file),
    };
    const provider = this.providers.require(this.prefs.provider);
    const now = Date.now();
    const said = (role: "user" | "reviewer", words: string) => ({
      id: createId("message"),
      role,
      text: words.trim(),
      createdAt: now,
    });

    if (request.kind === "example") {
      const result = await example(about, this.prefs, provider);
      if (!this.heard(result, "An example")) return false;

      this.amend(filePath, commentId, (entry) => ({
        ...entry,
        suggestedFix: result.value,
      }));
      return true;
    }

    const result =
      request.kind === "why"
        ? await explain(about, this.prefs, provider)
        : await reply(about, request.text, this.prefs, provider);
    if (!this.heard(result, request.kind === "why" ? "Asking why" : "Your reply")) return false;

    // The author's words are kept with her answer, so the exchange reads whole.
    this.amend(filePath, commentId, (entry) => ({
      ...entry,
      thread: [
        ...entry.thread,
        ...(request.kind === "reply" ? [said("user", request.text)] : []),
        { ...said("reviewer", result.value.text), ...(result.value.reaction === undefined ? {} : { reaction: result.value.reaction }) },
      ],
    }));
    return true;
  }

  /**
   * Writes a comment's example over the passage it is about.
   *
   * The one place the plugin changes the author's text, so the most careful: the
   * passage is found again in the note as it is at this moment, it must still be
   * what the example was written for, and only that range is replaced. It goes
   * through the editor, so Ctrl+Z takes it back like any typing.
   */
  private applyExample(filePath: string, commentId: string): boolean {
    const comment = this.store.comments(filePath).find((entry) => entry.id === commentId);
    const replacement = comment?.suggestedFix?.replacement;
    const editor = this.editorFor(filePath);

    if (comment === undefined || replacement === undefined || editor === null) {
      new Notice("Open the note to apply that.");
      return false;
    }

    const span = exampleSpan(editor.getValue(), comment);
    if (span === null) {
      new Notice("That passage has changed since the example was written. Ask for a new one.", 8000);
      return false;
    }

    editor.replaceRange(replacement, editor.offsetToPos(span.start), editor.offsetToPos(span.end));

    // Taking her suggestion answers the point she made.
    this.setStatus(filePath, commentId, "resolved");
    return true;
  }

  /** The editor showing a note, whichever pane it is in, or null when it is not open. */
  private editorFor(filePath: string): Editor | null {
    const active = this.activeView();
    if (active?.file?.path === filePath) return active.editor;

    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      if (leaf.view instanceof MarkdownView && leaf.view.file?.path === filePath) return leaf.view.editor;
    }
    return null;
  }

  /** Says why an exchange produced nothing, and narrows it to one that did. */
  private heard<T>(
    result: InteractionResult<T>,
    purpose: string,
  ): result is Extract<InteractionResult<T>, { status: "ok" }> {
    if (result.status === "ok") {
      this.remember(purpose, result.sent);
      return true;
    }

    new Notice(
      result.status === "unavailable" ? result.reason : describeProviderError(result.error, this.prefs.provider),
      8000,
    );
    return false;
  }

  private amend(filePath: string, commentId: string, change: (comment: ReviewComment) => ReviewComment): void {
    this.store.set(
      filePath,
      this.store.comments(filePath).map((comment) => (comment.id === commentId ? change(comment) : comment)),
    );
    this.companion.commentsChanged(filePath);
  }

  /** Stops her raising one kind of finding. Undone from settings. */
  private ignoreCategory(category: CommentCategory): void {
    void this.updateSettings((draft) => {
      if (!draft.ignoredCategories.includes(category)) draft.ignoredCategories.push(category);
    });
    new Notice(
      `${this.prefs.companion.name} will not mention ${category} again. You can change that in her settings.`,
      6000,
    );
  }

  /** Stops, or resumes, reading along. Asking her directly still works while paused. */
  togglePause(): void {
    this.paused = !this.paused;
    if (this.paused) this.scheduler.cancelAll();
    this.companion.refresh();

    const name = this.prefs.companion.name;
    new Notice(
      this.paused
        ? `${name} has stopped reading along. Press the moon in her window, or run this again, to resume.`
        : this.prefs.liveReview.enabled
          ? `${name} is reading along again.`
          : `${name} is no longer paused, but reading along is turned off in her settings.`,
      5000,
    );
  }

  private remember(purpose: string, sent: RenderedPrompt | undefined): void {
    if (sent === undefined) return;

    this.lastSent = {
      purpose,
      provider: this.prefs.provider,
      model: this.prefs.providers[this.prefs.provider].model,
      at: Date.now(),
      ...sent,
    };
  }

  /**
   * Obsidian's secret store, where this version has one. Keys are kept there
   * rather than in the plugin's own data file whenever they can be.
   */
  private secretStore(): SecretStore | null {
    if (!requireApiVersion("1.11.4")) return null;

    const store = (this.app as { secretStorage?: SecretStore }).secretStorage;
    return store !== undefined && typeof store.getSecret === "function" ? store : null;
  }

  /** Brings stored positions back in line with the text, after a save. */
  private reanchor(filePath: string): void {
    const existing = this.store.comments(filePath);
    const text = this.marks.text(filePath);
    if (existing.length === 0 || text === null) return;

    const updated = reanchored(existing, text);
    if (updated.every((comment, index) => comment === existing[index])) return;

    const statusChanged = updated.some((comment, index) => comment.status !== existing[index]?.status);
    this.store.set(filePath, updated);

    // Comments that merely followed the text look the same everywhere.
    if (statusChanged) {
      this.marks.refresh();
      this.companion.commentsChanged(filePath);
    }
  }

  /**
   * Scrolls the note to what one of her lines is about and lights it up for a
   * moment. The cursor and the selection are left exactly where they were.
   */
  private showPassage(filePath: string, line: CompanionLine): void {
    const text = this.marks.text(filePath);
    const comment = this.store.comments(filePath).find((entry) => entry.id === line.id);

    if (text !== null && comment !== undefined) {
      const resolution = resolveAnchor(text, comment.anchor);
      if (resolution.status === "resolved" && this.marks.flash(filePath, resolution.start, resolution.end)) {
        return;
      }
    }

    new Notice("That passage has changed and could not be found.");
  }

  private registerCommands(): void {
    this.addCommand({
      id: "review-selection",
      name: "Ask about the selection",
      editorCallback: () => void this.reviewSelection(),
    });

    this.addCommand({
      id: "review-scene",
      name: "Read the scene I am in",
      editorCallback: () => void this.reviewScene(),
    });

    this.addCommand({
      id: "open-brief",
      name: "Open the story brief for this folder",
      callback: () => void this.openBrief(),
    });

    this.addCommand({
      id: "read-novel",
      name: "Read the whole novel into her notes",
      callback: () => void this.readNovel(),
    });

    this.addCommand({
      id: "open-story-notes",
      name: "Open her notes on this novel",
      callback: () => void this.openStoryNotes(),
    });

    this.addCommand({
      id: "toggle-pause",
      name: "Pause or resume reading along",
      callback: () => this.togglePause(),
    });

    this.addCommand({
      id: "show-sent",
      name: "Show what was last sent",
      callback: () => {
        if (this.lastSent === null) new Notice("Nothing has been sent yet this session.");
        else showSent(this.app, this.lastSent);
      },
    });

    this.addCommand({
      id: "show-latest",
      name: "Show what she last said",
      callback: () => this.companion.showLatest(),
    });

    this.addCommand({
      id: "talk",
      name: "Talk with her about the story",
      callback: () => this.companion.enterTalk(),
    });

    this.addCommand({
      id: "toggle-live",
      name: "Toggle reading along as I write",
      callback: () => {
        const enabled = !this.prefs.liveReview.enabled;
        void this.updateSettings((draft) => {
          draft.liveReview.enabled = enabled;
        });
        new Notice(
          enabled
            ? `${this.prefs.companion.name} will read along as you write.`
            : `${this.prefs.companion.name} will wait to be asked.`,
        );
      },
    });
  }

  private registerEvents(): void {
    const { workspace, vault } = this.app;

    this.registerEvent(
      workspace.on("editor-menu", (menu, editor: Editor) => {
        if (editor.getSelection().trim().length === 0) return;

        menu.addItem((item) =>
          item
            .setTitle(`Ask ${this.prefs.companion.name} about this`)
            .setIcon("message-square-quote")
            .onClick(() => void this.reviewSelection()),
        );
      }),
    );

    // Her window lives in the editor area, which Obsidian rebuilds when the
    // layout changes, and it follows whichever note has the author's attention.
    this.registerEvent(workspace.on("active-leaf-change", () => this.companion.refresh()));
    this.registerEvent(workspace.on("layout-change", () => this.companion.refresh()));
    this.registerEvent(
      workspace.on("file-open", () => {
        this.marks.refresh();
        this.companion.refresh();
        this.noteInHand();
      }),
    );

    this.registerEvent(
      vault.on("modify", (file) => {
        if (!(file instanceof TFile) || file.extension !== "md") return;
        // Her own notes changing is her doing, and nothing follows from it.
        if (isStoryNote(file.path)) return;

        this.reanchorSoon.call(file.path);
        this.keeper.noteChanged(file.path);
      }),
    );

    this.registerEvent(
      vault.on("rename", (file, oldPath) => {
        if (!(file instanceof TFile)) return;
        this.scheduler.forget(oldPath);
        this.store.rename(oldPath, file.path);
        void this.moveTalk(oldPath, file.path)
          .catch((error: unknown) => this.logger.warn("Could not move a conversation with a renamed note", { error: String(error) }))
          .then(() => this.companion.refresh());
        this.companion.refresh();
        // A renamed chapter keeps its record; her notes are rewritten to link to its new name.
        if (file.extension === "md" && !isStoryNote(file.path)) this.keeper.noteChanged(file.path);
      }),
    );

    this.registerEvent(
      vault.on("delete", (file) => {
        if (!(file instanceof TFile)) return;
        this.scheduler.forget(file.path);
        this.store.delete(file.path);
      }),
    );
  }

  /** The text and frontmatter bounds of an open note, for the scheduler. */
  private snapshot(filePath: string): { text: string; bodyStart?: number } | null {
    const text = this.marks.text(filePath);
    if (text === null) return null;

    const file = this.app.vault.getAbstractFileByPath(filePath);
    return { text, ...(file instanceof TFile ? this.bodyStart(file) : {}) };
  }

  private bodyStart(file: TFile): { bodyStart?: number } {
    const end = this.app.metadataCache.getFileCache(file)?.frontmatterPosition?.end.offset;
    return end === undefined ? {} : { bodyStart: end };
  }

  /** A note says `lyra: false` in its frontmatter to be left alone. */
  private optedOut(file: TFile): boolean {
    // A brief is about the story. It is not part of it.
    if (isBrief(file.path)) return true;
    // Nor are the notes she keeps on it.
    if (isStoryNote(file.path)) return true;

    const value: unknown = this.app.metadataCache.getFileCache(file)?.frontmatter?.[FRONTMATTER_OPT_OUT_KEY];
    if (typeof value === "boolean") return !value;
    return typeof value === "string" && ["false", "no", "off"].includes(value.trim().toLowerCase());
  }

  /**
   * The note the author is writing in. Her window never takes focus, but a
   * sidebar might have it, so the most recent editor is the fallback.
   */
  private activeView(): MarkdownView | null {
    const focused = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (focused !== null) return focused;

    const recent = this.app.workspace.getMostRecentLeaf();
    return recent?.view instanceof MarkdownView ? recent.view : null;
  }

  private activeEditor(): Editor | null {
    return this.activeView()?.editor ?? null;
  }

  private activeFile(): TFile | null {
    return this.activeView()?.file ?? this.app.workspace.getActiveFile();
  }

  private pluginDirectory(): string {
    return this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${PLUGIN_ID}`;
  }

  /**
   * She is attached to the page itself, above the whole app, rather than inside
   * the editor area: Obsidian lays out everything in that area as a pane, and
   * squeezes anything else put there into a sliver of a column.
   */
  private companionHost(): HTMLElement | null {
    return (this.app.workspace.containerEl as HTMLElement | undefined)?.ownerDocument.body ?? null;
  }

  /** The editor area, looked up each time: Obsidian replaces it when the layout changes. */
  private editorArea(): HTMLElement | null {
    const workspace = this.app.workspace.containerEl as HTMLElement | undefined;
    return workspace?.querySelector<HTMLElement>(".workspace-split.mod-root") ?? workspace ?? null;
  }

  private rightSidebar(): HTMLElement | null {
    const workspace = this.app.workspace.containerEl as HTMLElement | undefined;
    return workspace?.querySelector<HTMLElement>(".workspace-split.mod-right-split") ?? null;
  }

  /**
   * The part of the app she stands in: the right sidebar when that is where the
   * author wants her and it is open wide enough to hold her, and the editor area
   * otherwise. A closed sidebar has no width, and she must not vanish with it.
   */
  private standingArea(): HTMLElement | null {
    if (this.prefs.companion.place === "sidebar") {
      const sidebar = this.rightSidebar();
      if (sidebar !== null && sidebar.getBoundingClientRect().width >= MINIMUM_SIDEBAR_WIDTH) {
        return sidebar;
      }
    }

    return this.editorArea();
  }

  /**
   * Where the bottom-right corner of her standing area is, measured from the app
   * window's edges, and how wide that area is.
   */
  private editorCorner(): {
    right: number;
    bottom: number;
    width: number;
  } | null {
    const area = this.standingArea();
    if (area === null) return null;

    const rect = area.getBoundingClientRect();
    const page = area.ownerDocument.documentElement;
    let bottom = page.clientHeight - rect.bottom;

    // The status bar lies over the bottom of whatever is beneath it. Where it
    // crosses her area she stands on top of it, not behind it.
    const status = area.ownerDocument.querySelector<HTMLElement>(".status-bar");
    const bar = status?.getBoundingClientRect();
    if (bar !== undefined && bar.height > 0 && bar.right > rect.left && bar.left < rect.right) {
      bottom = Math.max(bottom, page.clientHeight - bar.top);
    }

    return { right: page.clientWidth - rect.right, bottom, width: rect.width };
  }

  /**
   * Keeps her lined up as the editor area changes size: a sidebar opening, a
   * divider being dragged, the app window being resized.
   */
  private followEditorArea(): void {
    const observer = new ResizeObserver(() => this.companion.place());
    let watched: Array<HTMLElement | null> = [];

    // Both are watched whichever she stands in: opening or closing the sidebar
    // is what moves her from one to the other.
    const watch = (): void => {
      const areas = [this.editorArea(), this.rightSidebar()];
      if (areas.some((area, index) => area !== watched[index])) {
        observer.disconnect();
        for (const area of areas) if (area !== null) observer.observe(area);
        watched = areas;
      }
      this.companion.place();
    };

    watch();
    this.registerEvent(this.app.workspace.on("layout-change", watch));
    this.registerEvent(this.app.workspace.on("resize", watch));
    this.register(() => observer.disconnect());
  }

  /** Embedded image data for a scene asset. */
  private assetUrl(relativePath: string): string | null {
    return EMBEDDED_ASSETS[relativePath] ?? null;
  }
}

/** A passage with enough either side of it to tell who and where it is about. */
function around(text: string, start: number, end: number): string {
  return text.slice(Math.max(0, start - 1500), Math.min(text.length, end + 500));
}

function activityOf(state: SchedulerState): CompanionActivity {
  if (state === "reviewing") return "reading";
  return state === "waiting" ? "waiting" : "idle";
}

/** Every comment moved onto where its passage is in this text. */
function reanchored(comments: readonly ReviewComment[], text: string): ReviewComment[] {
  return comments.map((comment) => applyResolution(comment, resolveAnchor(text, comment.anchor)));
}
