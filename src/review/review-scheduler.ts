import type { CursorReport, EditorChangeReport } from "../editor/change-summary";
import {
  LIVE_REVIEW_FAILURE_COOLDOWN_MS,
  MAX_CONCURRENT_PROVIDER_REQUESTS,
} from "../constants";
import type { AIReviewerSettings } from "../settings/settings";
import type { Logger } from "../utils/logger";
import { DocumentSession } from "./document-session";
import { reviewability, selectReviewRange, unionOf, type DirtyRange } from "./dirty-ranges";

/** Schedules reviews: one per note, a vault-wide concurrency cap, stale-result drops, manual priority. */

export interface DocumentSnapshot {
  text: string;
  /** Offset after any frontmatter, which is never reviewed. */
  bodyStart?: number;
}

export interface LiveReviewJob {
  filePath: string;
  /** The revision the review is performed against, and anchored to. */
  documentText: string;
  range: DirtyRange;
  signal: AbortSignal;
  generation: number;
}

export type LiveReviewResult = "reviewed" | "skipped" | "cancelled" | "failed";

export type SchedulerState = "idle" | "waiting" | "reviewing";

/** Injectable so tests can drive time instead of waiting for it. */
export interface SchedulerTimers {
  setTimeout(handler: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  now(): number;
}

export interface ReviewSchedulerDeps {
  getSettings: () => AIReviewerSettings;
  /** Text of an open note, read only once the pause has elapsed. */
  snapshot: (filePath: string) => DocumentSnapshot | null;
  runReview: (job: LiveReviewJob) => Promise<LiveReviewResult>;
  logger: Logger;
  onState?: (state: SchedulerState) => void;
  timers?: SchedulerTimers;
}

/** Notes remembered before the ones with nothing pending are let go. */
const MAX_REMEMBERED_NOTES = 32;

/** How long to wait before trying again when the vault is already busy. */
const BUSY_RETRY_MS = 750;

/** Shorter pause once a paragraph is finished, when the reader asked for that. */
const PARAGRAPH_BREAK_DELAY_MS = 600;

const SYSTEM_TIMERS: SchedulerTimers = {
  setTimeout: (handler, ms) => setTimeout(handler, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
};

export class ReviewScheduler {
  private readonly sessions = new Map<string, DocumentSession>();
  private readonly timers = new Map<string, unknown>();
  private readonly reviewing = new Map<string, { range: DirtyRange; generation: number }>();
  private readonly clock: SchedulerTimers;
  private inFlight = 0;
  /** Manual reviews in progress. A count, since a refused second one also reports finishing. */
  private manualRunning = 0;
  private state: SchedulerState = "idle";

  constructor(private readonly deps: ReviewSchedulerDeps) {
    this.clock = deps.timers ?? SYSTEM_TIMERS;
  }

  /**
   * Called for every edit. This is the typing path: record the offsets, restart
   * the timer, return. Everything else waits.
   */
  noteChanged(report: EditorChangeReport): void {
    const session = this.session(report.filePath);

    session.record({
      ranges: report.ranges,
      mapPosition: report.mapPosition,
      ...(report.paragraphCompleted ? { paragraphCompleted: true } : {}),
      at: report.at,
    });

    // An edit to the passage being reviewed makes that review obsolete.
    const active = this.reviewing.get(report.filePath);
    if (active !== undefined && report.ranges.some((range) => overlaps(range, active.range))) {
      session.abortRequest();
      this.reviewing.delete(report.filePath);
      this.deps.logger.debug("live review superseded by an edit", { filePath: report.filePath });
    }

    if (!this.liveEnabled()) return;
    this.arm(report.filePath, this.delayFor(session));
  }

  cursorMoved(report: CursorReport): void {
    const session = this.sessions.get(report.filePath);
    if (session === undefined) return;

    const wasCompleted = session.paragraphCompleted;
    session.moveCursor(report);

    // Leaving a changed passage is the author saying they are done with it.
    if (!wasCompleted && session.paragraphCompleted && this.liveEnabled()) {
      this.arm(report.filePath, this.delayFor(session));
    }
  }

  /** Obsidian reports a save as a vault modification; review then if asked to. */
  noteSaved(filePath: string): void {
    if (!this.liveEnabled()) return;
    if (!this.deps.getSettings().liveReview.reviewOnSave) return;

    const session = this.sessions.get(filePath);
    if (session === undefined || !session.hasDirtyText) return;

    session.markParagraphCompleted();
    this.arm(filePath, 0);
  }

  /** A manual review takes the note over: its background review stands aside. */
  manualReviewStarted(filePath: string): void {
    this.manualRunning += 1;

    const session = this.sessions.get(filePath);
    session?.abortRequest();
    this.reviewing.delete(filePath);
    this.clearTimer(filePath);
  }

  manualReviewFinished(filePath: string): void {
    this.manualRunning = Math.max(0, this.manualRunning - 1);

    // A manual review covers what the author just changed there.
    this.sessions.get(filePath)?.clearDirty();

    // Another manual review is still going: it re-arms the notes when it ends.
    if (this.manualRunning > 0) return;
    if (!this.liveEnabled()) return;
    const debounceMs = this.deps.getSettings().liveReview.debounceMs;
    for (const [path, session] of this.sessions) {
      if (session.hasDirtyText) this.arm(path, debounceMs);
    }
  }

  /** Live review was turned on or off, or the plugin was disabled. */
  settingsChanged(): void {
    if (this.liveEnabled()) return;
    this.cancelAll();
  }

  /** A note was closed, renamed or deleted. */
  forget(filePath: string): void {
    this.clearTimer(filePath);
    this.sessions.get(filePath)?.abortRequest();
    this.sessions.delete(filePath);
    this.reviewing.delete(filePath);
    this.publishState();
  }

  cancelAll(): void {
    for (const filePath of [...this.timers.keys()]) this.clearTimer(filePath);
    for (const session of this.sessions.values()) session.abortRequest();
    this.reviewing.clear();
    this.publishState();
  }

  /** True while a pause is being waited out or a live review is running. */
  get pending(): boolean {
    return this.timers.size > 0 || this.inFlight > 0;
  }

  private session(filePath: string): DocumentSession {
    const existing = this.sessions.get(filePath);
    if (existing !== undefined) return existing;

    if (this.sessions.size >= MAX_REMEMBERED_NOTES) this.forgetIdleNotes();

    const created = new DocumentSession(filePath);
    this.sessions.set(filePath, created);
    return created;
  }

  /**
   * Drops notes with nothing pending: no unreviewed change, no request, no timer
   * and no cooldown. Nothing says when a note is closed, so without this every
   * note edited since startup would be remembered until Obsidian quit.
   */
  private forgetIdleNotes(): void {
    const now = this.clock.now();

    for (const [filePath, session] of this.sessions) {
      const idle =
        !session.hasDirtyText &&
        !session.isReviewing &&
        !session.isStoodDown(now) &&
        !this.timers.has(filePath);

      if (idle) this.sessions.delete(filePath);
    }
  }

  private liveEnabled(): boolean {
    const settings = this.deps.getSettings();
    return settings.enabled && settings.liveReview.enabled;
  }

  /**
   * How long to wait before reviewing. A finished paragraph is a clear signal
   * that the author has moved on, so it need not wait out the full pause — only
   * long enough that a second thought lands first.
   */
  private delayFor(session: DocumentSession): number {
    const live = this.deps.getSettings().liveReview;
    if (!session.paragraphCompleted || !live.reviewOnParagraphBreak) return live.debounceMs;

    return Math.min(PARAGRAPH_BREAK_DELAY_MS, live.debounceMs);
  }

  private arm(filePath: string, delayMs: number): void {
    this.clearTimer(filePath);

    const handle = this.clock.setTimeout(() => {
      this.timers.delete(filePath);
      void this.review(filePath);
    }, delayMs);

    this.timers.set(filePath, handle);
    this.publishState();
  }

  private clearTimer(filePath: string): void {
    const handle = this.timers.get(filePath);
    if (handle === undefined) return;

    this.clock.clearTimeout(handle);
    this.timers.delete(filePath);
  }

  private async review(filePath: string): Promise<void> {
    const settings = this.deps.getSettings();
    const session = this.sessions.get(filePath);

    if (!this.liveEnabled() || session === undefined || !session.hasDirtyText) {
      this.publishState();
      return;
    }

    // A manual review is running: wait for it rather than queue behind it.
    if (this.manualRunning > 0) {
      this.arm(filePath, settings.liveReview.debounceMs);
      return;
    }

    if (session.isStoodDown(this.clock.now())) {
      this.publishState();
      return;
    }

    // One live request per note. The one in flight will re-arm as it finishes.
    if (session.isReviewing) {
      this.arm(filePath, BUSY_RETRY_MS);
      return;
    }

    if (this.inFlight >= MAX_CONCURRENT_PROVIDER_REQUESTS) {
      this.arm(filePath, BUSY_RETRY_MS);
      return;
    }

    const snapshot = this.deps.snapshot(filePath);
    if (snapshot === null) {
      this.publishState();
      return;
    }

    const decision = this.decide(session, snapshot, settings);
    if (decision === null) {
      this.publishState();
      return;
    }

    await this.send(session, snapshot, decision);
  }

  /** The passage to review, or null when nothing is worth sending yet. */
  private decide(
    session: DocumentSession,
    snapshot: DocumentSnapshot,
    settings: AIReviewerSettings,
  ): DirtyRange | null {
    const changed = unionOf(session.dirtyRanges);
    if (changed === null) return null;

    const verdict = reviewability({
      text: snapshot.text,
      range: changed,
      minimumCharacters: settings.liveReview.minimumChangedCharacters,
      paragraphCompleted: session.paragraphCompleted,
      includeFencedCode: settings.context.includeFencedCode,
      ...(snapshot.bodyStart === undefined ? {} : { bodyStart: snapshot.bodyStart }),
    });

    if (!verdict.ok) {
      this.deps.logger.debug("live review skipped", {
        filePath: session.filePath,
        reason: verdict.reason,
      });
      return null;
    }

    if (this.midSentence(session, snapshot, settings, changed)) {
      this.deps.logger.debug("live review waiting for the sentence to end", {
        filePath: session.filePath,
      });
      return null;
    }

    return selectReviewRange({
      text: snapshot.text,
      ranges: session.dirtyRanges,
      maximumCharacters: settings.liveReview.maximumChangedCharacters,
      preferred: session.latestRange,
      ...(snapshot.bodyStart === undefined ? {} : { bodyStart: snapshot.bodyStart }),
    });
  }

  /**
   * True when the author is in the middle of a sentence in the passage they
   * changed. Criticising half a thought is worse than saying nothing, so unless
   * the reader asked for it, the review waits for the full stop.
   */
  private midSentence(
    session: DocumentSession,
    snapshot: DocumentSnapshot,
    settings: AIReviewerSettings,
    changed: DirtyRange,
  ): boolean {
    if (settings.liveReview.reviewWhileCursorInsideParagraph) return false;
    if (session.paragraphCompleted) return false;

    const cursor = session.cursorPosition?.position ?? changed.to;
    if (cursor < changed.from || cursor > changed.to) return false;

    const before = snapshot.text.slice(0, cursor).trimEnd();
    if (before.length === 0) return false;

    return !/[.!?;:)\]"'\u2019\u201d]$/.test(before);
  }

  private async send(
    session: DocumentSession,
    snapshot: DocumentSnapshot,
    range: DirtyRange,
  ): Promise<void> {
    const request = session.beginRequest();
    const editedAt = session.lastEditAt;

    this.reviewing.set(session.filePath, { range, generation: request.generation });
    this.inFlight += 1;
    this.publishState();

    try {
      const result = await this.deps.runReview({
        filePath: session.filePath,
        documentText: snapshot.text,
        range,
        signal: request.signal,
        generation: request.generation,
      });

      if (result === "failed") {
        session.standDown(this.clock.now() + LIVE_REVIEW_FAILURE_COOLDOWN_MS);
      }

      // Only a review that stayed current, on text nobody touched since, has
      // covered what was dirty. Anything else leaves the passage for next time.
      const covered = result === "reviewed" || result === "skipped";
      if (covered && session.isCurrent(request.generation) && session.lastEditAt === editedAt) {
        session.clearDirty();
      }
    } catch (error) {
      this.deps.logger.error("live review threw", {
        filePath: session.filePath,
        error: error instanceof Error ? error.name : "unknown",
      });
      session.standDown(this.clock.now() + LIVE_REVIEW_FAILURE_COOLDOWN_MS);
    } finally {
      this.inFlight -= 1;
      session.finishRequest(request.generation);
      // A request an edit superseded finishes after its successor has started, and
      // must leave the successor's record alone.
      if (this.reviewing.get(session.filePath)?.generation === request.generation) {
        this.reviewing.delete(session.filePath);
      }

      const stillTracked = this.sessions.get(session.filePath) === session;
      if (stillTracked && !session.isReviewing && session.hasDirtyText && this.liveEnabled()) {
        this.arm(session.filePath, this.delayFor(session));
      } else {
        this.publishState();
      }
    }
  }

  private publishState(): void {
    const next: SchedulerState =
      this.inFlight > 0 ? "reviewing" : this.timers.size > 0 ? "waiting" : "idle";

    if (next === this.state) return;

    this.state = next;
    this.deps.onState?.(next);
  }
}

function overlaps(a: DirtyRange, b: DirtyRange): boolean {
  return a.from <= b.to && b.from <= a.to;
}
