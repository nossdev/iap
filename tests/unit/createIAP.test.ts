import { describe, expect, it, vi } from 'vitest';
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

  it('accepts subscription product without androidPlanId (iOS-only or single-plan Android)', () => {
    // androidPlanId is only required when an Android multi-plan subscription
    // needs disambiguation. iOS-only consumers and single-plan Android
    // subscriptions don't need it; the native adapter falls back to the
    // default offer (`native.getOffer()`).
    expect(() =>
      createIAP({
        ...validConfig,
        products: [{ id: 'premium_monthly', type: 'subscription' }],
      }),
    ).not.toThrow();
  });

  it('accepts an iOS-only config (verifyGoogle omitted)', () => {
    expect(() =>
      createIAP({
        ...validConfig,
        backend: {
          ...validConfig.backend,
          endpoints: {
            verifyApple: '/api/iap/verify/apple',
            entitlements: '/api/iap/entitlements',
            restore: '/api/iap/restore',
          },
        },
      }),
    ).not.toThrow();
  });

  it('accepts an Android-only config (verifyApple omitted)', () => {
    expect(() =>
      createIAP({
        ...validConfig,
        backend: {
          ...validConfig.backend,
          endpoints: {
            verifyGoogle: '/api/iap/verify/google',
            entitlements: '/api/iap/entitlements',
            restore: '/api/iap/restore',
          },
        },
      }),
    ).not.toThrow();
  });

  it('rejects a config with neither verifyApple nor verifyGoogle', () => {
    expect(() =>
      createIAP({
        ...validConfig,
        backend: {
          ...validConfig.backend,
          endpoints: {
            entitlements: '/api/iap/entitlements',
            restore: '/api/iap/restore',
          },
        },
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

describe('createIAP — Phase 6 init wiring', () => {
  it('schedules a background refresh when cached entitlements exceed TTL', async () => {
    const backing = new Map<string, string>();
    const customAdapter = {
      verifyApple: async () => ({
        valid: false as const,
        error: 'NOT_USED',
      }),
      verifyGoogle: async () => ({
        valid: false as const,
        error: 'NOT_USED',
      }),
      getEntitlements: vi.fn(async () => [
        { key: 'fresh', productId: 'remove_ads', expiresAt: null },
      ]),
      restore: async () => ({ valid: false as const, error: 'NOT_USED' }),
    };

    // Pre-seed cache with a very old cachedAt
    const stale = {
      cachedAt: Date.now() - 24 * 60 * 60 * 1000, // 24h ago
      entitlements: [{ key: 'stale', productId: 'remove_ads', expiresAt: null }],
    };
    const customStorage = {
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
    backing.set('entitlements', JSON.stringify(stale));

    const iap = createIAP({
      ...validConfig,
      backend: { adapter: customAdapter, timeoutMs: 5_000, retries: 0 },
      storage: { type: 'custom', namespace: 'ttl_test', adapter: customStorage },
      options: {
        refreshOnResume: false, // don't wire @capacitor/app
        entitlementCacheTtlMs: 60 * 60 * 1000, // 1h — well below 24h
        recoverUnfinishedTransactions: false, // skip recovery
        productPriceCacheTtlMs: 24 * 60 * 60 * 1000,
        logLevel: 'silent',
      },
    });

    await iap.initialize();

    // Stale cache should still be served synchronously
    expect(iap.hasEntitlement('stale')).toBe(true);
    // Background refresh fires via queueMicrotask after init
    await new Promise((r) => setTimeout(r, 30));
    expect(customAdapter.getEntitlements).toHaveBeenCalledTimes(1);
    // After background refresh, fresh entitlements replaced stale
    expect(iap.hasEntitlement('fresh')).toBe(true);
    expect(iap.hasEntitlement('stale')).toBe(false);
  });

  it('does NOT schedule background refresh when cache is within TTL', async () => {
    const backing = new Map<string, string>();
    const customAdapter = {
      verifyApple: async () => ({ valid: false as const, error: 'NOT_USED' }),
      verifyGoogle: async () => ({ valid: false as const, error: 'NOT_USED' }),
      getEntitlements: vi.fn(async () => []),
      restore: async () => ({ valid: false as const, error: 'NOT_USED' }),
    };

    backing.set(
      'entitlements',
      JSON.stringify({
        cachedAt: Date.now() - 60_000, // 1 minute ago
        entitlements: [{ key: 'fresh', productId: 'remove_ads', expiresAt: null }],
      }),
    );
    const customStorage = {
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

    const iap = createIAP({
      ...validConfig,
      backend: { adapter: customAdapter, timeoutMs: 5_000, retries: 0 },
      storage: { type: 'custom', namespace: 'ttl_fresh', adapter: customStorage },
      options: {
        refreshOnResume: false,
        entitlementCacheTtlMs: 60 * 60 * 1000, // 1h
        recoverUnfinishedTransactions: false,
        productPriceCacheTtlMs: 24 * 60 * 60 * 1000,
        logLevel: 'silent',
      },
    });

    await iap.initialize();
    await new Promise((r) => setTimeout(r, 30));
    expect(customAdapter.getEntitlements).not.toHaveBeenCalled();
    expect(iap.hasEntitlement('fresh')).toBe(true);
  });
});

describe('createIAP — web platform skip paths (L7)', () => {
  // The test runtime defaults to platform='web' via jsdom (no native bindings).
  // These tests assert that recovery and resume listener are correctly
  // gated behind isNative() and skipped on web.

  it('recovery is NOT run on web even when recoverUnfinishedTransactions: true', async () => {
    const verifyApple = vi.fn(async () => ({
      valid: true as const,
      entitlements: [] as Array<{ key: string; productId: string; expiresAt: string | null }>,
      transaction: { id: 'tx', productId: 'premium_monthly' },
    }));
    const customAdapter = {
      verifyApple,
      verifyGoogle: async () => ({ valid: false as const, error: 'NOT_USED' }),
      getEntitlements: async () => [],
      restore: async () => ({ valid: false as const, error: 'NOT_USED' }),
    };
    // Pre-seed an entry into Preferences-backed memory storage by routing
    // through a custom adapter we can pre-populate.
    const backing = new Map<string, string>();
    backing.set(
      'unfinished_transactions',
      JSON.stringify([
        {
          platform: 'apple',
          productId: 'premium_monthly',
          token: '2000000111',
          productType: 'subscription',
          recordedAt: new Date().toISOString(),
        },
      ]),
    );
    const customStorage = {
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

    const iap = createIAP({
      ...validConfig,
      backend: { adapter: customAdapter, timeoutMs: 5000, retries: 0 },
      storage: { type: 'custom', namespace: 'web_skip_recovery', adapter: customStorage },
      options: {
        refreshOnResume: false,
        entitlementCacheTtlMs: 60 * 60 * 1000,
        recoverUnfinishedTransactions: true, // explicitly enabled, but web should skip
        recoveryMaxBatch: 50,
        productPriceCacheTtlMs: 24 * 60 * 60 * 1000,
        logLevel: 'silent',
      },
    });

    await iap.initialize();

    // CRITICAL: even though recovery is enabled, web platform skips it →
    // backend.verifyApple should never have been called.
    expect(verifyApple).not.toHaveBeenCalled();
    // The pre-seeded unfinished entry remains untouched in storage
    expect(JSON.parse(backing.get('unfinished_transactions') ?? '[]')).toHaveLength(1);
  });

  it('resume listener is NOT attached on web even when refreshOnResume: true', async () => {
    const getEntitlements = vi.fn(async () => []);
    const customAdapter = {
      verifyApple: async () => ({ valid: false as const, error: 'NOT_USED' }),
      verifyGoogle: async () => ({ valid: false as const, error: 'NOT_USED' }),
      getEntitlements,
      restore: async () => ({ valid: false as const, error: 'NOT_USED' }),
    };

    const iap = createIAP({
      ...validConfig,
      backend: { adapter: customAdapter, timeoutMs: 5000, retries: 0 },
      storage: { type: 'memory', namespace: 'web_skip_resume' },
      options: {
        refreshOnResume: true, // explicitly enabled, but web should skip listener
        entitlementCacheTtlMs: 60 * 60 * 1000,
        recoverUnfinishedTransactions: false,
        recoveryMaxBatch: 50,
        productPriceCacheTtlMs: 24 * 60 * 60 * 1000,
        logLevel: 'silent',
      },
    });

    await iap.initialize();
    await new Promise((r) => setTimeout(r, 20));

    // No resume listener was attached → no refresh fired automatically.
    expect(getEntitlements).not.toHaveBeenCalled();
    // Manual refresh still works
    await iap.refresh();
    expect(getEntitlements).toHaveBeenCalledTimes(1);
  });
});

describe('createIAP — backend-driven product manifest', () => {
  function makeListProducts(products: unknown) {
    return vi.fn().mockResolvedValue(products);
  }

  it('fetches the manifest from a custom adapter when products is omitted', async () => {
    const listProducts = makeListProducts([
      { id: 'premium_monthly', type: 'subscription', androidPlanId: 'monthly-plan' },
      { id: 'remove_ads', type: 'product' },
    ]);
    const customAdapter = {
      verifyApple: async () => ({ valid: false as const, error: 'NOT_TESTED' }),
      verifyGoogle: async () => ({ valid: false as const, error: 'NOT_TESTED' }),
      getEntitlements: async () => [],
      restore: async () => ({ valid: false as const, error: 'NOT_TESTED' }),
      listProducts,
    };

    const iap = createIAP({
      backend: { adapter: customAdapter },
    } as IAPConfigInput);

    await iap.initialize();
    expect(listProducts).toHaveBeenCalledTimes(1);
    expect(iap.hasEntitlement('anything')).toBe(false);
  });

  it('rejects at parse time when products is omitted and the backend cannot supply it', () => {
    const customAdapter = {
      verifyApple: async () => ({ valid: false as const, error: 'NOT_TESTED' }),
      verifyGoogle: async () => ({ valid: false as const, error: 'NOT_TESTED' }),
      getEntitlements: async () => [],
      restore: async () => ({ valid: false as const, error: 'NOT_TESTED' }),
    };
    expect(() =>
      createIAP({
        backend: { adapter: customAdapter },
      } as IAPConfigInput),
    ).toThrowError(IAPError);
  });

  it('rejects at parse time when HTTP backend lacks endpoints.products and config has no products', () => {
    expect(() =>
      createIAP({
        backend: {
          baseUrl: 'https://api.example.com',
          endpoints: {
            verifyApple: '/api/iap/verify/apple',
            verifyGoogle: '/api/iap/verify/google',
            entitlements: '/api/iap/entitlements',
            restore: '/api/iap/restore',
          },
          getAuthHeaders: async () => ({}),
        },
      } as IAPConfigInput),
    ).toThrowError(IAPError);
  });

  it('accepts HTTP config with endpoints.products and no static products', () => {
    expect(() =>
      createIAP({
        backend: {
          baseUrl: 'https://api.example.com',
          endpoints: {
            verifyApple: '/api/iap/verify/apple',
            verifyGoogle: '/api/iap/verify/google',
            entitlements: '/api/iap/entitlements',
            restore: '/api/iap/restore',
            products: '/api/iap/products',
          },
          getAuthHeaders: async () => ({}),
        },
      } as IAPConfigInput),
    ).not.toThrow();
  });

  it('throws BACKEND_BAD_RESPONSE when listProducts() returns malformed entries', async () => {
    const customAdapter = {
      verifyApple: async () => ({ valid: false as const, error: 'NOT_TESTED' }),
      verifyGoogle: async () => ({ valid: false as const, error: 'NOT_TESTED' }),
      getEntitlements: async () => [],
      restore: async () => ({ valid: false as const, error: 'NOT_TESTED' }),
      // missing `type` — invalid
      listProducts: async () => [{ id: 'oops' }] as never,
    };

    const iap = createIAP({
      backend: { adapter: customAdapter },
    } as IAPConfigInput);

    await expect(iap.initialize()).rejects.toMatchObject({
      code: IAPErrorCode.BACKEND_BAD_RESPONSE,
    });
  });

  it('propagates IAPError from listProducts() unchanged through initialize()', async () => {
    const customAdapter = {
      verifyApple: async () => ({ valid: false as const, error: 'NOT_TESTED' }),
      verifyGoogle: async () => ({ valid: false as const, error: 'NOT_TESTED' }),
      getEntitlements: async () => [],
      restore: async () => ({ valid: false as const, error: 'NOT_TESTED' }),
      listProducts: async () => {
        throw new IAPError({
          code: IAPErrorCode.BACKEND_UNAVAILABLE,
          message: 'simulated network failure',
          recoverable: true,
        });
      },
    };
    const iap = createIAP({
      backend: { adapter: customAdapter },
    } as IAPConfigInput);

    await expect(iap.initialize()).rejects.toMatchObject({
      code: IAPErrorCode.BACKEND_UNAVAILABLE,
    });
    // Confirm the original message survives (errorHint may append a hint).
    try {
      const i = createIAP({ backend: { adapter: customAdapter } } as IAPConfigInput);
      await i.initialize();
      throw new Error('should have thrown');
    } catch (error) {
      expect((error as IAPError).message).toContain('simulated network failure');
    }
  });

  it('throws INVALID_CONFIG when backend manifest contains duplicate product ids', async () => {
    const customAdapter = {
      verifyApple: async () => ({ valid: false as const, error: 'NOT_TESTED' }),
      verifyGoogle: async () => ({ valid: false as const, error: 'NOT_TESTED' }),
      getEntitlements: async () => [],
      restore: async () => ({ valid: false as const, error: 'NOT_TESTED' }),
      listProducts: async () => [
        { id: 'premium', type: 'subscription' as const, androidPlanId: 'monthly' },
        { id: 'premium', type: 'subscription' as const, androidPlanId: 'yearly' },
      ],
    };

    const iap = createIAP({
      backend: { adapter: customAdapter },
    } as IAPConfigInput);

    await expect(iap.initialize()).rejects.toMatchObject({
      code: IAPErrorCode.INVALID_CONFIG,
    });
  });
});
