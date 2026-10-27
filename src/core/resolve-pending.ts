import type { TypedEventEmitter } from '../events/emitter.js';
import type { EntitlementBase } from '../types/entitlement.js';
import type { PendingPurchasesStore } from './pending-purchases.js';

export interface ResolvePendingDeps<TEntitlement extends EntitlementBase> {
  pending: PendingPurchasesStore;
  emitter: TypedEventEmitter<TEntitlement>;
}

/**
 * Clear a product's pending mark and announce how it ended, if it was marked.
 *
 * Lives on its own because **every** path that settles a transaction has to
 * do this, not just the one that handles out-of-band updates. A pending
 * purchase can be finished by a later `purchase()` retry, by `restore()`, by
 * launch recovery, or by the update listener — and a path that settles the
 * purchase without clearing the mark leaves it behind to be reported
 * `cancelled` on a subsequent reconcile. Telling a consumer a purchase was
 * cancelled after it succeeded is the worst answer this feature can give.
 *
 * Atomic via {@link PendingPurchasesStore.takeIfPresent}: the callers can
 * overlap, and `purchase-pending-resolved` promises to fire at most once per
 * pending purchase.
 *
 * Emits nothing when the product was not marked pending, which is the common
 * case — an ordinary purchase or renewal was never announced as pending.
 */
export async function resolvePendingPurchase<TEntitlement extends EntitlementBase>(
  deps: ResolvePendingDeps<TEntitlement>,
  productId: string,
  status: 'purchased' | 'cancelled',
): Promise<void> {
  if (!(await deps.pending.takeIfPresent(productId))) return;
  deps.emitter.emit('purchase-pending-resolved', { productId, status });
}
