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
 * Value supplied to `iap.purchase({ appUserId })`. Either a UUID
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
 * Either form is validated as an RFC 9562 UUID — **any version**, so a
 * deterministic UUIDv5 over a stable name works as well as a random v4 —
 * before being forwarded to StoreKit's `appAccountToken` (iOS) / Play
 * Billing's `obfuscatedAccountId` (Android). Non-UUID values throw
 * `IAPError(INVALID_APP_USER_ID)`, as do the nil and max UUIDs, which
 * carry no identity. A throwing/rejecting fetcher
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
  /**
   * Android, one-time products only: buy a **specific offer** rather than
   * letting the store pick.
   *
   * Pass an `offerToken` from `Product.androidOneTimeOffers`, read on the
   * **same** `getProducts()` call: Play supports several one-time purchase
   * offers on one product — a base price plus, say, a launch discount — and
   * without this the choice is Play's, not yours. The native layer sets no
   * offer token at all while the product still has a backward-compatible
   * purchase option, and Play then applies *that* one — the first offer
   * **created** in Play Console, which need not be the one listed first
   * here. Only for a product with no backward-compatible option does the
   * first offer get used. So pass the token whenever the offer matters,
   * rather than relying on the default landing where you expect. The tokens
   * are per-query device tokens, so a persisted one is rejected as
   * `INVALID_PURCHASE_OPTIONS`.
   *
   * `null` means "no offer chosen" and behaves as if omitted, since
   * `Product.androidOfferToken` is `string | null`. An **empty string** is
   * refused: it is what a defensive `token ?? ''` produces when the offer
   * has gone, and letting it through would charge whichever offer the store
   * picked while the app displayed another.
   *
   * **Refused for a subscription**, with `INVALID_PURCHASE_OPTIONS`, rather than
   * accepted and ignored. The native plugin reads an offer token only on
   * its one-time-purchase path: for a subscription it selects by base plan
   * (`androidPlanId`) and picks the offer within it itself, so a token
   * passed here would be silently dropped and a *different* offer — at a
   * different price — could be charged. `androidPlanId` is the only
   * subscription-offer control there is; see
   * [the native-layer page](https://iap.nossdev.com/guide/native-layer).
   *
   * Ignored on iOS, which has no equivalent: StoreKit promotional offers
   * need a server-signed payload the plugin does not accept.
   */
  androidOfferToken?: string;
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
