import { describe, expect, it, vi } from 'vitest';
import { HttpBackendAdapter } from '../../src/adapters/backend/http-adapter.js';
import { selectBackendAdapter } from '../../src/adapters/backend/index.js';
import { LocalVerificationAdapter } from '../../src/adapters/backend/local-adapter.js';
import { IAPError, IAPErrorCode } from '../../src/lib/errors.js';
import type { IAPConfig } from '../../src/types/config.js';
import { makeSilentLogger } from '../mocks/http-helpers.js';

const silentLogger = makeSilentLogger();

/** The fields the schema would have defaulted, so a test names only its subject. */
function makeConfig(over: Partial<IAPConfig>): IAPConfig {
  return {
    products: [{ id: 'premium_monthly', type: 'subscription' }],
    storage: { type: 'memory', namespace: 'test' },
    options: {
      refreshOnResume: true,
      entitlementCacheTtlMs: 60_000,
      entitlementGraceMs: 0,
      recoverUnfinishedTransactions: true,
      recoveryMaxBatch: 50,
      productPriceCacheTtlMs: 60_000,
      logLevel: 'silent',
    },
    ...over,
  } as IAPConfig;
}

const httpBackend = {
  baseUrl: 'https://api.example.com',
  endpoints: {
    verifyApple: '/v/a',
    verifyGoogle: '/v/g',
    entitlements: '/e',
    restore: '/r',
  },
  getAuthHeaders: async () => ({ Authorization: 'Bearer t' }),
  timeoutMs: 1_000,
  retries: 0,
} as IAPConfig['backend'];

describe('selectBackendAdapter — backend paths', () => {
  it('returns HttpBackendAdapter when no custom adapter is provided', () => {
    const adapter = selectBackendAdapter({
      config: makeConfig({ backend: httpBackend }),
      logger: silentLogger,
    });
    expect(adapter).toBeInstanceOf(HttpBackendAdapter);
  });

  it('returns the supplied custom adapter directly', () => {
    const customAdapter = {
      verifyApple: vi.fn(),
      verifyGoogle: vi.fn(),
      getEntitlements: vi.fn(),
      restore: vi.fn(),
    };
    const adapter = selectBackendAdapter({
      config: makeConfig({
        backend: { adapter: customAdapter, timeoutMs: 1_000, retries: 0 } as IAPConfig['backend'],
      }),
      logger: silentLogger,
    });
    expect(adapter).toBe(customAdapter);
  });

  it('rejects a custom adapter that does not implement the interface', () => {
    expect(() =>
      selectBackendAdapter({
        config: makeConfig({
          backend: {
            adapter: { verifyApple: () => {}, foo: 'bar' },
            timeoutMs: 1_000,
            retries: 0,
          } as IAPConfig['backend'],
        }),
        logger: silentLogger,
      }),
    ).toThrowError(IAPError);
  });

  it('rejects the HTTP path when required fields are missing', () => {
    try {
      selectBackendAdapter({
        config: makeConfig({ backend: { timeoutMs: 1_000, retries: 0 } as IAPConfig['backend'] }),
        logger: silentLogger,
      });
      throw new Error('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(IAPError);
      expect((error as IAPError).code).toBe(IAPErrorCode.INVALID_CONFIG);
    }
  });

  it('throws when neither backend nor verification is configured', () => {
    // The schema refuses this at parse time; this is the defence-in-depth
    // check, for a caller that got here another way.
    try {
      selectBackendAdapter({ config: makeConfig({}), logger: silentLogger });
      throw new Error('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(IAPError);
      expect((error as IAPError).code).toBe(IAPErrorCode.INVALID_CONFIG);
    }
  });
});

describe('selectBackendAdapter — local verification', () => {
  it('builds the local adapter when verification is configured', () => {
    const adapter = selectBackendAdapter({
      config: makeConfig({ verification: { mode: 'local', entitlements: () => [] } }),
      logger: silentLogger,
    });
    expect(adapter).toBeInstanceOf(LocalVerificationAdapter);
  });

  it('prefers verification over a backend block rather than merging them', () => {
    // The schema refuses both at once, so this only pins which branch wins
    // if one ever slipped through: the one that cannot reach a network.
    const adapter = selectBackendAdapter({
      config: makeConfig({
        backend: httpBackend,
        verification: { mode: 'local', entitlements: () => [] },
      }),
      logger: silentLogger,
    });
    expect(adapter).toBeInstanceOf(LocalVerificationAdapter);
  });

  it('exposes verifyNative, which is how the router reaches it', () => {
    const local = selectBackendAdapter({
      config: makeConfig({ verification: { mode: 'local', entitlements: () => [] } }),
      logger: silentLogger,
    });
    const http = selectBackendAdapter({
      config: makeConfig({ backend: httpBackend }),
      logger: silentLogger,
    });

    expect(local.verifyNative).toBeTypeOf('function');
    // The HTTP adapter deliberately does not implement it, so the extracted
    // request shapes — and what goes over the wire — are unchanged.
    expect(http.verifyNative).toBeUndefined();
  });
});
