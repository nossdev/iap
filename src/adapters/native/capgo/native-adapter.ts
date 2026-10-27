import {
  NativePurchases,
  PURCHASE_TYPE,
  type Product as PluginProduct,
  type Transaction as PluginTransaction,
} from '@capgo/native-purchases';
import { IAPError, IAPErrorCode } from '../../../lib/errors.js';
import type { Logger } from '../../../lib/logger.js';
import type { ConfiguredProduct, Product, ProductType } from '../../../types/product.js';
import type { Storefront } from '../../../types/storefront.js';
import type { NativeTransaction } from '../../../types/transaction.js';
import type { NativeAdapter, NativePurchaseOptions, TransactionWatchHandle } from '../types.js';
import { mapPurchaseError } from './map-purchase-error.js';
import { resolveProducts } from './normalize-product.js';
import { inferProductType, normalizeTransaction } from './normalize-transaction.js';
import { readStorefront } from './storefront.js';
import { getCapgoPendingProductIds, watchCapgoTransactions } from './watch-transactions.js';

/**
 * Capacitor 8 adapter for the `@capgo/native-purchases` `^8` line (this is the
 * `8.x` line of `@nosslabs/iap`; Cap-7 consumers stay on `7.x`). The v8 plugin
 * is additive over the 7.16.x surface captured in
 * `docs/internal/plugin-v7-api.md` — every method that capture lists keeps
 * its 7.16.2 signature. It is no longer the *whole* of what this adapter
 * calls, though: `getStorefront()` and `consumePurchase()` are both v8-only
 * additions absent from it, and the peer range's floor is the version that
 * added the second (`8.2.0`).
 *
 * Plugin contract (relevant bits):
 * - `purchaseProduct({ ..., autoAcknowledgePurchases: false })` defers finishing on
 *   both iOS and Android (since v7) — this is the foundation of the
 *   "never grant entitlement before backend confirms" guarantee, with no
 *   iOS-specific finish-before-verify race.
 * - `acknowledgePurchase({ purchaseToken })` is cross-platform (since v7.14.0).
 * - `consumePurchase({ purchaseToken })` (since 8.2.0) is Android-only and
 *   both acknowledges and releases ownership, which is the only way a
 *   consumable can be bought again. iap never passes the plugin's
 *   `isConsumable` flag, because the plugin acts on it inside the purchase
 *   callback regardless of `autoAcknowledgePurchases` — see
 *   {@link CapgoNativeAdapter.purchaseProduct}.
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
  /**
   * @param logger used by the best-effort paths that swallow their failures.
   * @param packageName the app's Android applicationId, from
   *   `config.android.packageName`. Stamped onto every Google transaction
   *   because the plugin does not report it and Google's verification
   *   APIs are keyed on it.
   * @param getConfiguredProducts the catalog, for typing a transaction the
   *   store reported — the plugin's payload cannot distinguish a consumable
   *   from a one-time purchase, since Play calls both `'inapp'`.
   */
  constructor(
    private readonly logger: Logger,
    private readonly packageName?: string,
    private readonly getConfiguredProducts?: () => readonly ConfiguredProduct[],
  ) {}

  /**
   * The configured catalog, for typing a transaction the store reported.
   *
   * An empty one is not benign: every store-reported consumable would type
   * as `'product'`, be acknowledged rather than consumed, and stay owned —
   * which is the bug the catalog exists to prevent, reachable by
   * misconfiguration rather than by code. Warned once, since
   * `getOwnedTransactions` runs on every refresh.
   */
  private configured(): readonly ConfiguredProduct[] {
    const products = this.getConfiguredProducts?.() ?? [];
    if (products.length === 0 && !this.warnedAboutEmptyCatalog) {
      this.warnedAboutEmptyCatalog = true;
      this.logger.warn(
        'The native adapter has no configured products, so a purchase the store reports cannot be recognised as a consumable and will be acknowledged rather than consumed — leaving it owned and unbuyable. This is a wiring problem inside iap; please report it.',
      );
    }
    return products;
  }

  private warnedAboutEmptyCatalog = false;

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

    let tx: PluginTransaction;
    try {
      tx = await NativePurchases.purchaseProduct({
        productIdentifier: opts.productId,
        productType: purchaseType,
        planIdentifier: opts.androidPlanId,
        appAccountToken: opts.appAccountToken,
        // `false` even for a consumable, and this is load-bearing.
        //
        // `autoAcknowledgePurchases: false` does **not** cover the
        // consumable case: the plugin's `PurchaseActionDecider` returns
        // CONSUME whenever `isConsumable` is set, and its caller consumes
        // without consulting `autoAcknowledgePurchases` — that flag is only
        // read on the ACKNOWLEDGE branch. (Checked in the plugin's Java,
        // not its docs, and guarded by a test in
        // `tests/unit/native-plugin-contract.test.ts`.)
        //
        // So passing `true` here would have the plugin consume inside the
        // purchase callback, before iap has verified anything — breaking
        // acknowledge-only-after-verification for exactly the product type
        // where it cannot be undone, since Billing 8.x drops a consumed
        // purchase from `getPurchases()` entirely. iap consumes itself,
        // after verification, via {@link CapgoNativeAdapter.consume}.
        isConsumable: false,
        autoAcknowledgePurchases: false,
      });
    } catch (error) {
      throw mapPurchaseError(error, opts.productId);
    }

    return normalizeTransaction(tx, opts.productType, this.packageName);
  }

  async getOwnedTransactions(): Promise<NativeTransaction[]> {
    const result = await NativePurchases.getPurchases();
    return (
      result.purchases
        // Keep only Android PURCHASED purchases; iOS has no purchaseState.
        // A pending Play purchase isn't owned yet — sending it to the
        // backend's /restore would only get rejected. Note Play's enum is
        // UNSPECIFIED_STATE=0, PURCHASED=1, PENDING=2 — the plugin's own
        // .d.ts claims 0 means pending and is wrong; keeping only '1' is
        // correct regardless. (iOS-side
        // expired/revoked subs are NOT filtered here — they're part of
        // `Transaction.all` per the class-level JSDoc; the backend decides.)
        .filter((tx) => tx.purchaseState === undefined || tx.purchaseState === '1')
        .map((tx) =>
          normalizeTransaction(tx, inferProductType(tx, this.configured()), this.packageName),
        )
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

  /**
   * Consume an Android consumable, releasing ownership so it can be bought
   * again. See {@link NativeAdapter.consume} for why acknowledging is not
   * enough.
   *
   * The plugin rejects this on iOS and web, so the core calls it only for
   * Google transactions.
   */
  async consume(transaction: NativeTransaction): Promise<void> {
    try {
      await NativePurchases.consumePurchase({
        purchaseToken: transaction.token,
      });
    } catch (error) {
      throw new IAPError({
        code: IAPErrorCode.STORE_ERROR,
        message: `Failed to consume transaction for ${transaction.productId}.`,
        cause: error,
        // Retried by the recovery loop like a failed acknowledge: until it
        // succeeds, Play still reports the product owned and the user
        // cannot buy it again.
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

  /**
   * Subscribe to Apple's `Transaction.updates`. See
   * {@link watchCapgoTransactions} — iOS only in practice, and silent
   * about its own failures, since a missing listener degrades to
   * reconciliation rather than breaking anything.
   */
  async watchTransactions(
    onUpdate: (transaction: NativeTransaction) => void,
  ): Promise<TransactionWatchHandle | null> {
    return watchCapgoTransactions(onUpdate, this.logger, this.packageName, () => this.configured());
  }

  /** Android only; `null` on iOS. See {@link getCapgoPendingProductIds}. */
  async getPendingProductIds(): Promise<string[] | null> {
    return getCapgoPendingProductIds(this.logger);
  }

  async dispose(): Promise<void> {
    // No-op: this adapter owns no long-lived listeners or timers.
  }
}

function mapToPluginPurchaseType(type: ProductType): PURCHASE_TYPE {
  return type === 'subscription' ? PURCHASE_TYPE.SUBS : PURCHASE_TYPE.INAPP;
}
