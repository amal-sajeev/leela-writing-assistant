import type { EditorState } from "@codemirror/state";
import { editorInfoField } from "obsidian";

/** Path of the note an editor is showing, or null outside a Markdown file. */
export function editorFilePath(state: EditorState): string | null {
  return state.field(editorInfoField, false)?.file?.path ?? null;
}
