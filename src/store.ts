import { COMMENTS_SCHEMA_VERSION } from "./constants";
import { COMMENT_CATEGORIES, COMMENT_SEVERITIES, COMMENT_STATUSES, type ReviewComment } from "./types";

/**
 * What she has said about each note, kept in one small file beside the plugin.
 *
 * One file rather than one per note: there is a single reviewer and no threads
 * worth of data here, so the whole thing stays a few kilobytes and can be read
 * once at startup. Writes are batched, and a file that could not be read is never
 * written over.
 */

export interface StorePort {
  /** The stored text, or null when nothing has been stored yet. */
  read(): Promise<string | null>;
  write(contents: string): Promise<void>;
}

export interface ArchiveStats {
  notes: number;
  comments: number;
  bytes: number;
}

/** How long changes collect before they are written. */
const SAVE_DELAY_MS = 1_500;

export class NoteStore {
  private notes = new Map<string, ReviewComment[]>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private writing: Promise<void> = Promise.resolve();
  /** False when the file exists but could not be understood, so it is left alone. */
  private writable = true;

  constructor(
    private readonly port: StorePort,
    private readonly onProblem: (what: string) => void = () => undefined,
  ) {}

  async load(): Promise<void> {
    let raw: string | null;
    try {
      raw = await this.port.read();
    } catch {
      this.writable = false;
      this.onProblem("the saved comments could not be read, so nothing new will be saved this session");
      return;
    }

    if (raw === null) return;

    try {
      this.notes = parseStored(JSON.parse(raw));
    } catch {
      this.writable = false;
      this.onProblem("the saved comments were not readable, so they have been left untouched");
    }
  }

  comments(filePath: string): readonly ReviewComment[] {
    return this.notes.get(filePath) ?? [];
  }

  archiveStats(): ArchiveStats {
    const notes = Object.fromEntries(this.notes);
    const comments = [...this.notes.values()].reduce((total, entries) => total + entries.length, 0);
    const bytes = new TextEncoder().encode(JSON.stringify({ version: COMMENTS_SCHEMA_VERSION, notes })).length;
    return { notes: this.notes.size, comments, bytes };
  }

  /** Replaces a note's comments. An empty list forgets the note. */
  set(filePath: string, comments: readonly ReviewComment[]): void {
    if (comments.length === 0) this.notes.delete(filePath);
    else this.notes.set(filePath, [...comments].sort((a, b) => a.anchor.start - b.anchor.start));

    this.saveSoon();
  }

  rename(oldPath: string, newPath: string): void {
    const comments = this.notes.get(oldPath);
    if (comments === undefined) return;

    this.notes.delete(oldPath);
    this.notes.set(
      newPath,
      comments.map((comment) => ({ ...comment, filePath: newPath })),
    );
    this.saveSoon();
  }

  delete(filePath: string): void {
    if (this.notes.delete(filePath)) this.saveSoon();
  }

  /** Writes anything still waiting. Called on unload. */
  async flush(): Promise<void> {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
      this.save();
    }
    await this.writing;
  }

  private saveSoon(): void {
    if (this.timer !== undefined) return;

    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.save();
    }, SAVE_DELAY_MS);
  }

  private save(): void {
    if (!this.writable) return;

    const contents = JSON.stringify({
      version: COMMENTS_SCHEMA_VERSION,
      notes: Object.fromEntries(this.notes),
    });

    // One write at a time, in order, and a failed one must not stop the next.
    this.writing = this.writing
      .then(() => this.port.write(contents))
      .catch(() => this.onProblem("comments could not be saved"));
  }
}

/** Reads the stored file, keeping every comment that is whole and dropping the rest. */
function parseStored(value: unknown): Map<string, ReviewComment[]> {
  const notes = new Map<string, ReviewComment[]>();
  if (typeof value !== "object" || value === null) return notes;

  const record = value as { version?: unknown; notes?: unknown };
  if (typeof record.version === "number" && record.version > COMMENTS_SCHEMA_VERSION) {
    throw new Error("written by a newer version");
  }
  if (typeof record.notes !== "object" || record.notes === null) return notes;

  for (const [filePath, entries] of Object.entries(record.notes as Record<string, unknown>)) {
    if (!Array.isArray(entries)) continue;

    const comments = entries.filter(isComment);
    if (comments.length > 0) notes.set(filePath, comments);
  }

  return notes;
}

function isComment(value: unknown): value is ReviewComment {
  if (typeof value !== "object" || value === null) return false;

  const comment = value as Record<string, unknown>;
  const anchor = comment.anchor as Record<string, unknown> | null | undefined;

  return (
    typeof comment.id === "string" &&
    typeof comment.body === "string" &&
    typeof comment.createdAt === "number" &&
    (COMMENT_CATEGORIES as readonly unknown[]).includes(comment.category) &&
    (COMMENT_SEVERITIES as readonly unknown[]).includes(comment.severity) &&
    (COMMENT_STATUSES as readonly unknown[]).includes(comment.status) &&
    typeof anchor === "object" &&
    anchor !== null &&
    typeof anchor.quote === "string" &&
    typeof anchor.prefix === "string" &&
    typeof anchor.suffix === "string" &&
    typeof anchor.start === "number" &&
    typeof anchor.end === "number" &&
    typeof anchor.contextHash === "string"
  );
}
