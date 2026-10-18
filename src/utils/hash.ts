/**
 * Deterministic, synchronous, non-cryptographic hashing.
 *
 * Used for anchor context hashes and source revision hashes, where the only
 * requirements are stability across sessions and cheap change detection.
 * Never used for security decisions.
 */

/** Whitespace-insensitive normalization so that reflowed text hashes equally. */
export function normalizeForHash(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

/** 53-bit hash (cyrb53) rendered as hex. */
export function hashText(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }

  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);

  const value = 4294967296 * (2097151 & h2) + (h1 >>> 0);
  return value.toString(16).padStart(14, "0");
}

/** Hash of the normalized text surrounding an anchor. */
export function hashAnchorContext(prefix: string, quote: string, suffix: string): string {
  return hashText(normalizeForHash(`${prefix}\u0000${quote}\u0000${suffix}`));
}

/**
 * Identifies the exact document state a review was requested against
 * (specification section 79).
 */
export function hashSourceRevision(parts: {
  filePath: string;
  changedText: string;
  beforeContext: string;
  afterContext: string;
}): string {
  return hashText(
    [parts.filePath, parts.changedText, parts.beforeContext, parts.afterContext].join("\u0000"),
  );
}
