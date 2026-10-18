import {
  companionLines,
  leadComment,
  remarkFor,
  type CompanionLine,
  type CompanionMood,
  type CompanionRemark,
  type RemarkOccasion,
  type Scene,
} from "../companion/lines";
import {
  activeSceneOptions,
  ACTIVE_SCENES,
  IN_PROGRESS_ASSETS,
  PASSIVE_ASSETS,
  SceneRotation,
  sceneMode,
} from "../companion/scene-assets";
import type { LyraSettings } from "../settings/settings";
import type { ActiveReaction, ReviewComment } from "../types";
import { isActiveReaction } from "../types";
import { createId } from "../utils/ids";
import { keepHead } from "../utils/text";
import { segmentsOf, type TalkHost, type TalkMessage, type TalkMood, type TalkScope } from "../talk/talk";
import { parseInline, plainText } from "./inline";

/** Renders Lyra's scene and note box. It preserves editor focus and keeps comment history. */

export type CompanionActivity = "idle" | "waiting" | "reading" | "error";

/** Something the author can ask of her about one comment. */
export type Ask = { kind: "why" } | { kind: "example" } | { kind: "reply"; text: string };

export interface CompanionDeps {
  /** Where the window is attached, or null when there is nowhere to put it. */
  host(): HTMLElement | null;
  /**
   * Where the editor area's bottom-right corner is, as distances from the edges
   * of the app window, and how wide that area is. She floats above the whole
   * app and is lined up with the editor by these numbers, because Obsidian's own
   * layout rules decide the position of anything placed inside the editor area.
   */
  corner(): { right: number; bottom: number; width: number } | null;
  getSettings(): LyraSettings;
  activePath(): string | null;
  getComments(filePath: string): readonly ReviewComment[];
  /** A loadable address for a file under the plugin's `assets` folder. */
  assetUrl(relativePath: string): string | null;
  /** Scrolls to and briefly lights up what a line is about. */
  showPassage(filePath: string, line: CompanionLine): void;
  setStatus(filePath: string, commentId: string, status: "open" | "resolved" | "dismissed"): void;
  /** Removes every comment she has made on a note. It cannot be undone. */
  eraseComments(filePath: string): void;
  /** How much text the author has selected in the note, in characters. */
  selectionLength(): number;
  /** Remembers the width the author dragged her window to. Null goes back to fitting. */
  setWidth(width: number | null): void;
  /** Reads the selection. The result arrives later, like any other review. */
  reviewSelection(): void;
  /** Reads the scene the cursor is in. */
  reviewScene(): void;
  /**
   * Puts a question to her about one comment. Resolves to false when nothing was
   * said in answer, so that what the author wrote is kept for another try.
   */
  ask(filePath: string, commentId: string, request: Ask): Promise<boolean>;
  /** Puts text on the clipboard. */
  copy(text: string): void;
  /**
   * Writes a comment's example over the passage it is about, because the author
   * pressed Apply. False when it was not written: the note is not open, or the
   * passage is no longer what the example was written for.
   */
  applyExample(filePath: string, commentId: string): boolean;
  /** Hands the keyboard back to the note, after the one time she borrows it. */
  focusEditor(): void;
  /** Stops her raising one kind of finding, until the author says otherwise. */
  ignoreCategory(category: string): void;
  /** Whether she has been told to stop reading along for now. */
  isPaused(): boolean;
  togglePause(): void;
  /** Talking with her about the story, apart from her comments. */
  talk: TalkHost;
  /** True when the author has asked the system for less animation. */
  reducedMotion?(): boolean;
}

/** How long after a keystroke she waits before speaking. */
const TYPING_QUIET_MS = 1_500;

/** Remarks of her own kept for the session, across every note. */
const MAX_REMARKS = 30;

/** Longest quote shown in the message box before it is elided. */
const QUOTE_CHARACTERS = 160;

/** How often the scene changes while she is left to herself. */
const REST_SCENE_MS = 4 * 60_000;
const IN_PROGRESS_SCENE_MS = 12_000;
/** A deliberate note interaction briefly brings her back to the desk. */
const NOTE_INTERACTION_MS = 12_000;

/**
 * A change of channel: how long the static runs before the picture underneath
 * is swapped, and how long before it has cleared. The stylesheet's animation is
 * the same length as the second.
 */
const CHANNEL_CUT_MS = 130;
const CHANNEL_SETTLE_MS = 420;

/**
 * A change of expression between lines of talk: the same two moments, but only
 * a flicker, since it happens on every click. The stylesheet's `is-flicking`
 * animation is the same length as the second.
 */
const FLICKER_CUT_MS = 40;
const FLICKER_SETTLE_MS = 130;

/** The frame's shape, width over height, which a resize keeps. */
const FRAME_ASPECT = 1438 / 920;

/** How large she is folded away, as a fraction of her width while speaking. */
const FOLDED_FRACTION = 0.512;

/** The narrowest and widest she can be dragged, while speaking. */
const MIN_WIDTH = 200;
const MAX_WIDTH = 1200;

/** A line is typed out in about this long, however long it is. */
const TYPEWRITER_MS = 900;
const TYPEWRITER_TICK_MS = 16;

/** Her expression as she says a line, as the scene that shows it. */
const TALK_SCENE: Record<TalkMood, Scene> = {
  neutral: "listening",
  amused: "winking",
  laughing: "laughing",
  thinking: "pondering",
  surprised: "pondering",
  weary: "tired",
  unbothered: "sipping",
};

/** What is in the dialogue box before anything has been said. */
const TALK_OPENER = "Go on, then. What's on your mind?";

/**
 * The controls drawn into the frame's artwork, as areas over the picture. The
 * positions are fractions of the frame image, measured from the file itself.
 */
const FRAME_CONTROLS = [
  { key: "previous", label: "Previous thing she said", left: 16.48, top: 90.11, width: 3.13, height: 5.87 },
  { key: "show", label: "Show the passage this is about", left: 19.75, top: 90.11, width: 3.34, height: 5.87 },
  { key: "next", label: "Next thing she said", left: 23.23, top: 90.11, width: 3.2, height: 5.87 },
  // The moon in the frame's side panel: she stops reading along until it is pressed again.
  { key: "pause", label: "Pause or resume reading along", left: 3.4, top: 14.5, width: 4.6, height: 7.1 },
  // The heart under it: a pane for talking with her about the story.
  { key: "talk", label: "Talk with her about the story, or stop", left: 3.4, top: 40.0, width: 4.6, height: 7.1 },
  // The lined page under the heart: wipes what she has said about this note, after asking.
  { key: "erase", label: "Erase everything she has said about this note", left: 3.4, top: 48.5, width: 4.6, height: 7.1 },
  { key: "minimise", label: "Fold the window away", left: 86.93, top: 2.28, width: 3.06, height: 4.57 },
  { key: "resize", label: "Put the window back to its usual size", left: 90.33, top: 2.28, width: 3.06, height: 4.57 },
  { key: "close", label: "Fold the window away", left: 93.74, top: 2.28, width: 3.06, height: 4.57 },
] as const;
type FrameControl = (typeof FRAME_CONTROLS)[number]["key"];

export class Companion {
  private root: HTMLElement | null = null;
  private box: HTMLElement | null = null;
  private scene: HTMLImageElement | null = null;
  private stage: HTMLElement | null = null;
  /** The picture a change of channel is on its way to, while static covers the cut. */
  private nextScene: string | null = null;
  private cutTimer: number | undefined;
  private settleTimer: number | undefined;
  private plaque: HTMLElement | null = null;
  private ticker: HTMLElement | null = null;
  private say: HTMLElement | null = null;
  private readonly controls = new Map<FrameControl, HTMLButtonElement>();

  /**
   * Talking with her about the story: a dialogue box over her picture, as a
   * game would have it, and a place to type under her window. It has nothing to
   * do with the message box above the window, which stays on her comments.
   */
  private talking = false;
  private talkScope: TalkScope | null = null;
  private talkHistory: TalkMessage[] = [];
  /** Which line is in the dialogue box, counting every line of the conversation. */
  private talkAt = -1;
  /** The furthest line read. One past it is new, and is typed out when reached. */
  private talkSeen = -1;
  private talkWaiting = false;
  private talkProblem: string | null = null;
  private talkDraft = "";
  /** Letters of her reply shown so far, while it is being typed out. */
  private talkTyped: number | null = null;
  /** The dialogue box made taller, when a third of the picture is not enough. */
  private talkExpanded = false;
  /** Whether the message box may grow to all the room above her. */
  private boxTall = false;
  /** The note box collapsed to its clickable title bar. */
  private boxMinimized = false;
  /** True while she is asking whether to erase her comments on this note. */
  private erasing = false;
  /** What the dialogue box last showed, so being drawn again does not lose the place in it. */
  private talkShown: string | null = null;
  private talkMore: HTMLElement | null = null;
  private talkSize: HTMLElement | null = null;
  private talkTimer: number | undefined;
  private clearArmed = false;
  private frame: HTMLElement | null = null;
  private dialog: HTMLElement | null = null;
  private talkText: HTMLElement | null = null;
  private talkBox: HTMLElement | null = null;
  private talkHead: HTMLElement | null = null;
  private talkNote: HTMLElement | null = null;
  private talkInput: HTMLTextAreaElement | null = null;
  private talkSend: HTMLButtonElement | null = null;
  private talkClear: HTMLButtonElement | null = null;

  /** The line on show, by id, so it survives the list changing underneath it. */
  private currentId: string | null = null;
  private open = false;
  /** Opened by the author, so it stays until they close it. */
  private pinned = false;
  private hovering = false;
  /** She is asking whether to read the selection, rather than saying a line. */
  private offering = false;
  /** Comments she is working out an answer about. */
  private readonly answering = new Set<string>();
  /** The comment the author is writing back about, and what they have typed so far. */
  private discussingId: string | null = null;
  private draft = "";
  /** The comment whose extra actions are showing. */
  private moreId: string | null = null;
  /** The comment whose example was just copied, so the button can say so. */
  private copiedId: string | null = null;
  /** A drag of the window's corner in progress, and where it started. */
  private drag: { x: number; y: number; width: number; open: boolean } | null = null;

  private activity: CompanionActivity = "idle";
  private lastTypedAt = 0;
  private pendingId: string | null = null;
  private hideTimer: number | undefined;
  private pendingTimer: number | undefined;
  private restTimer: number | undefined;
  private noteInteractionTimer: number | undefined;
  private noteInteracting = false;
  private readonly passiveSceneRotation = new SceneRotation();
  private readonly activeSceneRotation = new SceneRotation();
  private readonly inProgressSceneRotation = new SceneRotation();
  private passiveSceneSlot: number | null = null;
  private selectedPassiveScene: ReturnType<SceneRotation["next"]> | null = null;
  private activeSceneSlot: number | null = null;
  private activeSceneContext: string | null = null;
  private selectedActiveScene: ReturnType<SceneRotation["next"]> | null = null;
  private inProgressSceneSlot: number | null = null;
  private selectedInProgressScene: ReturnType<SceneRotation["next"]> | null = null;

  /** The line being typed out, and how much of it is showing. */
  private typingId: string | null = null;
  private typedCharacters = 0;
  private typeTimer: number | undefined;

  /** Comments already known per note, so only new ones make her speak. */
  private readonly known = new Map<string, Set<string>>();
  private readonly openCounts = new Map<string, number>();
  private readonly remarks: CompanionRemark[] = [];
  /** Lines the author has not looked at yet. */
  private readonly unread = new Set<string>();
  private remarkTurn = 0;
  private renderedPath: string | null = null;
  private started = false;

  constructor(private readonly deps: CompanionDeps) {}

  start(): void {
    this.started = true;
    this.refresh();
  }

  stop(): void {
    this.started = false;
    this.unmount();
  }

  /** Called when settings, the layout or the note in front of the author change. */
  refresh(): void {
    if (!this.started) return;

    // Put back if something removed her from the page.
    if (this.root !== null && this.root.isConnected === false) this.unmount();
    if (this.root === null) this.mount();

    const path = this.deps.activePath();
    if (path !== this.renderedPath) {
      // Another note: what she was saying belonged to the last one.
      this.renderedPath = path;
      this.currentId = null;
      this.pendingId = null;
      this.clearNoteInteraction();
      // In another novel, the conversation is that novel's.
      if (this.talking && this.deps.talk.scope().path !== this.talkScope?.path) this.loadTalk();
      this.offering = false;
      this.stopTyping();
      if (!this.pinned) this.open = false;
      if (path !== null) this.learn(path);
    }

    this.place();
    this.render();
  }

  /** Lines her up with the editor area again. Called whenever that area moves or resizes. */
  place(): void {
    const style = this.root?.style;
    if (style === undefined) return;

    const corner = this.deps.corner();
    if (corner === null) return;

    style.setProperty("--lyra-right", `${Math.max(0, Math.round(corner.right))}px`);
    style.setProperty("--lyra-bottom", `${Math.max(0, Math.round(corner.bottom))}px`);
    style.setProperty("--lyra-room", `${Math.max(0, Math.round(corner.width))}px`);
    // The furthest she may reach to the left: the edge of the app window.
    style.setProperty("--lyra-reach", `${Math.max(0, Math.round(corner.right + corner.width))}px`);
  }

  /**
   * Applies the size the author chose, or none. A chosen size is her width while
   * speaking; folded away she is the same fraction of it as she is by default.
   */
  private applyWidth(width: number | null): void {
    const root = this.root;
    if (root === null) return;

    root.dataset.sized = String(width !== null);
    if (width === null) root.style.removeProperty("--lyra-open");
    else root.style.setProperty("--lyra-open", `${Math.round(width)}px`);
  }

  /**
   * Dragging the window's top-left corner resizes it. She is pinned by her
   * bottom-right corner, so pulling up and to the left makes her larger, and the
   * frame keeps its shape: whichever of the two directions was pulled further
   * decides the size.
   */
  private dragStarted(event: PointerEvent, grip: HTMLElement): void {
    const root = this.root;
    if (root === null) return;

    event.preventDefault();
    grip.setPointerCapture?.(event.pointerId);

    this.drag = {
      x: event.clientX,
      y: event.clientY,
      width: root.getBoundingClientRect().width,
      open: root.dataset.open === "true",
    };
    root.dataset.dragging = "true";
    this.clearHide();
  }

  private dragMoved(event: PointerEvent): void {
    if (this.drag === null) return;
    this.applyWidth(this.draggedWidth(event));
  }

  private dragEnded(event: PointerEvent, grip: HTMLElement): void {
    if (this.drag === null) return;

    const width = this.draggedWidth(event);
    this.drag = null;
    grip.releasePointerCapture?.(event.pointerId);
    if (this.root !== null) this.root.dataset.dragging = "false";

    this.applyWidth(width);
    this.deps.setWidth(width);
    this.scheduleHide();
  }

  /** Her speaking width for where the pointer is now. */
  private draggedWidth(event: PointerEvent): number {
    const drag = this.drag!;
    // Whichever direction moved further decides, pushing in as well as pulling out.
    const across = drag.x - event.clientX;
    const up = (drag.y - event.clientY) * FRAME_ASPECT;
    const shown = drag.width + (Math.abs(across) >= Math.abs(up) ? across : up);

    // Folded away she is drawn smaller, so the same pull means a larger window.
    const speaking = drag.open ? shown : shown / FOLDED_FRACTION;
    return Math.round(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, speaking)));
  }

  /** What she is doing, which is what the scene shows while she is not speaking. */
  setActivity(activity: CompanionActivity): void {
    this.activity = activity;
    this.paintScene(this.visibleLine());
    this.paintTicker();
  }

  /** The frame's ticker says what she is doing, when she is doing something. */
  private paintTicker(): void {
    const root = this.root;
    if (root === null) return;

    const paused = this.deps.isPaused();
    const busy = this.activity === "reading" || this.answering.size > 0;

    root.dataset.busy = String(busy);
    root.dataset.paused = String(paused && !busy);
    this.ticker?.setText(busy ? (this.answering.size > 0 ? "Thinking…" : "Reading…") : "Paused");
  }

  /** Called for every edit. Cheap by construction: a timestamp, and nothing else. */
  noteTyped(): void {
    this.lastTypedAt = Date.now();
  }

  /** Brings one comment forward, as when the author clicks its underline. */
  showComment(commentId: string): void {
    if (this.root === null) return;

    this.markNoteInteraction();
    this.offering = false;
    this.currentId = commentId;
    this.present(true, false);
  }

  /** Opens on the newest thing she has to say. Called by the command. */
  showLatest(): void {
    if (this.root === null) return;

    this.markNoteInteraction();
    this.offering = false;
    this.currentId = this.latestWorthShowing()?.id ?? null;
    this.present(true, false);
  }

  /** A note's comments changed: a review landed, or the author settled something. */
  commentsChanged(filePath: string, asked = false): void {
    if (this.root === null || filePath !== this.deps.activePath()) return;

    const comments = this.deps.getComments(filePath);
    const openNow = comments.filter(isAsking).length;
    const openBefore = this.openCounts.get(filePath) ?? 0;

    const known = this.known.get(filePath);
    if (known === undefined) {
      this.learn(filePath);
      this.render();
      return;
    }

    const fresh = comments.filter((comment) => comment.status === "open" && !known.has(comment.id));
    for (const comment of comments) known.add(comment.id);
    this.openCounts.set(filePath, openNow);

    for (const comment of fresh) this.unread.add(comment.id);

    const lead = leadComment(fresh);
    if (lead !== undefined) {
      this.speak(lead.id, asked);
      return;
    }

    // A reading the author asked for that found nothing says so itself, in a
    // moment: "all settled" as well would be two remarks about one thing.
    if (openBefore > 0 && openNow === 0 && !asked) {
      this.remark("all-settled", filePath);
      return;
    }

    this.render();
  }

  /**
   * A review the author asked for came back with nothing, or did not come back.
   * A background one that found nothing says nothing, so it is not reported here.
   */
  reviewEnded(filePath: string, outcome: "nothing-found" | "could-not-review"): void {
    if (this.root === null) return;
    this.remark(outcome, filePath, true);
  }

  /** Takes a note's comments as read, so opening it does not set her talking. */
  private learn(filePath: string): void {
    const comments = this.deps.getComments(filePath);
    this.known.set(filePath, new Set(comments.map((comment) => comment.id)));
    this.openCounts.set(filePath, comments.filter(isAsking).length);
  }

  private remark(occasion: RemarkOccasion, filePath: string, asked = false): void {
    if (filePath !== this.deps.activePath()) return;

    const said = remarkFor(occasion, this.remarkTurn);
    this.remarkTurn += 1;

    const id = createId("remark");
    this.remarks.push({ id, filePath, text: said.text, mood: said.mood, at: Date.now() });
    if (this.remarks.length > MAX_REMARKS) this.remarks.shift();

    this.unread.add(id);
    this.speak(id, asked);
  }

  /**
   * Has her say a line, unless the author asked her to keep quiet or is in the
   * middle of typing, in which case it waits.
   */
  private speak(lineId: string, asked = false): void {
    // Keeping quiet is about speaking unprompted. An answer to something the
    // author just asked for is not that.
    if (!asked && !this.deps.getSettings().companion.speakUp) {
      this.render();
      return;
    }

    // She does not talk over something the author is in the middle of. The new
    // line is counted, and one press of "next" away.
    if (this.open && this.pinned && !this.offering && this.engaged(asked)) {
      this.render();
      return;
    }

    this.pendingId = lineId;
    this.deliverWhenQuiet();
  }

  /**
   * Whether what is on show should be left there when something new arrives.
   *
   * An exchange under way always is. A comment still waiting for a decision is,
   * unless the author has just asked for a fresh reading, in which case the
   * answer to that is what they want to see. Anything else on show is finished
   * with: a remark of hers such as "all settled", or a comment already decided,
   * must never sit there while new comments queue up behind it.
   */
  private engaged(asked: boolean): boolean {
    if (this.discussingId !== null || this.answering.size > 0) return true;
    if (asked) return false;

    const line = this.lines().find((entry) => entry.id === this.currentId);
    return line !== undefined && line.kind === "comment" && !line.settled;
  }

  private deliverWhenQuiet(): void {
    if (this.pendingTimer !== undefined) window.clearTimeout(this.pendingTimer);
    this.pendingTimer = undefined;

    if (this.pendingId === null || this.root === null) return;

    const quietFor = Date.now() - this.lastTypedAt;
    if (quietFor < TYPING_QUIET_MS) {
      this.pendingTimer = window.setTimeout(() => this.deliverWhenQuiet(), TYPING_QUIET_MS - quietFor + 50);
      this.render();
      return;
    }

    this.currentId = this.pendingId;
    this.pendingId = null;
    this.offering = false;
    this.present(false, true);
  }

  /**
   * Unfolds the message box on the current line. `pinned` keeps it there, and
   * `typed` has the line appear a few letters at a time, as it would in the game.
   */
  private present(pinned: boolean, typed: boolean): void {
    this.open = true;
    this.pinned = pinned;

    this.stopTyping();
    const line = this.lines().find((entry) => entry.id === this.currentId);
    if (typed && line !== undefined && this.deps.reducedMotion?.() !== true) {
      this.typingId = line.id;
      this.typedCharacters = 0;
    }

    this.render();
    this.scheduleHide();
    if (this.typingId !== null && line !== undefined) this.type(line);
  }

  private type(line: CompanionLine): void {
    // Typed out without its emphasis marks, which only become formatting once
    // the line is whole: a lone asterisk appearing mid-line reads as a glitch.
    const text = plainText(line.text);
    const step = Math.max(1, Math.ceil(text.length / (TYPEWRITER_MS / TYPEWRITER_TICK_MS)));

    const tick = (): void => {
      this.typeTimer = undefined;
      if (this.typingId !== line.id) return;

      this.typedCharacters += step;
      if (this.typedCharacters >= text.length) {
        this.typingId = null;
        this.render();
        return;
      }

      this.say?.setText(text.slice(0, this.typedCharacters));
      this.typeTimer = window.setTimeout(tick, TYPEWRITER_TICK_MS);
    };

    this.typeTimer = window.setTimeout(tick, TYPEWRITER_TICK_MS);
  }

  private stopTyping(): void {
    if (this.typeTimer !== undefined) window.clearTimeout(this.typeTimer);
    this.typeTimer = undefined;
    this.typingId = null;
  }

  private close(): void {
    this.open = false;
    this.pinned = false;
    this.offering = false;
    this.talking = false;
    this.clearNoteInteraction();
    this.stopTalkTyping();
    this.stopTyping();
    this.clearHide();
    this.render();
  }

  private scheduleHide(): void {
    this.clearHide();
    if (!this.open || this.pinned || this.hovering || this.talking) return;
    // Not while the author is writing to her, or waiting on her answer.
    if (this.discussingId !== null || this.answering.size > 0) return;

    const linger = this.deps.getSettings().companion.lingerSeconds * 1000;
    this.hideTimer = window.setTimeout(() => {
      this.hideTimer = undefined;
      if (this.pinned || this.hovering || this.talking) return;
      if (this.discussingId !== null || this.answering.size > 0) return;
      this.close();
    }, linger);
  }

  private clearHide(): void {
    if (this.hideTimer !== undefined) window.clearTimeout(this.hideTimer);
    this.hideTimer = undefined;
  }

  private lines(): CompanionLine[] {
    const path = this.deps.activePath();
    if (path === null) return [];

    return companionLines(
      this.deps.getComments(path),
      this.remarks.filter((remark) => remark.filePath === path),
    );
  }

  /** The newest line still asking for something, or failing that the newest of all. */
  private latestWorthShowing(): CompanionLine | undefined {
    const lines = this.lines();
    return [...lines].reverse().find((line) => !line.settled) ?? lines.at(-1);
  }

  private mount(): void {
    const host = this.deps.host();
    if (host === null) return;

    const root = host.createDiv({ cls: "lyra" });
    // Keeps the cursor in the note: a click here acts, but never takes focus.
    // The one exception is the box the author asked for, to write back to her.
    root.addEventListener("mousedown", (event: MouseEvent) => {
      const target = event.target as { closest?: (selector: string) => unknown } | null;
      if (target?.closest?.(".lyra__input") != null) return;
      event.preventDefault();
    });
    root.addEventListener("mouseenter", () => {
      this.hovering = true;
      this.clearHide();
    });
    root.addEventListener("mouseleave", () => {
      this.hovering = false;
      this.scheduleHide();
    });

    // First in the column, so it sits above the window and grows upward from it.
    this.box = root.createDiv({ cls: "lyra__box" });

    const frame = root.createDiv({ cls: "lyra__window" });
    this.frame = frame;

    const stage = frame.createEl("button", { cls: "lyra__stage" });
    this.stage = stage;
    stage.addEventListener("click", () => this.stageClicked());

    this.scene = stage.createEl("img", { cls: "lyra__scene" });
    this.scene.alt = "";
    this.scene.addEventListener("error", () => this.scene?.addClass("is-missing"));

    // Over the picture: the tube's scanlines and grain, and the static that
    // covers a change of scene.
    stage.createSpan({ cls: "lyra__crt" });
    stage.createSpan({ cls: "lyra__static" });

    const border = frame.createEl("img", { cls: "lyra__frame" });
    border.alt = "";
    const frameUrl = this.deps.assetUrl("frame.webp");
    if (frameUrl === null) border.addClass("is-missing");
    else border.setAttribute("src", frameUrl);
    border.addEventListener("error", () => border.addClass("is-missing"));

    this.controls.clear();
    for (const control of FRAME_CONTROLS) {
      const button = frame.createEl("button", { cls: "lyra__control" });
      button.setAttribute("aria-label", control.label);
      button.setAttribute("title", control.label);
      button.setAttribute(
        "style",
        `left:${control.left}%;top:${control.top}%;width:${control.width}%;height:${control.height}%`,
      );
      button.addEventListener("click", () => this.controlPressed(control.key));
      this.controls.set(control.key, button);
    }

    // Shown over the frame's own ticker while a review is in flight.
    this.ticker = frame.createSpan({ cls: "lyra__ticker", text: "Reading…" });
    // The count is an invitation to read what it counts, so pressing it opens her
    // on the newest thing she has not been heard on, as pressing her does.
    this.plaque = frame.createSpan({ cls: "lyra__plaque" });
    this.plaque.setAttribute("role", "button");
    this.plaque.addEventListener("click", () => this.stageClicked());

    const grip = frame.createDiv({ cls: "lyra__grip" });
    grip.setAttribute("title", "Drag to resize. Double-click to reset.");
    grip.addEventListener("pointerdown", (event: PointerEvent) => this.dragStarted(event, grip));
    grip.addEventListener("pointermove", (event: PointerEvent) => this.dragMoved(event));
    grip.addEventListener("pointerup", (event: PointerEvent) => this.dragEnded(event, grip));
    grip.addEventListener("pointercancel", (event: PointerEvent) => this.dragEnded(event, grip));
    grip.addEventListener("dblclick", () => this.resetWidth());

    this.root = root;
    this.renderedPath = this.deps.activePath();
    if (this.renderedPath !== null) this.learn(this.renderedPath);

    // Casual scenes change slowly; while she works, the supplied progress poses cycle.
    this.restTimer = window.setInterval(() => this.paintScene(this.visibleLine()), IN_PROGRESS_SCENE_MS);
  }

  private unmount(): void {
    this.clearHide();
    this.clearNoteInteraction();
    this.stopTyping();
    if (this.pendingTimer !== undefined) window.clearTimeout(this.pendingTimer);
    if (this.restTimer !== undefined) window.clearInterval(this.restTimer);
    this.pendingTimer = undefined;
    this.restTimer = undefined;

    this.stopTalkTyping();
    this.talking = false;
    this.talkWaiting = false;
    this.frame = null;
    this.dialog = null;
    this.talkText = null;
    this.talkBox = null;
    this.talkHead = null;
    this.talkNote = null;
    this.talkInput = null;
    this.talkSend = null;
    this.talkClear = null;

    this.root?.remove();
    this.root = null;
    this.box = null;
    this.scene = null;
    this.stage = null;
    this.nextScene = null;
    if (this.cutTimer !== undefined) window.clearTimeout(this.cutTimer);
    if (this.settleTimer !== undefined) window.clearTimeout(this.settleTimer);
    this.cutTimer = undefined;
    this.settleTimer = undefined;
    this.plaque = null;
    this.ticker = null;
    this.say = null;
    this.discussingId = null;
    this.moreId = null;
    this.controls.clear();
    this.open = false;
    this.pinned = false;
    this.offering = false;
    this.renderedPath = null;
  }

  /** A click on the picture itself: open her up, or offer to read a selection. */
  private stageClicked(): void {
    if (this.open) {
      // Mid-sentence, a click finishes the line rather than doing anything else.
      if (this.typingId !== null) {
        this.stopTyping();
        this.render();
      }
      return;
    }

    this.markNoteInteraction();
    this.erasing = false;
    if (this.deps.selectionLength() > 0) {
      this.offering = true;
      this.open = true;
      this.pinned = true;
      this.render();
      return;
    }

    const unread = [...this.lines()].reverse().find((line) => this.unread.has(line.id));
    this.currentId = unread?.id ?? this.currentId ?? this.latestWorthShowing()?.id ?? null;

    if (this.currentId === null) {
      // Nothing said about this note yet: she offers to read the scene, rather
      // than opening an empty box.
      this.offering = true;
      this.open = true;
      this.pinned = true;
      this.render();
      return;
    }

    this.present(true, true);
  }

  private controlPressed(control: FrameControl): void {
    this.markNoteInteraction();
    switch (control) {
      case "previous":
        this.step(-1);
        return;
      case "next":
        this.step(1);
        return;
      case "show":
        this.showCurrentPassage();
        return;
      case "resize":
        this.resetWidth();
        return;
      case "pause":
        this.deps.togglePause();
        this.render();
        return;
      case "erase":
        if (this.lines().length === 0) return;
        this.stopTyping();
        this.erasing = true;
        this.offering = true;
        this.open = true;
        this.pinned = true;
        this.render();
        return;
      case "talk":
        if (this.talking) this.leaveTalk();
        else this.enterTalk();
        return;
      case "minimise":
      case "close":
        this.close();
    }
  }

  private resetWidth(): void {
    this.applyWidth(null);
    this.deps.setWidth(null);
  }

  private showCurrentPassage(): void {
    const path = this.deps.activePath();
    const line = this.lines().find((entry) => entry.id === this.currentId);
    if (path !== null && line !== undefined && line.quote !== undefined) {
      this.deps.showPassage(path, line);
    }
  }

  private render(): void {
    const root = this.root;
    const box = this.box;
    if (root === null || box === null) return;

    const name = this.deps.getSettings().companion.name;
    const lines = this.lines();

    let index = lines.findIndex((line) => line.id === this.currentId);
    if (index < 0 && this.open && !this.offering) {
      // What she was saying has gone, settled from elsewhere.
      index = lines.length - 1;
      this.currentId = lines[index]?.id ?? null;
    }
    if (!this.offering) this.erasing = false;
    const line = index >= 0 ? lines[index] : undefined;
    const speaking = this.open && (this.offering || line !== undefined);

    // Open with nothing to say, as when a pinned box follows the author to a note
    // she has said nothing about: she is folded, and a click must open her again.
    if (this.open && !speaking) {
      this.open = false;
      this.pinned = false;
    }

    // Being shown is being read, and has to be counted before the count is drawn.
    if (speaking && !this.offering && line !== undefined) this.unread.delete(line.id);

    // A compliment asks for nothing, so it is not counted as outstanding.
    const asking = lines.filter((entry) => !entry.settled && !entry.praise).length;
    const unread = lines.filter((entry) => this.unread.has(entry.id)).length;

    // Talking with her needs the window at its full size, with or without a comment on show.
    root.dataset.open = String(speaking || this.talking);
    root.dataset.box = String(speaking);
    root.dataset.talking = String(this.talking);
    root.dataset.tall = String(this.boxTall);
    root.dataset.boxMinimized = String(this.boxMinimized);
    root.dataset.unread = String(unread > 0);
    // Not while she is being dragged: the size under the pointer is newer than the saved one.
    if (this.drag === null) this.applyWidth(this.deps.getSettings().companion.width);
    this.paintTicker();
    root.dataset.crt = String(this.deps.getSettings().companion.crt);

    if (this.plaque !== null) {
      this.plaque.setText(asking > 0 ? String(asking) : "");
      this.plaque.toggleClass("is-empty", asking === 0);
    }

    root
      .querySelector(".lyra__stage")
      ?.setAttribute(
        "aria-label",
        speaking
          ? `${name}`
          : asking === 0
            ? `${name}. Nothing open on this note. Show what she said`
            : `${name} has ${asking} comment${asking === 1 ? "" : "s"} on this note. Show them`,
      );

    this.setControl("previous", speaking && !this.offering && index > 0);
    this.setControl("next", speaking && !this.offering && index < lines.length - 1);
    this.setControl("show", speaking && !this.offering && line?.quote !== undefined);
    this.setControl("resize", speaking && this.deps.getSettings().companion.width !== null);
    this.setControl("minimise", speaking || this.talking);
    this.setControl("close", speaking || this.talking);
    this.setControl("pause", speaking || this.talking);
    this.setControl("talk", speaking || this.talking);
    this.setControl("erase", (speaking || this.talking) && lines.length > 0);

    box.empty();
    this.say = null;
    this.paintScene(speaking && !this.offering ? line : undefined);
    this.syncTalk();

    if (!speaking) return;

    this.renderBoxHeader(box, name);
    if (this.boxMinimized) return;

    if (this.offering) this.renderOffer(box);
    else if (line !== undefined) this.renderLine(box, line, index, lines.length);
  }

  /** Starts talking with her about the story. Also what the command does. */
  enterTalk(): void {
    if (this.root === null || this.talking) return;

    this.talking = true;
    this.talkProblem = null;
    this.clearArmed = false;
    this.clearHide();
    this.loadTalk();
    this.render();
    this.talkInput?.focus();
  }

  private leaveTalk(): void {
    this.talking = false;
    this.stopTalkTyping();
    this.render();
    this.deps.focusEditor();
    this.scheduleHide();
  }

  /** Fetches the conversation for where the author is, and shows the last thing said. */
  private loadTalk(): void {
    const scope = this.deps.talk.scope();
    this.talkScope = scope;
    this.talkHistory = [];
    this.talkAt = -1;
    this.talkSeen = -1;
    this.stopTalkTyping();

    void this.deps.talk.history(scope).then((history) => {
      if (!this.talking || this.talkScope?.path !== scope.path) return;
      this.talkHistory = [...history];
      this.talkAt = this.talkLines().length - 1;
      this.talkSeen = this.talkAt;
      this.paintTalk();
    });
  }

  /** Puts the dialogue box and the typing box there while talking, and takes them away after. */
  private syncTalk(): void {
    const root = this.root;
    const frame = this.frame;
    if (root === null || frame === null) return;

    if (!this.talking) {
      this.dialog?.remove();
      this.talkBox?.remove();
      this.dialog = null;
      this.talkText = null;
      this.talkBox = null;
      this.talkHead = null;
      this.talkNote = null;
      this.talkInput = null;
      this.talkSend = null;
      this.talkClear = null;
      return;
    }

    if (this.dialog === null || this.talkBox === null) {
      const dialog = frame.createDiv({ cls: "lyra__dialog" });
      // As in a game: a click finishes the line being typed, and after that
      // moves on to the next part of what she said.
      dialog.addEventListener("click", (event: MouseEvent) => {
        const target = event.target as { closest?: (selector: string) => unknown } | null;
        if (target?.closest?.(".lyra__action") != null) return;

        if (this.talkTyped !== null) {
          this.stopTalkTyping();
          this.paintTalk();
          return;
        }
        this.turnTalkPage();
      });
      this.dialog = dialog;

      // Last in the column, so it sits under her window.
      const box = root.createDiv({ cls: "lyra__talkbox" });
      this.talkBox = box;
      this.talkHead = box.createDiv({ cls: "lyra__talkhead" });
      this.talkNote = box.createDiv({ cls: "lyra__talknote" });

      const input = box.createEl("textarea", { cls: "lyra__input lyra__talkinput" });
      input.rows = 2;
      input.placeholder = "Say something to her. Enter sends, Esc puts this away.";
      input.value = this.talkDraft;
      input.addEventListener("input", () => {
        this.talkDraft = input.value;
      });
      input.addEventListener("keydown", (event: KeyboardEvent) => {
        if (event.key === "Escape") {
          event.preventDefault();
          this.leaveTalk();
        } else if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
          event.preventDefault();
          this.sendTalk();
        }
      });
      this.talkInput = input;

      const actions = box.createDiv({ cls: "lyra__actions" });
      this.talkSend = this.action(actions, "Send", () => this.sendTalk());
      this.talkClear = this.action(actions, "Forget", () => this.forgetTalk());
      this.talkClear.setAttribute("aria-label", "Forget this conversation");
      this.action(actions, "Close", () => this.leaveTalk());
    }

    this.paintTalk();
  }

  /** What is in the dialogue box now: the thing said that is on show, or that she is thinking. */
  private paintTalk(): void {
    const dialog = this.dialog;
    if (dialog === null) return;

    const name = this.deps.getSettings().companion.name;
    const lines = this.talkLines();
    const total = lines.length;
    const message = lines[this.talkAt];
    if (this.talkTyped === null) this.talkSeen = Math.max(this.talkSeen, this.talkAt);
    const hers = this.talkWaiting || message === undefined || message.who === "lyra";

    // Drawn again for some other reason, it keeps the part of the text it was on.
    const showing = `${this.talkScope?.path ?? ""}:${this.talkAt}:${this.talkWaiting}:${this.talkTyped === null}`;
    const place = showing === this.talkShown ? (this.talkText?.scrollTop ?? 0) : 0;
    this.talkShown = showing;

    dialog.empty();
    dialog.dataset.who = hers ? "lyra" : "author";
    dialog.dataset.expanded = String(this.talkExpanded);
    dialog.createSpan({ cls: "lyra__dialog-name", text: hers ? name : "You" });

    const text = dialog.createDiv({ cls: "lyra__dialog-text" });
    text.addEventListener("scroll", () => this.markTalkMore());
    this.talkText = text;
    if (this.talkWaiting) text.setText("…");
    else if (message === undefined) text.setText(TALK_OPENER);
    else if (this.talkTyped !== null) text.setText(plainText(message.text).slice(0, this.talkTyped));
    else writeInline(text, message.text);

    const foot = dialog.createDiv({ cls: "lyra__dialog-foot" });

    // The box keeps to a third of her picture. This is for when that is too little.
    const size = this.action(foot, this.talkExpanded ? "▼" : "▲", () => {
      this.talkExpanded = !this.talkExpanded;
      this.paintTalk();
    });
    size.addClass("lyra__dialog-size");
    this.talkSize = size;
    size.setAttribute("aria-label", this.talkExpanded ? "Make the box small again" : "Make the box taller");
    size.setAttribute("title", this.talkExpanded ? "Make the box small again" : "Make the box taller");

    if (total > 0 && !this.talkWaiting) {
      const turn = (label: string, to: number, title: string): void => {
        const button = this.action(
          foot,
          label,
          () => {
            this.stopTalkTyping();
            this.showTalkLine(to);
          },
          to < 0 || to >= total,
        );
        button.setAttribute("aria-label", title);
      };
      turn("◀", this.talkAt - 1, "What was said before this");
      foot.createSpan({ cls: "lyra__count", text: `${this.talkAt + 1}/${total}` });
      turn("▶", this.talkAt + 1, "What was said after this");
    }

    // The mark a game shows when there is more of the line to come.
    this.talkMore = foot.createSpan({ cls: "lyra__more lyra__dialog-more", text: "▼" });
    (text as { scrollTop: number }).scrollTop = place;
    this.markTalkMore();

    this.talkHead?.setText(`Talking · ${this.talkScope?.title ?? ""}`);
    this.talkNote?.setText(this.talkProblem ?? "");
    if (this.talkSend !== null) this.talkSend.disabled = this.talkWaiting;
    this.talkClear?.setText(this.clearArmed ? "Forget it all?" : "Forget");
  }

  /** How much of the text is below what the box is showing. */
  private talkBelow(): number {
    const text = this.talkText as (HTMLElement & { scrollHeight?: number; clientHeight?: number }) | null;
    if (text === null) return 0;
    return (text.scrollHeight ?? 0) - (text.clientHeight ?? 0) - text.scrollTop;
  }

  /** The mark shows while there is more to click through: of this line, or lines after it. */
  private markTalkMore(): void {
    const more = this.talkBelow() > 1 || this.talkAt < this.talkLines().length - 1;
    this.talkMore?.toggleClass("is-hidden", !more || this.talkWaiting);

    // Making the box taller is only offered when the line does not fit in it.
    const fits = this.talkBelow() <= 1 && (this.talkText?.scrollTop ?? 0) <= 1;
    this.talkSize?.toggleClass("is-hidden", fits && !this.talkExpanded);
  }

  /**
   * The conversation as the lines it is read in: what the author said, each in
   * one piece, and what she said, a line of dialogue at a time.
   */
  private talkLines(): Array<{ who: TalkMessage["who"]; text: string; mood?: TalkMood; reaction?: ActiveReaction }> {
    return this.talkHistory.flatMap((message) =>
      message.who === "author"
        ? [{ who: message.who, text: message.text }]
        : segmentsOf(message).map((line) => ({ who: message.who, ...line })),
    );
  }

  /** Puts a line in the box. One not yet read is typed out, as it would be in a game. */
  private showTalkLine(to: number): void {
    const lines = this.talkLines();
    const line = lines[to];
    if (line === undefined) return;

    this.stopTalkTyping();
    this.talkAt = to;
    if (to > this.talkSeen && line.who === "lyra") this.typeTalk(line.text);
    this.paintTalk();
    this.paintScene();
  }

  /** The picture for the line in the box: her expression as she says it. */
  private talkScene(): Scene {
    const line = this.talkLines()[this.talkAt];
    return line === undefined || line.who === "author" ? "listening" : TALK_SCENE[line.mood ?? "neutral"];
  }

  /** Moves on to the next part of what is in the box, keeping its last line in view to read on from. */
  private turnTalkPage(): void {
    const text = this.talkText as (HTMLElement & { clientHeight?: number }) | null;
    const below = this.talkBelow();
    if (text === null) return;

    // The whole of this line has been read: on to the next.
    if (below <= 1) {
      if (!this.talkWaiting) this.showTalkLine(this.talkAt + 1);
      return;
    }

    const height = text.clientHeight ?? 0;
    const styled = typeof window.getComputedStyle === "function" ? window.getComputedStyle(text).lineHeight : "";
    const line = Number.parseFloat(styled);
    // Whole lines, so none is cut in half at the top of the box.
    const step =
      Number.isFinite(line) && line > 0
        ? Math.max(line, Math.floor(height / line) * line - line)
        : Math.max(1, Math.floor(height * 0.8));

    text.scrollTop += Math.min(below, step);
    this.markTalkMore();
  }

  private sendTalk(): void {
    const scope = this.talkScope;
    const text = this.talkDraft.trim();
    if (scope === null || this.talkWaiting || text.length === 0) return;

    this.talkWaiting = true;
    this.talkProblem = null;
    this.talkDraft = "";
    if (this.talkInput !== null) this.talkInput.value = "";
    this.stopTalkTyping();
    this.render();

    void this.deps.talk
      .say(scope, text)
      .catch(() => ({ ok: false as const, reason: "Something went wrong, and nothing was sent." }))
      .then((outcome) => {
        this.talkWaiting = false;

        if (outcome.ok) {
          // Still in the same conversation: it may have been put away, or changed, meanwhile.
          if (this.talkScope?.path === scope.path) {
            // What they said has been seen; her answer starts at its first line.
            this.talkHistory.push({ who: "author", text, at: outcome.reply.at });
            this.talkSeen = this.talkLines().length - 1;
            this.talkHistory.push(outcome.reply);
            this.talkAt = this.talkSeen + 1;
            if (this.talking) this.typeTalk(this.talkLines()[this.talkAt]?.text ?? "");
          }
        } else {
          // Not kept, so what they wrote goes back where they can send it again.
          this.talkProblem = outcome.reason;
          if (this.talkDraft.length === 0) {
            this.talkDraft = text;
            if (this.talkInput !== null) this.talkInput.value = text;
          }
        }

        this.render();
      });
  }

  /** Her reply appears a few letters at a time, as a line of hers does. */
  private typeTalk(said: string): void {
    this.stopTalkTyping();
    if (this.deps.reducedMotion?.() === true) return;

    const text = plainText(said);
    const step = Math.max(1, Math.ceil(text.length / (TYPEWRITER_MS / TYPEWRITER_TICK_MS)));
    this.talkTyped = 0;

    const tick = (): void => {
      this.talkTimer = undefined;
      if (this.talkTyped === null) return;

      this.talkTyped += step;
      if (this.talkTyped >= text.length) {
        this.talkTyped = null;
        this.paintTalk();
        return;
      }

      this.talkText?.setText(text.slice(0, this.talkTyped));
      this.talkTimer = window.setTimeout(tick, TYPEWRITER_TICK_MS);
    };

    this.talkTimer = window.setTimeout(tick, TYPEWRITER_TICK_MS);
  }

  private stopTalkTyping(): void {
    if (this.talkTimer !== undefined) window.clearTimeout(this.talkTimer);
    this.talkTimer = undefined;
    this.talkTyped = null;
  }

  /** Forgets the conversation, on the second press: it cannot be got back. */
  private forgetTalk(): void {
    const scope = this.talkScope;
    if (scope === null || this.talkWaiting) return;

    if (!this.clearArmed) {
      this.clearArmed = true;
      this.paintTalk();
      window.setTimeout(() => {
        this.clearArmed = false;
        this.paintTalk();
      }, 4000);
      return;
    }

    this.clearArmed = false;
    void this.deps.talk.clear(scope).then(() => {
      if (this.talkScope?.path !== scope.path) return;
      this.talkHistory = [];
      this.talkAt = -1;
      this.talkSeen = -1;
      this.stopTalkTyping();
      this.paintTalk();
      this.paintScene();
    });
  }

  /** She asks before erasing: it is everything on this note, and it does not come back. */
  private renderErase(box: HTMLElement): void {
    const count = this.lines().filter((line) => line.kind === "comment").length;

    const speech = box.createDiv({ cls: "lyra__speech" });
    this.say = speech.createDiv({
      cls: "lyra__say",
      text: `Erase everything I've said about this note? That's ${count} comment${count === 1 ? "" : "s"}, settled ones included, and there's no getting them back.`,
    });

    const actions = box.createDiv({ cls: "lyra__foot" }).createDiv({ cls: "lyra__actions" });
    this.action(actions, "Erase them", () => this.erase());
    this.action(actions, "Keep them", () => {
      this.offering = false;
      this.erasing = false;
      this.currentId = this.latestWorthShowing()?.id ?? null;
      if (this.currentId === null) this.close();
      else this.present(true, false);
    });
  }

  private erase(): void {
    const path = this.deps.activePath();
    if (path === null) return;

    for (const line of this.lines()) this.unread.delete(line.id);
    for (let index = this.remarks.length - 1; index >= 0; index -= 1) {
      if (this.remarks[index]!.filePath === path) this.remarks.splice(index, 1);
    }

    this.deps.eraseComments(path);
    this.known.set(path, new Set());
    this.openCounts.set(path, 0);
    this.currentId = null;
    this.pendingId = null;
    this.erasing = false;
    this.close();
  }

  private setControl(control: FrameControl, enabled: boolean): void {
    const button = this.controls.get(control);
    if (button === undefined) return;

    button.disabled = !enabled;
    button.toggleClass("is-off", !enabled);
  }

  /** She asks before reading, since a click on her is too easy to make by accident. */
  private renderOffer(box: HTMLElement): void {
    if (this.erasing) {
      this.renderErase(box);
      return;
    }

    const length = this.deps.selectionLength();

    const speech = box.createDiv({ cls: "lyra__speech" });
    this.say = speech.createDiv({
      cls: "lyra__say",
      text:
        length > 0
          ? `You've got ${length.toLocaleString()} character${length === 1 ? "" : "s"} selected. Want me to read ${length === 1 ? "it" : "them"}, or the whole scene?`
          : "I haven't said a word about this one yet. Select something for me, or I can read the scene you're in.",
    });

    const foot = box.createDiv({ cls: "lyra__foot" });
    const actions = foot.createDiv({ cls: "lyra__actions" });

    if (length > 0) {
      this.action(actions, "Read it", () => {
        this.close();
        this.deps.reviewSelection();
      });
    }
    this.action(actions, "Read the scene", () => {
      this.close();
      this.deps.reviewScene();
    });
    this.action(actions, "Not now", () => {
      this.offering = false;
      this.currentId = this.latestWorthShowing()?.id ?? null;
      if (this.currentId === null) this.close();
      else this.present(true, false);
    });
  }

  private renderLine(box: HTMLElement, line: CompanionLine, index: number, total: number): void {
    const path = this.deps.activePath();
    const typing = this.typingId === line.id;

    const meta = [line.label, line.settled && line.kind === "comment" ? "settled" : undefined].filter(
      (part): part is string => part !== undefined,
    );
    if (meta.length > 0) box.createDiv({ cls: "lyra__meta", text: meta.join(" · ") });

    // Everything she has to say about this one thing, which scrolls once it is long.
    const body = box.createDiv({ cls: "lyra__scroll" });

    // The dialogue is the control: clicking what she said shows what it is about.
    const pointsSomewhere = line.quote !== undefined && path !== null;
    const speech = body.createEl(pointsSomewhere ? "button" : "div", { cls: "lyra__speech" });

    if (line.quote !== undefined) {
      const shown = keepHead(line.quote, QUOTE_CHARACTERS);
      speech.createDiv({
        cls: "lyra__quote",
        text: shown.length < line.quote.length ? `${shown}…` : shown,
      });
    }

    this.say = speech.createDiv({ cls: "lyra__say" });
    if (typing) this.say.setText(plainText(line.text).slice(0, this.typedCharacters));
    else writeInline(this.say, line.text);

    if (pointsSomewhere) {
      speech.setAttribute("aria-label", `Show the passage this is about. ${plainText(line.text)}`);
      speech.addEventListener("click", () => {
        if (this.typingId !== null) {
          this.stopTyping();
          this.render();
        }
        this.deps.showPassage(path, line);
      });
    } else {
      speech.addEventListener("click", () => {
        if (this.typingId === null) return;
        this.stopTyping();
        this.render();
      });
    }

    const name = this.deps.getSettings().companion.name;
    for (const turn of line.thread) {
      const entry = body.createDiv({ cls: "lyra__turn" });
      entry.dataset.role = turn.role;
      entry.createSpan({ cls: "lyra__speaker", text: turn.role === "user" ? "You" : name });
      writeInline(entry.createDiv({ cls: "lyra__said" }), turn.text);
    }

    if (line.example !== undefined) this.renderExample(body, line, line.example);

    const waiting = this.answering.has(line.id);
    if (waiting) {
      const note = body.createDiv({ cls: "lyra__waiting", text: "…" });
      note.setAttribute("role", "status");
      note.setAttribute("aria-label", `${name} is thinking`);
    }

    // The newest thing said is at the bottom, so that is where the view goes.
    if (line.thread.length > 0 || line.example !== undefined || waiting) {
      (body as { scrollTop: number }).scrollTop = (body as { scrollHeight?: number }).scrollHeight ?? 0;
    }

    const asking = line.kind === "comment" && !line.settled && path !== null;

    if (asking && this.discussingId === line.id) this.renderDiscuss(box, path, line);

    if (asking) {
      const rows = box.createDiv({ cls: "lyra__rows" });

      if (!line.praise) {
        const talk = rows.createDiv({ cls: "lyra__actions lyra__actions--talk" });
        this.action(talk, "Why?", () => void this.put(path, line, { kind: "why" }), waiting);
        this.action(
          talk,
          "Discuss",
          () => {
            this.discussingId = line.id;
            this.moreId = null;
            this.pinned = true;
            this.render();
          },
          waiting || this.discussingId === line.id,
        );
        this.action(talk, "Example", () => void this.put(path, line, { kind: "example" }), waiting);
      }

      const decide = rows.createDiv({ cls: "lyra__actions" });
      this.action(decide, line.praise ? "Thanks" : "Got it", () => this.settle(path, line, "resolved"));
      if (!line.praise) {
        this.action(decide, "Not an issue", () => this.settle(path, line, "dismissed"));
        this.action(decide, "⋯", () => {
          this.moreId = this.moreId === line.id ? null : line.id;
          this.pinned = true;
          this.render();
        }).setAttribute("aria-label", "More");
      }

      if (this.moreId === line.id && line.category !== undefined) {
        const more = rows.createDiv({ cls: "lyra__actions lyra__actions--more" });
        const category = line.category;
        this.action(more, "Read the scene", () => {
          this.moreId = null;
          this.close();
          this.deps.reviewScene();
        });
        this.action(more, `Stop mentioning ${line.subject ?? category}`, () => {
          this.moreId = null;
          this.deps.ignoreCategory(category);
          this.settle(path, line, "dismissed");
        });
      }
    }

    // A comment already settled is history, but never a dead end: it can be taken
    // up again, and then has everything an open one has.
    if (line.kind === "comment" && line.settled && path !== null) {
      const rows = box.createDiv({ cls: "lyra__rows" });
      const decide = rows.createDiv({ cls: "lyra__actions" });
      this.action(decide, "Reopen", () => {
        this.pinned = true;
        this.deps.setStatus(path, line.id, "open");
        this.currentId = line.id;
        this.present(true, false);
      });
    }

    const foot = box.createDiv({ cls: "lyra__foot" });
    const previous = this.action(foot, "‹", () => this.step(-1));
    previous.addClass("lyra__note-nav");
    previous.setAttribute("aria-label", "Previous note");
    previous.setAttribute("title", "Previous note");
    previous.disabled = index <= 0;
    foot.createSpan({ cls: "lyra__count", text: `${index + 1}/${total}` });
    const next = this.action(foot, "›", () => this.step(1));
    next.addClass("lyra__note-nav");
    next.setAttribute("aria-label", "Next note");
    next.setAttribute("title", "Next note");
    next.disabled = index >= total - 1;

    // The mark a visual novel shows when a line has finished: there is more behind it.
    if (!typing) foot.createSpan({ cls: "lyra__more", text: "▼" });
  }

  private renderBoxHeader(box: HTMLElement, name: string): void {
    const head = box.createDiv({ cls: "lyra__box-head" });
    head.setAttribute("aria-label", this.boxMinimized ? `${name}. Expand note display` : `${name} note display`);
    if (this.boxMinimized) {
      head.setAttribute("role", "button");
      head.setAttribute("tabindex", "0");
      const restore = (): void => {
        this.boxMinimized = false;
        this.render();
      };
      head.addEventListener("click", restore);
      head.addEventListener("keydown", (event: KeyboardEvent) => {
        if (event.key === "Enter" || event.key === " ") restore();
      });
    }

    head.createSpan({ cls: "lyra__plate", text: name });
    const tools = head.createDiv({ cls: "lyra__box-tools" });
    const maximizeLabel = this.boxTall ? "Restore note display" : "Maximize note display";
    const maximize = this.action(tools, this.boxTall ? "▣" : "□", () => {
      this.boxTall = !this.boxTall;
      this.render();
    });
    maximize.addClass("lyra__box-tool");
    maximize.setAttribute("aria-label", maximizeLabel);
    maximize.setAttribute("title", maximizeLabel);
    maximize.addEventListener("click", (event) => event.stopPropagation?.());

    const minimize = this.action(tools, "—", () => {
      this.boxMinimized = true;
      this.render();
    });
    minimize.addClass("lyra__box-tool");
    minimize.setAttribute("aria-label", "Minimize note display");
    minimize.setAttribute("title", "Minimize note display");
    minimize.addEventListener("click", (event) => event.stopPropagation?.());
  }

  /**
   * One way the passage could go, when the author asked to be shown. It is an
   * illustration of her point, labelled as one. It can be copied, or applied:
   * nothing is written to the note unless the author presses Apply.
   */
  private renderExample(body: HTMLElement, line: CompanionLine, example: { text: string; note?: string }): void {
    const block = body.createDiv({ cls: "lyra__example" });
    block.createDiv({ cls: "lyra__example-label", text: "One way it could go. An option, not a correction." });
    block.createDiv({ cls: "lyra__example-text", text: example.text });
    if (example.note !== undefined && example.note.trim().length > 0) {
      writeInline(block.createDiv({ cls: "lyra__example-note" }), example.note);
    }

    const actions = block.createDiv({ cls: "lyra__actions" });

    this.action(actions, this.copiedId === line.id ? "Copied" : "Copy", () => {
      this.deps.copy(example.text);
      this.copiedId = line.id;
      this.render();
    });

    // Only on the author's say-so, and only while the comment is still open:
    // an example for a point already settled has nothing left to replace.
    const path = this.deps.activePath();
    if (path !== null && !line.settled) {
      this.action(actions, "Apply", () => this.applyExample(path, line));
    }
  }

  /**
   * Puts her example into the note in place of the passage. Doing so answers the
   * comment, so it is settled and she moves on, as she does after "Got it".
   */
  private applyExample(path: string, line: CompanionLine): void {
    // Decided before the change, while the line is still in the list to count from.
    const lines = this.lines();
    const index = lines.findIndex((entry) => entry.id === line.id);
    const next =
      lines.slice(index + 1).find((entry) => !entry.settled) ??
      [...lines.slice(0, index)].reverse().find((entry) => !entry.settled);

    const pinned = this.pinned;
    if (!this.deps.applyExample(path, line.id)) return;
    if (next === undefined) return;

    this.currentId = next.id;
    this.present(pinned, false);
  }

  /**
   * Where the author writes back. The one place she takes the keyboard, and only
   * because they pressed Discuss: Enter sends, Escape gives it back.
   */
  private renderDiscuss(box: HTMLElement, path: string, line: CompanionLine): void {
    const field = box.createDiv({ cls: "lyra__discuss" });

    const input = field.createEl("textarea", { cls: "lyra__input" });
    input.rows = 2;
    input.placeholder = "Answer her, or say why you disagree.";
    input.value = this.draft;
    input.addEventListener("input", () => {
      this.draft = input.value;
    });

    const cancel = (): void => {
      this.discussingId = null;
      this.render();
      this.deps.focusEditor();
    };

    const send = (): void => {
      const text = this.draft.trim();
      if (text.length === 0) return;

      this.discussingId = null;
      this.deps.focusEditor();
      void this.put(path, line, { kind: "reply", text }).then((answered) => {
        // Kept if she could not answer, so it does not have to be typed again.
        if (answered) this.draft = "";
        else this.discussingId = line.id;
        this.render();
      });
    };

    input.addEventListener("keydown", (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        cancel();
      } else if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        send();
      }
    });

    const actions = field.createDiv({ cls: "lyra__actions" });
    this.action(actions, "Send", send);
    this.action(actions, "Cancel", cancel);

    input.focus();
  }

  /** Puts a question to her, and shows that she is working on it until she answers. */
  private async put(path: string, line: CompanionLine, request: Ask): Promise<boolean> {
    if (this.answering.has(line.id)) return false;

    this.answering.add(line.id);
    this.pinned = true;
    this.clearHide();
    this.render();

    try {
      return await this.deps.ask(path, line.id, request);
    } catch {
      return false;
    } finally {
      this.answering.delete(line.id);
      this.render();
    }
  }

  private action(container: HTMLElement, label: string, run: () => void, disabled = false): HTMLButtonElement {
    const button = container.createEl("button", { cls: "lyra__action", text: label });
    button.disabled = disabled;
    button.addEventListener("click", () => {
      this.markNoteInteraction();
      run();
    });
    return button;
  }

  /** Moves through the history. Browsing it is the author's doing, so it stays open. */
  private step(direction: -1 | 1): void {
    const lines = this.lines();
    const index = lines.findIndex((line) => line.id === this.currentId);
    const next = lines[index + direction];
    if (next === undefined) return;

    this.markNoteInteraction();
    this.currentId = next.id;
    this.present(true, false);
  }

  private settle(filePath: string, line: CompanionLine, status: "resolved" | "dismissed"): void {
    // Decided before the change, while the line is still in the list to count from.
    const lines = this.lines();
    const index = lines.findIndex((entry) => entry.id === line.id);
    const next =
      lines.slice(index + 1).find((entry) => !entry.settled) ??
      [...lines.slice(0, index)].reverse().find((entry) => !entry.settled);

    const pinned = this.pinned;
    this.deps.setStatus(filePath, line.id, status);

    // Settling the last one produces her "all settled" remark, which then shows.
    if (next === undefined) return;

    this.currentId = next.id;
    this.present(pinned, false);
  }

  /** The scene: what she is saying when she is speaking, what she is doing when not. */
  private paintScene(line?: CompanionLine): void {
    const scene = this.scene;
    const root = this.root;
    const stage = this.stage;
    if (scene === null || root === null || stage === null) return;

    const currentTalkLine = this.talking && !this.talkWaiting ? this.talkLines()[this.talkAt] : undefined;
    const chatTone = currentTalkLine?.mood;
    const chatMood: CompanionMood | undefined =
      chatTone === "amused" ? "amused" : chatTone === "surprised" ? "surprised" : chatTone === "thinking" ? "answering" : chatTone === undefined ? undefined : "pointed";
    const mood: CompanionMood =
      this.answering.size > 0 || this.talkWaiting
        ? "answering"
        : this.offering && this.open
          ? "greeting"
          : (line?.mood ?? chatMood ?? this.restingMood());
    const mode = sceneMode({
      talking: this.talking,
      answering: this.answering.size > 0 || this.talkWaiting,
      discussing: this.discussingId !== null,
      noteInteracting: this.noteInteracting,
      activity: this.activity,
    });
    const working =
      this.activity === "waiting" || this.activity === "reading" || this.answering.size > 0 || this.talkWaiting;
    const latestReviewerReaction = line?.thread.filter((turn) => turn.role === "reviewer").at(-1)?.reaction;
    const requestedReaction = this.talking ? currentTalkLine?.reaction : latestReviewerReaction ?? line?.reaction;
    const passiveSlot = Math.floor(Date.now() / REST_SCENE_MS);
    const preferred = this.talking && !this.talkWaiting ? this.talkScene() : undefined;
    const sceneSlot = Math.floor(Date.now() / IN_PROGRESS_SCENE_MS);
    const activeContext = preferred ?? mood;
    let selected: ReturnType<SceneRotation["next"]>;
    if (mode === "passive") {
      const enteringPassive = root.dataset.mode !== "passive";
      if (this.selectedPassiveScene === null || this.passiveSceneSlot !== passiveSlot || enteringPassive) {
        this.selectedPassiveScene = this.passiveSceneRotation.next(PASSIVE_ASSETS);
        this.passiveSceneSlot = passiveSlot;
      }
      selected = this.selectedPassiveScene;
    } else if (working) {
      const enteringWork = !root.dataset.scene?.startsWith("in_progress_");
      if (
        this.selectedInProgressScene === null ||
        this.inProgressSceneSlot !== sceneSlot ||
        enteringWork
      ) {
        this.selectedInProgressScene = this.inProgressSceneRotation.next(IN_PROGRESS_ASSETS);
        this.inProgressSceneSlot = sceneSlot;
      }
      selected = this.selectedInProgressScene;
      } else {
      const enteringActive = root.dataset.mode !== "active" || root.dataset.scene?.startsWith("in_progress_");
      if (
        this.selectedActiveScene === null ||
        this.activeSceneSlot !== sceneSlot ||
        this.activeSceneContext !== activeContext ||
        enteringActive
      ) {
        this.selectedActiveScene = this.activeSceneRotation.next(activeSceneOptions(mood, preferred));
        this.activeSceneSlot = sceneSlot;
        this.activeSceneContext = activeContext;
      }
      selected = this.selectedActiveScene;
    }
    if (mode === "active" && !working && isActiveReaction(requestedReaction)) {
      selected = ACTIVE_SCENES.find((entry) => entry.id === requestedReaction) ?? selected;
    }
    const url = this.deps.assetUrl(selected.asset);
    root.dataset.mood = mood;
    root.dataset.mode = mode;
    root.dataset.scene = selected.id;

    if (url === null) {
      scene.addClass("is-missing");
      return;
    }
    const showing = this.nextScene ?? scene.getAttribute("src");
    if (showing === url) return;

    const animated = showing !== null && this.deps.getSettings().companion.crt && this.deps.reducedMotion?.() !== true;

    if (!animated) {
      this.nextScene = null;
      scene.removeClass("is-missing");
      scene.setAttribute("src", url);
      return;
    }

    this.changeChannel(url, this.talking);
  }

  /** Swaps scenes under a brief static effect; dialogue changes use a short flicker. */
  private changeChannel(url: string, quick = false): void {
    const stage = this.stage;
    const switching = this.nextScene !== null;
    this.nextScene = url;

    if (switching || stage === null) return;

    const cls = quick ? "is-flicking" : "is-switching";
    stage.addClass(cls);

    this.cutTimer = window.setTimeout(() => {
      this.cutTimer = undefined;
      if (this.nextScene === null || this.scene === null) return;

      this.scene.removeClass("is-missing");
      this.scene.setAttribute("src", this.nextScene);
    }, quick ? FLICKER_CUT_MS : CHANNEL_CUT_MS);

    this.settleTimer = window.setTimeout(() => {
      this.settleTimer = undefined;
      this.nextScene = null;
      this.stage?.removeClass(cls);
    }, quick ? FLICKER_SETTLE_MS : CHANNEL_SETTLE_MS);
  }

  private restingMood(): CompanionMood {
    switch (this.activity) {
      case "reading":
        return "reading";
      case "waiting":
        return "waiting";
      case "error":
        return "sad";
      case "idle":
        return "resting";
    }
  }

  private visibleLine(): CompanionLine | undefined {
    if (this.currentId === null) return undefined;
    return this.lines().find((line) => line.id === this.currentId);
  }

  private markNoteInteraction(): void {
    this.noteInteracting = true;
    if (this.noteInteractionTimer !== undefined) window.clearTimeout(this.noteInteractionTimer);
    this.paintScene(this.visibleLine());
    this.noteInteractionTimer = window.setTimeout(() => {
      this.noteInteractionTimer = undefined;
      this.noteInteracting = false;
      this.paintScene(this.visibleLine());
    }, NOTE_INTERACTION_MS);
  }

  private clearNoteInteraction(): void {
    this.noteInteracting = false;
    if (this.noteInteractionTimer !== undefined) window.clearTimeout(this.noteInteractionTimer);
    this.noteInteractionTimer = undefined;
  }

}

/**
 * Writes something she said, with its emphasis shown as emphasis.
 *
 * Built from elements, never from markup: what a model wrote is only ever set as
 * text. A line with no formatting in it is set directly, so it stays one piece.
 */
function writeInline(element: HTMLElement, text: string): void {
  const runs = parseInline(text);

  if (runs.every((run) => run.style === "plain")) {
    element.setText(runs.map((run) => run.text).join(""));
    return;
  }

  for (const run of runs) {
    if (run.style === "plain") element.appendText(run.text);
    else element.createEl(run.style, { text: run.text });
  }
}

/** Open and still pointing at something: the comments she is waiting on. */
function isAsking(comment: ReviewComment): boolean {
  return comment.status === "open" && comment.category !== "strength";
}
