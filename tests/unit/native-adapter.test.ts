import { describe, expect, it } from 'vitest';
import { WebStubAdapter } from '../../src/adapters/native/web/web-stub.js';
import { IAPError, IAPErrorCode } from '../../src/lib/errors.js';

describe('WebStubAdapter', () => {
  const adapter = new WebStubAdapter();

  it('reports unavailable on web', async () => {
    expect(await adapter.isAvailable()).toBe(false);
  });

  it('returns empty product list', async () => {
    const products = await adapter.getProducts([{ id: 'premium', type: 'subscription' }]);
    expect(products).toEqual([]);
  });

  it('rejects purchase with PLATFORM_NOT_SUPPORTED', async () => {
    await expect(
      adapter.purchaseProduct({ productId: 'premium', productType: 'subscription' }),
    ).rejects.toBeInstanceOf(IAPError);

    try {
      await adapter.purchaseProduct({ productId: 'premium', productType: 'subscription' });
    } catch (error) {
      expect(error).toBeInstanceOf(IAPError);
      expect((error as IAPError).code).toBe(IAPErrorCode.PLATFORM_NOT_SUPPORTED);
    }
  });

  it('returns empty owned-transactions list', async () => {
    expect(await adapter.getOwnedTransactions()).toEqual([]);
  });

  it('treats acknowledge as no-op', async () => {
    await expect(
      adapter.acknowledge({
        platform: 'apple',
        productId: 'premium',
        token: 'token',
        productType: 'subscription',
      }),
    ).resolves.toBeUndefined();
  });

  it('rejects manageSubscriptions on web', async () => {
    await expect(adapter.manageSubscriptions()).rejects.toBeInstanceOf(IAPError);
  });
});
