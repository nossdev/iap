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
import { toStorePurchase } from './store-purchase.js';
import type { UnfinishedTransactionsStore } from './unfinished-transactions.js';

interface RestoreOrchestratorDeps<TEntitlement extends EntitlementBase> {
  nativeAdapter: NativeAdapter;
  backend: BackendAdapter<TEntitlement>;
  cache: EntitlementCache<TEntitlement>;
  unfinished: UnfinishedTransactionsStore;
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
 *    - Acknowledge each native transaction (best-effort; an ack failure just
 *      means the store keeps reporting it as owned and the next
 *      restore()/refresh() retries).
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

    // Acknowledge each verified transaction. Failures are best-effort —
    // verification says these are valid; if acknowledge() fails the store
    // still reports the purchase as owned, so the next refresh()/restore()
    // retries.
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
        `Restore: acknowledging ${ackable.length} of ${owned.length} owned transaction(s); the rest were not verified.`,
      );
    }

    for (const tx of ackable) {
      try {
        await nativeAdapter.acknowledge(tx);
      } catch (error) {
        logger.warn(`acknowledge() failed for "${tx.productId}" during restore.`, error);
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

    // Drain the unfinished list of any tokens we just verified.
    for (const tx of owned) {
      try {
        await unfinished.remove(tx.token);
      } catch (error) {
        logger.warn(
          `Failed to remove "${tx.productId}" from unfinished list during restore.`,
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
