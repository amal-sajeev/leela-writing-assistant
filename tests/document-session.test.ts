import { describe, expect, it } from "vitest";

import { DocumentSession } from "../src/review/document-session";

function session(): DocumentSession {
  return new DocumentSession("note.md");
}

describe("DocumentSession dirty tracking", () => {
  it("starts clean", () => {
    const state = session();

    expect(state.hasDirtyText).toBe(false);
    expect(state.dirtyRanges).toEqual([]);
    expect(state.isReviewing).toBe(false);
  });

  it("records a change and remembers when it happened", () => {
    const state = session();

    state.record({ ranges: [{ from: 10, to: 14 }], at: 1000 });

    expect(state.dirtyRanges).toEqual([{ from: 10, to: 14 }]);
    expect(state.latestRange).toEqual({ from: 10, to: 14 });
    expect(state.lastEditAt).toBe(1000);
  });

  it("merges nearby typing into one passage", () => {
    const state = session();

    state.record({ ranges: [{ from: 10, to: 11 }], at: 1 });
    state.record({ ranges: [{ from: 11, to: 12 }], at: 2 });
    state.record({ ranges: [{ from: 12, to: 13 }], at: 3 });

    expect(state.dirtyRanges).toEqual([{ from: 10, to: 13 }]);
  });

  it("keeps edits in two distant paragraphs apart", () => {
    const state = session();

    state.record({ ranges: [{ from: 10, to: 14 }], at: 1 });
    state.record({ ranges: [{ from: 900, to: 905 }], at: 2 });

    expect(state.dirtyRanges).toHaveLength(2);
    expect(state.latestRange).toEqual({ from: 900, to: 905 });
  });

  it("moves earlier ranges onto the newer revision", () => {
    const state = session();

    state.record({ ranges: [{ from: 500, to: 510 }], at: 1 });
    state.record({
      ranges: [{ from: 0, to: 13 }],
      mapPosition: (position) => position + 13,
      at: 2,
    });

    expect(state.dirtyRanges).toEqual([
      { from: 0, to: 13 },
      { from: 513, to: 523 },
    ]);
  });

  it("keeps the point where a changed passage was deleted", () => {
    const state = session();

    state.record({ ranges: [{ from: 500, to: 510 }], at: 1 });
    state.record({
      ranges: [{ from: 0, to: 1 }],
      mapPosition: (position) => (position >= 500 ? 400 : position),
      at: 2,
    });

    // Deleting the passage still leaves its paragraph changed, so the collapsed
    // range stays: expanding it later recovers the paragraph it sat in.
    expect(state.dirtyRanges).toEqual([
      { from: 0, to: 1 },
      { from: 400, to: 400 },
    ]);
  });

  it("notices a completed paragraph", () => {
    const state = session();

    state.record({ ranges: [{ from: 10, to: 12 }], paragraphCompleted: true, at: 1 });

    expect(state.paragraphCompleted).toBe(true);
  });

  it("keeps a paragraph completed once it has been", () => {
    const state = session();

    state.record({ ranges: [{ from: 10, to: 12 }], paragraphCompleted: true, at: 1 });
    state.record({ ranges: [{ from: 40, to: 42 }], at: 2 });

    expect(state.paragraphCompleted).toBe(true);
  });

  it("forgets everything once a review has covered it", () => {
    const state = session();

    state.record({ ranges: [{ from: 10, to: 12 }], paragraphCompleted: true, at: 1 });
    state.clearDirty();

    expect(state.hasDirtyText).toBe(false);
    expect(state.paragraphCompleted).toBe(false);
    expect(state.latestRange).toBeNull();
  });
});

describe("DocumentSession cursor", () => {
  it("treats leaving the changed line as finishing with it", () => {
    const state = session();
    state.record({ ranges: [{ from: 10, to: 20 }], at: 1 });

    state.moveCursor({ position: 400, lineFrom: 390, lineTo: 420 });

    expect(state.paragraphCompleted).toBe(true);
  });

  it("does not treat moving within the changed line as finishing", () => {
    const state = session();
    state.record({ ranges: [{ from: 10, to: 20 }], at: 1 });

    state.moveCursor({ position: 12, lineFrom: 0, lineTo: 40 });

    expect(state.paragraphCompleted).toBe(false);
  });

  it("ignores cursor movement in an unchanged note", () => {
    const state = session();

    state.moveCursor({ position: 12, lineFrom: 0, lineTo: 40 });

    expect(state.paragraphCompleted).toBe(false);
    expect(state.cursorPosition?.position).toBe(12);
  });
});

describe("DocumentSession requests", () => {
  it("hands out a generation and a live signal", () => {
    const state = session();

    const request = state.beginRequest();

    expect(request.generation).toBe(1);
    expect(request.signal.aborted).toBe(false);
    expect(state.isReviewing).toBe(true);
    expect(state.isCurrent(request.generation)).toBe(true);
  });

  it("abandons an earlier request when a newer one starts", () => {
    const state = session();

    const first = state.beginRequest();
    const second = state.beginRequest();

    expect(first.signal.aborted).toBe(true);
    expect(state.isCurrent(first.generation)).toBe(false);
    expect(state.isCurrent(second.generation)).toBe(true);
  });

  it("stops treating an aborted request as current", () => {
    const state = session();
    const request = state.beginRequest();

    state.abortRequest();

    expect(request.signal.aborted).toBe(true);
    expect(state.isCurrent(request.generation)).toBe(false);
    expect(state.isReviewing).toBe(false);
  });

  it("clears the in-flight request when it finishes", () => {
    const state = session();
    const request = state.beginRequest();

    state.finishRequest(request.generation);

    expect(state.isReviewing).toBe(false);
  });

  it("ignores a finish from a superseded request", () => {
    const state = session();
    const first = state.beginRequest();
    state.beginRequest();

    state.finishRequest(first.generation);

    expect(state.isReviewing).toBe(true);
  });
});

describe("DocumentSession stand-down", () => {
  it("holds off until the cooldown passes", () => {
    const state = session();

    state.standDown(5_000);

    expect(state.isStoodDown(4_999)).toBe(true);
    expect(state.isStoodDown(5_000)).toBe(false);
  });

  it("is not standing down to begin with", () => {
    expect(session().isStoodDown(0)).toBe(false);
  });
});
