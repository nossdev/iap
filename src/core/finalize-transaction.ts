import type { NativeAdapter } from '../adapters/native/types.js';
import type { Logger } from '../lib/logger.js';
import type { NativeTransaction } from '../types/transaction.js';

/**
 * Finish a verified transaction with the store: acknowledge it, or consume
 * it when that is what the product needs.
 *
 * One function rather than each caller deciding for itself, because getting
 * it wrong is silent in both directions and the paths that settle a
 * transaction are not obviously related: a purchase, a restore, launch
 * recovery, and a transaction arriving on its own. (Three call sites for
 * those four paths — recovery's `processTransaction` serves the last two.)
 *
 * ## Why consuming is a separate thing
 *
 * On Android, acknowledging a purchase tells Play "I have granted this", and
 * consuming additionally tells it "ownership is released". For a consumable
 * only the second allows the product to be bought again — acknowledging
 * alone leaves Play reporting it owned forever, and `purchase()` of it then
 * fails `ALREADY_PURCHASED`. The user has paid for a consumable they can
 * never buy a second time, and no amount of retrying fixes it.
 *
 * Consuming also acknowledges, so this is one call either way, never both.
 *
 * iOS has no equivalent: `Transaction.finish()` — which `acknowledge()`
 * calls — is the whole of finishing there, for every product type. So the
 * consume branch is Google-only, and an adapter that does not implement
 * `consume` falls back to acknowledging, which still protects the refund
 * window even though the product stays owned.
 *
 * ## Ordering
 *
 * Called only **after** verification succeeds, on every path. That is iap's
 * central invariant and it is stronger here than elsewhere: a consumed
 * purchase is gone from `getPurchases()` in Billing 8.x, so consuming
 * before verifying would make a failed verification unrecoverable rather
 * than merely retried.
 *
 * ## On failure
 *
 * Throws, so the caller keeps the transaction's unfinished entry and
 * recovery retries on the next launch. Before throwing, a failed *consume*
 * falls back to acknowledging — not as a substitute, but to stop Google's
 * three-day auto-refund clock while the retry is pending.
 */
export async function finalizeTransaction(opts: {
  nativeAdapter: NativeAdapter;
  transaction: NativeTransaction;
  logger: Logger;
}): Promise<void> {
  const { nativeAdapter, transaction, logger } = opts;

  if (transaction.platform !== 'google' || transaction.productType !== 'consumable') {
    await nativeAdapter.acknowledge(transaction);
    return;
  }

  if (!nativeAdapter.consume) {
    // A custom adapter. (Not an old plugin: the peer range floor is the
    // version that added `consumePurchase()`, and the capgo adapter always
    // implements this.) Acknowledging is the safe fallback — the refund
    // window is what matters most — but say so, because the product will
    // stay owned and unbuyable.
    logger.warn(
      `The native adapter cannot consume, so "${transaction.productId}" was only acknowledged. Google will keep reporting it owned, and buying it again will fail with ALREADY_PURCHASED.`,
    );
    await nativeAdapter.acknowledge(transaction);
    return;
  }

  try {
    await nativeAdapter.consume(transaction);
  } catch (error) {
    // Acknowledge before giving up, for the refund window.
    //
    // A consume that fails leaves the purchase neither consumed nor
    // acknowledged, and Google auto-refunds an unacknowledged purchase
    // after three days — so a transient billing error would cost the user
    // a purchase iap had already granted them. Acknowledging stops that
    // clock without closing anything off: an acknowledged purchase can
    // still be consumed, so the retry below is still open.
    //
    // Best-effort, and usually futile — whatever broke the consume has
    // normally broken this too, and if the consume in fact *succeeded* and
    // only the bridge reply failed, there is no purchase left to
    // acknowledge. Either way the original error is what the caller needs.
    try {
      await nativeAdapter.acknowledge(transaction);
      logger.debug(
        `Consuming "${transaction.productId}" failed; acknowledged it instead so Google does not auto-refund, and the consume will be retried.`,
      );
    } catch {
      // Swallowed deliberately: it is a safety net, not the operation.
    }
    throw error;
  }
}
