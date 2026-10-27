import type { IAPError } from '../lib/errors.js';
import type { EntitlementBase } from './entitlement.js';
import type { Platform, SubscriptionRenewal, VerifiedTransaction } from './transaction.js';

/**
 * The **store's** view of a purchase, as reported by StoreKit or Play
 * Billing — distinct from {@link VerifiedTransaction}, which is your
 * backend's view after Attesto validated the receipt.
 *
 * Both appear on a successful purchase because they answer different
 * questions. The backend's `transaction.id` identifies the receipt *it*
 * recorded; `purchaseReference` identifies the purchase as the store sees
 * it, which is what survives renewals and reinstalls.
 */
export interface StorePurchase {
  platform: Platform;
  productId: string;
  /**
   * The store's stable reference to this purchase: Apple's
   * `originalTransactionId`, Google's `purchaseToken`. Unchanged across
   * renewals, so this is what to persist if you need to recognise the
   * subscription later — re-deriving a server-side token from it months
   * after the purchase, for instance.
   *
   * Recoverable after a reinstall via `restorePurchases()`, which is the
   * only route once the install that made the purchase is gone.
   *
   * Treat it as a receipt: useful for correlation, not something to leak.
   */
  purchaseReference: string;
  /**
   * The binding this purchase was made with — the value passed as
   * `purchase({ appUserId })`, read back off the transaction. `null` when
   * the purchase carried none. iap never generates one.
   */
  appUserId: string | null;
  /**
   * Renewal detail for a subscription, or `null` when the store reported
   * none — which is always the case on Android. See
   * {@link SubscriptionRenewal}.
   */
  subscription: SubscriptionRenewal | null;
}

/**
 * Convenience context the library passes to a function-form
 * {@link AppUserId} fetcher. `authHeaders` is the result of awaiting
 * `backend.getAuthHeaders()` — the same headers the library will use
 * for its own backend requests. Resolved fresh per purchase so token
 * refresh keeps working.
 *
 * It's a convenience, not a contract: fetchers may legitimately ignore
 * the parameter. Use it when your UUID-minting endpoint shares auth
 * with your IAP backend; ignore it (and close over your own auth
 * state) when it doesn't.
 *
 * For consumers using a custom `BackendAdapter` (no `getAuthHeaders`
 * configured), `authHeaders` is `{}`.
 */
export interface AppUserIdFetcherContext {
  authHeaders: Record<string, string>;
}

/**
 * Value supplied to `iap.purchase({ appUserId })`. Either a UUID v4
 * string the caller already has (e.g. from local cache / app state) or
 * an async fetcher the library invokes once per purchase to retrieve
 * the UUID from the caller's backend (typical pattern: backend mints +
 * persists on first call, returns the existing UUID on later calls).
 *
 * The fetcher is invoked **fresh on every purchase** — iap caches
 * nothing. The backend owns the mint-or-lookup idempotency.
 *
 * Two fetcher shapes are supported:
 * - `() => Promise<string>` — closes over its own auth state.
 * - `(ctx) => Promise<string>` — receives `ctx.authHeaders` populated
 *   from `backend.getAuthHeaders()` so the auth wired up for IAP
 *   requests can be reused without redefining a helper. See
 *   {@link AppUserIdFetcherContext}.
 *
 * Either form is validated as UUID v4 before being forwarded to
 * StoreKit's `appAccountToken` (iOS) / Play Billing's
 * `obfuscatedAccountId` (Android). Non-UUID values throw
 * `IAPError(INVALID_APP_USER_ID)`. A throwing/rejecting fetcher
 * surfaces as `IAPError(APP_USER_ID_FETCH_FAILED, cause: <original>)`.
 */
export type AppUserId =
  | string
  | (() => Promise<string>)
  | ((ctx: AppUserIdFetcherContext) => Promise<string>);

/**
 * Options accepted by `iap.purchase(...)`. `productId` is required;
 * `appUserId` is optional — when omitted, no `applicationUsername` is
 * passed to the native plugin (identical to behavior before v0.2).
 */
export interface PurchaseOptions {
  productId: string;
  /**
   * Pre-attach a user identifier so it travels through the StoreKit /
   * Play Billing purchase and reaches your backend on both the verify
   * response and the eventual webhook. Eliminates the verify/webhook
   * race for purchases where you have a user identity at purchase time.
   * See `AppUserId` for supplied-value semantics.
   */
  appUserId?: AppUserId;
}

export type PurchaseResult<TEntitlement extends EntitlementBase = EntitlementBase> =
  | {
      status: 'success';
      productId: string;
      /** Your backend's view of the receipt, after Attesto validated it. */
      transaction: VerifiedTransaction;
      /** The store's own view of the purchase. See {@link StorePurchase}. */
      purchase: StorePurchase;
      entitlements: TEntitlement[];
    }
  | { status: 'cancelled'; productId: string }
  | { status: 'pending'; productId: string }
  | { status: 'verification_failed'; productId: string; error: IAPError }
  | { status: 'failed'; productId: string; error: IAPError };

export interface RestoreResult<TEntitlement extends EntitlementBase = EntitlementBase> {
  restored: number;
  entitlements: TEntitlement[];
  /**
   * The store's view of every transaction the account currently owns — one
   * entry per transaction submitted, in the order the store reported them.
   * Empty when the store reports nothing owned.
   *
   * This is the route to a {@link StorePurchase.purchaseReference} after a
   * reinstall or on a new device, where the install that made the purchase
   * no longer exists to have kept it.
   */
  purchases: StorePurchase[];
}
