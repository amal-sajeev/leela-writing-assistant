import { describe, expect, it, vi } from "vitest";

import { ProviderError } from "../src/providers/provider-errors";
import { planReviewJobs, ReviewOrchestrator, splitRange } from "../src/review/review-orchestrator";

describe("review planning", () => {
  it("splits at readable boundaries with overlap and complete source coverage", () => {
    const text = `${"First paragraph. ".repeat(180)}\n\n${"Second paragraph. ".repeat(180)}`;
    const spans = splitRange(text, 0, text.length, 900, 120);

    expect(spans.length).toBeGreaterThan(2);
    expect(spans[0]?.start).toBe(0);
    expect(spans.at(-1)?.end).toBe(text.length);
    for (let index = 1; index < spans.length; index += 1) {
      expect(spans[index]!.start).toBeLessThan(spans[index - 1]!.end);
    }
    expect(spans.every((span) => span.end > span.start)).toBe(true);
  });

  it("keeps quick to one pass and adds focused passes for deeper reviews", () => {
    const text = "A paragraph. ".repeat(400);
    expect(planReviewJobs(text, 0, 100, "quick").map((job) => job.pass)).toEqual(["broad"]);
    expect(planReviewJobs(text, 0, 3_000, "standard").map((job) => job.pass)).toEqual(["broad", "line"]);
    expect(planReviewJobs(text, 0, 3_000, "exhaustive").map((job) => job.pass)).toEqual(["structure", "line"]);
  });
});

describe("review execution", () => {
  it("retries truncated responses on smaller ranges", async () => {
    const text = "Sentence. ".repeat(500);
    const runJob = vi.fn(async (job: { start: number; end: number }) => {
      if (job.end - job.start > 4_000) throw new ProviderError("output_truncated", "cut", false);
      return { comments: [1], span: { start: job.start, end: job.end } };
    });

    const result = await new ReviewOrchestrator().run({
      text,
      jobs: [{ start: 0, end: text.length, pass: "broad", instruction: "", part: 1, parts: 1 }],
      mode: "standard",
      maxRequests: 8,
      countFindings: (value) => value.comments.length,
      coverageOf: (value) => value.span,
      runJob,
    });

    expect(runJob.mock.calls.length).toBeGreaterThan(1);
    expect(runJob.mock.calls.slice(1).every(([job]) => job.end - job.start < text.length)).toBe(true);
    expect(result.complete).toBe(true);
    expect(result.coveredSpans).toEqual([{ start: 0, end: text.length }]);
    expect(result.warnings[0]).toContain("output limit");
  });

  it("keeps successful ranges when another part fails", async () => {
    const text = "x".repeat(4_000);
    const jobs = [0, 2_000].map((start, index) => ({
      start,
      end: start + 1_000,
      pass: "broad" as const,
      instruction: "",
      part: index + 1,
      parts: 2,
    }));

    const result = await new ReviewOrchestrator().run({
      text,
      jobs,
      mode: "standard",
      countFindings: () => 1,
      runJob: async (job) => {
        if (job.start === 2_000) throw new ProviderError("provider_error", "failed", false);
        return { span: { start: job.start, end: job.end } };
      },
    });

    expect(result.complete).toBe(false);
    expect(result.results).toHaveLength(1);
    expect(result.coveredSpans).toEqual([{ start: 0, end: 1_000 }]);
  });

  it("stops cleanly when cancelled", async () => {
    const controller = new AbortController();
    const text = "x".repeat(2_000);

    await expect(new ReviewOrchestrator().run({
      text,
      jobs: [{ start: 0, end: text.length, pass: "broad", instruction: "", part: 1, parts: 1 }],
      mode: "quick",
      signal: controller.signal,
      countFindings: () => 0,
      runJob: async () => {
        controller.abort();
        return {};
      },
    })).rejects.toMatchObject({ name: "AbortError" });
  });
});
