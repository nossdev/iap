import type { BackendAdapter } from '../adapters/backend/types.js';
import type { NativeAdapter } from '../adapters/native/types.js';
import type { TypedEventEmitter } from '../events/emitter.js';
import type { Logger } from '../lib/logger.js';
import { maskToken } from '../lib/redact.js';
import type { EntitlementBase } from '../types/entitlement.js';
import type { NativeTransaction } from '../types/transaction.js';
import { type EntitlementCache, entitlementsEqual } from './entitlement-cache.js';
import type {
  UnfinishedTransaction,
  UnfinishedTransactionsStore,
} from './unfinished-transactions.js';
import { verifyNativeTransaction } from './verify-helpers.js';

/**
 * Backend `valid:false` error codes that are treated as permanent by default
 * (entry removed from `unfinished_transactions` instead of retried forever).
 *
 * Conservative on purpose: only the two codes the documented recipe
 * contract identifies as unambiguous "domain-not-found" answers. Consumers
 * with custom backend error vocabularies extend via
 * `options.permanentErrorCodes`.
 *
 * Distinct from the `RECOVERABLE_CODES` set in `lib/errors.ts`: that one
 * classifies iap-internal `IAPErrorCode`s for transport/storage retry
 * semantics; this one classifies opaque error strings the consumer's
 * backend returns in `valid:false` responses.
 */
export const DEFAULT_PERMANENT_ERROR_CODES: readonly string[] = [
  'TRANSACTION_NOT_FOUND',
  'PRODUCT_MISMATCH',
] as const;

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
  /** Cap on entries inspected per launch (config.options.recoveryMaxBatch). */
  maxBatch: number;
  /**
   * Backend `valid:false` error codes treated as permanent. Entries with a
   * matching error are removed from storage instead of retried next launch.
   * Resolved from `config.options.permanentErrorCodes` (or the default set
   * when omitted) at orchestrator construction in `createIAP`.
   */
  permanentErrorCodes: ReadonlySet<string>;
}

interface RecoveryResult {
  /** Number of entries that were verified, acknowledged, and removed. */
  recovered: number;
  /** Number of entries left in the list (transient errors, valid:false, etc.). */
  failures: number;
  /**
   * Number of entries removed from the list because the backend's
   * `valid:false` response carried a permanent error code (per
   * `options.permanentErrorCodes`). These will NOT retry on next launch.
   */
  droppedPermanent: number;
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
    const { unfinished, logger, maxBatch } = this.deps;
    const allEntries = await unfinished.list();
    if (allEntries.length === 0) {
      return { recovered: 0, failures: 0, droppedPermanent: 0, inspected: 0 };
    }

    // L2: cap inspected entries per launch. Excess entries stay in storage
    // and are processed on subsequent launches.
    const entries = allEntries.slice(0, maxBatch);
    if (allEntries.length > maxBatch) {
      logger.info(
        `Recovery: inspecting ${entries.length}/${allEntries.length} entries; remaining ${allEntries.length - entries.length} will be processed on subsequent launches.`,
      );
    } else {
      logger.debug(`Recovery: inspecting ${entries.length} unfinished transaction(s).`);
    }

    // L1: parallelize per-entry verify→ack→remove via Promise.allSettled.
    // Within an entry the steps are sequential (the orchestrator's safety
    // invariants rely on it); across entries they're independent.
    const settled = await Promise.allSettled(entries.map((entry) => this.processEntry(entry)));

    let recovered = 0;
    let failures = 0;
    let droppedPermanent = 0;
    let latestEntitlements: TEntitlement[] | null = null;

    // Iterate in input order so latestEntitlements is the LAST successful
    // entry's response (deterministic last-write-wins). NOTE: parallel
    // verifies for the same user are expected to return the same consolidated
    // list — replicas that drift mid-rollout could yield different lists; in
    // that case the input-order tiebreak is arbitrary but stable. If your
    // backend cannot guarantee read-after-write across replicas, prefer a
    // single iap.refresh() over multi-entry recovery.
    for (const result of settled) {
      if (result.status === 'rejected') {
        // processEntry catches its own throws; this branch only fires on a
        // truly unexpected runtime error (e.g. logger threw). Count as failure.
        failures += 1;
        continue;
      }
      if (result.value.kind === 'recovered') {
        recovered += 1;
        latestEntitlements = result.value.entitlements;
      } else if (result.value.kind === 'dropped-permanent') {
        droppedPermanent += 1;
      } else {
        failures += 1;
      }
    }

    if (latestEntitlements !== null) {
      await this.applyEntitlements(latestEntitlements);
    }

    logger.debug(
      `Recovery: ${recovered} recovered, ${droppedPermanent} dropped (permanent), ${failures} left in list (will retry next launch).`,
    );

    return { recovered, failures, droppedPermanent, inspected: entries.length };
  }

  private async processEntry(
    entry: UnfinishedTransaction,
  ): Promise<
    | { kind: 'recovered'; entitlements: TEntitlement[] }
    | { kind: 'failed' }
    | { kind: 'dropped-permanent' }
  > {
    const { nativeAdapter, unfinished, logger, emitter, permanentErrorCodes } = this.deps;
    const tx = entryToNativeTransaction(entry);
    const tokenLabel = maskToken(entry.token);

    try {
      const response = await verifyNativeTransaction(this.deps.backend, tx);

      if (!response.valid) {
        if (permanentErrorCodes.has(response.error)) {
          logger.info(
            `Recovery: dropping permanently-invalid token=${tokenLabel} productId=${entry.productId} (${response.error}).`,
          );

          // Best-effort native ack — clears StoreKit's queue. Failure here
          // doesn't block removal: the entry is permanently invalid, native
          // ack failure is rare and transient, and even an orphaned native
          // tx won't re-enter unfinished storage (no init-time sync exists,
          // only `purchase-flow.ts` writes to this store).
          try {
            await nativeAdapter.acknowledge(tx);
          } catch (error) {
            logger.warn(
              `Recovery: best-effort acknowledge() failed for productId=${entry.productId}; proceeding with removal anyway.`,
              error,
            );
          }

          try {
            await unfinished.remove(entry.token);
          } catch (error) {
            logger.warn(
              `Recovery: unfinished.remove() failed for productId=${entry.productId} after permanent classification; will dedupe on next launch.`,
              error,
            );
          }

          emitter.emit('recovery-dropped-permanent', {
            productId: entry.productId,
            token: entry.token,
            error: response.error,
            ...(response.message !== undefined ? { message: response.message } : {}),
          });

          return { kind: 'dropped-permanent' };
        }

        logger.debug(
          `Recovery: backend rejected token=${tokenLabel} productId=${entry.productId} (${response.error}); leaving in list for retry.`,
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

    // L3: structural-compare BEFORE write so a future setter that normalizes
    // the array (sort, dedupe, freeze) can't make the equality check lie.
    const unchanged = entitlementsEqual(previous, entitlements);

    try {
      const cachedAt = await cache.save(entitlements);
      this.deps.setCachePersisted(cachedAt);
    } catch (error) {
      logger.warn('Recovery: cache.save failed; in-memory state still updated.', error);
    }
    this.deps.setEntitlements(entitlements);

    if (unchanged) return;

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
