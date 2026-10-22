import { PROVIDER_IDS, type ProviderId } from "../types";
import { MAX_FALLBACK_KEYS, type LyraSettings } from "./settings";

/**
 * Where API keys are kept.
 *
 * Obsidian has a secret store from 1.11.4. Where it exists, keys live there and
 * the plugin's own data file carries none; where it does not, they stay in the
 * data file, as before. Either way the rest of the plugin reads the keys from
 * `settings.providers`, in memory, and never needs to know which it was.
 */

/** The part of Obsidian's secret store this needs. */
export interface SecretStore {
  getSecret(id: string): string | null;
  setSecret(id: string, secret: string): void;
}

/**
 * The primary key keeps the original id, so keys stored by earlier versions are
 * found where they already are. Spare keys follow it, from two upwards.
 */
export function secretId(provider: ProviderId, index = 0): string {
  return index === 0 ? `lyra-${provider}-api-key` : `lyra-${provider}-api-key-${index + 1}`;
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
    const onDisk = [next.providers[id].apiKey, ...next.providers[id].fallbackKeys];
    const keys: string[] = [];

    for (let index = 0; index <= MAX_FALLBACK_KEYS; index += 1) {
      const fromDisk = (onDisk[index] ?? "").trim();
      if (fromDisk.length > 0) {
        store.setSecret(secretId(id, index), fromDisk);
        migrated = true;
        keys[index] = fromDisk;
        continue;
      }

      keys[index] = (store.getSecret(secretId(id, index)) ?? "").trim();
    }

    // Empty slots in the middle are kept so a key stays in the field it was
    // pasted into; only empty slots at the end are dropped.
    next.providers[id].apiKey = keys[0] ?? "";
    const fallbackKeys = keys.slice(1);
    while (fallbackKeys.length > 0 && fallbackKeys[fallbackKeys.length - 1] === "") {
      fallbackKeys.pop();
    }
    next.providers[id].fallbackKeys = fallbackKeys;
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
    const provider = settings.providers[id];

    store.setSecret(secretId(id), provider.apiKey.trim());
    for (let index = 1; index <= MAX_FALLBACK_KEYS; index += 1) {
      store.setSecret(secretId(id, index), (provider.fallbackKeys[index - 1] ?? "").trim());
    }

    saved.providers[id].apiKey = "";
    saved.providers[id].fallbackKeys = [];
  }

  return saved;
}
