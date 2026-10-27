/**
 * Serializes read-modify-write sequences against a single storage key.
 *
 * Every store here does the same thing — read the current value, change it,
 * write it back — and that is not atomic over an async storage adapter. Two
 * concurrent callers each read the same snapshot and the second write
 * silently discards the first. Recovery running several entries in parallel
 * is what first exposed it.
 *
 * A promise chain rather than a real lock: each call awaits the previous
 * one's completion, so sequences run in invocation order and a throw inside
 * one does not wedge the chain (the `finally` always releases).
 *
 * Reads are deliberately *not* serialized. They tolerate a stale snapshot,
 * and routing them through the chain would let a slow write block them.
 */
export type MutationLock = <T>(fn: () => Promise<T>) => Promise<T>;

export function createMutationLock(): MutationLock {
  let tail: Promise<void> = Promise.resolve();

  return async function runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const previous = tail;
    let release!: () => void;
    tail = new Promise((resolve) => {
      release = resolve;
    });
    try {
      await previous;
      return await fn();
    } finally {
      release();
    }
  };
}
