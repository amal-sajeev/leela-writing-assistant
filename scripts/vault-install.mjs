import { access, copyFile, mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_ID = "lyra-companion";
const ARTIFACTS = ["main.js", "manifest.json", "styles.css"];

/**
 * Resolves the plugin directory to copy build artifacts into.
 *
 * Precedence:
 *   1. OBSIDIAN_PLUGIN_DIR  - full path to the plugin folder
 *   2. OBSIDIAN_VAULT_PATH  - vault root; plugin folder is derived
 *   3. .vaultpath           - untracked file containing the vault root
 */
async function resolvePluginDir() {
  const explicit = process.env.OBSIDIAN_PLUGIN_DIR?.trim();
  if (explicit) return explicit;

  const fromEnv = process.env.OBSIDIAN_VAULT_PATH?.trim();
  const vaultRoot = fromEnv || (await readVaultPathFile());
  if (!vaultRoot) return null;

  return path.join(vaultRoot, ".obsidian", "plugins", PLUGIN_ID);
}

async function readVaultPathFile() {
  try {
    const raw = await readFile(path.join(repoRoot, ".vaultpath"), "utf8");
    const line = raw
      .split(/\r?\n/)
      .map((value) => value.trim())
      .find((value) => value.length > 0 && !value.startsWith("#"));
    return line ?? null;
  } catch {
    return null;
  }
}

export async function describeTarget() {
  const dir = await resolvePluginDir();
  return dir ?? "none configured (set OBSIDIAN_VAULT_PATH or create .vaultpath)";
}

/**
 * Copies build artifacts into the configured vault.
 * Returns the destination directory, or null when no vault is configured.
 */
export async function installBuild({ quiet = false } = {}) {
  const pluginDir = await resolvePluginDir();
  if (!pluginDir) {
    if (!quiet) {
      console.warn(
        "[lyra] no install target configured. Set OBSIDIAN_VAULT_PATH or create a .vaultpath file.",
      );
    }
    return null;
  }

  await mkdir(pluginDir, { recursive: true });

  for (const artifact of ARTIFACTS) {
    const source = path.join(repoRoot, artifact);
    try {
      await access(source);
    } catch {
      if (!quiet) console.warn(`[lyra] skipped missing artifact ${artifact}`);
      continue;
    }
    await copyFile(source, path.join(pluginDir, artifact));
  }

  const sourceAssets = path.join(repoRoot, "assets");
  const targetAssets = path.join(pluginDir, "assets");
  const files = (await listFiles(sourceAssets)).sort();
  const previous = await readAssetManifest(path.join(targetAssets, "manifest.json"));

  await copyTree(sourceAssets, targetAssets);
  const current = new Set(files);
  for (const stale of previous) {
    if (current.has(stale)) continue;
    const target = path.resolve(targetAssets, ...stale.split("/"));
    if (!target.startsWith(`${path.resolve(targetAssets)}${path.sep}`)) continue;
    try {
      await unlink(target);
    } catch {
      // A missing stale file is already gone.
    }
  }
  await writeFile(path.join(targetAssets, "manifest.json"), JSON.stringify({ version: 1, files }, null, 2));

  return pluginDir;
}

async function copyTree(sourceDir, targetDir) {
  await mkdir(targetDir, { recursive: true });
  for (const entry of await readdir(sourceDir, { withFileTypes: true })) {
    const source = path.join(sourceDir, entry.name);
    const target = path.join(targetDir, entry.name);
    if (entry.isDirectory()) {
      await copyTree(source, target);
    } else if (entry.isFile()) {
      await copyFile(source, target);
    }
  }
}

async function listFiles(sourceDir, relative = "") {
  const output = [];
  for (const entry of await readdir(path.join(sourceDir, relative), { withFileTypes: true })) {
    const child = relative.length === 0 ? entry.name : path.join(relative, entry.name);
    if (entry.isDirectory()) output.push(...(await listFiles(sourceDir, child)));
    else if (entry.isFile()) output.push(child.split(path.sep).join("/"));
  }
  return output;
}

async function readAssetManifest(filePath) {
  try {
    const parsed = JSON.parse(await readFile(filePath, "utf8"));
    if (parsed?.version !== 1 || !Array.isArray(parsed.files)) return [];
    return parsed.files.filter(isSafeAssetPath);
  } catch {
    return [];
  }
}

function isSafeAssetPath(value) {
  return typeof value === "string" &&
    /^(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+$/.test(value) &&
    !value.split("/").some((segment) => segment === "." || segment === "..");
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  const target = await installBuild();
  if (target) {
    console.warn(`[lyra] installed to ${target}`);
  } else {
    process.exitCode = 1;
  }
}
