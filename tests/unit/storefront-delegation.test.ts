import { describe, expect, it, vi } from 'vitest';

// Force the web platform so initialize() stays simple (no recovery/resume), and
// inject a fake native adapter via selectNativeAdapter so we can assert the
// createIAP -> adapter delegation returns the Storefront verbatim.
vi.mock('@capacitor/core', () => ({
  Capacitor: { getPlatform: () => 'web', isNativePlatform: () => false },
}));

const mocks = vi.hoisted(() => ({ getStorefront: vi.fn() }));

vi.mock('../../src/adapters/native/index.js', () => ({
  selectNativeAdapter: vi.fn(async () => ({
    isAvailable: vi.fn().mockResolvedValue(true),
    getProducts: vi.fn().mockResolvedValue([]),
    purchaseProduct: vi.fn(),
    getOwnedTransactions: vi.fn().mockResolvedValue([]),
    acknowledge: vi.fn().mockResolvedValue(undefined),
    getStorefront: mocks.getStorefront,
  })),
}));

import { createIAP } from '../../src/createIAP.js';
import type { Storefront } from '../../src/types/storefront.js';

const customAdapter = {
  verifyApple: async () => {
    throw new Error('not used');
  },
  verifyGoogle: async () => {
    throw new Error('not used');
  },
  getEntitlements: async () => [],
  restore: async () => {
    throw new Error('not used');
  },
};

const config = {
  products: [{ id: 'premium_monthly', type: 'subscription' as const }],
  backend: { adapter: customAdapter, timeoutMs: 5000, retries: 0 },
  storage: { type: 'memory' as const, namespace: 'storefront_delegation' },
};

describe('createIAP.getStorefront — delegation to the native adapter', () => {
  it('returns the native adapter Storefront verbatim after initialize()', async () => {
    const sf: Storefront = {
      countryCode: 'US',
      countryCodeRaw: 'USA',
      storefrontId: '143441',
      platform: 'apple',
    };
    mocks.getStorefront.mockResolvedValue(sf);

    const iap = createIAP(config);
    await iap.initialize();

    expect(await iap.getStorefront()).toEqual(sf);
    expect(mocks.getStorefront).toHaveBeenCalledOnce();
  });

  it('returns null when the adapter reports no storefront', async () => {
    mocks.getStorefront.mockResolvedValue(null);
    const iap = createIAP({ ...config, storage: { type: 'memory', namespace: 'sf_null' } });
    await iap.initialize();
    expect(await iap.getStorefront()).toBeNull();
  });
});
