import type { ProductType } from '../types/product.js';
import type { NativeTransaction, Platform, SubscriptionRenewal } from '../types/transaction.js';

/**
 * How strongly a purchase was checked. Exposed rather than hidden, because
 * the two platforms genuinely differ and a consumer deciding what to unlock
 * offline deserves to know which one it got.
 *
 * - `store-signed` — iOS. StoreKit 2 verified Apple's signature over the
 *   transaction in native code before it ever reached the WebView; the
 *   native layer resolves a purchase only for a `VerificationResult.verified`
 *   and rejects anything else. So this is a cryptographic guarantee, made by
 *   the platform rather than by iap.
 * - `store-reported` — Android. The native layer exposes neither Play's
 *   purchase signature nor the original JSON, so **no cryptographic check is
 *   possible on the device**. This means "Play told this device it owns
 *   this", which is a real answer and the one Play's own client APIs give —
 *   but it is the store's say-so, not proof.
 *
 * Neither is a substitute for server-side validation against the store's
 * API. A rooted device can lie to the app about both.
 */
export type PurchaseAssurance = 'store-signed' | 'store-reported';

/** Why a local check refused a purchase. Stable strings, safe to switch on. */
export type LocalVerificationError =
  | 'PRODUCT_NOT_CONFIGURED'
  | 'BINDING_MISMATCH'
  /**
   * The app binds purchases to an account, and there is no account to bind
   * to right now — a signed-out session, or a `verification.appUserId`
   * getter that threw. Raised by `LocalVerificationAdapter`, never by
   * {@link verifyPurchaseOnDevice}, which is told the binding rather than
   * resolving it.
   */
  | 'BINDING_UNAVAILABLE'
  | 'NOT_PURCHASED'
  | 'REVOKED'
  | 'SUBSCRIPTION_EXPIRED';

/** A purchase that passed the on-device checks. */
export interface LocallyVerifiedPurchase {
  productId: string;
  platform: Platform;
  /**
   * What the purchase was bought as.
   *
   * Exposed because it changes what an entitlement *means*, and a mapper
   * needs to know. In particular iOS's owned set retains **finished
   * consumables**, so a mapper that grants on every verified purchase
   * re-grants a consumable on every refresh, forever. A consumable's effect
   * belongs in your own records, not in a standing entitlement.
   */
  productType: ProductType;
  /** Stable across renewals. See `NativeTransaction.purchaseReference`. */
  purchaseReference: string;
  /** The binding the purchase carried, or `null`. */
  appUserId: string | null;
  /** ISO 8601 for a subscription; `null` for a non-expiring purchase. */
  expiresAt: string | null;
  subscription: SubscriptionRenewal | null;
  /** How strongly this was checked. See {@link PurchaseAssurance}. */
  assurance: PurchaseAssurance;
}

export type LocalVerification =
  | { valid: true; purchase: LocallyVerifiedPurchase }
  | { valid: false; error: LocalVerificationError; message: string };

export interface LocalVerificationOptions {
  /**
   * Product ids the app sells. A transaction for anything else is refused —
   * the store can report purchases from a previous version of the app, or
   * from a product that has since been retired.
   */
  productIds: readonly string[];
  /**
   * When set, the purchase must carry this binding. Compared
   * case-insensitively, because StoreKit returns an uppercase UUID string
   * while callers deal in lowercase.
   *
   * `null` or omitted skips the check: a purchase made before the app
   * started binding, or a flow with no user identity, carries none.
   */
  appUserId?: string | null;
  /** Extra time past `expiresAt` during which a subscription still counts. */
  graceMs?: number;
  /** Injectable clock. Defaults to `Date.now`. */
  now?: () => number;
}

/**
 * Whether an ISO 8601 expiry has passed, by the **device** clock.
 *
 * The device clock is the only clock available with no backend, and it can
 * be wrong — a user can set it back and extend a subscription. That is the
 * accepted cost of working offline, and the reason this is not a substitute
 * for server-side validation.
 *
 * An unparseable or absent expiry is treated as "does not expire" rather
 * than "expired": refusing a purchase because its expiry string was
 * malformed would revoke access over a formatting problem.
 *
 * `expiresAt` must be ISO 8601. `Date.parse` is lenient and
 * implementation-defined for anything else — `'10/26/2026'` parses as
 * *local* time in V8 — so a non-ISO string may compare against the wrong
 * instant. Everything iap produces is ISO 8601; this matters only for a
 * value you supply. An exact boundary (`now === expiry`) reads as active.
 */
export function isExpired(expiresAt: string | null | undefined, now: number, graceMs = 0): boolean {
  if (!expiresAt) return false;
  const expiry = Date.parse(expiresAt);
  if (Number.isNaN(expiry)) return false;
  // A non-finite grace would make `now > expiry + grace` false for every
  // date, so nothing would ever expire. This is a public export, so the
  // config schema's validation is not the only gate.
  const grace = Number.isFinite(graceMs) ? graceMs : 0;
  return now > expiry + grace;
}

/**
 * Check a purchase on the device, with no backend.
 *
 * This is the whole of what can be checked without a server, and it is
 * deliberately a short list:
 *
 * 1. The product is one the app actually sells.
 * 2. The binding matches, when one is expected.
 * 3. On Android, the store calls the purchase purchased rather than pending.
 * 4. The purchase has not been revoked or refunded, where the platform
 *    says so locally (iOS does; Android does not).
 * 5. A subscription has not expired by the device clock.
 *
 * What it does **not** do is verify a signature. On iOS it does not need to —
 * the platform already did, natively, and {@link PurchaseAssurance}
 * records that. On Android it cannot: the native layer exposes neither
 * Play's purchase signature nor the original JSON it is computed over.
 *
 * So a passing result means "this device's store says it owns this, and the
 * claim is internally consistent" — strong on iOS, the store's word on
 * Android. For anything where being wrong is expensive, verify server-side.
 */
export function verifyPurchaseOnDevice(
  transaction: NativeTransaction,
  options: LocalVerificationOptions,
): LocalVerification {
  const now = (options.now ?? Date.now)();

  if (!options.productIds.includes(transaction.productId)) {
    return {
      valid: false,
      error: 'PRODUCT_NOT_CONFIGURED',
      message: `The store reported a purchase of "${transaction.productId}", which is not in the configured product list.`,
    };
  }

  const expected = options.appUserId;
  if (expected) {
    const actual = transaction.appUserId ?? null;
    if (actual === null || actual.toLowerCase() !== expected.toLowerCase()) {
      return {
        valid: false,
        error: 'BINDING_MISMATCH',
        message: `The purchase of "${transaction.productId}" is not bound to the expected account.`,
      };
    }
  }

  // Android reports a purchase awaiting clearance as owned-but-not-purchased.
  // `getOwnedTransactions` already filters those out, so this is a second
  // line of defence for a transaction that reached here another way.
  if (transaction.platform === 'google') {
    const state = (transaction.raw as { purchaseState?: unknown } | undefined)?.purchaseState;
    // Coerced, not type-narrowed: the value crosses a native bridge, and a
    // `typeof === 'string'` gate would skip the check entirely if the plugin
    // ever sent a number. Play's own enum has PURCHASED = 1.
    if (state !== undefined && state !== null && String(state) !== '1') {
      return {
        valid: false,
        error: 'NOT_PURCHASED',
        message: `The purchase of "${transaction.productId}" is not in Play's purchased state.`,
      };
    }
  }

  // A refund or revocation, which iOS **does** report on the device — and
  // which the owned set still contains, because `Transaction.all` retains
  // revoked transactions. Missing this granted a refunded non-expiring
  // purchase forever, since it has no expiry to fall back on.
  //
  // Android reports none of this locally: a refunded Play purchase simply
  // disappears from the owned set, which is why refund detection there needs
  // the server API.
  const revocationDate = (transaction.raw as { revocationDate?: unknown } | undefined)
    ?.revocationDate;
  if (transaction.subscription?.state === 'revoked' || typeof revocationDate === 'string') {
    return {
      valid: false,
      error: 'REVOKED',
      message: `The purchase of "${transaction.productId}" has been revoked or refunded.`,
    };
  }

  const expiresAt = transaction.subscription?.expiresAt ?? null;
  if (isExpired(expiresAt, now, options.graceMs)) {
    return {
      valid: false,
      error: 'SUBSCRIPTION_EXPIRED',
      message: `The subscription "${transaction.productId}" expired at ${expiresAt}.`,
    };
  }

  return {
    valid: true,
    purchase: {
      productId: transaction.productId,
      platform: transaction.platform,
      productType: transaction.productType,
      purchaseReference: transaction.purchaseReference,
      appUserId: transaction.appUserId ?? null,
      expiresAt,
      subscription: transaction.subscription ?? null,
      // iOS transactions are signature-checked by StoreKit in native code
      // before they cross the bridge; Android has no equivalent available.
      assurance: transaction.platform === 'apple' ? 'store-signed' : 'store-reported',
    },
  };
}
