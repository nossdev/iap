import type { BackendAdapter, VerifyResponse } from '../adapters/backend/types.js';
import type { NativeAdapter } from '../adapters/native/types.js';
import type { TypedEventEmitter } from '../events/emitter.js';
import { IAPError, IAPErrorCode, isIAPError } from '../lib/errors.js';
import type { Logger } from '../lib/logger.js';
import type { EntitlementBase } from '../types/entitlement.js';
import type { ConfiguredProduct, ProductType } from '../types/product.js';
import type { PurchaseResult } from '../types/results.js';
import type { NativeTransaction, VerifiedTransaction } from '../types/transaction.js';
import type { EntitlementCache } from './entitlement-cache.js';
import type { UnfinishedTransactionsStore } from './unfinished-transactions.js';

interface PurchaseOrchestratorDeps<TEntitlement extends EntitlementBase> {
  /** Native adapter (cdv on iOS/Android, web stub on web). Always non-null
   *  by the time the orchestrator is invoked — initialize() ensures it. */
  nativeAdapter: NativeAdapter;
  backend: BackendAdapter<TEntitlement>;
  cache: EntitlementCache<TEntitlement>;
  unfinished: UnfinishedTransactionsStore;
  emitter: TypedEventEmitter<TEntitlement>;
  logger: Logger;
  /** Resolved product catalog from config. Used to look up productType. */
  products: ConfiguredProduct[];
  /**
   * Returns the current entitlements list. Read fresh from state each call so
   * concurrent refreshes are reflected in the `previous` payload of
   * entitlements-changed events.
   */
  getCurrentEntitlements: () => TEntitlement[];
  /**
   * Replace the current entitlements list. Implementation must freeze entries
   * (createIAP's `freezeAll`).
   */
  setEntitlements: (next: TEntitlement[]) => void;
  /**
   * Mark the persisted cache as written at the given timestamp. Keeps the
   * in-memory `cachedAt` in sync with disk so Phase 6 TTL evaluation doesn't
   * see a spurious "stale" reading after a purchase.
   */
  setCachePersisted: (cachedAt: number) => void;
}

/**
 * Coordinates the purchase flow across the native, backend, storage, and
 * eventing layers. The implementation is the literal expression of
 * PLAN.md §5.4 — read that section alongside this code.
 *
 * Safety guarantees:
 * 1. **At-least-once delivery to backend** — write to `unfinished` BEFORE
 *    calling `backend.verifyApple/Google()`. App death between these two
 *    points is recovered on next launch via `unfinished.list()`.
 * 2. **Never `acknowledge()` before backend confirms** — `nativeAdapter.acknowledge()`
 *    is only called after `backend.verifyApple/Google()` returns `valid: true`.
 *    On any failure path the cdv `Transaction` stays in cdv's `pendingFinish`
 *    map so it can be replayed by the long-lived `.approved()` listener on the
 *    next session.
 * 3. **Per-product lock** — concurrent `purchase('premium_monthly')` calls
 *    would race for the same `.approved()` event. The `inFlight` set rejects
 *    the second call with `ALREADY_IN_PROGRESS`.
 *
 * The 5 result statuses (PLAN.md §5.4):
 * - `success` — backend returned `valid: true`; entitlements + cache updated.
 * - `cancelled` — user cancelled the native sheet (USER_CANCELLED).
 * - `pending` — Android-only; payment pending platform-side. Not yet acked.
 * - `verification_failed` — backend returned `valid: false`. Persisted to
 *   `unfinished` for retry on next refresh.
 * - `failed` — native or transport error. May or may not be persisted depending
 *   on whether a NativeTransaction was produced.
 */
export class PurchaseOrchestrator<TEntitlement extends EntitlementBase = EntitlementBase> {
  private readonly inFlight = new Set<string>();

  constructor(private readonly deps: PurchaseOrchestratorDeps<TEntitlement>) {}

  async purchase(productId: string): Promise<PurchaseResult<TEntitlement>> {
    if (this.inFlight.has(productId)) {
      throw new IAPError({
        code: IAPErrorCode.ALREADY_IN_PROGRESS,
        message: `A purchase of "${productId}" is already in progress.`,
      });
    }
    const product = this.deps.products.find((p) => p.id === productId);
    if (!product) {
      throw new IAPError({
        code: IAPErrorCode.PRODUCT_NOT_FOUND,
        message: `Product "${productId}" is not in the configured catalog.`,
      });
    }

    this.inFlight.add(productId);
    this.deps.emitter.emit('purchase-started', { productId });

    try {
      return await this.runFlow(product);
    } finally {
      this.inFlight.delete(productId);
    }
  }

  private async runFlow(product: ConfiguredProduct): Promise<PurchaseResult<TEntitlement>> {
    const { nativeAdapter, logger } = this.deps;
    let nativeTx: NativeTransaction;

    // ----- 1. Native purchase -----
    try {
      nativeTx = await nativeAdapter.purchaseProduct({
        productId: product.id,
        productType: product.type,
        ...(product.androidPlanId ? { androidPlanId: product.androidPlanId } : {}),
      });
    } catch (error) {
      return this.handleNativeError(product.id, error);
    }

    // ----- 2. Persist BEFORE verifying — at-least-once invariant -----
    try {
      await this.deps.unfinished.add(nativeTx);
    } catch (error) {
      logger.warn(
        `Failed to persist unfinished entry for "${product.id}"; verification will still proceed.`,
        error,
      );
    }

    // ----- 3. Backend verification -----
    let verifyResult: VerifyResponse<TEntitlement>;
    try {
      verifyResult = await this.runVerify(nativeTx, product.type);
    } catch (error) {
      return this.handleVerifyError(product.id, error);
    }

    // ----- 4. Branch on backend response -----
    if (!verifyResult.valid) {
      return this.handleVerificationRejected(product.id, verifyResult);
    }

    // ----- 5. Backend says valid: ack natively + update cache + emit -----
    return this.finalizeSuccess(product.id, nativeTx, verifyResult);
  }

  private async runVerify(
    tx: NativeTransaction,
    productType: ProductType,
  ): Promise<VerifyResponse<TEntitlement>> {
    if (tx.platform === 'apple') {
      return this.deps.backend.verifyApple({
        productId: tx.productId,
        transactionId: tx.token,
        type: productType,
      });
    }
    if (!tx.packageName) {
      throw new IAPError({
        code: IAPErrorCode.STORE_ERROR,
        message: `Google transaction for "${tx.productId}" has no packageName; cannot verify.`,
      });
    }
    return this.deps.backend.verifyGoogle({
      productId: tx.productId,
      purchaseToken: tx.token,
      packageName: tx.packageName,
      type: productType,
    });
  }

  private async finalizeSuccess(
    productId: string,
    nativeTx: NativeTransaction,
    response: Extract<VerifyResponse<TEntitlement>, { valid: true }>,
  ): Promise<PurchaseResult<TEntitlement>> {
    const { nativeAdapter, cache, unfinished, emitter, logger } = this.deps;
    const transaction = response.transaction as VerifiedTransaction;
    const entitlements = response.entitlements;

    // Acknowledge the native transaction. Failure here is recoverable —
    // entitlement state on backend says we're good; ack will be retried
    // on next launch via the cdv adapter's long-lived approved listener.
    try {
      await nativeAdapter.acknowledge(nativeTx);
    } catch (error) {
      logger.warn(`acknowledge() failed for "${productId}"; entitlements still updated.`, error);
    }

    // Persist entitlements (best-effort) and clear the unfinished entry.
    const previous = this.deps.getCurrentEntitlements();
    try {
      const cachedAt = await cache.save(entitlements);
      this.deps.setCachePersisted(cachedAt);
    } catch (error) {
      logger.warn(
        `Failed to persist entitlements after purchase of "${productId}"; in-memory state still updated.`,
        error,
      );
    }
    this.deps.setEntitlements(entitlements);

    try {
      await unfinished.remove(nativeTx.token);
    } catch (error) {
      logger.warn(
        `Failed to remove "${productId}" from unfinished list; will be skipped on next recovery.`,
        error,
      );
    }

    emitter.emit('purchase-success', { productId, transaction });
    emitter.emit('entitlements-changed', {
      entitlements: this.deps.getCurrentEntitlements(),
      previous,
    });

    return {
      status: 'success',
      productId,
      transaction,
      entitlements: this.deps.getCurrentEntitlements(),
    };
  }

  private handleVerificationRejected(
    productId: string,
    response: Extract<VerifyResponse<TEntitlement>, { valid: false }>,
  ): PurchaseResult<TEntitlement> {
    const error = new IAPError({
      code: IAPErrorCode.VERIFICATION_REJECTED,
      message: response.message ?? `Backend rejected the transaction (${response.error}).`,
    });
    this.deps.emitter.emit('verification-failed', { productId, error });
    return { status: 'verification_failed', productId, error };
  }

  private handleNativeError(productId: string, error: unknown): PurchaseResult<TEntitlement> {
    const iapError = toIAPError(
      error,
      `Native purchase of "${productId}" failed.`,
      IAPErrorCode.STORE_ERROR,
    );

    if (iapError.code === IAPErrorCode.USER_CANCELLED) {
      this.deps.emitter.emit('purchase-cancelled', { productId });
      return { status: 'cancelled', productId };
    }

    if (iapError.code === IAPErrorCode.PURCHASE_PENDING) {
      this.deps.emitter.emit('purchase-pending', { productId });
      return { status: 'pending', productId };
    }

    this.deps.emitter.emit('purchase-failed', { productId, error: iapError });
    return { status: 'failed', productId, error: iapError };
  }

  private handleVerifyError(productId: string, error: unknown): PurchaseResult<TEntitlement> {
    const iapError = toIAPError(
      error,
      `Backend verification of "${productId}" failed.`,
      IAPErrorCode.BACKEND_UNAVAILABLE,
    );
    // Transport / auth errors leave the unfinished entry in place for retry.
    // We surface verification_failed so the consumer UI shows a "we'll retry"
    // message; a hard `failed` would suggest the user should restart the flow.
    this.deps.emitter.emit('verification-failed', { productId, error: iapError });
    return { status: 'verification_failed', productId, error: iapError };
  }
}

function toIAPError(error: unknown, fallbackMessage: string, fallbackCode: IAPErrorCode): IAPError {
  if (isIAPError(error)) return error;
  return new IAPError({
    code: fallbackCode,
    message: fallbackMessage,
    cause: error,
  });
}
