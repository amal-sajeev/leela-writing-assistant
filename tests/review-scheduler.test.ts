import { beforeEach, describe, expect, it } from "vitest";

import type { EditorChangeReport } from "../src/editor/change-summary";
import type { DirtyRange } from "../src/review/dirty-ranges";
import {
  ReviewScheduler,
  type LiveReviewJob,
  type LiveReviewResult,
  type SchedulerState,
} from "../src/review/review-scheduler";
import { DEFAULT_SETTINGS } from "../src/settings/defaults";
import type { AIReviewerSettings } from "../src/settings/settings";
import { Logger, type LogSink } from "../src/utils/logger";
import { ManualTimers } from "./support/manual-timers";

const FILE = "note.md";

const PARAGRAPHS = [
  "The opening paragraph states the claim plainly and stops there.",
  "The second paragraph pushes the argument further than the evidence allows.",
  "The third paragraph closes the note without adding anything new.",
].join("\n\n");

const silentSink: LogSink = {
  error: () => undefined,
  warn: () => undefined,
  info: () => undefined,
  debug: () => undefined,
};

interface Harness {
  scheduler: ReviewScheduler;
  timers: ManualTimers;
  settings: AIReviewerSettings;
  jobs: LiveReviewJob[];
  states: SchedulerState[];
  /** What the next review returns, and when it returns it. */
  respond: (result: LiveReviewResult) => void;
  release: () => Promise<void>;
  text: () => string;
  setText: (text: string) => void;
}

function harness(options: { hold?: boolean } = {}): Harness {
  const timers = new ManualTimers();
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.liveReview.enabled = true;

  const jobs: LiveReviewJob[] = [];
  const states: SchedulerState[] = [];
  let text = PARAGRAPHS;
  let result: LiveReviewResult = "reviewed";
  let releaseHeld: (() => void) | null = null;

  const scheduler = new ReviewScheduler({
    getSettings: () => settings,
    snapshot: () => ({ text }),
    runReview: async (job) => {
      jobs.push(job);

      if (options.hold === true) {
        await new Promise<void>((resolve) => {
          releaseHeld = resolve;
        });
      }

      return result;
    },
    logger: new Logger("test", "debug", silentSink),
    onState: (state) => states.push(state),
    timers,
  });

  return {
    scheduler,
    timers,
    settings,
    jobs,
    states,
    respond: (next) => {
      result = next;
    },
    release: async () => {
      releaseHeld?.();
      releaseHeld = null;
      // Let the scheduler's own continuation run.
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    },
    text: () => text,
    setText: (next) => {
      text = next;
    },
  };
}

/** An edit report, as the change tracker would produce it. */
function edit(
  ranges: DirtyRange[],
  overrides: Partial<EditorChangeReport> = {},
): EditorChangeReport {
  return {
    filePath: FILE,
    ranges,
    mapPosition: (position) => position,
    documentLength: PARAGRAPHS.length,
    paragraphCompleted: false,
    at: 0,
    ...overrides,
  };
}

/** A change covering the whole second paragraph, which is worth reviewing. */
function secondParagraphEdit(overrides: Partial<EditorChangeReport> = {}): EditorChangeReport {
  const from = PARAGRAPHS.indexOf("The second");
  const to = from + "The second paragraph pushes the argument further than the evidence allows.".length;
  return edit([{ from, to }], overrides);
}

let bench: Harness;

beforeEach(() => {
  bench = harness();
});

describe("ReviewScheduler debouncing", () => {
  it("sends nothing while the author is still typing", () => {
    bench.scheduler.noteChanged(secondParagraphEdit());
    bench.timers.advance(2_400);

    expect(bench.jobs).toEqual([]);
  });

  it("reviews once the pause has elapsed", () => {
    bench.scheduler.noteChanged(secondParagraphEdit());
    bench.timers.advance(2_500);

    expect(bench.jobs).toHaveLength(1);
    expect(bench.jobs[0]?.filePath).toBe(FILE);
  });

  it("collapses a burst of keystrokes into one review", () => {
    // Typing out the end of the second paragraph, one character at a time.
    const end = PARAGRAPHS.indexOf("allows.") + "allows.".length;

    for (let index = 40; index > 0; index -= 1) {
      bench.scheduler.noteChanged(edit([{ from: end - index, to: end - index + 1 }], { at: index }));
      bench.timers.advance(100);
    }

    expect(bench.jobs).toEqual([]);

    bench.timers.advance(2_500);
    expect(bench.jobs).toHaveLength(1);
  });

  it("uses the configured pause", () => {
    bench.settings.liveReview.debounceMs = 800;

    bench.scheduler.noteChanged(secondParagraphEdit());
    bench.timers.advance(900);

    expect(bench.jobs).toHaveLength(1);
  });

  it("reports waiting, then reviewing, then idle", async () => {
    const held = harness({ hold: true });
    held.scheduler.noteChanged(secondParagraphEdit());

    expect(held.states).toContain("waiting");

    held.timers.advance(2_500);
    expect(held.states).toContain("reviewing");

    await held.release();
    expect(held.states[held.states.length - 1]).toBe("idle");
  });
});

describe("ReviewScheduler eligibility", () => {
  it("does nothing while live review is off", () => {
    bench.settings.liveReview.enabled = false;

    bench.scheduler.noteChanged(secondParagraphEdit());
    bench.timers.advance(10_000);

    expect(bench.jobs).toEqual([]);
    expect(bench.timers.armed).toBe(0);
  });

  it("does nothing while reviewing is off altogether", () => {
    bench.settings.enabled = false;

    bench.scheduler.noteChanged(secondParagraphEdit());
    bench.timers.advance(10_000);

    expect(bench.jobs).toEqual([]);
  });

  it("holds back a change below the minimum size", () => {
    const from = PARAGRAPHS.indexOf("The second");

    bench.scheduler.noteChanged(edit([{ from, to: from + 10 }]));
    bench.timers.advance(2_500);

    expect(bench.jobs).toEqual([]);
  });

  it("reviews a short change once the paragraph is finished", () => {
    const from = PARAGRAPHS.indexOf("The second");

    bench.scheduler.noteChanged(edit([{ from, to: from + 10 }], { paragraphCompleted: true }));
    bench.timers.advance(2_500);

    expect(bench.jobs).toHaveLength(1);
  });

  it("waits for the end of a sentence by default", () => {
    const text = "A finished sentence sits here. And this one is still being written out as we wat";
    bench.setText(text);

    bench.scheduler.noteChanged(edit([{ from: 31, to: text.length }]));
    bench.timers.advance(2_500);

    expect(bench.jobs).toEqual([]);
  });

  it("reviews mid-sentence when the reader asked for it", () => {
    const text = "A finished sentence sits here. And this one is still being written out as we wat";
    bench.setText(text);
    bench.settings.liveReview.reviewWhileCursorInsideParagraph = true;

    bench.scheduler.noteChanged(edit([{ from: 31, to: text.length }]));
    bench.timers.advance(2_500);

    expect(bench.jobs).toHaveLength(1);
  });

  it("reviews once the sentence is finished", () => {
    const text = "A finished sentence sits here. And this one is finished as well, at some length.";
    bench.setText(text);

    bench.scheduler.noteChanged(edit([{ from: 31, to: text.length }]));
    bench.timers.advance(2_500);

    expect(bench.jobs).toHaveLength(1);
  });

  it("reviews the paragraph, not just the characters that changed", () => {
    const from = PARAGRAPHS.indexOf("pushes");

    bench.scheduler.noteChanged(
      edit([{ from, to: from + 6 }], { paragraphCompleted: true }),
    );
    bench.timers.advance(2_500);

    const job = bench.jobs[0];
    expect(PARAGRAPHS.slice(job!.range.from, job!.range.to)).toBe(
      "The second paragraph pushes the argument further than the evidence allows.",
    );
  });

  it("reviews nothing when the note is no longer open", () => {
    const closed = new ReviewScheduler({
      getSettings: () => bench.settings,
      snapshot: () => null,
      runReview: async () => {
        throw new Error("should not be called");
      },
      logger: new Logger("test", "debug", silentSink),
      timers: bench.timers,
    });

    closed.noteChanged(secondParagraphEdit());
    bench.timers.advance(2_500);
  });
});

describe("ReviewScheduler cursor", () => {
  it("reviews a finished short passage once the cursor leaves it", () => {
    const from = PARAGRAPHS.indexOf("The second");

    bench.scheduler.noteChanged(edit([{ from, to: from + 10 }]));
    bench.timers.advance(2_500);
    expect(bench.jobs).toEqual([]);

    bench.scheduler.cursorMoved({ filePath: FILE, position: 0, lineFrom: 0, lineTo: 20 });
    bench.timers.advance(2_500);

    expect(bench.jobs).toHaveLength(1);
  });

  it("ignores cursor movement inside the changed line", () => {
    const from = PARAGRAPHS.indexOf("The second");

    bench.scheduler.noteChanged(edit([{ from, to: from + 10 }]));
    bench.scheduler.cursorMoved({ filePath: FILE, position: from + 2, lineFrom: from, lineTo: from + 70 });
    bench.timers.advance(5_000);

    expect(bench.jobs).toEqual([]);
  });

  it("ignores cursor movement in a note that never changed", () => {
    bench.scheduler.cursorMoved({ filePath: FILE, position: 0, lineFrom: 0, lineTo: 20 });
    bench.timers.advance(5_000);

    expect(bench.jobs).toEqual([]);
  });
});

describe("ReviewScheduler stale responses", () => {
  it("abandons a review of a passage the author edits again", async () => {
    const held = harness({ hold: true });
    held.scheduler.noteChanged(secondParagraphEdit());
    held.timers.advance(2_500);

    const job = held.jobs[0]!;
    expect(job.signal.aborted).toBe(false);

    held.scheduler.noteChanged(secondParagraphEdit({ at: 5_000 }));

    expect(job.signal.aborted).toBe(true);
    await held.release();
  });

  it("leaves a review of another passage alone", async () => {
    const held = harness({ hold: true });
    held.scheduler.noteChanged(secondParagraphEdit());
    held.timers.advance(2_500);

    const job = held.jobs[0]!;
    held.scheduler.noteChanged(edit([{ from: 0, to: 5 }], { at: 5_000 }));

    expect(job.signal.aborted).toBe(false);
    await held.release();
  });

  it("reviews the passage again when it changed during the request", async () => {
    const held = harness({ hold: true });
    held.scheduler.noteChanged(secondParagraphEdit());
    held.timers.advance(2_500);

    // An edit elsewhere: the response stands, but the new passage is still dirty.
    held.scheduler.noteChanged(secondParagraphEdit({ at: 6_000 }));
    await held.release();

    held.timers.advance(2_500);
    expect(held.jobs).toHaveLength(2);
  });

  it("forgets what it reviewed when nothing changed meanwhile", async () => {
    bench.scheduler.noteChanged(secondParagraphEdit());
    bench.timers.advance(2_500);
    await bench.release();

    bench.timers.advance(10_000);
    expect(bench.jobs).toHaveLength(1);
  });

  it("keeps the passage dirty when a review was cancelled", async () => {
    bench.respond("cancelled");
    bench.scheduler.noteChanged(secondParagraphEdit());
    bench.timers.advance(2_500);
    await bench.release();

    bench.scheduler.noteChanged(edit([{ from: 0, to: 4 }], { at: 9_000 }));
    bench.timers.advance(2_500);

    expect(bench.jobs).toHaveLength(2);
  });
});

describe("ReviewScheduler concurrency", () => {
  it("runs one live review per note at a time", async () => {
    const held = harness({ hold: true });
    held.scheduler.noteChanged(secondParagraphEdit());
    held.timers.advance(2_500);

    held.scheduler.noteChanged(edit([{ from: 0, to: 5 }], { at: 3_000 }));
    held.timers.advance(2_500);

    expect(held.jobs).toHaveLength(1);

    // The waiting change is picked up once the first review is out of the way.
    await held.release();
    held.timers.advance(2_500);

    expect(held.jobs).toHaveLength(2);
  });

  it("holds a third note back until a slot frees up", async () => {
    const timers = new ManualTimers();
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.liveReview.enabled = true;

    const jobs: LiveReviewJob[] = [];
    const releases: Array<() => void> = [];

    const scheduler = new ReviewScheduler({
      getSettings: () => settings,
      snapshot: () => ({ text: PARAGRAPHS }),
      runReview: async (job) => {
        jobs.push(job);
        await new Promise<void>((resolve) => releases.push(resolve));
        return "reviewed";
      },
      logger: new Logger("test", "debug", silentSink),
      timers,
    });

    const from = PARAGRAPHS.indexOf("The second");
    const range = [{ from, to: from + 70 }];

    for (const path of ["a.md", "b.md", "c.md"]) {
      scheduler.noteChanged({
        filePath: path,
        ranges: range,
        mapPosition: (position) => position,
        documentLength: PARAGRAPHS.length,
        paragraphCompleted: true,
        at: 0,
      });
    }

    timers.advance(2_500);
    expect(jobs).toHaveLength(2);

    for (const release of releases) release();
    await Promise.resolve();
    await Promise.resolve();

    timers.advance(750);
    expect(jobs).toHaveLength(3);
  });
});

describe("ReviewScheduler manual priority", () => {
  it("abandons a live review when a manual one starts", async () => {
    const held = harness({ hold: true });
    held.scheduler.noteChanged(secondParagraphEdit());
    held.timers.advance(2_500);

    const job = held.jobs[0]!;
    held.scheduler.manualReviewStarted(FILE);

    expect(job.signal.aborted).toBe(true);
    await held.release();
  });

  it("waits rather than queueing behind a manual review", () => {
    bench.scheduler.manualReviewStarted(FILE);
    bench.scheduler.noteChanged(secondParagraphEdit());
    bench.timers.advance(2_500);

    expect(bench.jobs).toEqual([]);
  });

  it("treats a manual review as covering what changed", () => {
    bench.scheduler.noteChanged(secondParagraphEdit());
    bench.scheduler.manualReviewStarted(FILE);
    bench.scheduler.manualReviewFinished(FILE);
    bench.timers.advance(10_000);

    expect(bench.jobs).toEqual([]);
  });

  it("resumes live review of other changes afterwards", () => {
    bench.scheduler.manualReviewStarted("other.md");
    bench.scheduler.noteChanged(secondParagraphEdit());
    bench.timers.advance(2_500);
    expect(bench.jobs).toEqual([]);

    bench.scheduler.manualReviewFinished("other.md");
    bench.timers.advance(2_500);

    expect(bench.jobs).toHaveLength(1);
  });

  it("stays out of the way until every manual review has finished", () => {
    // A second manual request that is refused still reports finishing.
    bench.scheduler.manualReviewStarted("other.md");
    bench.scheduler.manualReviewStarted("other.md");
    bench.scheduler.noteChanged(secondParagraphEdit());

    bench.scheduler.manualReviewFinished("other.md");
    bench.timers.advance(5_000);
    expect(bench.jobs).toEqual([]);

    bench.scheduler.manualReviewFinished("other.md");
    bench.timers.advance(2_500);
    expect(bench.jobs).toHaveLength(1);
  });
});

describe("ReviewScheduler superseded requests", () => {
  it("still abandons the newer review after the older one returns", async () => {
    const timers = new ManualTimers();
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.liveReview.enabled = true;

    const jobs: LiveReviewJob[] = [];
    const releases: Array<() => void> = [];

    const scheduler = new ReviewScheduler({
      getSettings: () => settings,
      snapshot: () => ({ text: PARAGRAPHS }),
      runReview: async (job) => {
        jobs.push(job);
        await new Promise<void>((resolve) => releases.push(resolve));
        return job.signal.aborted ? "cancelled" : "reviewed";
      },
      logger: new Logger("test", "debug", silentSink),
      timers,
    });

    scheduler.noteChanged(secondParagraphEdit());
    timers.advance(2_500);

    // The author edits the passage, and a second review starts while the first,
    // already abandoned, is still on its way back.
    scheduler.noteChanged(secondParagraphEdit({ at: 5_000 }));
    timers.advance(2_500);
    expect(jobs).toHaveLength(2);

    releases[0]!();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    scheduler.noteChanged(secondParagraphEdit({ at: 9_000 }));
    expect(jobs[1]!.signal.aborted).toBe(true);

    releases[1]!();
    await Promise.resolve();
  });
});

describe("ReviewScheduler cancellation", () => {
  it("cancels everything when live review is turned off", async () => {
    const held = harness({ hold: true });
    held.scheduler.noteChanged(secondParagraphEdit());
    held.timers.advance(2_500);
    const job = held.jobs[0]!;

    held.settings.liveReview.enabled = false;
    held.scheduler.settingsChanged();

    expect(job.signal.aborted).toBe(true);
    expect(held.timers.armed).toBe(0);
    await held.release();
  });

  it("keeps scheduling when settings change but live review stays on", () => {
    bench.scheduler.noteChanged(secondParagraphEdit());
    bench.scheduler.settingsChanged();
    bench.timers.advance(2_500);

    expect(bench.jobs).toHaveLength(1);
  });

  it("forgets a note that was closed or deleted", async () => {
    const held = harness({ hold: true });
    held.scheduler.noteChanged(secondParagraphEdit());
    held.timers.advance(2_500);
    const job = held.jobs[0]!;

    held.scheduler.forget(FILE);

    expect(job.signal.aborted).toBe(true);
    await held.release();

    held.timers.advance(10_000);
    expect(held.jobs).toHaveLength(1);
  });

  it("cancels a pending pause on unload", () => {
    bench.scheduler.noteChanged(secondParagraphEdit());
    bench.scheduler.cancelAll();
    bench.timers.advance(10_000);

    expect(bench.jobs).toEqual([]);
  });
});

describe("ReviewScheduler failures", () => {
  it("stands down for a while after a provider failure", async () => {
    bench.respond("failed");
    bench.scheduler.noteChanged(secondParagraphEdit());
    bench.timers.advance(2_500);
    await bench.release();

    bench.scheduler.noteChanged(secondParagraphEdit({ at: 20_000 }));
    bench.timers.advance(2_500);

    expect(bench.jobs).toHaveLength(1);
  });

  it("tries again once the cooldown has passed", async () => {
    bench.respond("failed");
    bench.scheduler.noteChanged(secondParagraphEdit());
    bench.timers.advance(2_500);
    await bench.release();

    bench.respond("reviewed");
    bench.timers.advance(60_000);
    bench.scheduler.noteChanged(secondParagraphEdit({ at: 90_000 }));
    bench.timers.advance(2_500);

    expect(bench.jobs).toHaveLength(2);
  });

  it("survives a review that throws and stands down after it", async () => {
    const timers = new ManualTimers();
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.liveReview.enabled = true;
    let calls = 0;

    const scheduler = new ReviewScheduler({
      getSettings: () => settings,
      snapshot: () => ({ text: PARAGRAPHS }),
      runReview: () => {
        calls += 1;
        return Promise.reject(new Error("boom"));
      },
      logger: new Logger("test", "debug", silentSink),
      timers,
    });

    scheduler.noteChanged(secondParagraphEdit({ paragraphCompleted: true }));
    timers.advance(2_500);
    await Promise.resolve();
    await Promise.resolve();

    timers.advance(30_000);
    expect(calls).toBe(1);
  });
});

describe("ReviewScheduler save", () => {
  it("reviews on save when asked to", () => {
    bench.settings.liveReview.reviewOnSave = true;

    bench.scheduler.noteChanged(edit([{ from: 0, to: 8 }]));
    bench.scheduler.noteSaved(FILE);
    bench.timers.advance(0);

    expect(bench.jobs).toHaveLength(1);
  });

  it("ignores a save when that setting is off", () => {
    bench.scheduler.noteChanged(edit([{ from: 0, to: 8 }]));
    bench.scheduler.noteSaved(FILE);
    bench.timers.advance(0);

    expect(bench.jobs).toEqual([]);
  });

  it("ignores a save with nothing changed", () => {
    bench.settings.liveReview.reviewOnSave = true;

    bench.scheduler.noteSaved(FILE);
    bench.timers.advance(0);

    expect(bench.jobs).toEqual([]);
  });
});
