import {
  NativePurchases,
  PURCHASE_TYPE,
  type Product as PluginProduct,
  type Transaction as PluginTransaction,
} from '@capgo/native-purchases';
import { IAPError, IAPErrorCode } from '../../../lib/errors.js';
import { getPlatform } from '../../../lib/platform.js';
import type { Product, ProductType } from '../../../types/product.js';
import type { NativeTransaction, Platform } from '../../../types/transaction.js';
import type { NativeAdapter, NativePurchaseOptions } from '../types.js';

/**
 * Capacitor 7 adapter built against `@capgo/native-purchases@7.16.2`.
 *
 * Plugin contract (relevant bits):
 * - `purchaseProduct({ ..., autoAcknowledgePurchases: false })` defers finishing on
 *   both iOS and Android (since v7).
 * - `acknowledgePurchase({ purchaseToken })` is cross-platform (since v7.14.0).
 *   For iOS, pass the `transactionId` as a string in the `purchaseToken` arg —
 *   under the hood it calls `Transaction.finish()`.
 * - `getPurchases()` returns owned transactions on both platforms.
 */
export class V7NativeAdapter implements NativeAdapter {
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

    const tx = await NativePurchases.purchaseProduct({
      productIdentifier: opts.productId,
      productType: purchaseType,
      planIdentifier: opts.androidPlanId,
      appAccountToken: opts.appAccountToken,
      isConsumable,
      autoAcknowledgePurchases: false,
    });

    return normalizeTransaction(tx, opts.productType);
  }

  async getOwnedTransactions(): Promise<NativeTransaction[]> {
    const result = await NativePurchases.getPurchases();
    return result.purchases.map((tx) => normalizeTransaction(tx, inferProductType(tx)));
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
    await NativePurchases.manageSubscriptions();
  }
}

function normalizeProduct(p: PluginProduct, type: ProductType): Product {
  const priceMicros = Math.round(p.price * 1_000_000).toString();
  return {
    id: p.identifier,
    type,
    title: p.title,
    description: p.description,
    priceString: p.priceString,
    priceMicros,
    currency: p.currencyCode,
  };
}

function normalizeTransaction(tx: PluginTransaction, productType: ProductType): NativeTransaction {
  const platform = inferPlatform(tx);
  const token = platform === 'google' ? (tx.purchaseToken ?? tx.transactionId) : tx.transactionId;

  const native: NativeTransaction = {
    platform,
    productId: tx.productIdentifier,
    token,
    productType,
    raw: tx,
  };

  // packageName is not exposed by the plugin's Transaction shape; consumers
  // pass it via Capacitor app config and it's added by the backend HTTP layer
  // before sending to /verify/google.

  return native;
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

function inferProductType(tx: PluginTransaction): ProductType {
  if (tx.productType === 'subs') return 'subscription';
  return 'product';
}

function mapToPluginPurchaseType(type: ProductType): PURCHASE_TYPE {
  return type === 'subscription' ? PURCHASE_TYPE.SUBS : PURCHASE_TYPE.INAPP;
}
