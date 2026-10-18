/**
 * Vault path helpers.
 *
 * Obsidian reports forward-slashed, vault-relative paths, but stored settings and
 * paths typed by the author may carry Windows separators or a leading slash, so
 * every comparison starts by normalizing.
 */

export function normalizeVaultPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\/+/, "");
}

export function pathBasename(path: string): string {
  const parts = normalizeVaultPath(path).split("/");
  return parts[parts.length - 1] ?? path;
}

/** Folder containing the path. The vault root is the empty string. */
export function parentFolder(path: string): string {
  const normalized = normalizeVaultPath(path);
  const cut = normalized.lastIndexOf("/");
  return cut < 0 ? "" : normalized.slice(0, cut);
}

/** Joins a folder and a name, treating the empty folder as the vault root. */
export function joinVaultPath(folder: string, name: string): string {
  const base = normalizeVaultPath(folder).replace(/\/+$/, "");
  return base.length === 0 ? name : `${base}/${name}`;
}

/**
 * The folder chain containing the path, vault root first. `A/B/note.md` gives
 * `["", "A", "A/B"]`, which is the order project instructions merge in.
 */
export function ancestorFolders(path: string): string[] {
  const folder = parentFolder(path);
  const folders = [""];

  if (folder.length === 0) return folders;

  let walked = "";
  for (const segment of folder.split("/")) {
    if (segment.length === 0) continue;
    walked = walked.length === 0 ? segment : `${walked}/${segment}`;
    folders.push(walked);
  }

  return folders;
}
