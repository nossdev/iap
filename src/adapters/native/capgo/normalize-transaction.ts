import type { Transaction as PluginTransaction } from '@capgo/native-purchases';
import { readJwsClaims } from '../../../lib/jws.js';
import { getPlatform } from '../../../lib/platform.js';
import type { ConfiguredProduct, ProductType } from '../../../types/product.js';
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

/**
 * The product type of a transaction the *store* reported.
 *
 * The **store's family is authoritative**, and the catalog only refines
 * within it. The store knows whether it sold a subscription, because the
 * payload comes out of the subscription query or the in-app one. What it
 * cannot say is which kind of in-app purchase: `'inapp'` covers consumables
 * and one-time purchases alike, and that difference decides whether iap
 * acknowledges the transaction or consumes it. A consumable mistyped as
 * `'product'` is acknowledged but never consumed, so Play keeps reporting it
 * owned and `purchase()` of it fails `ALREADY_PURCHASED` for good — the user
 * paid for something they can never buy again.
 *
 * The order matters the other way round too, and more dangerously. Letting
 * the catalog override `'subs'` would let one wrong `type` — in a hand-written
 * config, or in a stale `backend.listProducts()` manifest, which is validated
 * for shape only — turn a subscription into a `'product'`. `normalizeTransaction`
 * drops the whole `subscription` block for a non-subscription, so the
 * transaction would arrive with no expiry and no renewal state, and an
 * on-device check would read "does not expire" and grant an expired
 * subscription indefinitely.
 */
export function inferProductType(
  tx: PluginTransaction,
  configured?: readonly ConfiguredProduct[],
): ProductType {
  if (tx.productType === 'subs') return 'subscription';

  const declared = configured?.find((p) => p.id === tx.productIdentifier)?.type;
  // Only `'consumable'` is a refinement of `'inapp'`. Anything else the
  // catalog says — including `'subscription'`, which the store has just
  // contradicted — leaves the store's answer standing.
  return declared === 'consumable' ? 'consumable' : 'product';
}
