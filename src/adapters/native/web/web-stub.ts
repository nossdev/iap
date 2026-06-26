import { IAPError, IAPErrorCode } from '../../../lib/errors.js';
import type { Product, ProductType } from '../../../types/product.js';
import type { Storefront } from '../../../types/storefront.js';
import type { NativeTransaction } from '../../../types/transaction.js';
import type { NativeAdapter, NativePurchaseOptions } from '../types.js';

export class WebStubAdapter implements NativeAdapter {
  async isAvailable(): Promise<boolean> {
    return false;
  }

  async getProducts(_requests: Array<{ id: string; type: ProductType }>): Promise<Product[]> {
    return [];
  }

  async purchaseProduct(_opts: NativePurchaseOptions): Promise<NativeTransaction> {
    throw new IAPError({
      code: IAPErrorCode.PLATFORM_NOT_SUPPORTED,
      message: 'In-app purchases are not supported on the web platform.',
    });
  }

  async getOwnedTransactions(): Promise<NativeTransaction[]> {
    return [];
  }

  async acknowledge(_transaction: NativeTransaction): Promise<void> {
    // No-op on web.
  }

  async manageSubscriptions(): Promise<void> {
    throw new IAPError({
      code: IAPErrorCode.PLATFORM_NOT_SUPPORTED,
      message: 'Subscription management is not supported on the web platform.',
    });
  }

  async getStorefront(): Promise<Storefront | null> {
    // No App Store / Play storefront on web — entitlement queries still work.
    return null;
  }
}
