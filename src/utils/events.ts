export type Unsubscribe = () => void;

/**
 * Minimal typed publish/subscribe used so that UI subscribes to state changes
 * instead of reaching into services (specification section 80).
 *
 * A throwing listener must not prevent other listeners from running.
 */
export class EventBus<E extends { type: string }> {
  private listeners = new Set<(event: E) => void>();

  constructor(private readonly onListenerError?: (error: unknown, event: E) => void) {}

  subscribe(listener: (event: E) => void): Unsubscribe {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  emit(event: E): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch (error) {
        this.onListenerError?.(error, event);
      }
    }
  }

  clear(): void {
    this.listeners.clear();
  }

  get size(): number {
    return this.listeners.size;
  }
}
