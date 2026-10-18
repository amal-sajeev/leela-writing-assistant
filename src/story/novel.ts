import { BRIEF_FILE_NAME, STORY_NOTES_FOLDER } from "../constants";
import { ancestorFolders, joinVaultPath, parentFolder, pathBasename } from "../utils/paths";

/** Finds novels and chapters from vault paths. */

/** The folder of the novel a note belongs to, or null when it belongs to none. */
export function novelFor(filePath: string, hasBrief: (folder: string) => boolean): string | null {
  // Nearest first: a novel inside a larger writing folder is its own novel.
  const folders = ancestorFolders(filePath).reverse();
  return folders.find((folder) => hasBrief(folder)) ?? null;
}

export function briefPathOf(novel: string): string {
  return joinVaultPath(novel, BRIEF_FILE_NAME);
}

export function notesFolderOf(novel: string): string {
  return joinVaultPath(novel, STORY_NOTES_FOLDER);
}

/** True for anything in a novel's notes folder: hers to write, never to review. */
export function isStoryNote(path: string): boolean {
  return ancestorFolders(path).some(
    (folder) => pathBasename(folder).toLowerCase() === STORY_NOTES_FOLDER.toLowerCase(),
  );
}

/** True when a note is a chapter of the novel: directly in its folder, and not the brief. */
export function isChapterOf(novel: string, path: string): boolean {
  if (!path.toLowerCase().endsWith(".md")) return false;
  if (parentFolder(path) !== novel) return false;
  return pathBasename(path).toLowerCase() !== BRIEF_FILE_NAME.toLowerCase();
}

/** A chapter's name as the author sees it, without the extension. */
export function chapterName(path: string): string {
  return pathBasename(path).replace(/\.md$/i, "");
}

/**
 * Chapters in reading order. Numbers inside names sort as numbers, so
 * "Chapter 2" comes before "Chapter 10" whether or not the author padded them.
 */
export function inReadingOrder(paths: readonly string[]): string[] {
  return [...paths].sort((left, right) =>
    chapterName(left).localeCompare(chapterName(right), undefined, { numeric: true, sensitivity: "base" }),
  );
}
