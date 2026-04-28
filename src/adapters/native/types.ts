import type { Product, ProductType } from '../../types/product.js';
import type { NativeTransaction } from '../../types/transaction.js';

export interface NativePurchaseOptions {
  productId: string;
  productType: ProductType;
  androidPlanId?: string;
  appAccountToken?: string;
}

export interface NativeAdapter {
  /**
   * Whether the underlying platform supports native purchases.
   * Web stub returns false; iOS/Android return true (after billing init).
   */
  isAvailable(): Promise<boolean>;

  /** Get product info merged with native pricing for the given productIds. */
  getProducts(requests: Array<{ id: string; type: ProductType }>): Promise<Product[]>;

  /**
   * Start a native purchase. Resolves to a normalized NativeTransaction.
   * Adapter MUST set `autoAcknowledgePurchases: false` so finishing is deferred.
   */
  purchaseProduct(opts: NativePurchaseOptions): Promise<NativeTransaction>;

  /** All currently-owned transactions (used for restore + recovery on init). */
  getOwnedTransactions(): Promise<NativeTransaction[]>;

  /**
   * Acknowledge / finish a transaction post-verification.
   * Translates to `acknowledgePurchase({ purchaseToken })` on v7+ for both platforms.
   * Web stub is a no-op.
   */
  acknowledge(transaction: NativeTransaction): Promise<void>;

  /** Open native subscription management UI. */
  manageSubscriptions?(): Promise<void>;
}
