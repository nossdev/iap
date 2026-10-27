import { describe, expect, it } from 'vitest';
import { isExpired, verifyPurchaseOnDevice } from '../../src/core/local-verification.js';
import type { NativeTransaction } from '../../src/types/transaction.js';

/**
 * What can be checked on a device with no server — and, just as important,
 * what cannot.
 */

const NOW = Date.parse('2026-10-27T12:00:00Z');

function appleSub(over: Partial<NativeTransaction> = {}): NativeTransaction {
  return {
    platform: 'apple',
    productId: 'household_yearly',
    token: '2000001099999999',
    purchaseReference: '2000001043762129',
    productType: 'subscription',
    appUserId: null,
    subscription: {
      state: 'subscribed',
      autoRenewing: true,
      renewsAt: '2026-11-27T00:00:00Z',
      renewalProductId: 'household_yearly',
      expiresAt: '2026-11-27T00:00:00Z',
    },
    ...over,
  };
}

function playPurchase(over: Partial<NativeTransaction> = {}): NativeTransaction {
  return {
    platform: 'google',
    productId: 'household_yearly',
    token: 'play-token',
    purchaseReference: 'play-token',
    packageName: 'com.example.app',
    productType: 'subscription',
    appUserId: null,
    subscription: null,
    raw: { purchaseState: '1' },
    ...over,
  };
}

const opts = { productIds: ['household_yearly'], now: () => NOW };

describe('isExpired', () => {
  it('compares against the device clock', () => {
    expect(isExpired('2026-10-27T11:59:59Z', NOW)).toBe(true);
    expect(isExpired('2026-10-27T12:00:01Z', NOW)).toBe(false);
  });

  it('treats an absent expiry as non-expiring', () => {
    // A one-time purchase has no deadline.
    expect(isExpired(null, NOW)).toBe(false);
    expect(isExpired(undefined, NOW)).toBe(false);
  });

  it('treats an unparseable expiry as non-expiring', () => {
    // Revoking access because a date string was malformed would be a worse
    // error than honouring it — the store said the purchase exists.
    expect(isExpired('whenever', NOW)).toBe(false);
  });

  it('extends the deadline by the grace window', () => {
    const justExpired = '2026-10-27T11:00:00Z';
    expect(isExpired(justExpired, NOW)).toBe(true);
    expect(isExpired(justExpired, NOW, 2 * 60 * 60 * 1000)).toBe(false);
  });
});

describe('verifyPurchaseOnDevice', () => {
  it('accepts an iOS subscription and reports it store-signed', () => {
    const result = verifyPurchaseOnDevice(appleSub(), opts);
    expect(result.valid).toBe(true);
    if (!result.valid) return;

    // iOS is the strong case: StoreKit checked Apple's signature natively
    // before the transaction crossed the bridge.
    expect(result.purchase.assurance).toBe('store-signed');
    expect(result.purchase.purchaseReference).toBe('2000001043762129');
    expect(result.purchase.expiresAt).toBe('2026-11-27T00:00:00Z');
  });

  it('accepts a Play purchase but reports it only store-reported', () => {
    const result = verifyPurchaseOnDevice(playPurchase(), opts);
    expect(result.valid).toBe(true);
    if (!result.valid) return;

    // The honest answer on Android: no cryptographic check is possible,
    // because the native layer exposes neither Play's purchase signature
    // nor the JSON it is computed over. This is the store's word.
    expect(result.purchase.assurance).toBe('store-reported');
  });

  it('refuses a product the app does not sell', () => {
    // The store reports purchases from retired products and older app
    // versions; granting on those would unlock whatever they map to.
    const result = verifyPurchaseOnDevice(appleSub({ productId: 'legacy_tier' }), opts);
    expect(result).toMatchObject({ valid: false, error: 'PRODUCT_NOT_CONFIGURED' });
  });

  it('refuses a purchase bound to someone else', () => {
    const result = verifyPurchaseOnDevice(
      appleSub({ appUserId: '00000000-0000-4000-8000-000000000001' }),
      { ...opts, appUserId: '00000000-0000-4000-8000-000000000002' },
    );
    expect(result).toMatchObject({ valid: false, error: 'BINDING_MISMATCH' });
  });

  it('matches the binding case-insensitively', () => {
    // StoreKit returns an uppercase UUID string; callers deal in lowercase.
    const bound = '550e8400-e29b-41d4-a716-446655440000';
    const result = verifyPurchaseOnDevice(appleSub({ appUserId: bound.toUpperCase() }), {
      ...opts,
      appUserId: bound,
    });
    expect(result.valid).toBe(true);
  });

  it('refuses an unbound purchase when a binding is expected', () => {
    const result = verifyPurchaseOnDevice(appleSub({ appUserId: null }), {
      ...opts,
      appUserId: '550e8400-e29b-41d4-a716-446655440000',
    });
    expect(result).toMatchObject({ valid: false, error: 'BINDING_MISMATCH' });
  });

  it('skips the binding check when none is expected', () => {
    // A purchase made before the app started binding, or a flow with no
    // user identity, carries none — and must still work.
    expect(verifyPurchaseOnDevice(appleSub({ appUserId: null }), opts).valid).toBe(true);
    expect(
      verifyPurchaseOnDevice(appleSub({ appUserId: 'whatever' }), { ...opts, appUserId: null })
        .valid,
    ).toBe(true);
  });

  it('refuses a Play purchase that is not in the purchased state', () => {
    const result = verifyPurchaseOnDevice(playPurchase({ raw: { purchaseState: '2' } }), opts);
    expect(result).toMatchObject({ valid: false, error: 'NOT_PURCHASED' });
  });

  it('refuses an expired subscription', () => {
    const result = verifyPurchaseOnDevice(
      appleSub({
        subscription: {
          state: 'expired',
          autoRenewing: false,
          renewsAt: null,
          renewalProductId: null,
          expiresAt: '2026-10-01T00:00:00Z',
        },
      }),
      opts,
    );
    expect(result).toMatchObject({ valid: false, error: 'SUBSCRIPTION_EXPIRED' });
  });

  it('accepts a just-expired subscription inside the grace window', () => {
    const result = verifyPurchaseOnDevice(
      appleSub({
        subscription: {
          state: 'subscribed',
          autoRenewing: true,
          renewsAt: null,
          renewalProductId: null,
          expiresAt: '2026-10-27T11:00:00Z',
        },
      }),
      { ...opts, graceMs: 2 * 60 * 60 * 1000 },
    );
    // A renewal receipt is not instantaneous; locking the user out in that
    // window is worse than running slightly long.
    expect(result.valid).toBe(true);
  });

  it('accepts a non-expiring purchase', () => {
    const result = verifyPurchaseOnDevice(
      playPurchase({ productType: 'product', subscription: null }),
      opts,
    );
    expect(result.valid).toBe(true);
    if (result.valid) expect(result.purchase.expiresAt).toBeNull();
  });
});
