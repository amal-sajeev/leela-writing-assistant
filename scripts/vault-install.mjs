import { access, copyFile, mkdir, readFile } from "node:fs/promises";
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

  return pluginDir;
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
