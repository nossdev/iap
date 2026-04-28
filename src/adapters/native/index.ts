import { getPlatform } from '../../lib/platform.js';
import type { ConfiguredProduct } from '../../types/product.js';
import { CdvNativeAdapter } from './cdv/native-adapter.js';
import type { NativeAdapter } from './types.js';
import { WebStubAdapter } from './web/web-stub.js';

export interface NativeAdapterOptions {
  products: ConfiguredProduct[];
}

/**
 * Select the appropriate native adapter for the runtime platform.
 *
 * - iOS / Android → cdv adapter wrapping `cordova-plugin-purchase@^13`
 * - web → no-op stub (purchases reject with PLATFORM_NOT_SUPPORTED)
 */
export function selectNativeAdapter(options: NativeAdapterOptions): NativeAdapter {
  const platform = getPlatform();
  if (platform === 'ios' || platform === 'android') {
    return new CdvNativeAdapter({ products: options.products });
  }
  return new WebStubAdapter();
}

export { CdvNativeAdapter, WebStubAdapter };
export type { NativeAdapter, NativePurchaseOptions } from './types.js';
