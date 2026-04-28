import { describe, expect, it } from 'vitest';
import { HttpBackendAdapter } from '../../src/adapters/backend/http-adapter.js';
import { selectBackendAdapter } from '../../src/adapters/backend/index.js';
import { IAPError, IAPErrorCode } from '../../src/lib/errors.js';
import { makeSilentLogger } from '../mocks/http-helpers.js';

const silentLogger = makeSilentLogger();

describe('selectBackendAdapter', () => {
  it('returns HttpBackendAdapter when no custom adapter is provided', () => {
    const adapter = selectBackendAdapter({
      config: {
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
      },
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
      config: {
        adapter: customAdapter,
        timeoutMs: 1_000,
        retries: 0,
      },
      logger: silentLogger,
    });
    expect(adapter).toBe(customAdapter);
  });

  it('rejects a custom adapter that does not implement the interface', () => {
    const broken = { verifyApple: () => {}, foo: 'bar' };
    try {
      selectBackendAdapter({
        config: {
          adapter: broken,
          timeoutMs: 1_000,
          retries: 0,
        },
        logger: silentLogger,
      });
      throw new Error('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(IAPError);
      expect((error as IAPError).code).toBe(IAPErrorCode.INVALID_CONFIG);
    }
  });

  it('rejects HTTP path when required fields are missing', () => {
    try {
      selectBackendAdapter({
        // Schema would normally catch this; the runtime check is defense-in-depth.
        config: { timeoutMs: 1_000, retries: 0 } as never,
        logger: silentLogger,
      });
      throw new Error('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(IAPError);
      expect((error as IAPError).code).toBe(IAPErrorCode.INVALID_CONFIG);
    }
  });
});
