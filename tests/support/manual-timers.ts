import type { SchedulerTimers } from "../../src/review/review-scheduler";

/**
 * Timers a test drives by hand, so scheduling behaviour can be asserted without
 * waiting for real time or depending on how many microtasks something uses.
 */
export class ManualTimers implements SchedulerTimers {
  private readonly pending = new Map<number, { at: number; handler: () => void }>();
  private nextHandle = 1;
  private current = 0;

  setTimeout(handler: () => void, ms: number): unknown {
    const handle = this.nextHandle;
    this.nextHandle += 1;
    this.pending.set(handle, { at: this.current + Math.max(0, ms), handler });
    return handle;
  }

  clearTimeout(handle: unknown): void {
    this.pending.delete(handle as number);
  }

  now(): number {
    return this.current;
  }

  get armed(): number {
    return this.pending.size;
  }

  /** Moves time forward, running whatever falls due in order. */
  advance(ms: number): void {
    const target = this.current + ms;

    for (;;) {
      const due = [...this.pending.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((a, b) => a[1].at - b[1].at || a[0] - b[0]);

      const next = due[0];
      if (next === undefined) break;

      const [handle, timer] = next;
      this.pending.delete(handle);
      this.current = Math.max(this.current, timer.at);
      timer.handler();
    }

    this.current = target;
  }
}
