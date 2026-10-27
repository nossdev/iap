import type { BackendAdapter } from '../adapters/backend/types.js';
import type { NativeAdapter } from '../adapters/native/types.js';
import type { TypedEventEmitter } from '../events/emitter.js';
import type { Logger } from '../lib/logger.js';
import { maskToken } from '../lib/redact.js';
import type { EntitlementBase } from '../types/entitlement.js';
import type { NativeTransaction } from '../types/transaction.js';
import { type EntitlementCache, entitlementsEqual } from './entitlement-cache.js';
import { finalizeTransaction } from './finalize-transaction.js';
import type { PendingPurchasesStore } from './pending-purchases.js';
import { resolvePendingPurchase } from './resolve-pending.js';
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
  /**
   * Pending marks, so a purchase settled here clears the one it was
   * announced under. Every settlement path has to, or a reconcile later
   * reports `cancelled` for a purchase that succeeded.
   */
  pending: PendingPurchasesStore;
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
 * Re-attempts verification and settlement for unfinished transactions
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
 *     a. `finalizeTransaction()` — acknowledge, or consume for an Android
 *        consumable. A failure means we don't yet remove from the list
 *        (next launch will retry).
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

  /**
   * Verify, acknowledge and settle one transaction that arrived outside a
   * `purchase()` call — a renewal, a refund, an Ask-to-Buy approval, a
   * pending Play purchase that cleared.
   *
   * Routed through the same path recovery uses, deliberately: persisted
   * before verification so app death cannot lose it, and left in the store
   * to retry if anything fails. A second settlement path would be a second
   * place for those to drift.
   *
   * **One invariant does not carry over, and it is worth being exact about.**
   * On the iOS update feed the native plugin calls `transaction.finish()`
   * *before* it notifies listeners, so by the time iap sees the transaction
   * the platform has already finished it. "Acknowledged only after the
   * backend confirms" therefore describes the purchase flow, not this path —
   * iap has no say in the ordering here. The consequence is that persisting
   * first matters *more*, not less: StoreKit will not redeliver a finished
   * transaction, so the `unfinished` entry is the only remaining handle on
   * it. Callers on that path pass `alreadyFinished`.
   */
  /**
   * Whether an Android consumable's purchase has left the store's owned set,
   * which makes a failed consume terminal rather than retryable.
   *
   * The sequence this exists for: the consume succeeds on Play, then the
   * bridge reply or the `unfinished.remove` that follows fails. Play has
   * already dropped the purchase — Billing 8.x stops returning consumed
   * purchases from `getPurchases()` — so every later consume of that token
   * rejects, the entry is retained, and recovery retries it at every launch
   * forever, burning a `recoveryMaxBatch` slot and a verify each time. The
   * unfinished store has no age-based eviction to catch that.
   *
   * Acknowledging had no such trap: the purchase stayed owned, so a retry
   * eventually worked. So this asks the store a positive question — is the
   * purchase still there — rather than trying to read a meaning out of the
   * error, which would mean matching on Play's message text.
   *
   * Only for Google consumables, only on the failure path, and `false` on
   * any doubt: a store that cannot answer must not be taken to have said
   * "gone", or a genuinely retryable failure would be dropped.
   */
  private async alreadyGone(tx: NativeTransaction): Promise<boolean> {
    if (tx.platform !== 'google' || tx.productType !== 'consumable') return false;

    try {
      const owned = await this.deps.nativeAdapter.getOwnedTransactions();
      return !owned.some((candidate) => candidate.token === tx.token);
    } catch (error) {
      this.deps.logger.debug(
        `Recovery: could not re-read the owned set for productId=${tx.productId}; treating the settle failure as retryable.`,
        error,
      );
      return false;
    }
  }

  async settleTransaction(
    tx: NativeTransaction,
    opts: { persist?: boolean; alreadyFinished?: boolean } = {},
  ): Promise<'settled' | 'failed' | 'dropped-permanent'> {
    // At-least-once: persist before verifying, as the purchase flow does.
    //
    // `persist: false` is for a transaction there is nothing to recover from
    // — a revocation, say. Those verify `valid:false` with a code no
    // permanent-error list knows, so they would be retained and re-verified
    // at every launch forever, eating the recovery batch that real entries
    // need. The store has no age-based eviction to catch that.
    if (opts.persist !== false) {
      try {
        await this.deps.unfinished.add(tx);
      } catch (error) {
        this.deps.logger.warn(
          `Transaction update: failed to persist unfinished entry for "${tx.productId}"; verifying anyway.`,
          error,
        );
      }
    }

    const result = await this.processTransaction(tx, opts);
    if (result.kind === 'recovered') {
      await this.applyEntitlements(result.entitlements);
      return 'settled';
    }
    return result.kind === 'dropped-permanent' ? 'dropped-permanent' : 'failed';
  }

  private async processEntry(
    entry: UnfinishedTransaction,
  ): Promise<
    | { kind: 'recovered'; entitlements: TEntitlement[] }
    | { kind: 'failed' }
    | { kind: 'dropped-permanent' }
  > {
    return this.processTransaction(entryToNativeTransaction(entry));
  }

  private async processTransaction(
    tx: NativeTransaction,
    opts: { alreadyFinished?: boolean } = {},
  ): Promise<
    | { kind: 'recovered'; entitlements: TEntitlement[] }
    | { kind: 'failed' }
    | { kind: 'dropped-permanent' }
  > {
    const { nativeAdapter, unfinished, logger, emitter, permanentErrorCodes } = this.deps;
    const tokenLabel = maskToken(tx.token);

    try {
      const response = await verifyNativeTransaction(this.deps.backend, tx);

      if (!response.valid) {
        if (permanentErrorCodes.has(response.error)) {
          logger.info(
            `Recovery: dropping permanently-invalid token=${tokenLabel} productId=${tx.productId} (${response.error}).`,
          );

          // Best-effort native ack — clears StoreKit's queue. Failure here
          // doesn't block removal: the entry is permanently invalid, native
          // ack failure is rare and transient, and even an orphaned native
          // tx won't re-enter unfinished storage (no init-time sync exists,
          // only `purchase-flow.ts` writes to this store).
          //
          // Deliberately an acknowledge and not `finalizeTransaction`:
          // consuming is for a purchase iap has granted, and verification
          // has just called this one permanently invalid. The cost is worth
          // naming — a permanently-rejected Android *consumable* stays
          // owned, so the user can never buy that product again. Releasing
          // ownership for something declared invalid is the worse trade, and
          // a purchase that fails verification permanently is a backend or
          // catalog problem to fix, not a state to launder.
          try {
            await nativeAdapter.acknowledge(tx);
          } catch (error) {
            logger.warn(
              `Recovery: best-effort acknowledge() failed for productId=${tx.productId}; proceeding with removal anyway.`,
              error,
            );
          }

          try {
            await unfinished.remove(tx.token);
          } catch (error) {
            logger.warn(
              `Recovery: unfinished.remove() failed for productId=${tx.productId} after permanent classification; will dedupe on next launch.`,
              error,
            );
          }

          emitter.emit('recovery-dropped-permanent', {
            productId: tx.productId,
            token: tx.token,
            error: response.error,
            ...(response.message !== undefined ? { message: response.message } : {}),
          });

          return { kind: 'dropped-permanent' };
        }

        logger.debug(
          `Recovery: backend rejected token=${tokenLabel} productId=${tx.productId} (${response.error}); leaving in list for retry.`,
        );
        return { kind: 'failed' };
      }

      // Settle with the store — acknowledge, or consume for an Android
      // consumable. Failure means we don't yet remove — next launch retries.
      //
      // The permanent-rejection path above deliberately still only
      // acknowledges: that transaction did *not* verify, and consuming is
      // for a purchase iap has granted.
      try {
        await finalizeTransaction({ nativeAdapter, transaction: tx, logger });
      } catch (error) {
        // …unless the platform already finished it, which is the case for a
        // transaction off the iOS update feed. There the plugin finishes
        // before notifying, and `acknowledgePurchase` then looks the
        // transaction up in `Transaction.all` and rejects with "not found or
        // already finished" — which `Transaction.all` guarantees for a
        // finished consumable. Treating that as a failure would retain the
        // entry forever and never resolve a pending purchase that in fact
        // completed.
        if (opts.alreadyFinished || (await this.alreadyGone(tx))) {
          logger.debug(
            `Recovery: settling productId=${tx.productId} failed, but the store no longer has the purchase; treating as settled.`,
          );
        } else {
          logger.warn(
            `Recovery: settling productId=${tx.productId} with the store failed; entry retained for next launch.`,
            error,
          );
          return { kind: 'failed' };
        }
      }

      // Remove from unfinished. A failure here is logged but treated as
      // success for entitlement purposes — the cache write below still
      // happens, and the next recovery's idempotent verify will be a
      // no-op (token already verified by backend).
      try {
        await unfinished.remove(tx.token);
      } catch (error) {
        logger.warn(
          `Recovery: unfinished.remove() failed for productId=${tx.productId}; will dedupe on next launch.`,
          error,
        );
      }

      // Settled, so a pending mark announced for this product is over.
      // Done here rather than in the caller so recovery at launch, the
      // update listener and reconciliation all get it.
      await resolvePendingPurchase(this.deps, tx.productId, 'purchased');

      return { kind: 'recovered', entitlements: response.entitlements };
    } catch (error) {
      logger.warn(
        `Recovery: verify failed for productId=${tx.productId}; will retry next launch.`,
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
    // Entries persisted before `purchaseReference` existed carry only the
    // token; on Android the two are the same value anyway, and on iOS the
    // token is the right fallback (see `NativeTransaction`).
    // `||`, not `??`: a stored empty string is as unusable as an absent one.
    purchaseReference: entry.purchaseReference || entry.token,
    productType: entry.productType,
  };
  // Restore what a verification needs. Without these a local check sees an
  // amputated transaction and answers differently than it did at purchase
  // time — see the fields' note in `unfinished-transactions.ts`.
  if (entry.appUserId) tx.appUserId = entry.appUserId;
  if (entry.expiresAt) {
    tx.subscription = {
      state: null,
      autoRenewing: null,
      renewsAt: null,
      renewalProductId: null,
      expiresAt: entry.expiresAt,
    };
  }
  if (entry.purchaseState) {
    tx.raw = { purchaseState: entry.purchaseState };
  }
  if (entry.packageName) tx.packageName = entry.packageName;
  return tx;
}
