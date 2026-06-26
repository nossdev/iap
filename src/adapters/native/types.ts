import type { Product, ProductType } from '../../types/product.js';
import type { Storefront } from '../../types/storefront.js';
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
   * Start a native purchase. Resolves to a normalized NativeTransaction
   * captured in an APPROVED but UNFINISHED state.
   *
   * Adapter implementations MUST defer the platform's finish/ack call until
   * the core flow invokes `acknowledge()` — this is the foundation of the
   * "never grant entitlement before backend confirms" safety guarantee
   * (PLAN.md §2.1).
   */
  purchaseProduct(opts: NativePurchaseOptions): Promise<NativeTransaction>;

  /** All currently-owned transactions (used for restore + recovery on init). */
  getOwnedTransactions(): Promise<NativeTransaction[]>;

  /**
   * Acknowledge / finish a transaction post-verification.
   * On the capgo adapter this calls `acknowledgePurchase({ purchaseToken })`
   * (which maps to `Transaction.finish()` on iOS); on the web stub it's a
   * no-op. Idempotent: a second call against the same token is safe.
   */
  acknowledge(transaction: NativeTransaction): Promise<void>;

  /** Open the platform's native subscription management UI. */
  manageSubscriptions?(): Promise<void>;

  /**
   * Read the current storefront (country the user's store account is
   * registered to). Resolves `null` when unavailable — on web, when the
   * installed native plugin predates storefront support, or when the store
   * reports an empty country (e.g. EU alternative distribution).
   *
   * Optional: adapters may omit it. Read live; do not cache.
   */
  getStorefront?(): Promise<Storefront | null>;

  /**
   * Tear down any long-lived listeners or timers the adapter owns.
   * Called from `iap.destroy()`. Idempotent and best-effort — failures
   * during dispose should not throw.
   */
  dispose?(): Promise<void>;
}
