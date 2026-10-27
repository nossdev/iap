import { Capacitor } from '@capacitor/core';
import {
  NativePurchases,
  PURCHASE_TYPE,
  type SKProductDiscount as PluginDiscount,
  type Product as PluginProduct,
  type Transaction as PluginTransaction,
} from '@capgo/native-purchases';
import { IAPError, IAPErrorCode } from '../../../lib/errors.js';
import { toAlpha2 } from '../../../lib/iso-country.js';
import { readJwsClaims } from '../../../lib/jws.js';
import { getPlatform } from '../../../lib/platform.js';
import { toIso8601Duration } from '../../../lib/subscription-period.js';
import type {
  Product,
  ProductType,
  SubscriptionOffer,
  SubscriptionOfferPayment,
  SubscriptionOfferType,
} from '../../../types/product.js';
import type { Storefront } from '../../../types/storefront.js';
import type {
  NativeTransaction,
  Platform,
  SubscriptionRenewal,
  SubscriptionState,
} from '../../../types/transaction.js';
import type { NativeAdapter, NativePurchaseOptions } from '../types.js';

/**
 * The plugin's `Product`, retyped with what it *actually* delivers.
 *
 * `@capgo/native-purchases` declares `subscriptionPeriod` and
 * `subscriptionGroupIdentifier` as required, but its Android side sets
 * neither — so `p.subscriptionPeriod.unitString` is a TypeError on a real
 * device while typechecking clean. Narrowing them here is the only place
 * that lie is contained.
 */
type DeliveredProduct = Omit<
  PluginProduct,
  'subscriptionPeriod' | 'subscriptionGroupIdentifier' | 'introductoryPrice' | 'discounts'
> & {
  subscriptionPeriod?: unknown;
  subscriptionGroupIdentifier?: string;
  introductoryPrice?: PluginDiscount | null;
  discounts?: PluginDiscount[];
};

/** Raw storefront shape the plugin `getStorefront` resolves to. */
type NativeStorefront = { countryCode?: string; storefrontId?: string };

/**
 * The plugin surface for `getStorefront`, declared locally because some
 * installed `@capgo/native-purchases` builds predate it. Availability is
 * detected via the Capacitor plugin header (see {@link nativeStorefrontRegistered}),
 * NOT by inspecting this optional method: on a device `registerPlugin` returns
 * a Proxy that fabricates a function for any property name, so a `typeof
 * np.getStorefront === 'function'` check is always true and would not detect
 * an older plugin.
 */
type StorefrontCapablePlugin = {
  getStorefront?: () => Promise<NativeStorefront>;
};

/** Minimal shape of the Capacitor plugin-header registry we read. */
type CapacitorPluginHeaders = {
  PluginHeaders?: ReadonlyArray<{ name: string; methods?: ReadonlyArray<{ name: string }> }>;
};

/**
 * Whether the *native* `@capgo/native-purchases` build actually registered a
 * `getStorefront` method. Reads the Capacitor plugin header (the list the
 * native bridge injects) so older plugins resolve `null` without crossing the
 * bridge (which would log a native "not implemented" error on every call), and
 * the method lights up automatically once capgo ships it.
 */
function nativeStorefrontRegistered(): boolean {
  const headers = (Capacitor as CapacitorPluginHeaders).PluginHeaders;
  return (
    headers
      ?.find((h) => h.name === 'NativePurchases')
      ?.methods?.some((m) => m.name === 'getStorefront') ?? false
  );
}

/**
 * Capacitor 8 adapter for the `@capgo/native-purchases` `^8` line (this is the
 * `8.x` line of `@nosslabs/iap`; Cap-7 consumers stay on `7.x`). The v8 plugin
 * is additive over the 7.16.x surface captured in
 * `docs/internal/plugin-v7-api.md` — every method below keeps its 7.16.2
 * signature — so that capture still describes what this adapter calls.
 *
 * Plugin contract (relevant bits):
 * - `purchaseProduct({ ..., autoAcknowledgePurchases: false })` defers finishing on
 *   both iOS and Android (since v7) — this is the foundation of the
 *   "never grant entitlement before backend confirms" guarantee, with no
 *   iOS-specific finish-before-verify race.
 * - `acknowledgePurchase({ purchaseToken })` is cross-platform (since v7.14.0).
 *   For iOS, pass the `transactionId` as a string in the `purchaseToken` arg —
 *   under the hood it calls `Transaction.finish()`. Stateless: no transaction
 *   object to retain, so this adapter holds no internal state and needs no
 *   long-lived listeners.
 * - `getPurchases()` returns owned transactions, but with a platform quirk
 *   worth knowing: on iOS it bundles `Transaction.currentEntitlements`
 *   *plus* `Transaction.all` (full history including expired/revoked
 *   subscriptions); on Android it returns Google Play's owned set, and
 *   {@link CapgoNativeAdapter.getOwnedTransactions} filters out PENDING
 *   purchases (`purchaseState !== '1'`). The library passes whatever
 *   survives that filter to `backend.restore()`; the backend is the source
 *   of truth for "is this receipt currently valid" and is expected to
 *   tolerate historical iOS entries gracefully.
 */
export class CapgoNativeAdapter implements NativeAdapter {
  async isAvailable(): Promise<boolean> {
    try {
      const result = await NativePurchases.isBillingSupported();
      return result.isBillingSupported;
    } catch {
      return false;
    }
  }

  async getProducts(requests: Array<{ id: string; type: ProductType }>): Promise<Product[]> {
    if (requests.length === 0) return [];

    const inappIds: string[] = [];
    const subsIds: string[] = [];
    const requestById = new Map<string, ProductType>();

    for (const req of requests) {
      requestById.set(req.id, req.type);
      if (req.type === 'subscription') {
        subsIds.push(req.id);
      } else {
        inappIds.push(req.id);
      }
    }

    const [inapp, subs] = await Promise.all([
      inappIds.length > 0
        ? NativePurchases.getProducts({
            productIdentifiers: inappIds,
            productType: PURCHASE_TYPE.INAPP,
          })
        : Promise.resolve({ products: [] as PluginProduct[] }),
      subsIds.length > 0
        ? NativePurchases.getProducts({
            productIdentifiers: subsIds,
            productType: PURCHASE_TYPE.SUBS,
          })
        : Promise.resolve({ products: [] as PluginProduct[] }),
    ]);

    const all = [...inapp.products, ...subs.products];
    return all.map((p) => normalizeProduct(p, requestById.get(p.identifier) ?? 'product'));
  }

  async purchaseProduct(opts: NativePurchaseOptions): Promise<NativeTransaction> {
    const purchaseType = mapToPluginPurchaseType(opts.productType);
    const isConsumable = opts.productType === 'consumable';

    let tx: PluginTransaction;
    try {
      tx = await NativePurchases.purchaseProduct({
        productIdentifier: opts.productId,
        productType: purchaseType,
        planIdentifier: opts.androidPlanId,
        appAccountToken: opts.appAccountToken,
        isConsumable,
        autoAcknowledgePurchases: false,
      });
    } catch (error) {
      throw mapPurchaseError(error, opts.productId);
    }

    return normalizeTransaction(tx, opts.productType);
  }

  async getOwnedTransactions(): Promise<NativeTransaction[]> {
    const result = await NativePurchases.getPurchases();
    return (
      result.purchases
        // Drop Android PENDING purchases (purchaseState '0'); iOS has no
        // purchaseState. A pending Play purchase isn't owned yet — sending
        // it to the backend's /restore would only get rejected. (iOS-side
        // expired/revoked subs are NOT filtered here — they're part of
        // `Transaction.all` per the class-level JSDoc; the backend decides.)
        .filter((tx) => tx.purchaseState === undefined || tx.purchaseState === '1')
        .map((tx) => normalizeTransaction(tx, inferProductType(tx)))
    );
  }

  async acknowledge(transaction: NativeTransaction): Promise<void> {
    try {
      await NativePurchases.acknowledgePurchase({
        purchaseToken: transaction.token,
      });
    } catch (error) {
      throw new IAPError({
        code: IAPErrorCode.STORE_ERROR,
        message: `Failed to acknowledge transaction for ${transaction.productId}.`,
        cause: error,
        recoverable: true,
      });
    }
  }

  async manageSubscriptions(): Promise<void> {
    try {
      await NativePurchases.manageSubscriptions();
    } catch (error) {
      // No `recoverable: true` here (unlike acknowledge()): this is a UI
      // navigation action, not a transaction-lifecycle step, so there's
      // nothing for the recovery loop to retry.
      throw new IAPError({
        code: IAPErrorCode.STORE_ERROR,
        message: 'Failed to open the native subscription management UI.',
        cause: error,
      });
    }
  }

  /**
   * Read the current storefront from the native plugin — which is expected to
   * source it from StoreKit 2 `Storefront.current` on iOS (alpha-3) and
   * `getBillingConfigAsync()` on Android (alpha-2) — normalizing `countryCode`
   * to alpha-2. Silent like {@link CapgoNativeAdapter.isAvailable}: any
   * unavailability — older plugin (no native method registered), native
   * rejection, or empty country — resolves to `null` rather than throwing.
   */
  async getStorefront(): Promise<Storefront | null> {
    if (!nativeStorefrontRegistered()) return null;
    const np = NativePurchases as typeof NativePurchases & StorefrontCapablePlugin;
    try {
      const raw = await np.getStorefront?.();
      return raw ? normalizeStorefront(raw) : null;
    } catch {
      return null;
    }
  }

  async dispose(): Promise<void> {
    // No-op: this adapter owns no long-lived listeners or timers.
  }
}

function normalizeStorefront(raw: NativeStorefront): Storefront | null {
  const code = raw?.countryCode?.trim();
  if (!code) return null;

  const platform: Platform = getPlatform() === 'android' ? 'google' : 'apple';
  return {
    // alpha-2 when recognized; otherwise the uppercased raw code as a
    // best-effort fallback (see `Storefront.countryCode`).
    countryCode: toAlpha2(code) ?? code.toUpperCase(),
    countryCodeRaw: code,
    storefrontId: raw.storefrontId,
    platform,
  };
}

function normalizeProduct(raw: PluginProduct, type: ProductType): Product {
  const p = raw as DeliveredProduct;
  return {
    id: p.identifier,
    type,
    title: p.title,
    description: p.description,
    priceString: p.priceString,
    priceMicros: toMicros(p.price),
    currency: p.currencyCode,

    // `toIso8601Duration` returns null for the `{ numberOfUnits: 0, unit: 0 }`
    // placeholder a non-subscription carries, and for Android's absent value.
    subscriptionPeriod: toIso8601Duration(p.subscriptionPeriod),
    // capgo sends "" rather than null for a product with no group.
    subscriptionGroupId: p.subscriptionGroupIdentifier || null,
    introductoryOffer: p.introductoryPrice ? normalizeOffer(p.introductoryPrice) : null,
    promotionalOffers: (p.discounts ?? []).map(normalizeOffer),
    androidOfferToken: p.offerToken ?? null,
    androidOfferId: p.offerId ?? null,
  };
}

/** Price in micro-units as a string, avoiding float precision loss on render. */
function toMicros(price: number): string {
  return Math.round(price * 1_000_000).toString();
}

function normalizeOffer(discount: PluginDiscount): SubscriptionOffer {
  return {
    // An iOS introductory offer and an Android base-plan intro phase both
    // arrive with an empty identifier; neither is named by its store.
    id: discount.identifier || null,
    type: mapOfferType(discount.type),
    payment: mapOfferPayment(discount.paymentMode),
    priceString: discount.priceString,
    priceMicros: toMicros(discount.price),
    currency: discount.currencyCode,
    period: toIso8601Duration(discount.subscriptionPeriod),
    periodCount: discount.numberOfPeriods,
  };
}

/** capgo's offer-type integers: introductory=0, promotional=1, winBack=2. */
function mapOfferType(type: number): SubscriptionOfferType {
  switch (type) {
    case 0:
      return 'introductory';
    case 1:
      return 'promotional';
    case 2:
      return 'win-back';
    default:
      // capgo emits -1 for a StoreKit offer type it does not know.
      return 'unknown';
  }
}

/**
 * Map capgo's `paymentMode` integer.
 *
 * **Read the legend from capgo's code, not from its comment.** capgo's iOS
 * source labels this mapping "SKProductDiscount.PaymentMode-compatible:
 * freeTrial=0, payUpFront=1, payAsYouGo=2" — but Apple's actual
 * `SKProductDiscount.PaymentMode` is payAsYouGo=0, payUpFront=1,
 * freeTrial=2. The comment is wrong about Apple; the numbers it emits are
 * what ships, and capgo's Android side independently uses the same order
 * (price 0 → 0, non-recurring → 1, otherwise → 2).
 *
 * So both platforms agree with each other and disagree with the name in the
 * comment. Mapping from Apple's documented legend would report every free
 * trial as pay-as-you-go.
 */
function mapOfferPayment(paymentMode: number): SubscriptionOfferPayment {
  switch (paymentMode) {
    case 0:
      return 'free-trial';
    case 1:
      return 'pay-up-front';
    case 2:
      return 'pay-as-you-go';
    default:
      return 'unknown';
  }
}

function normalizeTransaction(tx: PluginTransaction, productType: ProductType): NativeTransaction {
  const platform = inferPlatform(tx);
  const token = platform === 'google' ? (tx.purchaseToken ?? tx.transactionId) : tx.transactionId;

  const native: NativeTransaction = {
    platform,
    productId: tx.productIdentifier,
    token,
    purchaseReference: purchaseReferenceFor(tx, platform, token),
    productType,
    appUserId: tx.appAccountToken ?? null,
    subscription: normalizeSubscription(tx, productType),
    raw: tx,
  };

  // packageName is not exposed by the plugin's Transaction shape; consumers
  // pass it via Capacitor app config and it's added by the backend HTTP layer
  // before sending to /verify/google.

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

/** capgo's `subscriptionState` strings, hyphenated to iap's own vocabulary. */
const SUBSCRIPTION_STATES: Readonly<Record<string, SubscriptionState>> = {
  subscribed: 'subscribed',
  expired: 'expired',
  revoked: 'revoked',
  inGracePeriod: 'in-grace-period',
  inBillingRetryPeriod: 'in-billing-retry',
  unknown: 'unknown',
};

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
    ? (SUBSCRIPTION_STATES[tx.subscriptionState] ?? 'unknown')
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
function inferProductType(tx: PluginTransaction): ProductType {
  if (tx.productType === 'subs') return 'subscription';
  return 'product';
}

function mapToPluginPurchaseType(type: ProductType): PURCHASE_TYPE {
  return type === 'subscription' ? PURCHASE_TYPE.SUBS : PURCHASE_TYPE.INAPP;
}

/**
 * Translate a `purchaseProduct()` rejection into a coded {@link IAPError} so
 * the purchase orchestrator can route it to the right `PurchaseResult` status.
 *
 * `@capgo/native-purchases` rejects with plain message strings — the
 * signals we can distinguish (verified against the plugin's native source):
 * - iOS: `"User cancelled"`, `"Transaction pending"`,
 *   `"Cannot find product for id <id>"`.
 * - Android: `"Purchase is pending"`, `"Product not found"`. Note Android
 *   does NOT distinguish user-cancel from other billing errors — both
 *   surface as `"Purchase is not purchased"`, which falls through to
 *   `STORE_ERROR`. The error-handling docs note this asymmetry for
 *   consumer UX (treat Android `failed` similarly to `cancelled`).
 */
function mapPurchaseError(error: unknown, productId: string): IAPError {
  if (error instanceof IAPError) return error;
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();

  if (lower.includes('cancel')) {
    return new IAPError({
      code: IAPErrorCode.USER_CANCELLED,
      message: `Purchase of "${productId}" was cancelled.`,
      cause: error,
    });
  }
  if (lower.includes('pending')) {
    return new IAPError({
      code: IAPErrorCode.PURCHASE_PENDING,
      message: `Purchase of "${productId}" is pending external clearance.`,
      cause: error,
    });
  }
  // iOS uses `"Cannot find product for id <id>"`; Android uses
  // `"Product not found"`. Match both shapes.
  if (lower.includes('product not found') || lower.includes('cannot find product')) {
    return new IAPError({
      code: IAPErrorCode.PRODUCT_NOT_FOUND,
      message: `Product "${productId}" was not found in the store catalog.`,
      cause: error,
    });
  }
  return new IAPError({
    code: IAPErrorCode.STORE_ERROR,
    message: `Native purchase of "${productId}" failed.`,
    cause: error,
  });
}
