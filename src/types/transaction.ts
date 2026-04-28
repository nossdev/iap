import type { ProductType } from './product.js';

/** Platform a transaction originated from. */
export type Platform = 'apple' | 'google';

/**
 * Normalized native transaction handed to core flows.
 * Plugin-version differences are translated by the adapter so this shape
 * stays stable across Capacitor majors.
 */
export interface NativeTransaction {
  platform: Platform;
  productId: string;
  /**
   * Apple: the StoreKit `transactionId` (numeric string).
   * Google: the `purchaseToken` from Play Billing.
   */
  token: string;
  /** Google only — required by Attesto's `/v1/google/verify`. */
  packageName?: string;
  /** Product type the transaction was originally purchased as. */
  productType: ProductType;
  /** Optional pass-through of plugin-native fields for backend hints. */
  raw?: unknown;
}

/**
 * Verified transaction returned by the consumer backend after Attesto check.
 * Generic over the backend-defined transaction shape.
 */
export interface VerifiedTransaction<TExtra = Record<string, unknown>> {
  id: string;
  productId: string;
  expiresAt: string | null;
  verifiedAt: string;
  raw?: TExtra;
}
