import { isSettled } from "../comments/comment-state";
import { withoutDashes } from "../utils/text";
import type { ActiveReaction, CommentMessage, CommentSeverity, ReviewComment } from "../types";

/**
 * What she has to say, and what she is doing while she says it, as plain data.
 *
 * Every comment is one line of dialogue; a few remarks of her own fill the gaps.
 * Each line carries a mood, and each mood has scenes drawn for it, so the window
 * shows her doing something that fits. Nothing here touches the DOM, which is
 * what lets all of it be tested.
 */

export const COMPANION_MOODS = [
  /** Nothing is happening: she is getting on with her evening. */
  "resting",
  /** The author is writing, and she is waiting for them to pause. */
  "waiting",
  /** A review is in flight. */
  "reading",
  /** She has an ordinary point to make. */
  "pointed",
  /** She has a question about a choice that may be deliberate. */
  "asking",
  /** She is working out a reply to something the author said or asked. */
  "answering",
  /** She has found something serious. */
  "surprised",
  /** Good news: a compliment, or nothing to report. */
  "happy",
  /** Everything she raised has been dealt with. */
  "excited",
  /** The same, said with a laugh at the author's expense. */
  "amused",
  /** Something went wrong on her side. */
  "sad",
  /** Hello: she has nothing on this note yet. */
  "greeting",
] as const;
export type CompanionMood = (typeof COMPANION_MOODS)[number];

/**
 * Legacy scene names retained for semantic mood mapping and archived art.
 */
export const SCENES = [
  "listening",
  "sipping",
  "window",
  "watering",
  "strolling",
  "writing",
  "reading",
  "typing",
  "shelf",
  "pondering",
  "winking",
  "laughing",
  "stretching",
  "tired",
  "waving",
] as const;
export type Scene = (typeof SCENES)[number];

/**
 * Which scenes suit which mood. More than one means she is not always the same
 * picture: at rest she drifts between them, as someone sharing a room would.
 */
const SCENES_FOR: Record<CompanionMood, readonly Scene[]> = {
  resting: ["listening", "sipping", "window", "watering", "strolling"],
  waiting: ["writing"],
  reading: ["reading", "typing", "shelf"],
  pointed: ["listening", "pondering"],
  asking: ["pondering"],
  answering: ["typing"],
  surprised: ["pondering"],
  happy: ["winking", "laughing"],
  // Satisfied, not amused: the work is done and she goes back to her evening.
  excited: ["stretching", "sipping", "winking", "strolling"],
  amused: ["laughing"],
  sad: ["tired"],
  greeting: ["waving"],
};

/**
 * The scene for a mood. `seed` picks among the candidates: a line's own id while
 * she is speaking, so one line always has one picture, and the clock while she
 * is at rest, so the room changes slowly on its own.
 */
export function sceneFor(mood: CompanionMood, seed = 0): Scene {
  const scenes = SCENES_FOR[mood];
  return scenes[Math.abs(Math.trunc(seed)) % scenes.length]!;
}

/**
 * Legacy animation metadata for the archived scene set. Runtime scene selection
 * uses the original-design assets mapped in `scene-assets.ts`.
 */
export const ANIMATED_SCENES: ReadonlySet<Scene> = new Set<Scene>();

/** The picture for a scene: its loop when it has one and movement is wanted, its still otherwise. */
export function sceneFile(scene: Scene, moving = false): string {
  return moving && ANIMATED_SCENES.has(scene) ? `${scene}.anim.webp` : `${scene}.webp`;
}

/** A small stable number from an id, for picking a scene. */
export function seedOf(id: string): number {
  let total = 0;
  for (let index = 0; index < id.length; index += 1) total += id.charCodeAt(index);
  return total;
}

export interface CompanionLine {
  /** The comment this line speaks for, or a remark's own id. */
  id: string;
  kind: "comment" | "remark";
  mood: CompanionMood;
  reaction?: ActiveReaction;
  /** What she says. */
  text: string;
  /** The passage it is about, when it is about one. */
  quote?: string;
  /** "clarity · high", shown small above the line. */
  label?: string;
  /** What kind of finding it is, as stored, for "stop mentioning this". */
  category?: ReviewComment["category"];
  /** That category as a reader would say it: "point of view", not "pov". */
  subject?: string;
  /** What has been said back and forth about it since. */
  thread: readonly CommentMessage[];
  /** One way the passage could go, when the author asked to be shown. */
  example?: { text: string; note?: string };
  /** True for a compliment, which is answered with thanks rather than a fix. */
  praise: boolean;
  /** True once the author has resolved it: still in the history, no longer asking. */
  settled: boolean;
  /** When it was said, which is what orders the history. */
  at: number;
}

/** Something she says on her own account, kept for the session only. */
export interface CompanionRemark {
  id: string;
  filePath: string | null;
  text: string;
  mood: CompanionMood;
  at: number;
}

const SEVERITY_RANK: Record<CommentSeverity, number> = { high: 3, medium: 2, low: 1 };

/** How a comment is delivered: who it is good news for decides it. */
export function moodForComment(comment: ReviewComment): CompanionMood {
  if (comment.category === "strength") return "happy";
  if (comment.status === "stale") return "resting";
  if (comment.kind === "taste") return "asking";
  return comment.severity === "high" ? "surprised" : "pointed";
}

/**
 * Everything she has said about a note, oldest first, so "previous" walks back
 * in time and the last line is the newest.
 *
 * Dismissed points are left out: the author said they were not problems, and a
 * companion who keeps bringing them up has stopped listening. Comments from one
 * review share a timestamp, and among those the most serious comes last, which
 * makes it the one she opens with.
 */
export function companionLines(
  comments: readonly ReviewComment[],
  remarks: readonly CompanionRemark[] = [],
): CompanionLine[] {
  const lines: Array<CompanionLine & { rank: number }> = [];

  for (const comment of comments) {
    if (comment.status === "dismissed") continue;

    const praise = comment.category === "strength";
    const quote = comment.anchor.quote.trim();

    lines.push({
      id: comment.id,
      kind: "comment",
      mood: moodForComment(comment),
      ...(comment.reaction === undefined ? {} : { reaction: comment.reaction }),
      // Held to on the way out as well, for what was said before she was told not to.
      text: withoutDashes(comment.body),
      ...(quote.length > 0 ? { quote } : {}),
      label: labelFor(comment),
      category: comment.category,
      subject: subjectOf(comment),
      thread: comment.thread.map((turn) =>
        turn.role === "reviewer" ? { ...turn, text: withoutDashes(turn.text) } : turn,
      ),
      ...(comment.suggestedFix === undefined
        ? {}
        : {
            example: {
              text: comment.suggestedFix.replacement,
              ...(comment.suggestedFix.explanation === undefined
                ? {}
                : { note: comment.suggestedFix.explanation }),
            },
          }),
      praise,
      settled: isSettled(comment),
      at: comment.createdAt,
      rank: praise ? 0 : SEVERITY_RANK[comment.severity],
    });
  }

  for (const remark of remarks) {
    lines.push({
      id: remark.id,
      kind: "remark",
      mood: remark.mood,
      text: remark.text,
      thread: [],
      praise: false,
      settled: true,
      at: remark.at,
      rank: 0,
    });
  }

  return lines
    .sort((left, right) => left.at - right.at || left.rank - right.rank)
    .map(({ rank: _rank, ...line }) => line);
}

/**
 * The small heading over a line: what it is about, and how it is meant. A
 * matter of taste is called a question, because that is how it is put.
 */
function labelFor(comment: ReviewComment): string {
  if (comment.category === "strength") return "what works";

  const subject = subjectOf(comment);
  if (comment.kind === "taste") return `${subject} · a question`;
  if (comment.kind === "error") return `${subject} · ${comment.severity === "high" ? "serious" : "an error"}`;
  return `${subject} · ${comment.severity}`;
}

function subjectOf(comment: ReviewComment): string {
  return CATEGORY_NAMES[comment.category] ?? comment.category;
}

/** Categories whose identifier is not what a reader would call them. */
const CATEGORY_NAMES: Partial<Record<ReviewComment["category"], string>> = {
  pov: "point of view",
  emotion: "feeling",
};

/**
 * Which of several new comments she leads with: a problem before a compliment,
 * the most serious problem first, and the surer of two equals.
 */
export function leadComment(comments: readonly ReviewComment[]): ReviewComment | undefined {
  const rank = (comment: ReviewComment): number =>
    comment.category === "strength" ? 0 : SEVERITY_RANK[comment.severity];

  return [...comments].sort(
    (left, right) => rank(right) - rank(left) || right.confidence - left.confidence,
  )[0];
}

export type RemarkOccasion = "nothing-found" | "all-settled" | "could-not-review" | "no-selection";

/** A line is said in its occasion's mood unless it names one of its own. */
type RemarkLine = string | { text: string; mood: CompanionMood };

const REMARKS: Record<RemarkOccasion, { mood: CompanionMood; lines: readonly RemarkLine[] }> = {
  "nothing-found": {
    mood: "happy",
    lines: [
      "Nothing from me. It does what you wanted it to.",
      "I went looking for trouble in that and came back empty-handed. Annoying.",
      "That holds up. Don't let it go to your head.",
      "Hm. No complaints. Keep going.",
    ],
  },
  "all-settled": {
    mood: "excited",
    lines: [
      "That's everything I had. It's all yours again.",
      { text: "All settled. I've got nothing left to hold over you.", mood: "amused" },
      "Clean slate. I'll say something if anything else catches my eye.",
      { text: "Every last one? You're no fun when you behave.", mood: "amused" },
    ],
  },
  "could-not-review": {
    mood: "sad",
    lines: [
      "I couldn't get an answer just now. Check the connection or the key, then ask me again.",
      "Something broke on my end, so I've got nothing for you yet. Try me again.",
    ],
  },
  "no-selection": {
    mood: "greeting",
    lines: [
      "Select something and click me, and I'll tell you what I make of it. Or have me read the scene you're in.",
      "I haven't said a word about this one yet. Highlight something and I'll take a look.",
    ],
  },
};

/** What she says on an occasion. `turn` varies the wording without randomness. */
export function remarkFor(occasion: RemarkOccasion, turn: number): { text: string; mood: CompanionMood } {
  const entry = REMARKS[occasion];
  const index = Math.abs(Math.trunc(turn)) % entry.lines.length;
  const line = entry.lines[index]!;
  return typeof line === "string" ? { text: line, mood: entry.mood } : line;
}
