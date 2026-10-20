export class TimeoutError extends Error {
  constructor(message = "Operation timed out") {
    super(message);
    this.name = "TimeoutError";
  }
}

/** Resolves after `ms`, or rejects with an `AbortError` as soon as `signal` fires. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal === undefined) return new Promise((resolve) => window.setTimeout(resolve, ms));

  return new Promise((resolve, reject) => {
    const abort = (): void => {
      window.clearTimeout(timer);
      const error = new Error("Request aborted");
      error.name = "AbortError";
      reject(error);
    };

    const timer = window.setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);

    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
}

/**
 * Rejects with {@link TimeoutError} when `promise` does not settle in time.
 * The underlying work is not cancelled; callers that support cancellation pass
 * an AbortSignal to the operation itself.
 */
export function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  if (timeoutMs <= 0) return promise;

  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new TimeoutError()), timeoutMs);
    promise.then(
      (value) => {
        window.clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        window.clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

export function isAbortError(error: unknown): boolean {
  if (error instanceof DOMException) return error.name === "AbortError";
  return error instanceof Error && error.name === "AbortError";
}

/** Serializes async work so that persistence writes cannot interleave. */
export class TaskQueue {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task, task);
    // Keep the chain alive even when a task rejects.
    this.tail = result.catch(() => undefined);
    return result;
  }

  /** Resolves once all queued work has settled. */
  async drain(): Promise<void> {
    await this.tail;
  }
}
