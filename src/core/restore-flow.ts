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
 * 2. `nativeAdapter.getOwnedTransactions()` (delegates to cdv's
 *    `store.restorePurchases()` + `localTransactions` filter).
 * 3. If empty → emit `restore-completed` with current entitlements,
 *    return `{ restored: 0, entitlements: <current> }`. No backend call.
 *    This covers fresh-install-no-purchases. The empty-array guard lives
 *    here (orchestrator level) rather than in the HTTP adapter so all
 *    transport implementations benefit automatically.
 * 4. POST batch to `backend.restore()`.
 * 5. On `valid: true`:
 *    - Acknowledge each native transaction (best-effort; cdv's
 *      `pendingFinish` map needs draining or `.approved()` will replay
 *      them every launch).
 *    - Persist consolidated entitlements via `cache.save()`.
 *    - Replace state.
 *    - Remove from `unfinished_transactions` (the entries were never
 *      written by purchase flow, but defensive — getOwnedTransactions
 *      may have re-staged them via the cdv long-lived listener).
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
      return { restored: 0, entitlements };
    }

    const request: RestoreRequest = {
      transactions: owned.map((tx) => this.toRestoreEntry(tx)),
    };

    let response: RestoreResponse<TEntitlement>;
    try {
      response = await backend.restore(request);
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

    // Acknowledge each native transaction. Failures are best-effort —
    // backend says these are valid; if cdv finish() fails, the long-lived
    // .approved() listener on next launch will re-stage them and the
    // next refresh()/restore() will retry the ack.
    for (const tx of owned) {
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

    return { restored: owned.length, entitlements: next };
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
        message: `Google owned transaction for "${tx.productId}" has no packageName; cannot restore.`,
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
