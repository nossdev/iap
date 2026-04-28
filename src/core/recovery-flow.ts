import type { BackendAdapter } from '../adapters/backend/types.js';
import type { NativeAdapter } from '../adapters/native/types.js';
import type { TypedEventEmitter } from '../events/emitter.js';
import type { Logger } from '../lib/logger.js';
import { maskToken } from '../lib/redact.js';
import type { EntitlementBase } from '../types/entitlement.js';
import type { NativeTransaction } from '../types/transaction.js';
import type { EntitlementCache } from './entitlement-cache.js';
import type {
  UnfinishedTransaction,
  UnfinishedTransactionsStore,
} from './unfinished-transactions.js';
import { verifyNativeTransaction } from './verify-helpers.js';

interface RecoveryOrchestratorDeps<TEntitlement extends EntitlementBase> {
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

interface RecoveryResult {
  /** Number of entries that were verified, acknowledged, and removed. */
  recovered: number;
  /** Number of entries left in the list (transient errors, valid:false, etc.). */
  failures: number;
  /** Total entries inspected. */
  inspected: number;
}

/**
 * Re-attempts verification + acknowledgement for unfinished transactions
 * that survived from a prior session (app killed mid-purchase, network
 * outage during verify, etc.). Runs once per `initialize()` call before
 * `ready` fires.
 *
 * Best-effort by design — never throws. Each entry is processed
 * independently; one failure does not abort the rest. Entries that fail
 * stay in storage for the next launch's recovery.
 *
 * Per-entry sequence:
 *  1. `verifyNativeTransaction` — reuse the shared platform router.
 *  2. If `valid: false` → log debug, increment `failures`, leave in list.
 *  3. If `valid: true`:
 *     a. `nativeAdapter.acknowledge()` — best-effort; ack failure means
 *        we don't yet remove from the list (next launch will retry).
 *     b. `unfinished.remove(token)` — clear the entry.
 *     c. Stash the response's `entitlements` as the latest seen.
 *  4. Transport / verify throw → log warn, increment `failures`, leave.
 *
 * After processing all entries, if at least one succeeded, the latest
 * verified `entitlements` array is applied as the new state (cache.save +
 * setEntitlements + emit `entitlements-changed`). Multiple verifies for
 * the same user normally return the same consolidated list — last-wins
 * is the simplest correct strategy.
 */
export class RecoveryOrchestrator<TEntitlement extends EntitlementBase = EntitlementBase> {
  constructor(private readonly deps: RecoveryOrchestratorDeps<TEntitlement>) {}

  async recoverUnfinishedTransactions(): Promise<RecoveryResult> {
    const { unfinished, logger } = this.deps;
    const entries = await unfinished.list();
    if (entries.length === 0) {
      return { recovered: 0, failures: 0, inspected: 0 };
    }

    logger.debug(`Recovery: inspecting ${entries.length} unfinished transaction(s).`);

    let recovered = 0;
    let failures = 0;
    let latestEntitlements: TEntitlement[] | null = null;

    for (const entry of entries) {
      const outcome = await this.processEntry(entry);
      if (outcome.kind === 'recovered') {
        recovered += 1;
        latestEntitlements = outcome.entitlements;
      } else {
        failures += 1;
      }
    }

    if (latestEntitlements !== null) {
      await this.applyEntitlements(latestEntitlements);
    }

    logger.debug(
      `Recovery: ${recovered} recovered, ${failures} left in list (will retry next launch).`,
    );

    return { recovered, failures, inspected: entries.length };
  }

  private async processEntry(
    entry: UnfinishedTransaction,
  ): Promise<{ kind: 'recovered'; entitlements: TEntitlement[] } | { kind: 'failed' }> {
    const { nativeAdapter, unfinished, logger } = this.deps;
    const tx = entryToNativeTransaction(entry);
    const tokenLabel = maskToken(entry.token);

    try {
      const response = await verifyNativeTransaction(this.deps.backend, tx);

      if (!response.valid) {
        logger.debug(
          `Recovery: backend rejected token=${tokenLabel} productId=${entry.productId} (${response.error}); leaving in list.`,
        );
        return { kind: 'failed' };
      }

      // Ack natively. Failure means we don't yet remove — next launch retries.
      try {
        await nativeAdapter.acknowledge(tx);
      } catch (error) {
        logger.warn(
          `Recovery: acknowledge() failed for productId=${entry.productId}; entry retained for next launch.`,
          error,
        );
        return { kind: 'failed' };
      }

      // Remove from unfinished. A failure here is logged but treated as
      // success for entitlement purposes — the cache write below still
      // happens, and the next recovery's idempotent verify will be a
      // no-op (token already verified by backend).
      try {
        await unfinished.remove(entry.token);
      } catch (error) {
        logger.warn(
          `Recovery: unfinished.remove() failed for productId=${entry.productId}; will dedupe on next launch.`,
          error,
        );
      }

      return { kind: 'recovered', entitlements: response.entitlements };
    } catch (error) {
      logger.warn(
        `Recovery: verify failed for productId=${entry.productId}; will retry next launch.`,
        error,
      );
      return { kind: 'failed' };
    }
  }

  private async applyEntitlements(entitlements: TEntitlement[]): Promise<void> {
    const { cache, emitter, logger } = this.deps;
    const previous = this.deps.getCurrentEntitlements();

    try {
      const cachedAt = await cache.save(entitlements);
      this.deps.setCachePersisted(cachedAt);
    } catch (error) {
      logger.warn('Recovery: cache.save failed; in-memory state still updated.', error);
    }
    this.deps.setEntitlements(entitlements);

    emitter.emit('entitlements-changed', {
      entitlements: this.deps.getCurrentEntitlements(),
      previous,
    });
  }
}

function entryToNativeTransaction(entry: UnfinishedTransaction): NativeTransaction {
  const tx: NativeTransaction = {
    platform: entry.platform,
    productId: entry.productId,
    token: entry.token,
    productType: entry.productType,
  };
  if (entry.packageName) tx.packageName = entry.packageName;
  return tx;
}
