import type { NativeAdapter } from '../adapters/native/types.js';
import type { TypedEventEmitter } from '../events/emitter.js';
import type { Logger } from '../lib/logger.js';
import type { EntitlementBase } from '../types/entitlement.js';
import type { NativeTransaction } from '../types/transaction.js';
import type { PendingPurchasesStore } from './pending-purchases.js';
import type { RecoveryOrchestrator } from './recovery-flow.js';
import { resolvePendingPurchase } from './resolve-pending.js';
import { toStorePurchase } from './store-purchase.js';

interface TransactionUpdateDeps<TEntitlement extends EntitlementBase> {
  nativeAdapter: NativeAdapter;
  /** Reused for settlement so the safety invariants live in one place. */
  recoverer: RecoveryOrchestrator<TEntitlement>;
  pending: PendingPurchasesStore;
  emitter: TypedEventEmitter<TEntitlement>;
  logger: Logger;
  /**
   * Whether `purchase()` is currently handling this product. The platform
   * delivers the same transaction to both paths, and the purchase flow owns
   * the one it started.
   */
  isPurchaseInFlight: (productId: string) => boolean;
  /**
   * Whether the iap instance is still live. A native callback can fire
   * during or after `destroy()`, and settling then would write through the
   * shared state closures and repopulate a torn-down instance.
   */
  isActive: () => boolean;
}

/**
 * Handles transactions the store produces on its own, and closes out
 * pending purchases.
 *
 * Two entry points, because the platforms differ:
 *
 * - {@link handle} is driven by a native listener. Apple's
 *   `Transaction.updates` pushes renewals, refunds, revocations and
 *   Ask-to-Buy approvals as they happen.
 * - {@link reconcilePending} asks the store directly. It is the **only**
 *   mechanism on Android, which has no equivalent feed — a Play purchase
 *   that clears while the app is closed is discovered by looking, at the
 *   next launch or resume.
 *
 * Nothing here throws. Both are called from a native callback or from
 * `initialize()`, where a rejection would either be swallowed somewhere
 * unhelpful or break startup.
 */
export class TransactionUpdateOrchestrator<TEntitlement extends EntitlementBase = EntitlementBase> {
  /**
   * Tokens currently being settled, so two paths cannot settle the same
   * transaction at once.
   *
   * The listener is fire-and-forget and reconciliation runs on resume, so
   * they genuinely overlap. Without this, both verify and both acknowledge —
   * and on Android a second `acknowledge` of an already-acked token errors,
   * which the settle path reads as a failure and retains the entry for.
   */
  private readonly settling = new Set<string>();

  /** The in-flight reconciliation pass, so concurrent callers join it. */
  private reconciling: Promise<void> | null = null;

  constructor(private readonly deps: TransactionUpdateDeps<TEntitlement>) {}

  /** Settle a transaction pushed by the platform. Never throws. */
  async handle(transaction: NativeTransaction): Promise<void> {
    const { logger, emitter, isPurchaseInFlight } = this.deps;

    try {
      // StoreKit delivers the transaction a purchase() produced to
      // Transaction.updates as well. Settling it here too would verify and
      // acknowledge twice and emit a spurious entitlements-changed, so the
      // flow that started it keeps it.
      if (!this.deps.isActive()) {
        logger.debug('Transaction update arrived after teardown; ignoring.');
        return;
      }

      if (isPurchaseInFlight(transaction.productId)) {
        logger.debug(
          `Transaction update for "${transaction.productId}" arrived while a purchase is in flight; leaving it to the purchase flow.`,
        );
        return;
      }

      emitter.emit('transaction-updated', {
        productId: transaction.productId,
        purchase: toStorePurchase(transaction),
      });

      // A revocation or a refund has nothing to recover: it verifies
      // `valid:false` with a code no permanent-error list knows, so
      // persisting it would retain it and re-verify at every launch forever,
      // crowding out entries that can still succeed.
      const isRevocation = transaction.subscription?.state === 'revoked';

      // On iOS the plugin finishes the transaction before notifying, so a
      // failing acknowledge here means "already finished", not "could not
      // finish". Android has no update feed, so this only ever applies to
      // Apple transactions.
      const outcome = await this.settleOnce(transaction, {
        persist: !isRevocation,
        alreadyFinished: transaction.platform === 'apple',
      });
      if (outcome !== 'settled') {
        logger.debug(
          `Transaction update for "${transaction.productId}" did not settle (${outcome}).`,
        );
      }
      // The 'purchased' resolution happens inside the settle path, so every
      // route to a settled transaction reports it — see `resolve-pending.ts`.
    } catch (error) {
      logger.warn(
        `Transaction update handling threw for "${transaction.productId}"; ignoring.`,
        error,
      );
    }
  }

  /**
   * Ask the store what became of the purchases iap reported as pending.
   *
   * Call at `initialize()` and on resume. Does nothing when nothing is
   * tracked, so the common case costs no native calls. Never throws.
   */
  async reconcilePending(): Promise<void> {
    // Single-flight. Two resume events in quick succession each schedule a
    // pass (the resume listener does not debounce), and two passes would
    // each settle the same transactions.
    if (this.reconciling) return this.reconciling;
    this.reconciling = this.runReconcile().finally(() => {
      this.reconciling = null;
    });
    return this.reconciling;
  }

  private async runReconcile(): Promise<void> {
    const { nativeAdapter, logger, pending } = this.deps;

    try {
      if (!this.deps.isActive()) return;
      const tracked = await pending.list();
      if (tracked.length === 0) return;

      // Read pending FIRST, then owned. These are two separate native
      // round-trips, so a purchase can clear in between — and the order
      // decides which way that window resolves. Pending-then-owned means a
      // purchase seen as pending and then as owned reads as owned (correct),
      // while owned-then-pending would show it in neither and report it
      // cancelled. Erring towards "still pending" self-corrects next pass;
      // erring towards "cancelled" is permanent.
      //
      // `null` means the platform cannot report pending state, which is a
      // different answer from "nothing is pending". iOS cannot: a deferred
      // purchase that is never approved produces no signal, so "not owned"
      // there is indistinguishable from "still waiting".
      const stillPending = (await nativeAdapter.getPendingProductIds?.()) ?? null;

      const owned = await nativeAdapter.getOwnedTransactions();
      const ownedByProduct = new Map(owned.map((tx) => [tx.productId, tx]));

      for (const productId of tracked) {
        // Same reasoning as `handle()`: whichever path started a purchase
        // owns settling it. Reconciliation can coincide with a retry of the
        // same product, and settling underneath it would verify and
        // acknowledge twice.
        if (this.deps.isPurchaseInFlight(productId)) {
          logger.debug(
            `Pending purchase "${productId}" is being purchased right now; leaving it to the purchase flow.`,
          );
          continue;
        }

        const ownedTx = ownedByProduct.get(productId);
        if (ownedTx) {
          // Announcing it is not enough: an unacknowledged Play purchase is
          // refunded after three days, and nothing else will settle this one
          // on Android, where no update event exists.
          const outcome = await this.settleOnce(ownedTx);
          if (outcome !== 'settled') {
            logger.debug(
              `Pending purchase "${productId}" is owned but did not settle (${outcome}); keeping it pending.`,
            );
          }
          continue;
        }

        if (stillPending === null) {
          logger.debug(
            `Pending purchase "${productId}" is not owned, but this platform cannot report pending state; keeping it pending.`,
          );
          continue;
        }

        if (stillPending.includes(productId)) continue;

        // The store has it neither owned nor waiting: the payment failed,
        // expired, or was abandoned.
        await this.resolvePending(productId, 'cancelled');
      }
    } catch (error) {
      // Keep every marker on failure. A pending purchase wrongly left
      // pending resolves on the next pass; one wrongly cancelled tells the
      // consumer something false and never corrects itself.
      logger.warn('Reconciling pending purchases failed; markers kept for the next pass.', error);
    }
  }

  /**
   * Settle a transaction, unless it is already being settled.
   *
   * Keyed on the token, not the product: two different transactions for one
   * product (an iOS subscription has a token per renewal) should both
   * settle, while the same transaction reaching both paths should not.
   */
  private async settleOnce(
    tx: NativeTransaction,
    opts: { persist?: boolean; alreadyFinished?: boolean } = {},
  ): Promise<'settled' | 'failed' | 'dropped-permanent' | 'already-settling'> {
    if (this.settling.has(tx.token)) return 'already-settling';
    this.settling.add(tx.token);
    try {
      return await this.deps.recoverer.settleTransaction(tx, opts);
    } finally {
      this.settling.delete(tx.token);
    }
  }

  /** Announce how a pending purchase ended. See `resolve-pending.ts`. */
  private async resolvePending(
    productId: string,
    status: 'purchased' | 'cancelled',
  ): Promise<void> {
    await resolvePendingPurchase(this.deps, productId, status);
  }
}
