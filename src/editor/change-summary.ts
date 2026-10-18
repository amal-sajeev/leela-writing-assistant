import type { ChangeSet, EditorState, Text } from "@codemirror/state";

import type { DirtyRange } from "../review/dirty-ranges";

/**
 * What an editor transaction changed, reduced to offsets
 * (specification sections 15, 16 and 44).
 *
 * This runs on the typing path, so it may only touch what is O(1) in the size of
 * the note: the changed ranges themselves and a few characters at their edges.
 * Reading the document, deciding whether anything is worth reviewing and building
 * a request all wait for the debounce.
 */

export interface EditorChangeReport {
  filePath: string;
  /** Changed ranges, in the revision that now exists. */
  ranges: DirtyRange[];
  /** Moves offsets from the previous revision onto this one. */
  mapPosition: (position: number) => number;
  documentLength: number;
  /** True when this edit closed a paragraph, such as a second newline. */
  paragraphCompleted: boolean;
  at: number;
}

export interface CursorReport {
  filePath: string;
  position: number;
  lineFrom: number;
  lineTo: number;
}

/** The shape of a `ViewUpdate` this module needs, so it can be tested headlessly. */
export interface ChangedTransaction {
  changes: ChangeSet;
  state: EditorState;
}

export function summarizeChange(
  update: ChangedTransaction,
  filePath: string,
  at: number,
): EditorChangeReport {
  const ranges: DirtyRange[] = [];
  let paragraphCompleted = false;

  update.changes.iterChanges((_fromA, _toA, fromB, toB, inserted) => {
    ranges.push({ from: fromB, to: toB });
    if (!paragraphCompleted && closesParagraph(update.state, fromB, toB, inserted)) {
      paragraphCompleted = true;
    }
  });

  return {
    filePath,
    ranges,
    mapPosition: (position) => update.changes.mapPos(position, 1),
    documentLength: update.state.doc.length,
    paragraphCompleted,
    at,
  };
}

export function summarizeCursor(state: EditorState, filePath: string): CursorReport {
  const head = state.selection.main.head;
  const line = state.doc.lineAt(head);

  return { filePath, position: head, lineFrom: line.from, lineTo: line.to };
}

/**
 * A blank line at either edge of the edit, which is how an author says they have
 * finished a paragraph. Only the newline count of the inserted text is consulted,
 * never its content: a large paste must not be read here.
 */
function closesParagraph(state: EditorState, from: number, to: number, inserted: Text): boolean {
  if (inserted.lines < 2) return false;
  return blankLineAt(state, from) || blankLineAt(state, to);
}

function blankLineAt(state: EditorState, at: number): boolean {
  const from = Math.max(0, at - 2);
  const to = Math.min(state.doc.length, at + 2);

  return /\n[ \t]*\n/.test(state.doc.sliceString(from, to));
}
