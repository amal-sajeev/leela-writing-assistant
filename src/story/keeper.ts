import type { RenderedPrompt } from "../review/prompt-builder";
import type { RetrievedContext } from "../types";
import { hashText } from "../utils/hash";
import { joinVaultPath, pathBasename } from "../utils/paths";
import {
  buildDigestPrompt,
  chapterFactsSchema,
  mergeFacts,
  parseChapterFacts,
  splitChapter,
  STORY_DIGEST_PROMPT_VERSION,
  type ChapterFacts,
} from "./facts";
import {
  correctionsIn,
  emptyState,
  knownNames,
  NOTE_FILES,
  relevantNotes,
  renderNote,
  STORY_STATE_VERSION,
  type ChapterCheckpoint,
  type NoteFile,
  type StoryState,
} from "./notes";
import { briefPathOf, chapterName, inReadingOrder, isChapterOf, novelFor, notesFolderOf } from "./novel";
import { ChapterSearch } from "./search";
import {
  buildOutlinePrompt,
  OUTLINE_FILE,
  outlineForReview,
  parseOutline,
  planIn,
  renderOutline,
} from "./outline";

/** Refreshes chapter notes through injected vault and provider dependencies. */

export interface KeeperDeps {
  /** True when a folder has a story brief in it, which is what makes it a novel. */
  hasBrief(folder: string): boolean;
  /** Paths of the Markdown notes directly inside a folder. */
  notesIn(folder: string): string[];
  /** A note's text, or null when there is none at that path. */
  read(path: string): Promise<string | null>;
  /** Writes one of her notes, creating it and its folder as needed. */
  writeNote(path: string, text: string): Promise<void>;
  /** Her record, kept as a file beside the notes so it travels with the vault. */
  readState(path: string): Promise<string | null>;
  writeState(path: string, text: string): Promise<void>;
  /** Sends one chapter to be recorded, or her record to be outlined, and resolves to the reply. */
  digest(prompt: RenderedPrompt): Promise<string>;
  /** Changes to the provider model invalidate partial chapter digests. */
  modelId?(): string;
  /** False while she has been told not to read along, or has no way to. */
  mayRead(): boolean;
  /** Told when she starts and stops reading chapters, for her window. */
  onBusy?(busy: boolean): void;
  /** Told about a novel with more unread chapters than she will read unasked. */
  onBacklog?(novel: string, unread: number): void;
  onProblem?(what: string): void;
  timers?: { setTimeout(run: () => void, ms: number): unknown; clearTimeout(handle: unknown): void };
  now?(): number;
}

/** How long a chapter is left alone before she reads it again. */
export const QUIET_BEFORE_READING_MS = 3 * 60_000;

/**
 * Chapters she will read by herself in one go. More than this is a novel she
 * has not read yet, and that is for the author to start.
 */
export const UNASKED_CHAPTERS = 3;

/** Shorter than this is a stub: a title, a note to self. Nothing to record. */
const MINIMUM_CHAPTER_CHARACTERS = 400;

const STATE_FILE = "story.json";

export class StoryKeeper {
  private readonly states = new Map<string, StoryState>();
  private readonly readOnly = new Set<string>();
  private readonly chapterTexts = new Map<string, string>();
  private readonly timers = new Map<string, unknown>();
  private readonly reading = new Set<string>();
  private readonly told = new Set<string>();
  /** Novels whose record has changed in memory and not yet been written out. */
  private readonly unsaved = new Set<string>();
  private readonly search = new ChapterSearch();

  constructor(private readonly deps: KeeperDeps) {}

  /** The novel a note belongs to, or null. */
  novelOf(filePath: string): string | null {
    return novelFor(filePath, (folder) => this.deps.hasBrief(folder));
  }

  /** A note changed. If it is a chapter, she reads it once it has been left alone. */
  noteChanged(filePath: string): void {
    this.invalidateChapter(filePath);
    const novel = this.novelOf(filePath);
    if (novel === null || !isChapterOf(novel, filePath)) return;

    const clock = this.deps.timers ?? SYSTEM_TIMERS;
    const pending = this.timers.get(novel);
    if (pending !== undefined) clock.clearTimeout(pending);

    this.timers.set(
      novel,
      clock.setTimeout(() => {
        this.timers.delete(novel);
        void this.update(novel, { unasked: true });
      }, QUIET_BEFORE_READING_MS),
    );
  }

  /** Stops anything waiting to happen. Called on unload. */
  stop(): void {
    const clock = this.deps.timers ?? SYSTEM_TIMERS;
    for (const handle of this.timers.values()) clock.clearTimeout(handle);
    this.timers.clear();
    this.chapterTexts.clear();
    this.search.clear();
  }

  invalidateChapter(path: string): void {
    this.chapterTexts.delete(path);
  }

  /** Chapters she has not read, or that have changed since she did, in reading order. */
  async unread(novel: string): Promise<string[]> {
    const state = await this.load(novel);
    await this.follow(novel, state);
    const changed: string[] = [];

    for (const path of this.chapters(novel)) {
      const text = await this.deps.read(path);
      if (text === null || bodyOf(text).length < MINIMUM_CHAPTER_CHARACTERS) continue;
      if (state.chapters[path]?.hash !== hashText(text)) changed.push(path);
    }

    return changed;
  }

  /**
   * Reads the chapters that need it and rewrites her notes.
   *
   * `unasked` is how she behaves on her own: a few chapters at most, and none at
   * all while paused. Asked, she reads everything that has changed.
   */
  async update(
    novel: string,
    options: { unasked?: boolean; onProgress?: (done: number, total: number) => void } = {},
  ): Promise<{ read: number; failed: number; waiting: number }> {
    if (this.reading.has(novel)) return { read: 0, failed: 0, waiting: 0 };
    if (options.unasked === true && !this.deps.mayRead()) return { read: 0, failed: 0, waiting: 0 };

    this.reading.add(novel);
    let read = 0;
    let failed = 0;
    let waiting = 0;
    let busy = false;
    const justRead: string[] = [];

    try {
      const state = await this.load(novel);
      if (this.readOnly.has(novel)) return { read: 0, failed: 0, waiting: 0 };
      // Renamed chapters are followed first, so they are not forgotten and read again.
      let unread = await this.unread(novel);
      this.forget(novel, state);

      if (options.unasked === true && unread.length > UNASKED_CHAPTERS) {
        waiting = unread.length;
        // Said once a session, not every time a chapter is saved.
        if (!this.told.has(novel)) {
          this.told.add(novel);
          this.deps.onBacklog?.(novel, unread.length);
        }
        unread = [];
      }

      if (unread.length > 0) {
        busy = true;
        this.deps.onBusy?.(true);
      }
      const brief = (await this.deps.read(briefPathOf(novel))) ?? undefined;

      for (const [index, path] of unread.entries()) {
        options.onProgress?.(index, unread.length);

        const text = await this.deps.read(path);
        if (text === null) continue;

        try {
          // A long chapter is read in parts, each told the names the ones before it used.
          const parts = splitChapter(bodyOf(text));
          const recorded: ChapterFacts[] = [];
          const characters = new Set(knownNames(state, "characters"));
          const places = new Set(knownNames(state, "places"));
          const checkpoint = this.checkpointFor(state, path, text, parts.length);
          state.checkpoints ??= {};
          state.checkpoints[path] = checkpoint;
          await this.deps.writeState(this.statePath(novel), JSON.stringify(state));

          for (const [at, part] of parts.entries()) {
            const saved = checkpoint.completedParts[at];
            if (saved !== null && saved !== undefined) {
              recorded.push(saved);
              for (const entry of saved.characters) characters.add(entry.name);
              for (const entry of saved.places) places.add(entry.name);
              continue;
            }

            const reply = await this.deps.digest(
              buildDigestPrompt({
                novelTitle: pathBasename(novel) || "Untitled",
                chapterTitle: chapterName(path),
                chapterText: part,
                ...(brief === undefined ? {} : { brief: bodyOf(brief) }),
                knownCharacters: [...characters],
                knownPlaces: [...places],
                ...(parts.length === 1 ? {} : { part: { number: at + 1, of: parts.length } }),
              }),
            );

            const facts = parseChapterFacts(reply);
            for (const entry of facts.characters) characters.add(entry.name);
            for (const entry of facts.places) places.add(entry.name);
            recorded.push(facts);
            checkpoint.completedParts[at] = facts;
            await this.deps.writeState(this.statePath(novel), JSON.stringify(state));
          }

          state.chapters[path] = {
            hash: hashText(text),
            readAt: (this.deps.now ?? Date.now)(),
            facts: mergeFacts(recorded),
          };
          delete state.checkpoints?.[path];
          read += 1;
          justRead.push(path);
        } catch {
          // One chapter she could not read must not cost the others, or what
          // she already has. It stays unread, and is tried again next time.
          failed += 1;
          this.deps.onProblem?.(`could not read ${chapterName(path)} into the story notes`);
        }
      }

      // Asked, she also outlines a novel she read before she kept an outline.
      const recorded = Object.keys(state.chapters).length > 0;
      if (read > 0 || (recorded && state.outline === undefined && options.unasked !== true)) {
        if (!busy) {
          busy = true;
          this.deps.onBusy?.(true);
        }
        if (await this.outlineAgain(novel, state, justRead, brief)) this.unsaved.add(novel);
      }

      if (read > 0 || this.unsaved.has(novel)) {
        await this.deps.writeState(this.statePath(novel), JSON.stringify(state));
        await this.writeNotes(novel, state);
        this.unsaved.delete(novel);
      }
    } finally {
      this.reading.delete(novel);
      // Only when she said she had started: a review may be using her window.
      if (busy) this.deps.onBusy?.(false);
    }

    return { read, failed, waiting };
  }

  /** What she knows that bears on a passage of a note, for a review of it. */
  async context(filePath: string, text: string): Promise<RetrievedContext[]> {
    const novel = this.novelOf(filePath);
    if (novel === null) return [];

    const state = await this.load(novel);
    const corrections: Partial<Record<NoteFile, string>> = {};
    for (const file of NOTE_FILES) {
      corrections[file] = correctionsIn(await this.deps.read(this.notePath(novel, file)));
    }

    return relevantNotes({ novel, state, filePath, text, corrections });
  }

  /**
   * What earlier chapters actually say that a passage has most to do with: a few
   * stretches of their text, found by shared words. Read from the chapters as
   * they are now, so it needs no notes and is never out of date.
   */
  async earlier(filePath: string, text: string): Promise<RetrievedContext[]> {
    const novel = this.novelOf(filePath);
    if (novel === null) return [];

    const ordered = this.chapters(novel);
    const at = ordered.indexOf(filePath);
    const before = at < 0 ? ordered : ordered.slice(0, at);

    const chapters: Array<{ path: string; text: string }> = [];
    for (const path of before) {
      const chapter = await this.chapterText(path);
      if (chapter !== null) chapters.push({ path, text: chapter });
    }

    return this.search.find(chapters, text);
  }

  /** The shape of the whole story, and the author's plan for it, for a review of a note in it. */
  async outline(filePath: string): Promise<string | undefined> {
    const novel = this.novelOf(filePath);
    if (novel === null) return undefined;

    const state = await this.load(novel);
    return outlineForReview(planIn(await this.deps.read(this.outlinePath(novel))), state.outline);
  }

  /**
   * Writes the outline again from her record of every chapter, and has her say
   * what the chapters just read changed. One request. True when it was done:
   * failing leaves the outline she had, which is only a reading out of date.
   */
  private async outlineAgain(
    novel: string,
    state: StoryState,
    justRead: readonly string[],
    brief: string | undefined,
  ): Promise<boolean> {
    const fresh = new Set(justRead);
    const before = state.outline;

    try {
      const reply = await this.deps.digest(
        buildOutlinePrompt({
          novelTitle: pathBasename(novel) || "Untitled",
          ...(brief === undefined ? {} : { brief: bodyOf(brief) }),
          plan: planIn(await this.deps.read(this.outlinePath(novel))),
          ...(before === undefined
            ? {}
            : { previous: { premise: before.premise, movements: before.movements, owed: before.owed } }),
          chapters: inReadingOrder(Object.keys(state.chapters)).map((path) => ({
            name: chapterName(path),
            facts: state.chapters[path]!.facts,
            justRead: fresh.has(path),
          })),
        }),
      );

      state.outline = { ...parseOutline(reply), after: inReadingOrder(justRead).map(chapterName) };
      return true;
    } catch {
      this.deps.onProblem?.("could not write the story outline");
      return false;
    }
  }

  private chapters(novel: string): string[] {
    return inReadingOrder(this.deps.notesIn(novel).filter((path) => isChapterOf(novel, path)));
  }

  private async chapterText(path: string): Promise<string | null> {
    const cached = this.chapterTexts.get(path);
    if (cached !== undefined) return cached;
    const raw = await this.deps.read(path);
    if (raw === null) return null;
    const text = bodyOf(raw);
    this.chapterTexts.set(path, text);
    return text;
  }

  private checkpointFor(
    state: StoryState,
    path: string,
    text: string,
    partCount: number,
  ): ChapterCheckpoint {
    const existing = state.checkpoints?.[path];
    const sourceHash = hashText(text);
    const modelId = this.deps.modelId?.() ?? "default";
    if (
      existing !== undefined &&
      existing.sourceHash === sourceHash &&
      existing.modelId === modelId &&
      existing.promptVersion === STORY_DIGEST_PROMPT_VERSION &&
      existing.partCount === partCount &&
      existing.completedParts.length === partCount
    ) {
      return existing;
    }

    return {
      sourceHash,
      modelId,
      promptVersion: STORY_DIGEST_PROMPT_VERSION,
      partCount,
      completedParts: Array.from({ length: partCount }, () => null),
    };
  }

  /** Drops what she recorded from chapters that are no longer there. */
  private forget(novel: string, state: StoryState): void {
    const present = new Set(this.chapters(novel));

    for (const path of Object.keys(state.chapters)) {
      if (present.has(path)) continue;
      delete state.chapters[path];
      this.unsaved.add(novel);
    }
  }

  /**
   * Follows chapters that were renamed or moved, the novel's own folder
   * included: a chapter she has no record of, whose text is exactly that of one
   * that is gone, is that chapter under its new name. Nothing is sent.
   */
  private async follow(novel: string, state: StoryState): Promise<void> {
    const present = this.chapters(novel);
    const here = new Set(present);

    const gone = new Map<string, string>();
    for (const [path, record] of Object.entries(state.chapters)) {
      if (!here.has(path)) gone.set(record.hash, path);
    }
    if (gone.size === 0) return;

    for (const path of present) {
      if (state.chapters[path] !== undefined) continue;

      const text = await this.deps.read(path);
      const from = text === null ? undefined : gone.get(hashText(text));
      if (from === undefined || text === null) continue;

      state.chapters[path] = state.chapters[from]!;
      delete state.chapters[from];
      gone.delete(hashText(text));
      this.unsaved.add(novel);
    }
  }

  private async writeNotes(novel: string, state: StoryState): Promise<void> {
    for (const file of NOTE_FILES) {
      const path = this.notePath(novel, file);
      const existing = await this.deps.read(path);
      const next = renderNote(file, state, existing);
      // Left alone when nothing in it changed, so a save does not touch five files.
      if (next !== existing) await this.deps.writeNote(path, next);
    }

    const path = this.outlinePath(novel);
    const existing = await this.deps.read(path);
    const next = renderOutline(state.outline, existing);
    if (next !== existing) await this.deps.writeNote(path, next);
  }

  private async load(novel: string): Promise<StoryState> {
    const cached = this.states.get(novel);
    if (cached !== undefined) return cached;

    let state = emptyState();
    try {
      const raw = await this.deps.readState(this.statePath(novel));
      if (raw !== null) {
        const parsed: unknown = JSON.parse(raw);
        if (isRecord(parsed) && (parsed.version === 1 || parsed.version === STORY_STATE_VERSION) && validChapters(parsed.chapters)) {
          state = {
            version: STORY_STATE_VERSION,
            chapters: parsed.chapters,
            ...(validCheckpoints(parsed.checkpoints) ? { checkpoints: parsed.checkpoints } : {}),
            ...(validOutline(parsed.outline) ? { outline: parsed.outline } : {}),
          };
        } else {
          this.readOnly.add(novel);
          this.deps.onProblem?.("the story record is unreadable or newer, so it has been left untouched");
        }
      }
    } catch {
      this.readOnly.add(novel);
      this.deps.onProblem?.("the story record could not be read, so it has been left untouched");
    }

    this.states.set(novel, state);
    return state;
  }

  private notePath(novel: string, file: NoteFile): string {
    return joinVaultPath(notesFolderOf(novel), `${file}.md`);
  }

  private outlinePath(novel: string): string {
    return joinVaultPath(notesFolderOf(novel), `${OUTLINE_FILE}.md`);
  }

  private statePath(novel: string): string {
    return joinVaultPath(notesFolderOf(novel), STATE_FILE);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validChapters(value: unknown): value is StoryState["chapters"] {
  if (!isRecord(value)) return false;
  return Object.values(value).every((entry) =>
    isRecord(entry) &&
    typeof entry.hash === "string" &&
    typeof entry.readAt === "number" &&
    chapterFactsSchema.safeParse(entry.facts).success,
  );
}

function validOutline(value: unknown): value is NonNullable<StoryState["outline"]> {
  if (!isRecord(value)) return false;
  return (
    typeof value.premise === "string" &&
    Array.isArray(value.movements) &&
    Array.isArray(value.owed) &&
    Array.isArray(value.changed) &&
    Array.isArray(value.after)
  );
}

function validCheckpoints(value: unknown): value is Record<string, ChapterCheckpoint> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return Object.values(value as Record<string, unknown>).every((entry) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return false;
    const checkpoint = entry as Record<string, unknown>;
    return (
      typeof checkpoint.sourceHash === "string" &&
      typeof checkpoint.modelId === "string" &&
      typeof checkpoint.promptVersion === "number" &&
      typeof checkpoint.partCount === "number" &&
      Array.isArray(checkpoint.completedParts) &&
      checkpoint.completedParts.length === checkpoint.partCount &&
      checkpoint.completedParts.every((part) => part === null || chapterFactsSchema.safeParse(part).success)
    );
  });
}

/** A note without its frontmatter, which is never sent. */
function bodyOf(text: string): string {
  const match = /^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  return (match === null ? text : text.slice(match[0].length)).trim();
}

const SYSTEM_TIMERS = {
  setTimeout: (run: () => void, ms: number): unknown => setTimeout(run, ms),
  clearTimeout: (handle: unknown): void => clearTimeout(handle as ReturnType<typeof setTimeout>),
};
