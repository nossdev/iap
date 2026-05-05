import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpBackendAdapter } from '../../src/adapters/backend/http-adapter.js';
import { IAPError, IAPErrorCode } from '../../src/lib/errors.js';
import { jsonResponse, makeSilentLogger } from '../mocks/http-helpers.js';

const silentLogger = makeSilentLogger();

const endpoints = {
  verifyApple: '/api/iap/verify/apple',
  verifyGoogle: '/api/iap/verify/google',
  entitlements: '/api/iap/entitlements',
  restore: '/api/iap/restore',
};

function makeAdapter(
  fetchStub: typeof fetch,
  overrides: Partial<ConstructorParameters<typeof HttpBackendAdapter>[0]> = {},
) {
  return new HttpBackendAdapter({
    baseUrl: 'https://api.example.com',
    endpoints,
    getAuthHeaders: async () => ({ Authorization: 'Bearer test' }),
    timeoutMs: 5_000,
    retries: 0,
    fetch: fetchStub,
    logger: silentLogger,
    ...overrides,
  });
}

describe('HttpBackendAdapter — verifyApple', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('POSTs the expected body and returns a parsed success response', async () => {
    const fetchStub = vi.fn().mockResolvedValue(
      jsonResponse({
        valid: true,
        entitlements: [
          { key: 'premium', productId: 'premium_monthly', expiresAt: '2026-12-01T00:00:00Z' },
        ],
        transaction: {
          id: '2000000123456789',
          productId: 'premium_monthly',
          expiresAt: '2026-12-01T00:00:00Z',
          verifiedAt: '2026-04-28T10:00:00Z',
        },
      }),
    );
    const adapter = makeAdapter(fetchStub);

    const result = await adapter.verifyApple({
      productId: 'premium_monthly',
      transactionId: '2000000123456789',
      type: 'subscription',
    });

    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.entitlements).toHaveLength(1);
      expect(result.entitlements[0]?.key).toBe('premium');
      expect(result.transaction.id).toBe('2000000123456789');
    }
    const call = fetchStub.mock.calls[0];
    if (!call) throw new Error('fetch was not called');
    const [url, init] = call;
    expect(url).toBe('https://api.example.com/api/iap/verify/apple');
    expect((init as RequestInit).method).toBe('POST');
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      productId: 'premium_monthly',
      transactionId: '2000000123456789',
      type: 'subscription',
    });
  });

  it('returns valid:false envelope without throwing', async () => {
    const fetchStub = vi.fn().mockResolvedValue(
      jsonResponse({
        valid: false,
        error: 'TRANSACTION_NOT_FOUND',
        message: 'Apple returned TRANSACTION_NOT_FOUND',
      }),
    );
    const adapter = makeAdapter(fetchStub);

    const result = await adapter.verifyApple({
      productId: 'premium_monthly',
      transactionId: 'bogus',
      type: 'subscription',
    });

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toBe('TRANSACTION_NOT_FOUND');
    }
  });

  it('preserves consumer-defined entitlement fields via passthrough', async () => {
    const fetchStub = vi.fn().mockResolvedValue(
      jsonResponse({
        valid: true,
        entitlements: [
          {
            key: 'premium',
            productId: 'premium_monthly',
            expiresAt: null,
            tier: 'pro', // consumer-defined
            features: ['no-ads', 'sync'], // consumer-defined
          },
        ],
        transaction: { id: '1', productId: 'premium_monthly' },
      }),
    );
    interface AppEnt {
      key: string;
      productId: string;
      expiresAt: string | null;
      tier?: string;
      features?: string[];
    }
    const adapter = new HttpBackendAdapter<AppEnt>({
      baseUrl: 'https://api.example.com',
      endpoints,
      getAuthHeaders: async () => ({ Authorization: 'Bearer t' }),
      timeoutMs: 5_000,
      retries: 0,
      fetch: fetchStub,
      logger: silentLogger,
    });

    const result = await adapter.verifyApple({
      productId: 'premium_monthly',
      transactionId: 'tx',
      type: 'subscription',
    });
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.entitlements[0]?.tier).toBe('pro');
      expect(result.entitlements[0]?.features).toEqual(['no-ads', 'sync']);
    }
  });

  it('rejects when 401 (BACKEND_AUTH_FAILED)', async () => {
    const fetchStub = vi.fn().mockResolvedValue(new Response('', { status: 401 }));
    const adapter = makeAdapter(fetchStub);

    await expect(
      adapter.verifyApple({ productId: 'x', transactionId: 'y', type: 'product' }),
    ).rejects.toMatchObject({ code: IAPErrorCode.BACKEND_AUTH_FAILED });
  });
});

describe('HttpBackendAdapter — verifyGoogle', () => {
  it('POSTs purchaseToken + packageName', async () => {
    const fetchStub = vi.fn().mockResolvedValue(
      jsonResponse({
        valid: true,
        entitlements: [{ key: 'premium', productId: 'premium_monthly', expiresAt: null }],
        transaction: { id: 'GPA.x', productId: 'premium_monthly' },
      }),
    );
    const adapter = makeAdapter(fetchStub);

    await adapter.verifyGoogle({
      productId: 'premium_monthly',
      purchaseToken: 'play-token-abc',
      packageName: 'com.example.app',
      type: 'subscription',
    });

    const call = fetchStub.mock.calls[0];
    if (!call) throw new Error('fetch was not called');
    const [url, init] = call;
    expect(url).toBe('https://api.example.com/api/iap/verify/google');
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      productId: 'premium_monthly',
      purchaseToken: 'play-token-abc',
      packageName: 'com.example.app',
      type: 'subscription',
    });
  });
});

describe('HttpBackendAdapter — getEntitlements', () => {
  it('GETs and unwraps the entitlements array', async () => {
    const fetchStub = vi.fn().mockResolvedValue(
      jsonResponse({
        entitlements: [{ key: 'premium', productId: 'premium_monthly', expiresAt: null }],
      }),
    );
    const adapter = makeAdapter(fetchStub);

    const result = await adapter.getEntitlements();
    expect(result).toHaveLength(1);
    expect(result[0]?.key).toBe('premium');
    const call = fetchStub.mock.calls[0];
    if (!call) throw new Error('fetch was not called');
    const [url, init] = call;
    expect(url).toBe('https://api.example.com/api/iap/entitlements');
    expect((init as RequestInit).method).toBe('GET');
  });

  it('returns empty array if backend returns []', async () => {
    const fetchStub = vi.fn().mockResolvedValue(jsonResponse({ entitlements: [] }));
    const adapter = makeAdapter(fetchStub);
    expect(await adapter.getEntitlements()).toEqual([]);
  });
});

describe('HttpBackendAdapter — listProducts', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('GETs the configured endpoint and unwraps the products array', async () => {
    const fetchStub = vi.fn().mockResolvedValue(
      jsonResponse({
        products: [
          { id: 'premium_monthly', type: 'subscription', androidPlanId: 'monthly-plan' },
          { id: 'premium_yearly', type: 'subscription', androidPlanId: 'yearly-plan' },
          { id: 'remove_ads', type: 'product' },
        ],
      }),
    );
    const adapter = makeAdapter(fetchStub, {
      endpoints: { ...endpoints, products: '/api/iap/products' },
    });

    const products = await adapter.listProducts();
    expect(products).toHaveLength(3);
    expect(products[0]).toEqual({
      id: 'premium_monthly',
      type: 'subscription',
      androidPlanId: 'monthly-plan',
    });
    const call = fetchStub.mock.calls[0];
    if (!call) throw new Error('fetch was not called');
    const [url, init] = call;
    expect(url).toBe('https://api.example.com/api/iap/products');
    expect((init as RequestInit).method).toBe('GET');
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer test');
  });

  it('throws BACKEND_BAD_RESPONSE when manifest entries are malformed', async () => {
    const fetchStub = vi.fn().mockResolvedValue(
      jsonResponse({
        products: [{ id: 'premium_monthly' }],
      }),
    );
    const adapter = makeAdapter(fetchStub, {
      endpoints: { ...endpoints, products: '/api/iap/products' },
    });

    await expect(adapter.listProducts()).rejects.toMatchObject({
      code: IAPErrorCode.BACKEND_BAD_RESPONSE,
    });
  });

  it('accepts manifest entries for subscriptions without androidPlanId', async () => {
    // androidPlanId is optional in the manifest contract — required only at
    // runtime by the Android native adapter when disambiguating multi-plan
    // subscriptions. iOS-only consumers and single-plan Android subs don't
    // need it. (See src/types/config.ts and createIAP.test.ts for the matching
    // schema-side guarantee.)
    const fetchStub = vi.fn().mockResolvedValue(
      jsonResponse({
        products: [{ id: 'premium_monthly', type: 'subscription' }],
      }),
    );
    const adapter = makeAdapter(fetchStub, {
      endpoints: { ...endpoints, products: '/api/iap/products' },
    });

    await expect(adapter.listProducts()).resolves.toEqual([
      { id: 'premium_monthly', type: 'subscription' },
    ]);
  });

  it('throws INVALID_CONFIG when the endpoint is not configured', async () => {
    const fetchStub = vi.fn();
    const adapter = makeAdapter(fetchStub);

    await expect(adapter.listProducts()).rejects.toMatchObject({
      code: IAPErrorCode.INVALID_CONFIG,
    });
    expect(fetchStub).not.toHaveBeenCalled();
  });
});

describe('HttpBackendAdapter — restore', () => {
  it('POSTs the transactions batch and returns consolidated response', async () => {
    const fetchStub = vi.fn().mockResolvedValue(
      jsonResponse({
        valid: true,
        entitlements: [{ key: 'premium', productId: 'premium_monthly', expiresAt: null }],
        transaction: { id: 'consolidated', productId: 'premium_monthly' },
      }),
    );
    const adapter = makeAdapter(fetchStub);

    const result = await adapter.restore({
      transactions: [
        { platform: 'apple', transactionId: '2000000111', productId: 'premium_monthly' },
        {
          platform: 'google',
          purchaseToken: 'play-tok',
          packageName: 'com.example.app',
          productId: 'premium_monthly',
        },
      ],
    });
    expect(result.valid).toBe(true);
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });
});

describe('HttpBackendAdapter — platform-specific endpoint optionality', () => {
  it('throws INVALID_CONFIG when verifyApple is called without endpoints.verifyApple', async () => {
    const fetchStub = vi.fn();
    const adapter = makeAdapter(fetchStub, {
      endpoints: {
        verifyGoogle: '/api/iap/verify/google',
        entitlements: '/api/iap/entitlements',
        restore: '/api/iap/restore',
      },
    });

    await expect(
      adapter.verifyApple({
        productId: 'premium_monthly',
        transactionId: '2000000123',
        type: 'subscription',
      }),
    ).rejects.toMatchObject({ code: IAPErrorCode.INVALID_CONFIG });
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it('throws INVALID_CONFIG when verifyGoogle is called without endpoints.verifyGoogle', async () => {
    const fetchStub = vi.fn();
    const adapter = makeAdapter(fetchStub, {
      endpoints: {
        verifyApple: '/api/iap/verify/apple',
        entitlements: '/api/iap/entitlements',
        restore: '/api/iap/restore',
      },
    });

    await expect(
      adapter.verifyGoogle({
        productId: 'premium_monthly',
        purchaseToken: 'play-tok',
        packageName: 'com.example.app',
        type: 'subscription',
      }),
    ).rejects.toMatchObject({ code: IAPErrorCode.INVALID_CONFIG });
    expect(fetchStub).not.toHaveBeenCalled();
  });
});
