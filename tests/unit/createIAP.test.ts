import { describe, expect, it } from 'vitest';
import { createIAP } from '../../src/createIAP.js';
import { IAPError, IAPErrorCode } from '../../src/lib/errors.js';
import type { IAPConfigInput } from '../../src/types/config.js';

const validConfig: IAPConfigInput = {
  products: [
    { id: 'premium_monthly', type: 'subscription', androidPlanId: 'monthly-plan' },
    { id: 'remove_ads', type: 'product' },
    { id: 'coin_pack_100', type: 'consumable' },
  ],
  backend: {
    baseUrl: 'https://api.example.com',
    endpoints: {
      verifyApple: '/api/iap/verify/apple',
      verifyGoogle: '/api/iap/verify/google',
      entitlements: '/api/iap/entitlements',
      restore: '/api/iap/restore',
    },
    getAuthHeaders: async () => ({ Authorization: 'Bearer token' }),
  },
};

describe('createIAP — config validation', () => {
  it('accepts a valid config', () => {
    expect(() => createIAP(validConfig)).not.toThrow();
  });

  it('rejects empty product list', () => {
    expect(() => createIAP({ ...validConfig, products: [] })).toThrowError(IAPError);
  });

  it('rejects subscription product without androidPlanId', () => {
    expect(() =>
      createIAP({
        ...validConfig,
        products: [{ id: 'premium_monthly', type: 'subscription' }],
      }),
    ).toThrowError(IAPError);
  });

  it('rejects backend.baseUrl that is not a URL', () => {
    expect(() =>
      createIAP({
        ...validConfig,
        backend: { ...validConfig.backend, baseUrl: 'not-a-url' },
      }),
    ).toThrowError(IAPError);
  });

  it('rejects duplicate product ids', () => {
    expect(() =>
      createIAP({
        ...validConfig,
        products: [
          { id: 'remove_ads', type: 'product' },
          { id: 'remove_ads', type: 'product' },
        ],
      }),
    ).toThrowError(IAPError);
  });

  it('emits IAPError with INVALID_CONFIG code', () => {
    try {
      createIAP({ ...validConfig, products: [] });
      throw new Error('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(IAPError);
      expect((error as IAPError).code).toBe(IAPErrorCode.INVALID_CONFIG);
    }
  });
});

describe('createIAP — lifecycle', () => {
  it('initialize() resolves on web and emits ready', async () => {
    const iap = createIAP(validConfig);
    let readyCount = 0;
    iap.on('ready', () => {
      readyCount += 1;
    });
    await iap.initialize();
    expect(readyCount).toBe(1);
  });

  it('initialize() is idempotent', async () => {
    const iap = createIAP(validConfig);
    let readyCount = 0;
    iap.on('ready', () => {
      readyCount += 1;
    });
    await iap.initialize();
    await iap.initialize();
    expect(readyCount).toBe(1);
  });

  it('destroy() then initialize() throws NOT_INITIALIZED', async () => {
    const iap = createIAP(validConfig);
    await iap.initialize();
    await iap.destroy();
    await expect(iap.initialize()).rejects.toBeInstanceOf(IAPError);
  });

  it('refresh() before initialize() throws NOT_INITIALIZED', async () => {
    const iap = createIAP(validConfig);
    await expect(iap.refresh()).rejects.toBeInstanceOf(IAPError);
  });

  it('entitlement queries return empty/null before any data is loaded', () => {
    const iap = createIAP(validConfig);
    expect(iap.hasEntitlement('premium')).toBe(false);
    expect(iap.getEntitlements()).toEqual([]);
    expect(iap.getEntitlement('premium')).toBeNull();
  });
});
