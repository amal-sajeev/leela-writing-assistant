/**
 * How much room a reply is given, in tokens.
 *
 * Shared so the same review costs the same everywhere: a provider that budgeted
 * differently would silently return fewer comments than its neighbours on the
 * same passage, which would read as that provider being worse.
 */

/** Enough room for the requested comments plus overhead, without inviting an essay. */
export function reviewTokenBudget(maxComments: number): number {
  return Math.min(4000, 400 + Math.max(1, maxComments) * 250);
}

/** An observation is a paragraph rather than a sentence, so it costs more room. */
export function observationTokenBudget(maxObservations: number): number {
  return Math.min(4000, 400 + Math.max(1, maxObservations) * 400);
}

/** A reply is conversational prose, and a fix is a rewritten passage. */
export const REPLY_TOKEN_BUDGET = 600;
export const FIX_TOKEN_BUDGET = 1200;

/**
 * Extra room for a model that thinks before it answers and bills that thinking
 * against the same limit. A ceiling, not a target: unused headroom costs nothing,
 * and without it a short budget can be spent before the answer begins.
 */
export const THINKING_HEADROOM_TOKENS = 6000;
