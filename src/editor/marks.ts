import { StateEffect, StateField, type EditorState, type Extension } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, type DecorationSet } from "@codemirror/view";

import { resolveAnchor } from "../comments/anchor-resolver";
import type { ReviewComment } from "../types";
import type { CursorReport, EditorChangeReport } from "./change-summary";
import { changeTracker } from "./change-tracker";
import { editorFilePath } from "./editor-file";

/**
 * Everything she does inside the editor: underline what she commented on, light
 * a passage up when asked where a comment points, and report edits so she knows
 * when the author has paused.
 *
 * Underlines live in a StateField, so ordinary typing moves them with the text
 * for free. They are only rebuilt when the comments themselves change.
 */

export interface EditorMarksDeps {
  /** The open comments on a note, which are the ones that are underlined. */
  getComments(filePath: string): readonly ReviewComment[];
  underline(): boolean;
  /** Called when the author clicks an underline. */
  onSelect(filePath: string, commentId: string): void;
  onEdit(report: EditorChangeReport): void;
  onCursor(report: CursorReport): void;
}

const COMMENT_ATTRIBUTE = "data-lyra-comment";

/** How long a passage stays lit after the author asks to be shown it. */
const FLASH_MS = 2_200;

const setMarks = StateEffect.define<DecorationSet>();
const setFlash = StateEffect.define<{ from: number; to: number } | null>();

const marksField = StateField.define<DecorationSet>({
  create: () => Decoration.none,

  update(value, transaction) {
    let next = transaction.docChanged ? value.map(transaction.changes) : value;
    for (const effect of transaction.effects) {
      if (effect.is(setMarks)) next = effect.value;
    }
    return next;
  },

  provide: (field) => EditorView.decorations.from(field),
});

const flashMark = Decoration.mark({ class: "lyra-flash" });

/** A passage lit for a moment, without moving the cursor or the selection. */
const flashField = StateField.define<DecorationSet>({
  create: () => Decoration.none,

  update(value, transaction) {
    let next = transaction.docChanged ? value.map(transaction.changes) : value;
    for (const effect of transaction.effects) {
      if (!effect.is(setFlash)) continue;
      next =
        effect.value === null
          ? Decoration.none
          : Decoration.set([flashMark.range(effect.value.from, effect.value.to)]);
    }
    return next;
  },

  provide: (field) => EditorView.decorations.from(field),
});

export class EditorMarks {
  private readonly views = new Set<EditorView>();
  /** The note each editor was last drawn for, since one editor is reused across notes. */
  private readonly drawnFor = new WeakMap<EditorView, string | null>();

  constructor(private readonly deps: EditorMarksDeps) {}

  /** The extension to hand to `registerEditorExtension`. */
  extension(): Extension {
    return [
      marksField,
      flashField,
      this.syncPlugin(),
      EditorView.domEventHandlers({
        mousedown: (event, view) => {
          this.handleClick(event, view);
          // The click still belongs to the editor: it places the cursor as usual.
          return false;
        },
      }),
      changeTracker({
        onChange: (report) => this.deps.onEdit(report),
        onCursor: (report) => this.deps.onCursor(report),
      }),
    ];
  }

  /** Redraws the underlines in every open editor. Cheap, and safe to call often. */
  refresh(): void {
    for (const view of this.views) this.draw(view);
  }

  /** The text an open editor has for a note right now, or null when it is not open. */
  text(filePath: string): string | null {
    for (const view of this.views) {
      if (editorFilePath(view.state) === filePath) return view.state.doc.toString();
    }
    return null;
  }

  /**
   * Scrolls an open note to a passage and lights it briefly. Returns false when
   * no editor is showing that note.
   */
  flash(filePath: string, from: number, to: number): boolean {
    let shown = false;

    for (const view of this.views) {
      if (editorFilePath(view.state) !== filePath) continue;

      const length = view.state.doc.length;
      const start = Math.max(0, Math.min(from, length));
      const end = Math.max(start, Math.min(to, length));
      if (end === start) continue;

      view.dispatch({
        effects: [setFlash.of({ from: start, to: end }), EditorView.scrollIntoView(start, { y: "center" })],
      });
      shown = true;

      window.setTimeout(() => {
        if (this.views.has(view)) view.dispatch({ effects: setFlash.of(null) });
      }, FLASH_MS);
    }

    return shown;
  }

  private syncPlugin(): Extension {
    return ViewPlugin.define((view) => {
      this.views.add(view);
      // A plugin is created inside an update, where dispatching is not allowed.
      queueMicrotask(() => {
        if (this.views.has(view)) this.draw(view);
      });

      return {
        update: (update) => {
          // The same editor is reused when the author switches notes.
          if (this.drawnFor.get(update.view) === editorFilePath(update.state)) return;

          queueMicrotask(() => {
            if (this.views.has(update.view)) this.draw(update.view);
          });
        },
        destroy: () => {
          this.views.delete(view);
        },
      };
    });
  }

  private draw(view: EditorView): void {
    const filePath = editorFilePath(view.state);
    this.drawnFor.set(view, filePath);

    const comments =
      filePath === null || !this.deps.underline() ? [] : this.deps.getComments(filePath);

    view.dispatch({ effects: setMarks.of(buildMarks(view.state, comments)) });
  }

  private handleClick(event: MouseEvent, view: EditorView): void {
    const target = event.target instanceof HTMLElement ? event.target : null;
    const commentId = target?.closest(`[${COMMENT_ATTRIBUTE}]`)?.getAttribute(COMMENT_ATTRIBUTE);
    const filePath = editorFilePath(view.state);

    if (commentId !== null && commentId !== undefined && filePath !== null) {
      this.deps.onSelect(filePath, commentId);
    }
  }
}

/**
 * Underlines for a note's open comments, placed where each passage is in this
 * editor right now: stored offsets trail the editor by a save, so a comment whose
 * text is not where it was last seen is looked for before it is drawn.
 */
function buildMarks(state: EditorState, comments: readonly ReviewComment[]): DecorationSet {
  const length = state.doc.length;
  const ranges: Array<{ from: number; to: number; comment: ReviewComment }> = [];
  let text: string | undefined;

  for (const comment of comments) {
    if (comment.status !== "open") continue;

    let { start, end } = comment.anchor;
    const inPlace =
      start >= 0 && end <= length && state.doc.sliceString(start, end) === comment.anchor.quote;

    if (!inPlace) {
      text ??= state.doc.toString();
      const resolution = resolveAnchor(text, comment.anchor);
      if (resolution.status === "stale") continue;
      ({ start, end } = resolution);
    }

    if (end > start) ranges.push({ from: start, to: end, comment });
  }

  ranges.sort((left, right) => left.from - right.from || left.to - right.to);

  return Decoration.set(
    ranges.map(({ from, to, comment }) =>
      Decoration.mark({
        class: [
          "lyra-mark",
          comment.category === "strength" ? "lyra-mark--strength" : "",
          comment.severity === "high" ? "lyra-mark--high" : "",
        ]
          .filter((name) => name.length > 0)
          .join(" "),
        attributes: { [COMMENT_ATTRIBUTE]: comment.id },
      }).range(from, to),
    ),
    true,
  );
}
