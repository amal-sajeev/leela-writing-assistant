export interface Debounced<A extends unknown[]> {
  call(...args: A): void;
  cancel(): void;
  /** Runs a pending call immediately, if one is scheduled. */
  flush(): void;
  isPending(): boolean;
}

/**
 * Trailing-edge debounce. Every call restarts the timer, which is the behaviour
 * live review depends on (specification section 17).
 */
export function debounce<A extends unknown[]>(fn: (...args: A) => void, waitMs: number): Debounced<A> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pendingArgs: A | undefined;

  const run = (): void => {
    timer = undefined;
    const args = pendingArgs;
    pendingArgs = undefined;
    if (args) fn(...args);
  };

  return {
    call(...args: A): void {
      pendingArgs = args;
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(run, waitMs);
    },
    cancel(): void {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      pendingArgs = undefined;
    },
    flush(): void {
      if (timer === undefined) return;
      clearTimeout(timer);
      run();
    },
    isPending(): boolean {
      return timer !== undefined;
    },
  };
}
