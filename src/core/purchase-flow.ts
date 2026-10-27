import type { BackendAdapter, VerifyResponse } from '../adapters/backend/types.js';
import type { NativeAdapter } from '../adapters/native/types.js';
import type { TypedEventEmitter } from '../events/emitter.js';
import { IAPError, IAPErrorCode, toIAPError } from '../lib/errors.js';
import type { Logger } from '../lib/logger.js';
import { isValidUuid } from '../lib/uuid.js';
import type { EntitlementBase } from '../types/entitlement.js';
import type { ConfiguredProduct } from '../types/product.js';
import type {
  AppUserId,
  AppUserIdFetcherContext,
  PurchaseOptions,
  PurchaseResult,
} from '../types/results.js';
import type { NativeTransaction, VerifiedTransaction } from '../types/transaction.js';
import type { EntitlementCache } from './entitlement-cache.js';
import { finalizeTransaction } from './finalize-transaction.js';
import type { PendingPurchasesStore } from './pending-purchases.js';
import { resolvePendingPurchase } from './resolve-pending.js';
import { toStorePurchase } from './store-purchase.js';
import type { UnfinishedTransactionsStore } from './unfinished-transactions.js';
import { verifyNativeTransaction } from './verify-helpers.js';

interface PurchaseOrchestratorDeps<TEntitlement extends EntitlementBase> {
  /** Native adapter (capgo on iOS/Android, web stub on web). Always non-null
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
  /**
   * Resolves the auth headers the library uses for backend requests.
   * Forwarded to function-form `appUserId` fetchers as `ctx.authHeaders`
   * so consumers whose UUID-minting endpoint shares auth with their IAP
   * backend can reuse it without redefining a helper. For consumers
   * using a custom `BackendAdapter` (no `getAuthHeaders` configured),
   * this returns `{}`. Awaited fresh per purchase so token refresh
   * keeps working.
   */
  getAuthHeaders: () => Promise<Record<string, string>>;
  /**
   * Records a product whose purchase is awaiting clearance, so the
   * pending state can be closed out in a later session — a Play
   * e-wallet purchase usually clears with the app closed.
   */
  pending: PendingPurchasesStore;
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
 *    On any failure path the transaction is left in the `unfinished` store (or
 *    still owned at the store level) so it's retried on the next launch via
 *    the recovery flow.
 * 3. **Per-product lock** — concurrent `purchase('premium_monthly')` calls are
 *    rejected: the `inFlight` set throws `ALREADY_IN_PROGRESS` on the second.
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

  /**
   * Whether this orchestrator is currently handling `productId`.
   *
   * Read by the transaction-update orchestrator: StoreKit delivers the
   * transaction a purchase produced to `Transaction.updates` as well, and
   * whichever path started it owns settling it.
   */
  isInFlight(productId: string): boolean {
    return this.inFlight.has(productId);
  }

  /**
   * The products currently being purchased.
   *
   * Read by `reset()`, which refuses to run while one is in flight. The
   * reason is the unfinished-transaction entry, not the cache: that entry is
   * written *before* verification precisely so a purchase survives a crash,
   * and deleting it mid-flight leaves a purchase that is neither
   * acknowledged nor tracked — which Play auto-refunds in three days. The
   * cache coming back is harmless by comparison, since `reset()` is not a
   * revocation.
   *
   * Marked from the moment the purchase is committed to running, before any
   * consumer-supplied `appUserId` fetcher is awaited — that await is a
   * network round-trip, and a window in which this said "nothing in flight"
   * while a purchase was already under way.
   */
  inFlightProducts(): string[] {
    return [...this.inFlight];
  }

  constructor(private readonly deps: PurchaseOrchestratorDeps<TEntitlement>) {}

  async purchase(opts: PurchaseOptions): Promise<PurchaseResult<TEntitlement>> {
    const { productId, appUserId } = opts;
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

    // In flight from here, before the appUserId resolution below. That
    // resolution awaits consumer code — typically an HTTP call — and
    // marking only after it left a window the length of a network
    // round-trip in which `isInFlight`/`inFlightProducts` reported nothing
    // while the purchase was already committed. `reset()` could wipe the
    // unfinished queue in that window, and a second tap could open a
    // second native sheet.
    this.inFlight.add(productId);

    try {
      // Resolve and validate appUserId BEFORE emitting purchase-started —
      // these throws are pre-flight (caller bug or backend-fetcher
      // failure), not purchase outcomes. They surface synchronously to the
      // awaiter without polluting the event stream.
      //
      // For function-form fetchers, eagerly resolve `getAuthHeaders()` so
      // we can pass it via ctx. String-form supplies skip the await. The
      // ctx is always populated (with `{}` when no headers are wired) so
      // fetchers that destructure `({ authHeaders })` never see undefined.
      let resolvedAppUserId: string | undefined;
      if (appUserId !== undefined) {
        const ctx: AppUserIdFetcherContext =
          typeof appUserId === 'function'
            ? { authHeaders: await this.deps.getAuthHeaders() }
            : { authHeaders: {} };
        resolvedAppUserId = await resolveAppUserId(appUserId, ctx);
      }

      this.deps.emitter.emit('purchase-started', { productId });

      return await this.runFlow(product, resolvedAppUserId);
    } finally {
      this.inFlight.delete(productId);
    }
  }

  private async runFlow(
    product: ConfiguredProduct,
    appUserId: string | undefined,
  ): Promise<PurchaseResult<TEntitlement>> {
    const { nativeAdapter, logger } = this.deps;
    let nativeTx: NativeTransaction;

    // ----- 1. Native purchase -----
    try {
      nativeTx = await nativeAdapter.purchaseProduct({
        productId: product.id,
        productType: product.type,
        ...(product.androidPlanId ? { androidPlanId: product.androidPlanId } : {}),
        ...(appUserId ? { appAccountToken: appUserId } : {}),
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
      verifyResult = await verifyNativeTransaction(this.deps.backend, nativeTx);
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

  private async finalizeSuccess(
    productId: string,
    nativeTx: NativeTransaction,
    response: Extract<VerifyResponse<TEntitlement>, { valid: true }>,
  ): Promise<PurchaseResult<TEntitlement>> {
    const { nativeAdapter, cache, unfinished, emitter, logger } = this.deps;
    const transaction = response.transaction as VerifiedTransaction;
    const entitlements = response.entitlements;

    // Acknowledge the native transaction. Failure here is recoverable: the
    // entitlement is confirmed, so the user gets access — but the store
    // still considers the purchase unfinished, and on Android Google
    // auto-refunds an unacknowledged purchase after three days.
    //
    // So the unfinished entry is **kept** when this fails, for recovery to
    // retry the acknowledgement on the next launch. It used to be removed
    // regardless, on the reasoning that "a later restore()/refresh() re-acks
    // it" — but only `restore()` acknowledges, and nothing calls it
    // automatically. An ack failure therefore left a paid-for purchase
    // unacknowledged and untracked, granting access right up to the silent
    // refund.
    let acknowledged = true;
    try {
      // Acknowledge, or consume for an Android consumable — see
      // `finalizeTransaction`. Both are "tell the store we are done with
      // it", and only the second lets a consumable be bought again.
      await finalizeTransaction({ nativeAdapter, transaction: nativeTx, logger });
    } catch (error) {
      acknowledged = false;
      logger.warn(
        `Settling "${nativeTx.productId}" with the store failed; the entitlement is granted, and the transaction is retained for recovery to retry on the next launch.`,
        error,
      );
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

    if (acknowledged) {
      try {
        await unfinished.remove(nativeTx.token);
      } catch (error) {
        logger.warn(
          `Failed to remove "${productId}" from unfinished list; will be skipped on next recovery.`,
          error,
        );
      }
    }

    // A pending purchase the user retried and completed directly: clear the
    // mark, or a later reconcile finds it unowned and reports `cancelled`.
    await resolvePendingPurchase(this.deps, productId, 'purchased');

    emitter.emit('purchase-success', { productId, transaction });
    emitter.emit('entitlements-changed', {
      entitlements: this.deps.getCurrentEntitlements(),
      previous,
    });

    return {
      status: 'success',
      productId,
      transaction,
      purchase: toStorePurchase(nativeTx),
      entitlements: this.deps.getCurrentEntitlements(),
    };
  }

  private handleVerificationRejected(
    productId: string,
    response: Extract<VerifyResponse<TEntitlement>, { valid: false }>,
  ): PurchaseResult<TEntitlement> {
    // Compose both the human-readable message and the stable machine code
    // so consumers can grep for either. PLAN.md §5.8 marks `error` as the
    // stable identifier — preserve it even when message is present.
    const detail = response.message
      ? `${response.message} [${response.error}]`
      : `Backend rejected the transaction (${response.error}).`;
    const error = new IAPError({
      code: IAPErrorCode.VERIFICATION_REJECTED,
      message: detail,
    });
    this.deps.emitter.emit('verification-failed', { productId, error });
    return { status: 'verification_failed', productId, error };
  }

  private async handleNativeError(
    productId: string,
    error: unknown,
  ): Promise<PurchaseResult<TEntitlement>> {
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
      // Remember it before announcing it. The purchase can clear hours
      // later in another session, and without a persisted mark nothing
      // would ever tell the consumer the pending state had ended.
      await this.deps.pending.add(productId);
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

/**
 * Resolve an `appUserId` supply to a validated UUID string (any RFC 9562
 * version — see {@link isValidUuid}).
 *
 * - String input: validate directly.
 * - Async fetcher: invoke once (fresh per purchase — iap caches nothing,
 *   the backend owns mint-or-lookup idempotency), then validate the
 *   resolved value. Wraps fetcher rejections in
 *   `IAPError(APP_USER_ID_FETCH_FAILED, cause)` so callers can
 *   distinguish "fetcher exploded" from "fetcher returned junk".
 *
 * Function-form fetchers always receive `ctx`. Zero-arg fetchers
 * (`async () => '...'`) ignore the extra argument at runtime — JS
 * standard behavior — so 0.2.x callers continue to work unchanged.
 *
 * Throws synchronously (or via Promise rejection) on invalid input;
 * never returns a non-UUID string.
 */
async function resolveAppUserId(supply: AppUserId, ctx: AppUserIdFetcherContext): Promise<string> {
  let resolved: string;
  if (typeof supply === 'function') {
    try {
      // Cast to the ctx-form signature so the call typechecks for both
      // shapes in the union; zero-arg fetchers ignore the extra arg.
      resolved = await (supply as (ctx: AppUserIdFetcherContext) => Promise<string>)(ctx);
    } catch (cause) {
      throw new IAPError({
        code: IAPErrorCode.APP_USER_ID_FETCH_FAILED,
        message: 'The async appUserId fetcher threw or rejected.',
        cause,
      });
    }
  } else {
    resolved = supply;
  }
  if (!isValidUuid(resolved)) {
    throw new IAPError({
      code: IAPErrorCode.INVALID_APP_USER_ID,
      message: `appUserId must be an RFC 9562 UUID (any version); received ${
        typeof resolved === 'string' ? `"${resolved}"` : typeof resolved
      }.`,
    });
  }
  return resolved;
}
