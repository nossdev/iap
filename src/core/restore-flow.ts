import type {
  BackendAdapter,
  RestoreRequest,
  RestoreRequestTransaction,
  RestoreResponse,
} from '../adapters/backend/types.js';
import type { NativeAdapter } from '../adapters/native/types.js';
import type { TypedEventEmitter } from '../events/emitter.js';
import { IAPError, IAPErrorCode, toIAPError } from '../lib/errors.js';
import type { Logger } from '../lib/logger.js';
import type { EntitlementBase } from '../types/entitlement.js';
import type { RestoreResult } from '../types/results.js';
import type { NativeTransaction } from '../types/transaction.js';
import { type EntitlementCache, entitlementsEqual } from './entitlement-cache.js';
import { finalizeTransaction } from './finalize-transaction.js';
import type { PendingPurchasesStore } from './pending-purchases.js';
import { resolvePendingPurchase } from './resolve-pending.js';
import { toStorePurchase } from './store-purchase.js';
import type { UnfinishedTransactionsStore } from './unfinished-transactions.js';

interface RestoreOrchestratorDeps<TEntitlement extends EntitlementBase> {
  nativeAdapter: NativeAdapter;
  backend: BackendAdapter<TEntitlement>;
  cache: EntitlementCache<TEntitlement>;
  unfinished: UnfinishedTransactionsStore;
  /**
   * So a pending mark this restore settles is cleared.
   *
   * Restore used to be the one settle path without this, and it was
   * survivable only by accident: an acknowledged purchase stays in the
   * store's owned set, so the next reconcile found it and cleared the mark
   * one pass late. A **consumed** purchase is gone from that set, so the
   * reconcile instead sees it neither owned nor pending and reports it
   * `cancelled` — for a purchase that succeeded.
   */
  pending: PendingPurchasesStore;
  emitter: TypedEventEmitter<TEntitlement>;
  logger: Logger;
  getCurrentEntitlements: () => TEntitlement[];
  setEntitlements: (next: TEntitlement[]) => void;
  setCachePersisted: (cachedAt: number) => void;
}

/**
 * Coordinates `iap.restorePurchases()` per PLAN.md §5.5.
 *
 * Sequence:
 * 1. Emit `restore-started`.
 * 2. `nativeAdapter.getOwnedTransactions()` (delegates to the capgo plugin's
 *    `getPurchases()`).
 * 3. If empty → emit `restore-completed` with current entitlements,
 *    return `{ restored: 0, entitlements: <current> }`. No backend call.
 *    This covers fresh-install-no-purchases. The empty-array guard lives
 *    here (orchestrator level) rather than in the HTTP adapter so all
 *    transport implementations benefit automatically.
 * 4. POST batch to `backend.restore()`.
 * 5. On `valid: true`:
 *    - Settle each verified transaction with the store — acknowledge, or
 *      consume for an Android consumable (see `finalizeTransaction`).
 *      Best-effort per transaction; one that fails keeps its unfinished
 *      entry so recovery retries it on the next launch.
 *    - Persist consolidated entitlements via `cache.save()`.
 *    - Replace state.
 *    - Remove from `unfinished_transactions` (defensive — purchase flow may
 *      have left an entry there for one of these tokens after a crash).
 *    - Emit `restore-completed` then `entitlements-changed`.
 * 6. On `valid: false` or backend throw: throw `IAPError` (orchestrator
 *    surface is throw-on-fail, unlike `purchase()` which returns a
 *    discriminated union; restore is consumer-initiated and a thrown
 *    error is the right shape for "Restore Purchases" buttons).
 */
export class RestoreOrchestrator<TEntitlement extends EntitlementBase = EntitlementBase> {
  constructor(private readonly deps: RestoreOrchestratorDeps<TEntitlement>) {}

  async restorePurchases(): Promise<RestoreResult<TEntitlement>> {
    const { nativeAdapter, backend, cache, unfinished, emitter, logger } = this.deps;

    emitter.emit('restore-started', undefined);

    let owned: NativeTransaction[];
    try {
      owned = await nativeAdapter.getOwnedTransactions();
    } catch (cause) {
      throw toIAPError(cause, 'Failed to fetch owned transactions.', IAPErrorCode.STORE_ERROR);
    }

    if (owned.length === 0) {
      const entitlements = this.deps.getCurrentEntitlements();
      emitter.emit('restore-completed', { restored: 0, entitlements });
      // `purchases` is derived from the store's own answer, not the backend
      // response, so it is correct on this short-circuit path too.
      return { restored: 0, entitlements, purchases: [] };
    }

    let response: RestoreResponse<TEntitlement>;
    try {
      // An adapter that answers from the transaction gets them whole. The
      // extraction below drops the fields it needs, and building it requires
      // a packageName such an adapter never reads — so a request it would
      // discard could fail the restore outright.
      response = backend.restoreNative
        ? await backend.restoreNative(owned)
        : await backend.restore({ transactions: owned.map((tx) => this.toRestoreEntry(tx)) });
    } catch (cause) {
      throw toIAPError(cause, 'Backend restore call failed.', IAPErrorCode.BACKEND_UNAVAILABLE);
    }

    if (!response.valid) {
      // Compose both the human-readable message and the stable machine code
      // so consumers can grep for either. PLAN.md §5.8 marks `error` as the
      // stable identifier — preserve it even when message is present.
      const detail = response.message
        ? `${response.message} [${response.error}]`
        : `Backend rejected restore (${response.error}).`;
      throw new IAPError({
        code: IAPErrorCode.VERIFICATION_REJECTED,
        message: detail,
      });
    }

    // Settle each verified transaction with the store. Failures are
    // best-effort per transaction — verification says these are valid — and
    // the entry survives below so recovery retries it.
    //
    // `verifiedTokens`, when the adapter supplies it, is what keeps the
    // acknowledge-after-verification invariant true here. An adapter that
    // judges transactions individually (on-device verification does) can
    // pass some and refuse others, and a single consolidated `valid: true`
    // cannot say which — so acknowledging the whole owned set would
    // finalise purchases that were just refused.
    const ackable =
      response.verifiedTokens === undefined
        ? owned
        : owned.filter((tx) => response.verifiedTokens?.includes(tx.token));

    if (ackable.length !== owned.length) {
      logger.debug(
        `Restore: settling ${ackable.length} of ${owned.length} owned transaction(s); the rest were not verified.`,
      );
    }

    // Which transactions actually settled, so the drain below removes only
    // those. Draining the whole owned set used to be merely untidy, because
    // a failed acknowledge left the purchase owned and the next
    // restore()/refresh() re-acked it. A consumable that fails to consume
    // stays owned *and* unacknowledged, with Play's three-day refund clock
    // running — and dropping its unfinished entry removes the only record
    // that would have made recovery retry it.
    const settled: NativeTransaction[] = [];
    for (const tx of ackable) {
      try {
        await finalizeTransaction({ nativeAdapter, transaction: tx, logger });
        settled.push(tx);
      } catch (error) {
        logger.warn(`Settling "${tx.productId}" with the store failed during restore.`, error);
      }
    }

    const entitlements = response.entitlements;
    const previous = this.deps.getCurrentEntitlements();

    try {
      const cachedAt = await cache.save(entitlements);
      this.deps.setCachePersisted(cachedAt);
    } catch (error) {
      logger.warn(
        'Failed to persist entitlements after restore; in-memory state still updated.',
        error,
      );
    }
    this.deps.setEntitlements(entitlements);

    // Drain the unfinished list of the tokens we actually settled — not the
    // whole owned set, which would also drop entries for transactions
    // `verifiedTokens` explicitly refused.
    for (const tx of settled) {
      try {
        await unfinished.remove(tx.token);
      } catch (error) {
        logger.warn(
          `Failed to remove "${tx.productId}" from unfinished list during restore.`,
          error,
        );
      }
    }

    // And clear any pending mark these settled, which is what stops a later
    // reconcile reporting a succeeded purchase as `cancelled`. Atomic via
    // `takeIfPresent`, so overlapping with recovery or the update listener
    // still fires `purchase-pending-resolved` at most once.
    for (const tx of settled) {
      try {
        await resolvePendingPurchase(this.deps, tx.productId, 'purchased');
      } catch (error) {
        logger.warn(
          `Failed to clear the pending mark for "${tx.productId}" during restore.`,
          error,
        );
      }
    }

    const next = this.deps.getCurrentEntitlements();
    emitter.emit('restore-completed', { restored: owned.length, entitlements: next });

    // L3: skip the emit when content is unchanged (avoids spurious re-renders
    // in reactive consumer stores that subscribe to entitlements-changed).
    if (!entitlementsEqual(previous, next)) {
      emitter.emit('entitlements-changed', { entitlements: next, previous });
    }

    return {
      restored: owned.length,
      entitlements: next,
      purchases: owned.map(toStorePurchase),
    };
  }

  private toRestoreEntry(tx: NativeTransaction): RestoreRequestTransaction {
    if (tx.platform === 'apple') {
      return {
        platform: 'apple',
        productId: tx.productId,
        transactionId: tx.token,
      };
    }
    if (!tx.packageName) {
      throw new IAPError({
        code: IAPErrorCode.STORE_ERROR,
        message: `Google owned transaction for "${tx.productId}" has no packageName; cannot restore. Set config.android.packageName to your app's applicationId — the native plugin does not report it, so iap cannot derive it from the purchase.`,
      });
    }
    return {
      platform: 'google',
      productId: tx.productId,
      purchaseToken: tx.token,
      packageName: tx.packageName,
    };
  }
}
