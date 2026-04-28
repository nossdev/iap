/**
 * Shared factory helpers used by purchase-flow and restore-flow unit tests.
 *
 * Both test suites need stub `NativeAdapter` and `BackendAdapter` objects
 * whose default behaviours can be overridden per-test via the `overrides`
 * parameter. Centralising them here removes the duplicate definitions and
 * makes it easier to add new fields when the adapter interfaces evolve.
 */
import type { BackendAdapter } from '../../src/adapters/backend/types.js';
import type { NativeAdapter } from '../../src/adapters/native/types.js';
import type { EntitlementBase } from '../../src/types/entitlement.js';
import type { NativeTransaction } from '../../src/types/transaction.js';

export function makeAppleTransaction(productId = 'premium_monthly'): NativeTransaction {
  return {
    platform: 'apple',
    productId,
    token: `apple-token-${productId}`,
    productType: 'subscription',
  };
}

export function makeGoogleTransaction(productId = 'premium_monthly'): NativeTransaction {
  return {
    platform: 'google',
    productId,
    token: `play-token-${productId}`,
    packageName: 'com.example.app',
    productType: 'subscription',
  };
}

/**
 * Minimal `NativeAdapter` stub.
 *
 * - `purchaseProduct` throws by default so restore-flow tests fail loudly
 *   if they accidentally invoke it. Purchase-flow tests always override it.
 * - Everything else is a silent no-op or returns an empty result.
 */
export function makeNativeAdapter(overrides: Partial<NativeAdapter> = {}): NativeAdapter {
  return {
    async isAvailable() {
      return true;
    },
    async getProducts() {
      return [];
    },
    async purchaseProduct() {
      throw new Error('purchaseProduct not configured for this test');
    },
    async getOwnedTransactions() {
      return [];
    },
    async acknowledge() {
      // default success
    },
    ...overrides,
  };
}

/**
 * Minimal `BackendAdapter` stub that returns valid-true responses with empty
 * entitlement arrays. Override individual methods per-test as needed.
 */
export function makeBackend<T extends EntitlementBase>(
  overrides: Partial<BackendAdapter<T>> = {},
): BackendAdapter<T> {
  return {
    verifyApple: async () => ({
      valid: true,
      entitlements: [],
      transaction: { id: 'tx', productId: 'x' },
    }),
    verifyGoogle: async () => ({
      valid: true,
      entitlements: [],
      transaction: { id: 'tx', productId: 'x' },
    }),
    getEntitlements: async () => [],
    restore: async () => ({
      valid: true,
      entitlements: [],
      transaction: { id: 'consolidated', productId: 'consolidated' },
    }),
    ...overrides,
  } as BackendAdapter<T>;
}
