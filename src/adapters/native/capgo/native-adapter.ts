import {
  NativePurchases,
  PURCHASE_TYPE,
  type Product as PluginProduct,
  type Transaction as PluginTransaction,
} from '@capgo/native-purchases';
import { IAPError, IAPErrorCode } from '../../../lib/errors.js';
import type { ConfiguredProduct, Product, ProductType } from '../../../types/product.js';
import type { Storefront } from '../../../types/storefront.js';
import type { NativeTransaction } from '../../../types/transaction.js';
import type { NativeAdapter, NativePurchaseOptions } from '../types.js';
import { mapPurchaseError } from './map-purchase-error.js';
import { resolveProducts } from './normalize-product.js';
import { inferProductType, normalizeTransaction } from './normalize-transaction.js';
import { readStorefront } from './storefront.js';

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

  async getProducts(requests: ConfiguredProduct[]): Promise<Product[]> {
    if (requests.length === 0) return [];

    const inappIds: string[] = [];
    const subsIds: string[] = [];

    for (const req of requests) {
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
    return resolveProducts(all, requests);
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
    return readStorefront();
  }

  async dispose(): Promise<void> {
    // No-op: this adapter owns no long-lived listeners or timers.
  }
}

function mapToPluginPurchaseType(type: ProductType): PURCHASE_TYPE {
  return type === 'subscription' ? PURCHASE_TYPE.SUBS : PURCHASE_TYPE.INAPP;
}
