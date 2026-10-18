import { addDirtyRange, mapDirtyRanges, unionOf, type DirtyRange } from "./dirty-ranges";

/**
 * What the plugin knows about one open note between reviews
 * (specification section 15).
 *
 * The session is the only thing the typing path touches, and all it does there is
 * merge a few offsets. Everything expensive — reading the document, building
 * context, sending a request — happens later, on the far side of the debounce.
 */

export interface SessionChange {
  /** Changed ranges in the revision that now exists. */
  ranges: readonly DirtyRange[];
  /** Moves previously recorded ranges onto that revision. */
  mapPosition?: (position: number) => number;
  /** True when the edit closed a paragraph, such as typing a blank line. */
  paragraphCompleted?: boolean;
  at: number;
}

export interface SessionRequest {
  generation: number;
  signal: AbortSignal;
}

/** Where the cursor sits, and the bounds of the line it sits on. */
export interface CursorPosition {
  position: number;
  lineFrom: number;
  lineTo: number;
}

export class DocumentSession {
  private dirty: DirtyRange[] = [];
  private latest: DirtyRange | null = null;
  private completed = false;
  private editedAt = 0;
  private cursor: CursorPosition | null = null;
  private generationCounter = 0;
  private inFlight: { generation: number; controller: AbortController } | null = null;
  private standDownUntil = 0;

  constructor(readonly filePath: string) {}

  get dirtyRanges(): readonly DirtyRange[] {
    return this.dirty;
  }

  /** The passage edited most recently, which is the one the author is thinking about. */
  get latestRange(): DirtyRange | null {
    return this.latest;
  }

  get paragraphCompleted(): boolean {
    return this.completed;
  }

  get lastEditAt(): number {
    return this.editedAt;
  }

  get cursorPosition(): CursorPosition | null {
    return this.cursor;
  }

  get generation(): number {
    return this.generationCounter;
  }

  get isReviewing(): boolean {
    return this.inFlight !== null;
  }

  get hasDirtyText(): boolean {
    return this.dirty.length > 0;
  }

  record(change: SessionChange): void {
    if (change.mapPosition !== undefined) {
      this.dirty = mapDirtyRanges(this.dirty, change.mapPosition);
      this.latest = this.latest === null ? null : firstOf(mapDirtyRanges([this.latest], change.mapPosition));
    }

    for (const range of change.ranges) {
      this.dirty = addDirtyRange(this.dirty, range);
    }

    this.latest = unionOf(change.ranges) ?? this.latest;
    this.editedAt = change.at;
    if (change.paragraphCompleted === true) this.completed = true;
  }

  /**
   * Records where the cursor went. Leaving the line that was changed is taken as
   * finishing with that passage, which is what makes a short paragraph reviewable.
   */
  moveCursor(cursor: CursorPosition): void {
    this.cursor = cursor;

    if (this.dirty.length === 0) return;

    const stillThere = this.dirty.some(
      (range) => range.to >= cursor.lineFrom && range.from <= cursor.lineTo,
    );
    if (!stillThere) this.completed = true;
  }

  markParagraphCompleted(): void {
    this.completed = true;
  }

  /** Forgets what changed, after a review covered it. */
  clearDirty(): void {
    this.dirty = [];
    this.latest = null;
    this.completed = false;
  }

  /**
   * Claims the right to review. Anything already in flight for this note is
   * abandoned: one live request per document, and the newer edit wins
   * (specification section 17).
   */
  beginRequest(): SessionRequest {
    this.abortRequest();

    this.generationCounter += 1;
    const controller = new AbortController();
    this.inFlight = { generation: this.generationCounter, controller };

    return { generation: this.generationCounter, signal: controller.signal };
  }

  /** False once a newer edit or request has superseded this one. */
  isCurrent(generation: number): boolean {
    return this.generationCounter === generation;
  }

  finishRequest(generation: number): void {
    if (this.inFlight?.generation === generation) this.inFlight = null;
  }

  abortRequest(): void {
    if (this.inFlight === null) return;

    this.inFlight.controller.abort();
    this.inFlight = null;
    // A superseded response must never be applied, even if it arrives anyway.
    this.generationCounter += 1;
  }

  /** Holds live review back for this note, after a provider failure. */
  standDown(until: number): void {
    this.standDownUntil = until;
  }

  isStoodDown(now: number): boolean {
    return now < this.standDownUntil;
  }
}

function firstOf(ranges: readonly DirtyRange[]): DirtyRange | null {
  return ranges[0] ?? null;
}
