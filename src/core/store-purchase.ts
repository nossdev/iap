import type { StorePurchase } from '../types/results.js';
import type { NativeTransaction } from '../types/transaction.js';

/**
 * Project a normalized {@link NativeTransaction} down to the public
 * {@link StorePurchase} a consumer sees.
 *
 * Deliberately a narrowing rather than a pass-through: `token` is the
 * acknowledge handle and `raw` is the plugin's own shape, and neither is
 * part of iap's contract. Exposing the transaction wholesale would promise
 * both, and `raw` cannot be promised across plugin versions at all.
 */
export function toStorePurchase(tx: NativeTransaction): StorePurchase {
  return {
    platform: tx.platform,
    productId: tx.productId,
    purchaseReference: tx.purchaseReference,
    appUserId: tx.appUserId ?? null,
    subscription: tx.subscription ?? null,
  };
}
