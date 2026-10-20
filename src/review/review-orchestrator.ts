import { isProviderError, type ProviderError } from "../providers/provider-errors";
import type { ReviewDepth } from "../types";

export interface ReviewSpan {
  start: number;
  end: number;
}

export interface ReviewJob extends ReviewSpan {
  pass: "broad" | "structure" | "line";
  instruction: string;
  part: number;
  parts: number;
}

export interface ReviewProgress {
  phase: string;
  part: number;
  parts: number;
  requests: number;
  findings: number;
}

export interface ReviewJobResult<T> {
  job: ReviewJob;
  value: T;
}

export interface ReviewRunResult<T> {
  results: ReviewJobResult<T>[];
  coveredSpans: ReviewSpan[];
  complete: boolean;
  requests: number;
  warnings: string[];
}

export interface ReviewRunOptions<T> {
  text: string;
  jobs: readonly ReviewJob[];
  mode: ReviewDepth;
  maxRequests?: number;
  maxDurationMs?: number;
  maxContextCharacters?: number;
  signal?: AbortSignal;
  onProgress?: (progress: ReviewProgress) => void;
  countFindings: (value: T) => number;
  coverageOf?: (value: T, job: ReviewJob) => ReviewSpan;
  runJob: (job: ReviewJob) => Promise<T>;
}

export const REVIEW_RUN_LIMITS = {
  chunkCharacters: 6_000,
  overlapCharacters: 500,
  minimumRecoveryCharacters: 1_600,
  maxRequests: 24,
  maxDurationMs: 4 * 60_000,
  maxContextCharacters: 180_000,
} as const;

const PASS_INSTRUCTIONS: Record<ReviewJob["pass"], string> = {
  broad: "Review this passage as a whole. Find only supported, useful issues, and cover the most important ones first.",
  structure: "Focus on structure, causality, continuity, viewpoint, and the reader's understanding. Skip line edits unless they cause a larger problem.",
  line: "Focus on clarity, sentence mechanics, prose, and dialogue. Skip issues that belong only to the larger structure.",
};

export function planReviewJobs(
  text: string,
  start: number,
  end: number,
  mode: ReviewDepth,
): ReviewJob[] {
  const from = Math.max(0, Math.min(text.length, Math.floor(start)));
  const to = Math.max(from, Math.min(text.length, Math.floor(end)));
  if (to <= from) return [];

  const length = to - from;
  const chunked = mode === "exhaustive" || (mode === "standard" && length > REVIEW_RUN_LIMITS.chunkCharacters);
  const ranges = chunked
    ? splitRange(text, from, to, REVIEW_RUN_LIMITS.chunkCharacters, REVIEW_RUN_LIMITS.overlapCharacters)
    : [{ start: from, end: to }];
  const passes: ReviewJob["pass"][] =
    mode === "quick" || (mode === "standard" && length < 2_500)
      ? ["broad"]
      : mode === "standard"
        ? ["broad", "line"]
        : ["structure", "line"];

  return ranges.flatMap((range, index) =>
    passes.map((pass) => ({
      ...range,
      pass,
      instruction: PASS_INSTRUCTIONS[pass],
      part: index + 1,
      parts: ranges.length,
    })),
  );
}

export function splitRange(
  text: string,
  start: number,
  end: number,
  targetCharacters: number = REVIEW_RUN_LIMITS.chunkCharacters,
  overlapCharacters: number = REVIEW_RUN_LIMITS.overlapCharacters,
): ReviewSpan[] {
  const from = Math.max(0, Math.min(text.length, Math.floor(start)));
  const to = Math.max(from, Math.min(text.length, Math.floor(end)));
  const target = Math.max(256, Math.floor(targetCharacters));
  const overlap = Math.max(0, Math.min(Math.floor(overlapCharacters), target - 1));
  if (to - from <= target) return to > from ? [{ start: from, end: to }] : [];

  const ranges: ReviewSpan[] = [];
  let cursor = from;
  while (cursor < to) {
    const hardEnd = Math.min(to, cursor + target);
    const chunkEnd = hardEnd === to ? to : boundaryBefore(text, cursor, hardEnd, target);
    ranges.push({ start: cursor, end: chunkEnd });
    if (chunkEnd >= to) break;

    let next = Math.max(cursor + 1, chunkEnd - overlap);
    while (next < chunkEnd - 64 && !/\s/.test(text[next]!)) next += 1;
    while (next < chunkEnd && /\s/.test(text[next]!)) next += 1;
    cursor = Math.min(next, chunkEnd);
  }

  return ranges;
}

function boundaryBefore(text: string, start: number, hardEnd: number, target: number): number {
  const earliest = start + Math.floor(target * 0.65);
  const paragraph = text.lastIndexOf("\n\n", hardEnd);
  if (paragraph >= earliest) return paragraph + 2;

  const section = text.slice(earliest, hardEnd);
  const sentences = [...section.matchAll(/[.!?]["'’”)}\]]*\s+/g)];
  const sentence = sentences.at(-1);
  if (sentence?.index !== undefined) return earliest + sentence.index + sentence[0].length;

  const space = text.lastIndexOf(" ", hardEnd);
  return space >= earliest ? space + 1 : hardEnd;
}

export class ReviewOrchestrator {
  async run<T>(options: ReviewRunOptions<T>): Promise<ReviewRunResult<T>> {
    const maxRequests = Math.max(1, options.maxRequests ?? REVIEW_RUN_LIMITS.maxRequests);
    const maxDurationMs = Math.max(1, options.maxDurationMs ?? REVIEW_RUN_LIMITS.maxDurationMs);
    const maxContextCharacters = Math.max(1, options.maxContextCharacters ?? REVIEW_RUN_LIMITS.maxContextCharacters);
    const startedAt = Date.now();
    const queue = [...options.jobs];
    const results: ReviewJobResult<T>[] = [];
    const successful: ReviewSpan[] = [];
    const failed: ReviewSpan[] = [];
    const warnings = new Set<string>();
    let requests = 0;
    let contextCharacters = 0;
    let findings = 0;
    let firstError: unknown;

    while (queue.length > 0) {
      throwIfAborted(options.signal);
      const job = queue.shift()!;
      const jobContextCharacters = job.end - job.start + 4_000;

      if (requests >= maxRequests || Date.now() - startedAt >= maxDurationMs || contextCharacters + jobContextCharacters > maxContextCharacters) {
        failed.push(job, ...queue);
        warnings.add(budgetWarning(requests >= maxRequests ? "request" : contextCharacters + jobContextCharacters > maxContextCharacters ? "context" : "time"));
        break;
      }

      requests += 1;
      contextCharacters += jobContextCharacters;
      options.onProgress?.({
        phase: phaseName(job.pass),
        part: job.part,
        parts: job.parts,
        requests,
        findings,
      });

      try {
        const value = await options.runJob(job);
        throwIfAborted(options.signal);
        results.push({ job, value });
        successful.push(options.coverageOf?.(value, job) ?? job);
        findings += options.countFindings(value);
      } catch (error) {
        if (options.signal?.aborted) throw abortError();
        if (firstError === undefined) firstError = error;

        const children = recoveryJobs(options.text, job, error, options.mode);
        if (children.length > 0) {
          queue.unshift(...children);
          warnings.add("A response hit its output limit and was retried on smaller text ranges.");
        } else {
          failed.push(job);
          warnings.add("Part of the review did not complete.");
        }
      }
    }

    if (options.signal?.aborted) throw abortError();
    if (results.length === 0 && firstError !== undefined) {
      if (firstError instanceof Error) throw firstError;
      throw new Error(String(firstError));
    }
    if (results.length === 0 && failed.length > 0) {
      warnings.add("No part of the review completed, so existing notes were left alone.");
    }

    const coveredSpans = subtractSpans(mergeSpans(successful), mergeSpans(failed));
    return {
      results,
      coveredSpans,
      complete: failed.length === 0 && queue.length === 0,
      requests,
      warnings: [...warnings],
    };
  }
}

function recoveryJobs(text: string, job: ReviewJob, error: unknown, mode: ReviewDepth): ReviewJob[] {
  if (!isProviderError(error) || error.code !== "output_truncated" || mode === "quick") return [];
  if (job.end - job.start < REVIEW_RUN_LIMITS.minimumRecoveryCharacters * 2) return [];

  const ranges = splitRange(
    text,
    job.start,
    job.end,
    Math.floor((job.end - job.start) / 2),
    REVIEW_RUN_LIMITS.overlapCharacters,
  );
  return ranges.length < 2 ? [] : ranges.map((range) => ({ ...job, ...range }));
}

function mergeSpans(spans: readonly ReviewSpan[]): ReviewSpan[] {
  const sorted = [...spans].sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: ReviewSpan[] = [];
  for (const span of sorted) {
    const last = merged.at(-1);
    if (last === undefined || span.start > last.end) merged.push({ start: span.start, end: span.end });
    else last.end = Math.max(last.end, span.end);
  }
  return merged;
}

function subtractSpans(covered: readonly ReviewSpan[], failed: readonly ReviewSpan[]): ReviewSpan[] {
  let remaining = [...covered];
  for (const hole of failed) {
    remaining = remaining.flatMap((span) => {
      if (hole.end <= span.start || hole.start >= span.end) return [span];
      const pieces: ReviewSpan[] = [];
      if (hole.start > span.start) pieces.push({ start: span.start, end: hole.start });
      if (hole.end < span.end) pieces.push({ start: hole.end, end: span.end });
      return pieces;
    });
  }
  return mergeSpans(remaining);
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

function abortError(): Error {
  const error = new Error("Review cancelled");
  error.name = "AbortError";
  return error;
}

function phaseName(pass: ReviewJob["pass"]): string {
  if (pass === "structure") return "Checking structure and continuity";
  if (pass === "line") return "Checking clarity and prose";
  return "Reading the passage";
}

function budgetWarning(kind: "request" | "time" | "context"): string {
  if (kind === "request") return "The review reached its request limit before all work was done.";
  if (kind === "context") return "The review reached its context budget before all work was done.";
  return "The review reached its time limit before all work was done.";
}

export type { ProviderError };
