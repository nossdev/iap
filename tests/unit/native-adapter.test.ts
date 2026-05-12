import { beforeEach, describe, expect, it, vi } from 'vitest';

let mockedPlatform: 'ios' | 'android' | 'web' = 'ios';
vi.mock('@capacitor/core', () => ({
  Capacitor: {
    getPlatform: () => mockedPlatform,
    isNativePlatform: () => mockedPlatform !== 'web',
  },
}));

const nativePurchasesMock = vi.hoisted(() => ({
  isBillingSupported: vi.fn(),
  getProducts: vi.fn(),
  purchaseProduct: vi.fn(),
  getPurchases: vi.fn(),
  acknowledgePurchase: vi.fn(),
  manageSubscriptions: vi.fn(),
}));

vi.mock('@capgo/native-purchases', () => ({
  NativePurchases: nativePurchasesMock,
  PURCHASE_TYPE: { INAPP: 'inapp', SUBS: 'subs' },
}));

import { CapgoNativeAdapter } from '../../src/adapters/native/capgo/native-adapter.js';
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

// Minimal plugin-shape builders — only the fields the adapter reads matter.
function pluginProduct(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    identifier: 'premium_monthly',
    description: 'Premium, billed monthly',
    title: 'Premium Monthly',
    price: 4.99,
    priceString: '$4.99',
    currencyCode: 'USD',
    currencySymbol: '$',
    isFamilyShareable: false,
    ...over,
  };
}

function appleTx(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    transactionId: '2000000123456789',
    productIdentifier: 'premium_monthly',
    purchaseDate: '2026-05-12T00:00:00Z',
    receipt: 'base64-storekit-receipt',
    willCancel: null,
    productType: 'subs',
    ...over,
  };
}

function googleTx(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    transactionId: 'GPA.1234-5678-9012-34567',
    productIdentifier: 'remove_ads',
    purchaseDate: '2026-05-12T00:00:00Z',
    purchaseToken: 'play-token-abc',
    orderId: 'GPA.1234-5678-9012-34567',
    purchaseState: '1',
    willCancel: null,
    productType: 'inapp',
    ...over,
  };
}

describe('CapgoNativeAdapter', () => {
  beforeEach(() => {
    mockedPlatform = 'ios';
    nativePurchasesMock.isBillingSupported.mockReset();
    nativePurchasesMock.getProducts.mockReset();
    nativePurchasesMock.purchaseProduct.mockReset();
    nativePurchasesMock.getPurchases.mockReset();
    nativePurchasesMock.acknowledgePurchase.mockReset();
    nativePurchasesMock.manageSubscriptions.mockReset();
  });

  it('isAvailable() returns true when billing is supported', async () => {
    nativePurchasesMock.isBillingSupported.mockResolvedValue({ isBillingSupported: true });
    expect(await new CapgoNativeAdapter().isAvailable()).toBe(true);
  });

  it('isAvailable() returns false when billing is unsupported', async () => {
    nativePurchasesMock.isBillingSupported.mockResolvedValue({ isBillingSupported: false });
    expect(await new CapgoNativeAdapter().isAvailable()).toBe(false);
  });

  it('isAvailable() returns false when the plugin throws', async () => {
    nativePurchasesMock.isBillingSupported.mockRejectedValue(new Error('no bridge'));
    expect(await new CapgoNativeAdapter().isAvailable()).toBe(false);
  });

  it('getProducts() returns [] for an empty request without calling the plugin', async () => {
    const products = await new CapgoNativeAdapter().getProducts([]);
    expect(products).toEqual([]);
    expect(nativePurchasesMock.getProducts).not.toHaveBeenCalled();
  });

  it('getProducts() splits a mixed catalog into separate inapp/subs calls and normalizes', async () => {
    nativePurchasesMock.getProducts.mockImplementation(async (opts: { productType: string }) => {
      if (opts.productType === 'subs') {
        return { products: [pluginProduct({ identifier: 'premium_monthly', price: 4.99 })] };
      }
      return {
        products: [
          pluginProduct({
            identifier: 'remove_ads',
            title: 'Remove Ads',
            description: 'No ads, forever',
            price: 1.99,
            priceString: '$1.99',
          }),
        ],
      };
    });

    const adapter = new CapgoNativeAdapter();
    const products = await adapter.getProducts([
      { id: 'premium_monthly', type: 'subscription' },
      { id: 'remove_ads', type: 'product' },
      { id: 'cant_find_me', type: 'product' },
    ]);

    expect(nativePurchasesMock.getProducts).toHaveBeenCalledWith({
      productIdentifiers: ['remove_ads', 'cant_find_me'],
      productType: 'inapp',
    });
    expect(nativePurchasesMock.getProducts).toHaveBeenCalledWith({
      productIdentifiers: ['premium_monthly'],
      productType: 'subs',
    });

    const monthly = products.find((p) => p.id === 'premium_monthly');
    expect(monthly).toEqual({
      id: 'premium_monthly',
      type: 'subscription',
      title: 'Premium Monthly',
      description: 'Premium, billed monthly',
      priceString: '$4.99',
      priceMicros: '4990000',
      currency: 'USD',
    });
    const ads = products.find((p) => p.id === 'remove_ads');
    expect(ads?.type).toBe('product');
    expect(ads?.priceMicros).toBe('1990000');
    // unmatched id silently dropped (plugin didn't return it)
    expect(products.find((p) => p.id === 'cant_find_me')).toBeUndefined();
  });

  it('getProducts() only calls the subs endpoint when the catalog is subs-only', async () => {
    nativePurchasesMock.getProducts.mockResolvedValue({ products: [pluginProduct()] });
    await new CapgoNativeAdapter().getProducts([{ id: 'premium_monthly', type: 'subscription' }]);
    expect(nativePurchasesMock.getProducts).toHaveBeenCalledTimes(1);
    expect(nativePurchasesMock.getProducts).toHaveBeenCalledWith({
      productIdentifiers: ['premium_monthly'],
      productType: 'subs',
    });
  });

  it('purchaseProduct() defers acknowledgement and normalizes an iOS transaction', async () => {
    nativePurchasesMock.purchaseProduct.mockResolvedValue(appleTx());
    const result = await new CapgoNativeAdapter().purchaseProduct({
      productId: 'premium_monthly',
      productType: 'subscription',
      androidPlanId: 'monthly-plan',
      appAccountToken: '550e8400-e29b-41d4-a716-446655440000',
    });

    expect(nativePurchasesMock.purchaseProduct).toHaveBeenCalledWith({
      productIdentifier: 'premium_monthly',
      productType: 'subs',
      planIdentifier: 'monthly-plan',
      appAccountToken: '550e8400-e29b-41d4-a716-446655440000',
      isConsumable: false,
      autoAcknowledgePurchases: false,
    });
    expect(result).toMatchObject({
      platform: 'apple',
      productId: 'premium_monthly',
      token: '2000000123456789',
      productType: 'subscription',
    });
  });

  it('purchaseProduct() marks consumables and normalizes a Google transaction', async () => {
    nativePurchasesMock.purchaseProduct.mockResolvedValue(googleTx());
    const result = await new CapgoNativeAdapter().purchaseProduct({
      productId: 'coins_100',
      productType: 'consumable',
    });

    expect(nativePurchasesMock.purchaseProduct).toHaveBeenCalledWith({
      productIdentifier: 'coins_100',
      productType: 'inapp',
      planIdentifier: undefined,
      appAccountToken: undefined,
      isConsumable: true,
      autoAcknowledgePurchases: false,
    });
    expect(result).toMatchObject({
      platform: 'google',
      token: 'play-token-abc',
      productType: 'consumable',
    });
  });

  it('purchaseProduct() falls back to transactionId for a Google tx with no purchaseToken', async () => {
    nativePurchasesMock.purchaseProduct.mockResolvedValue(
      googleTx({ purchaseToken: undefined, transactionId: 'GPA.fallback-id' }),
    );
    const result = await new CapgoNativeAdapter().purchaseProduct({
      productId: 'remove_ads',
      productType: 'product',
    });
    expect(result.platform).toBe('google');
    expect(result.token).toBe('GPA.fallback-id');
  });

  describe('purchaseProduct() error mapping', () => {
    it.each([
      ['User cancelled', IAPErrorCode.USER_CANCELLED],
      ['Transaction pending', IAPErrorCode.PURCHASE_PENDING],
      ['Purchase is pending', IAPErrorCode.PURCHASE_PENDING],
      ['Product not found', IAPErrorCode.PRODUCT_NOT_FOUND],
      ['Purchase is not purchased', IAPErrorCode.STORE_ERROR],
    ])('maps "%s" → %s', async (pluginMessage, expectedCode) => {
      nativePurchasesMock.purchaseProduct.mockRejectedValue(new Error(pluginMessage));
      try {
        await new CapgoNativeAdapter().purchaseProduct({
          productId: 'remove_ads',
          productType: 'product',
        });
        throw new Error('should have rejected');
      } catch (error) {
        expect(error).toBeInstanceOf(IAPError);
        expect((error as IAPError).code).toBe(expectedCode);
      }
    });

    it('passes an existing IAPError through unchanged', async () => {
      const original = new IAPError({ code: IAPErrorCode.STORE_ERROR, message: 'boom' });
      nativePurchasesMock.purchaseProduct.mockRejectedValue(original);
      await expect(
        new CapgoNativeAdapter().purchaseProduct({
          productId: 'remove_ads',
          productType: 'product',
        }),
      ).rejects.toBe(original);
    });
  });

  it('getOwnedTransactions() maps getPurchases() and infers per-tx product type', async () => {
    nativePurchasesMock.getPurchases.mockResolvedValue({
      purchases: [appleTx({ productType: 'subs' }), googleTx({ productType: 'inapp' })],
    });
    const owned = await new CapgoNativeAdapter().getOwnedTransactions();
    expect(owned).toHaveLength(2);
    expect(owned[0]).toMatchObject({ platform: 'apple', productType: 'subscription' });
    expect(owned[1]).toMatchObject({ platform: 'google', productType: 'product' });
  });

  it('getOwnedTransactions() drops Android PENDING purchases and defaults missing productType to product', async () => {
    nativePurchasesMock.getPurchases.mockResolvedValue({
      purchases: [
        googleTx({ purchaseState: '1', productType: undefined }), // owned, no productType
        googleTx({ purchaseState: '0', transactionId: 'GPA.pending' }), // pending — dropped
      ],
    });
    const owned = await new CapgoNativeAdapter().getOwnedTransactions();
    expect(owned).toHaveLength(1);
    expect(owned[0]).toMatchObject({ platform: 'google', productType: 'product' });
  });

  it('acknowledge() finishes the transaction by token', async () => {
    nativePurchasesMock.acknowledgePurchase.mockResolvedValue(undefined);
    await new CapgoNativeAdapter().acknowledge({
      platform: 'google',
      productId: 'remove_ads',
      token: 'play-token-abc',
      productType: 'product',
    });
    expect(nativePurchasesMock.acknowledgePurchase).toHaveBeenCalledWith({
      purchaseToken: 'play-token-abc',
    });
  });

  it('acknowledge() wraps plugin failures as a recoverable STORE_ERROR', async () => {
    nativePurchasesMock.acknowledgePurchase.mockRejectedValue(new Error('billing offline'));
    try {
      await new CapgoNativeAdapter().acknowledge({
        platform: 'google',
        productId: 'remove_ads',
        token: 'play-token-abc',
        productType: 'product',
      });
      throw new Error('should have rejected');
    } catch (error) {
      expect(error).toBeInstanceOf(IAPError);
      expect((error as IAPError).code).toBe(IAPErrorCode.STORE_ERROR);
      expect((error as IAPError).recoverable).toBe(true);
    }
  });

  it('manageSubscriptions() delegates to the plugin', async () => {
    nativePurchasesMock.manageSubscriptions.mockResolvedValue(undefined);
    await new CapgoNativeAdapter().manageSubscriptions();
    expect(nativePurchasesMock.manageSubscriptions).toHaveBeenCalledOnce();
  });

  it('manageSubscriptions() wraps plugin failures as a STORE_ERROR', async () => {
    nativePurchasesMock.manageSubscriptions.mockRejectedValue(new Error('cannot open'));
    try {
      await new CapgoNativeAdapter().manageSubscriptions();
      throw new Error('should have rejected');
    } catch (error) {
      expect(error).toBeInstanceOf(IAPError);
      expect((error as IAPError).code).toBe(IAPErrorCode.STORE_ERROR);
    }
  });

  it('dispose() is a safe no-op', async () => {
    await expect(new CapgoNativeAdapter().dispose()).resolves.toBeUndefined();
  });

  describe('platform inference', () => {
    it('treats a transaction with a purchaseToken as Google', async () => {
      nativePurchasesMock.purchaseProduct.mockResolvedValue(
        googleTx({ orderId: undefined, purchaseState: undefined }),
      );
      const r = await new CapgoNativeAdapter().purchaseProduct({
        productId: 'remove_ads',
        productType: 'product',
      });
      expect(r.platform).toBe('google');
    });

    it('treats a transaction with a jwsRepresentation as Apple', async () => {
      nativePurchasesMock.purchaseProduct.mockResolvedValue(
        appleTx({ receipt: undefined, jwsRepresentation: 'eyJ...' }),
      );
      const r = await new CapgoNativeAdapter().purchaseProduct({
        productId: 'premium_monthly',
        productType: 'subscription',
      });
      expect(r.platform).toBe('apple');
    });

    it('falls back to the runtime platform when the transaction is ambiguous', async () => {
      mockedPlatform = 'android';
      nativePurchasesMock.purchaseProduct.mockResolvedValue({
        transactionId: 'ambiguous-1',
        productIdentifier: 'remove_ads',
        purchaseDate: '2026-05-12T00:00:00Z',
        willCancel: null,
      });
      const r = await new CapgoNativeAdapter().purchaseProduct({
        productId: 'remove_ads',
        productType: 'product',
      });
      expect(r.platform).toBe('google');
    });
  });
});
