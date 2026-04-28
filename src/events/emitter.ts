import type { EntitlementBase } from '../types/entitlement.js';
import type { EventMap, EventName, EventPayload, Unsubscribe } from '../types/events.js';

type AnyHandler = (payload: unknown) => void;

/**
 * Tiny typed event emitter. No external dep — just a Map of name → Set<handler>.
 * Generic over the consumer's entitlement type so payloads are statically checked.
 */
export class TypedEventEmitter<TEntitlement extends EntitlementBase = EntitlementBase> {
  private readonly handlers = new Map<string, Set<AnyHandler>>();

  on<K extends EventName<TEntitlement>>(
    event: K,
    handler: (payload: EventPayload<K, TEntitlement>) => void,
  ): Unsubscribe {
    const key = event as string;
    let set = this.handlers.get(key);
    if (!set) {
      set = new Set();
      this.handlers.set(key, set);
    }
    set.add(handler as AnyHandler);
    return () => {
      const current = this.handlers.get(key);
      if (current) current.delete(handler as AnyHandler);
    };
  }

  emit<K extends EventName<TEntitlement>>(event: K, payload: EventPayload<K, TEntitlement>): void {
    const set = this.handlers.get(event as string);
    if (!set) return;
    for (const handler of [...set]) {
      try {
        handler(payload);
      } catch {
        // Handlers must not break the emitter. Swallow to keep other listeners alive.
      }
    }
  }

  removeAll(): void {
    this.handlers.clear();
  }

  /** Number of listeners for a given event — used by tests. */
  listenerCount(event: keyof EventMap<TEntitlement>): number {
    return this.handlers.get(event as string)?.size ?? 0;
  }
}
