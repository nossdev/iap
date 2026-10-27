import type { NativeAdapter, TransactionWatchHandle } from '../adapters/native/types.js';
import type { Logger } from '../lib/logger.js';
import type { EntitlementBase } from '../types/entitlement.js';
import type { TransactionUpdateOrchestrator } from './transaction-updates.js';

export interface AttachTransactionWatchOptions<TEntitlement extends EntitlementBase> {
  adapter: NativeAdapter;
  updates: TransactionUpdateOrchestrator<TEntitlement>;
  logger: Logger;
}

/**
 * Subscribe to the platform's transaction feed, if it has one.
 *
 * Lives outside `initialize()` because the two subtle lines in it deserve a
 * home where they can be explained, rather than being three of two hundred
 * in a lifecycle function:
 *
 * - **The handler is deliberately not awaited.** It runs from a native
 *   callback, which has nobody to await it and nowhere to put a rejection.
 *   `handle` is written never to reject, so `void` is the honest spelling
 *   rather than a swallowed promise.
 * - **`null` is a real answer, not a failure.** An adapter may have no feed
 *   to offer — Android does not, today — and that is not an error: launch
 *   recovery and refresh-on-resume cover the same ground more slowly. The
 *   same `null` also comes back when subscribing failed, which is why this
 *   returns one value for both and logs the difference.
 *
 * Never throws. A missing listener costs latency, not correctness, so it
 * must not be able to fail `initialize()`.
 */
export async function attachTransactionWatch<TEntitlement extends EntitlementBase>(
  opts: AttachTransactionWatchOptions<TEntitlement>,
): Promise<TransactionWatchHandle | null> {
  const { adapter, updates, logger } = opts;

  let handle: TransactionWatchHandle | null;
  try {
    handle =
      (await adapter.watchTransactions?.((transaction) => {
        void updates.handle(transaction);
      })) ?? null;
  } catch (error) {
    logger.warn(
      'Failed to subscribe to native transaction updates; renewals and refunds will be picked up at the next launch or resume instead.',
      error,
    );
    return null;
  }

  if (handle === null) {
    logger.debug(
      'No native transaction feed on this platform; relying on recovery at launch and refresh on resume.',
    );
  }
  return handle;
}
