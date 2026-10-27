import type { NativeTransaction } from '../../src/types/transaction.js';

/**
 * `NativeTransaction` builders, shared because three test files were each
 * writing their own.
 *
 * Unlike the `vi.mock` scaffolding in those files, these need no hoisting,
 * so they extract cleanly. (The mock factories do not: `vi.mock` is hoisted
 * above imports and `vi.hoisted` cannot synchronously import, so sharing one
 * mock instance would need a `globalThis` singleton — worse than the
 * boilerplate it removes.)
 *
 * Both builders set a `purchaseReference` that **differs** from `token` on
 * Apple, because that is true on a real device — the token changes with each
 * renewal while the reference does not — so a test that conflates them
 * fails here rather than in production.
 */

export function appleTransaction(over: Partial<NativeTransaction> = {}): NativeTransaction {
  return {
    platform: 'apple',
    productId: 'household_yearly',
    token: '2000001099999999',
    purchaseReference: '2000001043762129',
    productType: 'subscription',
    appUserId: null,
    subscription: null,
    ...over,
  };
}

export function playTransaction(over: Partial<NativeTransaction> = {}): NativeTransaction {
  return {
    platform: 'google',
    productId: 'household_yearly',
    token: 'play-token',
    // On Android the purchase token *is* the stable reference.
    purchaseReference: 'play-token',
    packageName: 'com.example.app',
    productType: 'subscription',
    appUserId: null,
    subscription: null,
    raw: { purchaseState: '1' },
    ...over,
  };
}

/** An active auto-renewing subscription, expiring at `expiresAt`. */
export function activeSubscription(expiresAt: string): NativeTransaction['subscription'] {
  return {
    state: 'subscribed',
    autoRenewing: true,
    renewsAt: expiresAt,
    renewalProductId: 'household_yearly',
    expiresAt,
  };
}

/** A subscription the store reports as expired at `expiresAt`. */
export function expiredSubscription(expiresAt: string): NativeTransaction['subscription'] {
  return {
    state: 'expired',
    autoRenewing: false,
    renewsAt: null,
    renewalProductId: null,
    expiresAt,
  };
}
