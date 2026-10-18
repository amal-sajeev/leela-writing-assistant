let fallbackCounter = 0;

/**
 * Creates an identifier for comments, threads and requests.
 * Uses `crypto.randomUUID` where available and stays usable on platforms
 * (older mobile webviews) that do not expose it.
 */
export function createId(prefix?: string): string {
  const raw = randomToken();
  return prefix ? `${prefix}_${raw}` : raw;
}

function randomToken(): string {
  const cryptoRef = globalThis.crypto as Crypto | undefined;
  if (cryptoRef?.randomUUID) return cryptoRef.randomUUID();

  if (cryptoRef?.getRandomValues) {
    const bytes = cryptoRef.getRandomValues(new Uint8Array(16));
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  fallbackCounter += 1;
  return `${Date.now().toString(36)}${fallbackCounter.toString(36)}${Math.random()
    .toString(36)
    .slice(2, 10)}`;
}
