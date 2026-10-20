import { withoutDashes } from "../utils/text";
import { isActiveReaction, type ActiveReaction } from "../types";

export interface ReviewerReply { text: string; reaction?: ActiveReaction }

function responseFromBrokenEnvelope(raw: string): string | undefined {
  const key = /["']response["']\s*:\s*["']/i.exec(raw);
  if (key === null) return undefined;

  const start = key.index + key[0].length;
  const rest = raw.slice(start);
  const reaction = /["']\s*,\s*["']reaction["']\s*:/i.exec(rest);
  const tail = reaction === null ? /["']\s*[,}]\s*(?:```)?\s*$/.exec(rest) : null;
  const end = reaction?.index ?? tail?.index;
  if (end === undefined) return undefined;

  const fragment = rest.slice(0, end);
  try {
    return JSON.parse(`"${fragment}"`) as string;
  } catch {
    return fragment
      .replace(/\\n/g, "\n")
      .replace(/\\r/g, "\r")
      .replace(/\\t/g, "\t")
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, "\\");
  }
}

function reactionFromEnvelope(raw: string): ActiveReaction | undefined {
  const match = /["']reaction["']\s*:\s*["']([^"']+)["']/i.exec(raw);
  const reaction = match?.[1];
  return isActiveReaction(reaction) ? reaction : undefined;
}

/** Unwraps valid or slightly broken reply envelopes and keeps older plain text. */
export function parseReviewerReply(raw: string): ReviewerReply {
  const trimmed = raw.trim();
  try {
    const from = trimmed.indexOf("{");
    const to = trimmed.lastIndexOf("}");
    if (from >= 0 && to > from) {
      const parsed: unknown = JSON.parse(trimmed.slice(from, to + 1));
      if (typeof parsed === "object" && parsed !== null) {
        const record = parsed as { response?: unknown; reaction?: unknown };
        if (typeof record.response === "string" && record.response.trim()) {
          return { text: withoutDashes(record.response), ...(isActiveReaction(record.reaction) ? { reaction: record.reaction } : {}) };
        }
      }
    }
  } catch { /* Keep legacy text when the envelope is malformed. */ }

  const recovered = responseFromBrokenEnvelope(trimmed);
  if (recovered?.trim()) {
    const reaction = reactionFromEnvelope(trimmed);
    return { text: withoutDashes(recovered), ...(reaction === undefined ? {} : { reaction }) };
  }

  return { text: withoutDashes(raw) };
}
