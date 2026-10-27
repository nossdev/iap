import type { Transaction as PluginTransaction } from '@capgo/native-purchases';
import { readJwsClaims } from '../../../lib/jws.js';
import { getPlatform } from '../../../lib/platform.js';
import type { ProductType } from '../../../types/product.js';
import type {
  NativeTransaction,
  Platform,
  SubscriptionRenewal,
  SubscriptionState,
} from '../../../types/transaction.js';

export function normalizeTransaction(
  tx: PluginTransaction,
  productType: ProductType,
  packageName?: string,
): NativeTransaction {
  const platform = inferPlatform(tx);
  const token = platform === 'google' ? (tx.purchaseToken ?? tx.transactionId) : tx.transactionId;

  const native: NativeTransaction = {
    platform,
    productId: tx.productIdentifier,
    token,
    purchaseReference: purchaseReferenceFor(tx, platform, token),
    productType,
    // Lower-cased so it compares equal to what the caller supplied:
    // StoreKit returns `UUID.uuidString`, which Swift renders uppercase,
    // while `crypto.randomUUID()` and iap's case-insensitive validator both
    // deal in lowercase. Returned raw, the binding would never `===` the
    // value that was sent — the one comparison this field exists for.
    appUserId: tx.appAccountToken?.toLowerCase() ?? null,
    subscription: normalizeSubscription(tx, productType),
    raw: tx,
  };

  // The plugin's Transaction shape has no packageName, and Google's
  // verification APIs are keyed on it — so it comes from
  // `config.android.packageName` and is stamped on here. Without it the
  // verify and restore requests cannot be built at all, which is why
  // omitting it is a config error rather than a silent degradation.
  if (native.platform === 'google' && packageName) {
    native.packageName = packageName;
  }

  return native;
}

/**
 * The reference that survives renewals.
 *
 * Google's `purchaseToken` already is one. Apple's `transactionId` is not —
 * it changes on every renewal — and the plugin does not expose
 * `originalTransactionId` as a field, so it is read out of the signed JWS
 * payload. That decode is for data only; Apple's signature was already
 * verified natively (see {@link readJwsClaims}).
 *
 * Falls back to `token` whenever the claim is unavailable, so the field is
 * always populated and a malformed JWS can never fail a purchase.
 */
function purchaseReferenceFor(tx: PluginTransaction, platform: Platform, token: string): string {
  if (platform === 'google' || !tx.jwsRepresentation) return token;

  const claims = readJwsClaims(tx.jwsRepresentation);
  const original = claims?.originalTransactionId;
  return typeof original === 'string' && original.length > 0 ? original : token;
}

/**
 * capgo's `subscriptionState` strings, hyphenated to iap's own vocabulary.
 *
 * A `Map`, not an object literal: the key arrives off a native bridge, and
 * a plain object resolves inherited names — looking up 'constructor' would
 * return a function, so the `?? 'unknown'` fallback would not fire and
 * `state` would be a function at runtime while typed as a string union.
 */
const SUBSCRIPTION_STATES: ReadonlyMap<string, SubscriptionState> = new Map([
  ['subscribed', 'subscribed'],
  ['expired', 'expired'],
  ['revoked', 'revoked'],
  ['inGracePeriod', 'in-grace-period'],
  ['inBillingRetryPeriod', 'in-billing-retry'],
  ['unknown', 'unknown'],
]);

/**
 * Renewal detail, or `null` when there is none to report.
 *
 * In practice this is iOS-only: on Android the plugin exposes no
 * subscription state, no expiry and no renewal info, and always sends
 * `willCancel: null` — so every field would be null, and a renewal object
 * full of nulls is worse than none. Returning `null` says "ask the server",
 * which is the correct answer on Android.
 */
function normalizeSubscription(
  tx: PluginTransaction,
  productType: ProductType,
): SubscriptionRenewal | null {
  if (productType !== 'subscription') return null;

  const renewalInfo = tx.renewalInfo;
  const state = tx.subscriptionState
    ? (SUBSCRIPTION_STATES.get(tx.subscriptionState) ?? 'unknown')
    : null;

  // `willAutoRenew` is the direct answer; `willCancel` is its inverse and
  // the only signal older builds and some states provide.
  const autoRenewing =
    renewalInfo?.willAutoRenew ?? (typeof tx.willCancel === 'boolean' ? !tx.willCancel : null);

  const renewal: SubscriptionRenewal = {
    state,
    autoRenewing,
    renewsAt: renewalInfo?.renewalDate ?? null,
    renewalProductId: renewalInfo?.autoRenewProductId ?? null,
    expiresAt: tx.expirationDate ?? null,
  };

  // Nothing was reported — say so, rather than handing back all-nulls.
  const reportedNothing =
    renewal.state === null &&
    renewal.autoRenewing === null &&
    renewal.renewsAt === null &&
    renewal.renewalProductId === null &&
    renewal.expiresAt === null;

  return reportedNothing ? null : renewal;
}

function inferPlatform(tx: PluginTransaction): Platform {
  if (
    tx.purchaseToken !== undefined ||
    tx.purchaseState !== undefined ||
    tx.orderId !== undefined
  ) {
    return 'google';
  }
  if (tx.receipt !== undefined || tx.jwsRepresentation !== undefined) {
    return 'apple';
  }
  // Fall back to runtime platform.
  return getPlatform() === 'android' ? 'google' : 'apple';
}

// The plugin's Transaction only carries 'inapp' | 'subs', so this never
// resolves to 'consumable' — fine, since getOwnedTransactions() consumers
// (restore-flow) key on platform/token/packageName, not the consumable bit.
export function inferProductType(tx: PluginTransaction): ProductType {
  if (tx.productType === 'subs') return 'subscription';
  return 'product';
}
