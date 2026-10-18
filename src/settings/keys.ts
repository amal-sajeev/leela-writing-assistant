import { PROVIDER_IDS, type ProviderId } from "../types";
import type { LyraSettings } from "./settings";

/**
 * Where API keys are kept.
 *
 * Obsidian has a secret store from 1.11.4. Where it exists, keys live there and
 * the plugin's own data file carries none; where it does not, they stay in the
 * data file, as before. Either way the rest of the plugin reads the key from
 * `settings.providers`, in memory, and never needs to know which it was.
 */

/** The part of Obsidian's secret store this needs. */
export interface SecretStore {
  getSecret(id: string): string | null;
  setSecret(id: string, secret: string): void;
}

export function secretId(provider: ProviderId): string {
  return `lyra-${provider}-api-key`;
}

/**
 * Settings as loaded from disk, with each key filled in from the secret store.
 *
 * A key still sitting in the data file is from before the move, or from an older
 * Obsidian: it is put into the store, and the returned flag says the data file
 * should now be saved again without it.
 */
export function withStoredKeys(
  settings: LyraSettings,
  store: SecretStore | null,
): { settings: LyraSettings; migrated: boolean } {
  if (store === null) return { settings, migrated: false };

  const next = structuredClone(settings);
  let migrated = false;

  for (const id of PROVIDER_IDS) {
    const onDisk = next.providers[id].apiKey.trim();

    if (onDisk.length > 0) {
      store.setSecret(secretId(id), onDisk);
      migrated = true;
      continue;
    }

    next.providers[id].apiKey = store.getSecret(secretId(id)) ?? "";
  }

  return { settings: next, migrated };
}

/**
 * What goes into the data file: everything but the keys, which are written to
 * the secret store instead. Without a store the settings are saved whole.
 */
export function forSaving(settings: LyraSettings, store: SecretStore | null): LyraSettings {
  if (store === null) return settings;

  const saved = structuredClone(settings);
  for (const id of PROVIDER_IDS) {
    store.setSecret(secretId(id), settings.providers[id].apiKey.trim());
    saved.providers[id].apiKey = "";
  }

  return saved;
}
