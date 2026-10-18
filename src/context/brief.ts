import { BRIEF_FILE_NAME } from "../constants";
import type { RetrievedContext } from "../types";
import { ancestorFolders, joinVaultPath, parentFolder, pathBasename } from "../utils/paths";
import { relevantParts } from "../utils/relevance";
import { keepHead } from "../utils/text";

/** Loads a story brief and its linked canon notes for reviews. */

export interface BriefDeps {
  /** A note's text, or null when there is no note at that path. */
  read(path: string): Promise<string | null>;
  /** The path a `[[link]]` written in `fromPath` points at, or null when it points nowhere. */
  resolveLink(target: string, fromPath: string): string | null;
}

export interface StoryContext {
  /** The brief, or briefs, that apply to the note. Absent when there is none. */
  brief?: string;
  /** Excerpts of the notes the brief links to. */
  canon: RetrievedContext[];
}

/** How much of the brief travels with a review. */
const MAX_BRIEF_CHARACTERS = 4_000;

/** Canon notes followed from the brief, and how much of each travels. */
const MAX_CANON_NOTES = 6;
const CANON_EXCERPT_CHARACTERS = 1_500;

export function isBrief(path: string): boolean {
  return pathBasename(path).toLowerCase() === BRIEF_FILE_NAME.toLowerCase();
}

/** Where a note's briefs may live, vault root first. */
export function briefPathsFor(filePath: string): string[] {
  return ancestorFolders(filePath).map((folder) => joinVaultPath(folder, BRIEF_FILE_NAME));
}

/** Where a new brief for this note would go: beside it. */
export function newBriefPathFor(filePath: string): string {
  return joinVaultPath(parentFolder(filePath), BRIEF_FILE_NAME);
}

export async function storyContext(
  filePath: string,
  deps: BriefDeps,
  /** The passage being read and its surroundings, which decide what of a long canon note is sent. */
  passage = "",
): Promise<StoryContext> {
  const briefs: Array<{ path: string; text: string }> = [];

  for (const path of briefPathsFor(filePath)) {
    const text = withoutFrontmatter((await deps.read(path)) ?? "").trim();
    if (text.length > 0) briefs.push({ path, text });
  }

  if (briefs.length === 0) return { canon: [] };

  return {
    brief: mergeBriefs(briefs),
    canon: await canonFor(filePath, briefs, deps, passage),
  };
}

/**
 * Several briefs become one, the vault's first and the story's own last, so the
 * nearest folder has the final word. The budget is spent from the nearest
 * outward, because that is the one that describes this story most precisely.
 */
function mergeBriefs(briefs: ReadonlyArray<{ path: string; text: string }>): string {
  if (briefs.length === 1) return keepHead(briefs[0]!.text, MAX_BRIEF_CHARACTERS);

  const kept: string[] = [];
  let remaining = MAX_BRIEF_CHARACTERS;

  for (let index = briefs.length - 1; index >= 0 && remaining > 80; index -= 1) {
    const brief = briefs[index]!;
    const body = keepHead(brief.text, remaining);
    kept.push(`[${brief.path}]\n${body}`);
    remaining -= body.length;
  }

  return `Briefs from folders nearer the story come last and take precedence.\n\n${kept.reverse().join("\n\n")}`;
}

/** The notes the briefs link to, nearest brief first, each read once. */
async function canonFor(
  filePath: string,
  briefs: ReadonlyArray<{ path: string; text: string }>,
  deps: BriefDeps,
  passage: string,
): Promise<RetrievedContext[]> {
  const canon: RetrievedContext[] = [];
  const seen = new Set<string>([filePath.toLowerCase()]);

  for (const brief of [...briefs].reverse()) {
    for (const target of linkTargets(brief.text)) {
      if (canon.length >= MAX_CANON_NOTES) return canon;

      const path = deps.resolveLink(target, brief.path);
      // Not the note being read, which is already the request, nor another brief.
      if (path === null || isBrief(path) || seen.has(path.toLowerCase())) continue;
      seen.add(path.toLowerCase());

      const text = withoutFrontmatter((await deps.read(path)) ?? "").trim();
      if (text.length === 0) continue;

      canon.push({
        filePath: path,
        excerpt: relevantParts(text, passage, CANON_EXCERPT_CHARACTERS),
        score: 1,
        reason: "wikilink",
      });
    }
  }

  return canon;
}

/** What each `[[link]]` in a text points at, without its alias, heading or block. */
export function linkTargets(text: string): string[] {
  const targets: string[] = [];

  for (const match of text.matchAll(/\[\[([^[\]]+)\]\]/g)) {
    // Inside a table the pipe before an alias is escaped: `[[Note\|alias]]`.
    const withoutAlias = ((match[1] ?? "").split("|")[0] ?? "").replace(/\\$/, "");
    const target = (withoutAlias.split("#")[0] ?? "").trim();
    if (target.length > 0) targets.push(target);
  }

  return targets;
}

/** Frontmatter is never sent, from any note. */
function withoutFrontmatter(text: string): string {
  const match = /^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  return match === null ? text : text.slice(match[0].length);
}

/** What a new brief starts as: the headings worth filling in, and nothing else. */
export const BRIEF_TEMPLATE = [
  "This note tells Lyra about the story in this folder. Fill in what helps and delete the rest.",
  "It is never reviewed itself. Any note linked from here is read as canon.",
  "",
  "## The story",
  "Genre, and who it is for.",
  "",
  "## How it is told",
  "Point of view, tense, and anything deliberate about the voice (fragments, dialect, an unreliable narrator).",
  "",
  "## What I want from this draft",
  "For example: tension in the middle chapters, restraint in the dialogue.",
  "",
  "## Canon",
  "Link the notes she should treat as fact, such as [[Characters]] or [[Timeline]].",
  "",
  "## Leave alone",
  "Choices that are intentional and should not be questioned.",
  "",
].join("\n");
