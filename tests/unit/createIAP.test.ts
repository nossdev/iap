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

  it('rejects backend without HTTP fields and without a custom adapter', () => {
    expect(() =>
      createIAP({
        ...validConfig,
        backend: { timeoutMs: 1000, retries: 0 } as never,
      }),
    ).toThrowError(IAPError);
  });

  it('accepts a custom backend adapter without HTTP fields', () => {
    const customAdapter = {
      verifyApple: async () => ({
        valid: false as const,
        error: 'NOT_TESTED',
      }),
      verifyGoogle: async () => ({
        valid: false as const,
        error: 'NOT_TESTED',
      }),
      getEntitlements: async () => [],
      restore: async () => ({ valid: false as const, error: 'NOT_TESTED' }),
    };
    expect(() =>
      createIAP({
        ...validConfig,
        backend: { adapter: customAdapter },
      }),
    ).not.toThrow();
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

describe('createIAP — entitlement cache', () => {
  it('initialize() loads cached entitlements from a custom storage adapter', async () => {
    const backing = new Map<string, string>();
    const customAdapter = {
      async get(key: string) {
        return backing.get(key) ?? null;
      },
      async set(key: string, value: string) {
        backing.set(key, value);
      },
      async remove(key: string) {
        backing.delete(key);
      },
      async clear() {
        backing.clear();
      },
    };

    // Pre-seed the cache as if a previous session had written it.
    // Custom adapters receive bare keys (no namespace prefix is applied
    // by the library — the consumer's adapter owns its own key strategy).
    backing.set(
      'entitlements',
      JSON.stringify({
        cachedAt: Date.now(),
        entitlements: [
          { key: 'premium', productId: 'premium_monthly', expiresAt: '2026-12-01T00:00:00Z' },
        ],
      }),
    );

    const iap = createIAP({
      ...validConfig,
      storage: { type: 'custom', namespace: 'cache_test', adapter: customAdapter },
    });

    expect(iap.hasEntitlement('premium')).toBe(false); // not loaded yet
    await iap.initialize();
    expect(iap.hasEntitlement('premium')).toBe(true);
    expect(iap.getEntitlements()).toHaveLength(1);
    expect(iap.getEntitlement('premium')?.productId).toBe('premium_monthly');
  });

  it('initialize() tolerates an empty cache', async () => {
    const iap = createIAP({
      ...validConfig,
      storage: { type: 'memory', namespace: 'fresh' },
    });
    await iap.initialize();
    expect(iap.getEntitlements()).toEqual([]);
  });

  it('rejects custom storage type without an adapter', () => {
    expect(() =>
      createIAP({
        ...validConfig,
        storage: { type: 'custom', namespace: 'broken' },
      }),
    ).toThrowError(IAPError);
  });

  it('cached entitlements are frozen — direct mutation is rejected by runtime', async () => {
    const backing = new Map<string, string>();
    const customAdapter = {
      async get(key: string) {
        return backing.get(key) ?? null;
      },
      async set(key: string, value: string) {
        backing.set(key, value);
      },
      async remove(key: string) {
        backing.delete(key);
      },
      async clear() {
        backing.clear();
      },
    };
    backing.set(
      'entitlements',
      JSON.stringify({
        cachedAt: Date.now(),
        entitlements: [{ key: 'premium', productId: 'premium_monthly', expiresAt: null }],
      }),
    );

    const iap = createIAP({
      ...validConfig,
      storage: { type: 'custom', namespace: 'frozen_test', adapter: customAdapter },
    });
    await iap.initialize();

    const ent = iap.getEntitlement('premium');
    expect(ent).not.toBeNull();
    expect(Object.isFrozen(ent)).toBe(true);
    // Mutation in strict mode (which test files are in) throws TypeError.
    expect(() => {
      (ent as { key: string }).key = 'hacked';
    }).toThrow(TypeError);
  });

  it('refresh() before initialize() throws NOT_INITIALIZED', async () => {
    const iap = createIAP({
      ...validConfig,
      storage: { type: 'memory', namespace: 'refresh_uninit' },
    });
    await expect(iap.refresh()).rejects.toBeInstanceOf(IAPError);
  });

  it('refresh() fetches from backend, freezes, persists, and emits entitlements-changed', async () => {
    const customAdapter = {
      verifyApple: async () => {
        throw new Error('not used here');
      },
      verifyGoogle: async () => {
        throw new Error('not used here');
      },
      getEntitlements: async () => [
        { key: 'premium', productId: 'premium_monthly', expiresAt: '2026-12-01T00:00:00Z' },
      ],
      restore: async () => {
        throw new Error('not used here');
      },
    };

    const iap = createIAP({
      products: validConfig.products,
      backend: { adapter: customAdapter, timeoutMs: 5000, retries: 0 },
      storage: { type: 'memory', namespace: 'refresh_ok' },
    });
    let changedPayload: { entitlements: unknown[]; previous: unknown[] } | null = null;
    iap.on('entitlements-changed', (p) => {
      changedPayload = p;
    });
    await iap.initialize();
    await iap.refresh();

    expect(iap.getEntitlements()).toHaveLength(1);
    expect(iap.hasEntitlement('premium')).toBe(true);
    const ent = iap.getEntitlement('premium');
    expect(Object.isFrozen(ent)).toBe(true);
    expect(changedPayload).not.toBeNull();
    expect(changedPayload).not.toBeNull();
    const payload = changedPayload as unknown as { entitlements: unknown[]; previous: unknown[] };
    expect(payload.entitlements).toHaveLength(1);
    expect(payload.previous).toEqual([]);
  });

  it('destroy() is idempotent', async () => {
    const iap = createIAP({
      ...validConfig,
      storage: { type: 'memory', namespace: 'destroy_test' },
    });
    await iap.initialize();
    await iap.destroy();
    await iap.destroy(); // second call should not throw
    expect(iap.getEntitlements()).toEqual([]);
  });
});
