/**
 * Secret redaction (specification section 33).
 *
 * API keys must never reach a log, an error message or exported data. These
 * helpers are the last line of defence: the primary rule is that callers do not
 * put secrets into messages in the first place.
 */

const SENSITIVE_HEADERS = new Set(["authorization", "x-api-key", "api-key", "proxy-authorization"]);

export const REDACTED = "[redacted]";

/** Replaces the value of any authentication header. */
export function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    result[key] = SENSITIVE_HEADERS.has(key.toLowerCase()) ? REDACTED : value;
  }
  return result;
}

/**
 * Removes known secret values from arbitrary text, plus anything that looks like
 * a bearer token, in case a provider echoes a credential back in an error body.
 */
export function redactSecrets(text: string, secrets: readonly string[] = []): string {
  return redactKnownSecrets(text, secrets).replace(/Bearer\s+[A-Za-z0-9._~+/-]{8,}=*/gi, `Bearer ${REDACTED}`);
}

/**
 * Removes exactly the given secret values and nothing else. This is the one for
 * the author's own prose: the bearer heuristic above would rewrite "standard
 * bearer certificates", and a model cannot quote text it was never shown.
 */
export function redactKnownSecrets(text: string, secrets: readonly string[]): string {
  let result = text;

  for (const secret of secrets) {
    if (secret.length < 8) continue;
    result = result.split(secret).join(REDACTED);
  }

  return result;
}

/** Shortens a provider error body for debug logs, after redaction. */
export function sanitizeErrorDetail(
  text: string,
  secrets: readonly string[] = [],
  maxLength = 200,
): string {
  const redacted = redactSecrets(text, secrets).replace(/\s+/g, " ").trim();
  return redacted.length > maxLength ? `${redacted.slice(0, maxLength)}…` : redacted;
}

/** Masks a key for display, revealing nothing usable. */
export function maskKey(apiKey: string): string {
  if (apiKey.length === 0) return "not set";
  return `${"•".repeat(12)} (${apiKey.length} characters)`;
}
