import { NativePurchases } from '@capgo/native-purchases';
import type { Logger } from '../../../lib/logger.js';
import { getPlatform } from '../../../lib/platform.js';
import type { NativeTransaction } from '../../../types/transaction.js';
import type { TransactionWatchHandle } from '../types.js';
import { inferProductType, normalizeTransaction } from './normalize-transaction.js';

/**
 * Subscribe to the plugin's transaction feed.
 *
 * **iOS only, in practice.** The plugin emits `transactionUpdated` from
 * Apple's `Transaction.updates` and has no Android equivalent — the Android
 * side notifies no listeners at all (asserted in
 * `tests/unit/native-plugin-contract.test.ts`). The listener is registered on
 * both platforms anyway: it costs nothing on Android, and it lights up on its
 * own if capgo ever adds the event.
 *
 * Also subscribes to `transactionVerificationFailed`, which fires when
 * StoreKit hands the plugin an unverified transaction. That one is logged
 * rather than surfaced as an event: its payload carries a transaction id and
 * an error string but **no product id**, and iap's `verification-failed`
 * event requires one. A half-populated event would be worse than a log.
 */
export async function watchCapgoTransactions(
  onUpdate: (transaction: NativeTransaction) => void,
  logger: Logger,
  packageName?: string,
): Promise<TransactionWatchHandle | null> {
  const handles: Array<{ remove(): Promise<void> }> = [];

  try {
    handles.push(
      await NativePurchases.addListener('transactionUpdated', (tx) => {
        // This runs on a native callback. A throw here has nowhere useful to
        // go — it would surface as an unhandled rejection in the bridge, or
        // be swallowed — so it stops at the boundary.
        try {
          onUpdate(normalizeTransaction(tx, inferProductType(tx), packageName));
        } catch (error) {
          logger.warn('transactionUpdated handler threw; ignoring the update.', error);
        }
      }),
    );
  } catch (error) {
    logger.warn(
      'Could not subscribe to native transaction updates; renewals and refunds will be picked up at the next launch or resume instead.',
      error,
    );
    return null;
  }

  try {
    handles.push(
      await NativePurchases.addListener('transactionVerificationFailed', (payload) => {
        // Never log the transaction id: it is a receipt identifier.
        logger.warn(
          `The store reported a transaction that failed Apple's verification; ignoring it. Reason: ${payload.error}`,
        );
      }),
    );
  } catch (error) {
    // Non-fatal: the update listener above is the one that matters.
    logger.debug('Could not subscribe to transactionVerificationFailed.', error);
  }

  return {
    async remove() {
      for (const handle of handles) {
        try {
          await handle.remove();
        } catch (error) {
          logger.warn('Failed to remove a native transaction listener.', error);
        }
      }
    },
  };
}

/**
 * Product ids with a purchase awaiting clearance, or `null` when the
 * platform cannot say.
 *
 * Android only, and the state check here is the inverse of the one
 * {@link CapgoNativeAdapter.getOwnedTransactions} applies — a pending
 * purchase is precisely one the store has but does not call owned.
 *
 * **Do not read the state constants from the plugin's `.d.ts`.** It says
 * `"0": Payment pending`, which is wrong. The value is Play's own
 * `Purchase.PurchaseState` int, stringified verbatim by the plugin
 * (`String.valueOf(purchase.getPurchaseState())`), and in
 * `com.android.billingclient:billing` that enum is
 * `UNSPECIFIED_STATE = 0, PURCHASED = 1, PENDING = 2`. Filtering on `'0'`
 * matches nothing Play ever emits — `getPurchaseState()` returns only 1 or 2 —
 * so it would report every pending purchase as having vanished.
 *
 * Expressed as "has it, does not own it" rather than `=== '2'` so that
 * `UNSPECIFIED_STATE`, and any state Play adds later, also count as
 * not-yet-granted rather than as gone.
 *
 * iOS resolves `null`, not `[]`, and the difference matters: StoreKit gives
 * no way to enumerate deferred purchases, so "nothing pending" is not
 * something iap can observe there. Returning `[]` would let the caller
 * conclude a deferred purchase had been cancelled while the parent was
 * still deciding.
 */
export async function getCapgoPendingProductIds(logger: Logger): Promise<string[] | null> {
  if (getPlatform() !== 'android') return null;

  try {
    const result = await NativePurchases.getPurchases();
    return result.purchases
      .filter((tx) => tx.purchaseState !== undefined && tx.purchaseState !== '1')
      .map((tx) => tx.productIdentifier);
  } catch (error) {
    // Cannot tell, which is not the same as nothing pending.
    logger.warn('Could not read pending purchases from the store.', error);
    return null;
  }
}
