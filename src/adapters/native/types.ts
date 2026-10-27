import type { ConfiguredProduct, Product, ProductType } from '../../types/product.js';
import type { Storefront } from '../../types/storefront.js';
import type { NativeTransaction } from '../../types/transaction.js';

export interface NativePurchaseOptions {
  productId: string;
  productType: ProductType;
  androidPlanId?: string;
  appAccountToken?: string;
}

/** Handle for removing a {@link NativeAdapter.watchTransactions} listener. */
export interface TransactionWatchHandle {
  remove(): Promise<void>;
}

export interface NativeAdapter {
  /**
   * Whether the underlying platform supports native purchases.
   * Web stub returns false; iOS/Android return true (after billing init).
   */
  isAvailable(): Promise<boolean>;

  /** Get product info merged with native pricing for the given productIds. */
  /**
   * Get product info merged with native pricing for the given products.
   *
   * Takes the whole {@link ConfiguredProduct}, not just id and type: on
   * Android `androidPlanId` is what picks a base plan out of the several
   * entries the plugin returns for one subscription.
   */
  getProducts(requests: ConfiguredProduct[]): Promise<Product[]>;

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
   * Subscribe to transactions that arrive **outside** a `purchase()` call:
   * a subscription renewal, a refund or revocation, an Ask-to-Buy request
   * the parent approved later, a pending purchase that finally cleared.
   *
   * `onUpdate` may be called at any time after subscribing, including
   * immediately for transactions the platform had queued. The handler must
   * not throw; implementations should swallow and log.
   *
   * Resolves to a handle for removing the listener, or `null` when the
   * platform has no such feed. **In practice that means Android**: the
   * capgo plugin's `transactionUpdated` event is wired from Apple's
   * `Transaction.updates` only, so Android relies on reconciliation at
   * launch and on resume instead.
   *
   * Optional: adapters may omit it entirely (the web stub does).
   */
  watchTransactions?(
    onUpdate: (transaction: NativeTransaction) => void,
  ): Promise<TransactionWatchHandle | null>;

  /**
   * Product ids the store reports as having a purchase awaiting clearance.
   *
   * Resolves `null` when the platform **cannot report** pending state, which
   * is a different answer from "nothing is pending" and is treated as such:
   * iap will not conclude a tracked pending purchase was cancelled on a
   * platform that cannot tell it apart from one still waiting. Only Android
   * can (Play's `purchaseState`), so the capgo adapter resolves `null` on
   * iOS.
   *
   * Optional: adapters may omit it.
   */
  getPendingProductIds?(): Promise<string[] | null>;

  /**
   * Tear down any long-lived listeners or timers the adapter owns.
   * Called from `iap.destroy()`. Idempotent and best-effort — failures
   * during dispose should not throw.
   */
  dispose?(): Promise<void>;
}
