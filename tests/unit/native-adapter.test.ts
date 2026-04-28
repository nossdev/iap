import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CdvNativeAdapter } from '../../src/adapters/native/cdv/native-adapter.js';
import { WebStubAdapter } from '../../src/adapters/native/web/web-stub.js';
import { IAPError, IAPErrorCode } from '../../src/lib/errors.js';
import {
  MOCK_PAYMENT_CANCELLED_CODE,
  type MockCdv,
  fireApproved,
  installMockCdv,
  makeTransaction,
  uninstallMockCdv,
} from '../mocks/mock-cdv-purchase.js';

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

describe('CdvNativeAdapter', () => {
  let mock: MockCdv;

  beforeEach(() => {
    mock = installMockCdv({
      defaultPlatform: 'ios-appstore',
      products: [
        {
          id: 'premium_monthly',
          title: 'Premium Monthly',
          priceString: '$4.99',
          priceMicros: 4_990_000,
          currency: 'USD',
        },
        {
          id: 'remove_ads',
          title: 'Remove Ads',
          priceString: '$1.99',
          priceMicros: 1_990_000,
          currency: 'USD',
        },
      ],
    });
  });

  afterEach(() => {
    uninstallMockCdv();
  });

  it('isAvailable() bootstraps and returns true', async () => {
    const adapter = new CdvNativeAdapter({
      products: [{ id: 'premium_monthly', type: 'subscription', androidPlanId: 'monthly' }],
    });
    expect(await adapter.isAvailable()).toBe(true);
    expect(mock.store._initialized).toBe(true);
    expect(mock.store._registered).toHaveLength(1);
    expect(mock.store._registered[0]?.id).toBe('premium_monthly');
  });

  it('purchaseProduct() resolves on .approved() event with normalized transaction', async () => {
    const adapter = new CdvNativeAdapter({
      products: [{ id: 'premium_monthly', type: 'subscription', androidPlanId: 'monthly' }],
    });

    // order() succeeds; .approved() fires shortly after
    mock.store._orderImpl = async () => {
      queueMicrotask(() => {
        const tx = makeTransaction('premium_monthly');
        fireApproved(mock, tx);
      });
      return undefined;
    };

    const result = await adapter.purchaseProduct({
      productId: 'premium_monthly',
      productType: 'subscription',
    });

    expect(result.platform).toBe('apple');
    expect(result.productId).toBe('premium_monthly');
    expect(result.token).toMatch(/^txn-premium_monthly-/);
    expect(result.productType).toBe('subscription');
  });

  it('purchaseProduct() rejects with USER_CANCELLED when order returns PAYMENT_CANCELLED', async () => {
    const adapter = new CdvNativeAdapter({
      products: [{ id: 'remove_ads', type: 'product' }],
    });

    mock.store._orderImpl = async () => ({
      isError: true,
      code: MOCK_PAYMENT_CANCELLED_CODE,
      message: 'cancelled',
    });

    try {
      await adapter.purchaseProduct({
        productId: 'remove_ads',
        productType: 'product',
      });
      throw new Error('should have rejected');
    } catch (error) {
      expect(error).toBeInstanceOf(IAPError);
      expect((error as IAPError).code).toBe(IAPErrorCode.USER_CANCELLED);
    }
  });

  it('purchaseProduct() rejects with STORE_ERROR for non-cancellation order errors', async () => {
    const adapter = new CdvNativeAdapter({
      products: [{ id: 'remove_ads', type: 'product' }],
    });

    mock.store._orderImpl = async () => ({
      isError: true,
      code: 6777999,
      message: 'something went wrong',
    });

    try {
      await adapter.purchaseProduct({
        productId: 'remove_ads',
        productType: 'product',
      });
      throw new Error('should have rejected');
    } catch (error) {
      expect(error).toBeInstanceOf(IAPError);
      expect((error as IAPError).code).toBe(IAPErrorCode.STORE_ERROR);
    }
  });

  it('purchaseProduct() rejects with PRODUCT_NOT_FOUND when product is unregistered', async () => {
    const adapter = new CdvNativeAdapter({
      products: [{ id: 'premium_monthly', type: 'subscription', androidPlanId: 'monthly' }],
    });
    // bootstrap so the store is ready
    await adapter.isAvailable();
    // request a productId that wasn't registered
    try {
      await adapter.purchaseProduct({
        productId: 'unknown_product',
        productType: 'product',
      });
      throw new Error('should have rejected');
    } catch (error) {
      expect(error).toBeInstanceOf(IAPError);
      expect((error as IAPError).code).toBe(IAPErrorCode.PRODUCT_NOT_FOUND);
    }
  });

  it('acknowledge() calls finish() on the captured transaction', async () => {
    const adapter = new CdvNativeAdapter({
      products: [{ id: 'remove_ads', type: 'product' }],
    });

    const tx = makeTransaction('remove_ads');
    mock.store._orderImpl = async () => {
      queueMicrotask(() => fireApproved(mock, tx));
      return undefined;
    };

    const purchase = await adapter.purchaseProduct({
      productId: 'remove_ads',
      productType: 'product',
    });

    expect(tx.finishCalls).toBe(0);
    await adapter.acknowledge(purchase);
    expect(tx.finishCalls).toBe(1);
  });

  it('acknowledge() is idempotent — second call is a no-op', async () => {
    const adapter = new CdvNativeAdapter({
      products: [{ id: 'remove_ads', type: 'product' }],
    });

    const tx = makeTransaction('remove_ads');
    mock.store._orderImpl = async () => {
      queueMicrotask(() => fireApproved(mock, tx));
      return undefined;
    };

    const purchase = await adapter.purchaseProduct({
      productId: 'remove_ads',
      productType: 'product',
    });

    await adapter.acknowledge(purchase);
    await adapter.acknowledge(purchase); // second call
    expect(tx.finishCalls).toBe(1);
  });

  it('getOwnedTransactions() returns approved-state transactions and stages them for finish', async () => {
    const adapter = new CdvNativeAdapter({
      products: [
        { id: 'premium_monthly', type: 'subscription', androidPlanId: 'monthly' },
        { id: 'remove_ads', type: 'product' },
      ],
    });

    const owned1 = makeTransaction('premium_monthly', { state: 'approved' });
    const owned2 = makeTransaction('remove_ads', { state: 'approved' });
    const stale = makeTransaction('remove_ads', { state: 'finished' });
    mock.store._localTransactions = [owned1, owned2, stale];

    const result = await adapter.getOwnedTransactions();
    expect(result).toHaveLength(2);
    expect(result.map((t) => t.productId).sort()).toEqual(['premium_monthly', 'remove_ads']);

    // After acknowledging, finish() runs on the right cdv tx
    const first = result[0];
    if (!first) throw new Error('expected at least one owned transaction');
    await adapter.acknowledge(first);
    expect(owned1.finishCalls + owned2.finishCalls).toBe(1);
  });

  it('getProducts() returns normalized product info from the cdv catalog', async () => {
    const adapter = new CdvNativeAdapter({
      products: [
        { id: 'premium_monthly', type: 'subscription', androidPlanId: 'monthly' },
        { id: 'remove_ads', type: 'product' },
      ],
    });

    const products = await adapter.getProducts([
      { id: 'premium_monthly', type: 'subscription' },
      { id: 'remove_ads', type: 'product' },
      { id: 'unknown', type: 'product' },
    ]);

    expect(products).toHaveLength(2);
    const monthly = products.find((p) => p.id === 'premium_monthly');
    expect(monthly?.priceString).toBe('$4.99');
    expect(monthly?.priceMicros).toBe('4990000');
    expect(monthly?.currency).toBe('USD');
    expect(monthly?.type).toBe('subscription');
  });

  it('detects google platform from android user agent', async () => {
    uninstallMockCdv();
    mock = installMockCdv({
      defaultPlatform: 'android-playstore',
      products: [
        { id: 'remove_ads', priceString: '$1.99', priceMicros: 1_990_000, currency: 'USD' },
      ],
    });

    const adapter = new CdvNativeAdapter({
      products: [{ id: 'remove_ads', type: 'product' }],
    });

    const googleTx = makeTransaction('remove_ads', {
      platform: 'android-playstore',
      nativePurchase: { purchaseToken: 'play-token-abc' },
    });
    mock.store._orderImpl = async () => {
      queueMicrotask(() => fireApproved(mock, googleTx));
      return undefined;
    };

    const result = await adapter.purchaseProduct({
      productId: 'remove_ads',
      productType: 'product',
    });

    expect(result.platform).toBe('google');
    expect(result.token).toBe('play-token-abc');
    expect(mock.store._registered[0]?.platform).toBe('android-playstore');
  });
});
