import type { ProductType } from './product.js';

/** Platform a transaction originated from. */
export type Platform = 'apple' | 'google';

/**
 * Where a subscription stands with the store, as the store reports it.
 *
 * iap passes these through; it does not interpret them. Deciding what counts
 * as "entitled" — whether a grace period still grants access, say — is the
 * consumer's business rule, and the authoritative answer comes from the
 * backend (PLAN.md §14).
 */
export type SubscriptionState =
  | 'subscribed'
  | 'expired'
  | 'revoked'
  | 'in-grace-period'
  | 'in-billing-retry'
  | 'unknown';

/**
 * Renewal detail for an auto-renewing subscription, normalized from the
 * store's own fields.
 *
 * **iOS only, in practice.** Every field is `null` on Android: the native
 * plugin exposes neither `isAutoRenewing` nor a renewal date, and reports
 * cancellation as always-null. On Android this information lives server-side
 * (Google Play Developer API), so take it from your backend.
 */
export interface SubscriptionRenewal {
  state: SubscriptionState | null;
  /**
   * Whether the subscription renews at the end of the current period.
   * `false` means the user cancelled but still has access until it expires.
   */
  autoRenewing: boolean | null;
  /** When the next period begins, ISO 8601. */
  renewsAt: string | null;
  /**
   * The product the subscription renews into — different from the current
   * one after a plan change takes effect at the period boundary.
   */
  renewalProductId: string | null;
  /** When the current period ends, ISO 8601. */
  expiresAt: string | null;
}

/**
 * Normalized native transaction handed to core flows.
 * Plugin-version differences are translated by the adapter so this shape
 * stays stable across Capacitor majors.
 */
export interface NativeTransaction {
  platform: Platform;
  productId: string;
  /**
   * Apple: the StoreKit `transactionId` (numeric string) — **changes with
   * every renewal**. Google: the `purchaseToken` from Play Billing.
   *
   * This is the handle for acknowledging *this* transaction. To store a
   * reference to the purchase itself, use `purchaseReference` — which is
   * what a consumer sees, as `StorePurchase.purchaseReference`.
   */
  token: string;
  /**
   * The stable reference to the purchase, which survives renewals — store
   * this when you need to identify the subscription later.
   *
   * Apple: `originalTransactionId`, read from the signed `jwsRepresentation`
   * payload (the plugin does not expose it as a field). Falls back to
   * `token` when the JWS is absent or unreadable, so it is always set.
   * Google: the `purchaseToken`, identical to `token`.
   */
  purchaseReference: string;
  /** Google only — required by Attesto's `/v1/google/verify`. */
  packageName?: string;
  /** Product type the transaction was originally purchased as. */
  productType: ProductType;
  /**
   * The binding this purchase was made with, read back off the transaction:
   * `appAccountToken` on iOS, `obfuscatedAccountId` on Android. `null` when
   * the purchase carried none.
   *
   * Use it to check what a purchase is bound to. iap never generates one —
   * it is whatever was passed as `iap.purchase({ appUserId })`.
   */
  appUserId?: string | null;
  /**
   * Renewal detail for a subscription, or `null` for a non-subscription and
   * on platforms that do not report it. See {@link SubscriptionRenewal}.
   */
  subscription?: SubscriptionRenewal | null;
  /** Optional pass-through of plugin-native fields for backend hints. */
  raw?: unknown;
}

/**
 * Verified transaction returned by the consumer backend after Attesto check.
 * Generic over the backend-defined transaction shape.
 */
export interface VerifiedTransaction<TExtra = Record<string, unknown>> {
  id: string;
  productId: string;
  expiresAt: string | null;
  verifiedAt: string;
  raw?: TExtra;
}
