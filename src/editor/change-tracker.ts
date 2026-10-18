import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

import { summarizeChange, summarizeCursor, type CursorReport, type EditorChangeReport } from "./change-summary";
import { editorFilePath } from "./editor-file";

/**
 * Reports what the author changed, as they change it (specification section 15).
 *
 * The listener does the least work that still answers "what moved": collect the
 * changed offsets, note whether a paragraph was closed, hand them over. No
 * document is read in full, no request is made, nothing is scheduled here.
 */

export interface ChangeTrackerOptions {
  onChange(report: EditorChangeReport): void;
  onCursor?(report: CursorReport): void;
  now?(): number;
}

export function changeTracker(options: ChangeTrackerOptions): Extension {
  const clock = options.now ?? Date.now;

  return EditorView.updateListener.of((update) => {
    const filePath = editorFilePath(update.state);
    if (filePath === null) return;

    if (update.docChanged) {
      options.onChange(summarizeChange(update, filePath, clock()));
      return;
    }

    if (update.selectionSet) options.onCursor?.(summarizeCursor(update.state, filePath));
  });
}
