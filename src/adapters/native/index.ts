import { getPlatform } from '../../lib/platform.js';
import type { ConfiguredProduct } from '../../types/product.js';
import type { NativeAdapter } from './types.js';
import { WebStubAdapter } from './web/web-stub.js';

export interface NativeAdapterOptions {
  products: ConfiguredProduct[];
}

/**
 * Select the appropriate native adapter for the runtime platform.
 *
 * - iOS / Android → cdv adapter wrapping `cordova-plugin-purchase@^13`,
 *   loaded via dynamic import so web builds don't pull in the plugin's
 *   ~5000-line bundle (and don't trigger its `window`-attaching side
 *   effects on page load).
 * - web → no-op stub (purchases reject with PLATFORM_NOT_SUPPORTED).
 *
 * Async because the cdv module is loaded lazily; web returns synchronously
 * but is still wrapped in a Promise for a uniform call signature.
 */
export async function selectNativeAdapter(options: NativeAdapterOptions): Promise<NativeAdapter> {
  const platform = getPlatform();
  if (platform === 'ios' || platform === 'android') {
    const mod = await import('./cdv/native-adapter.js');
    return new mod.CdvNativeAdapter({ products: options.products });
  }
  return new WebStubAdapter();
}

export type { NativeAdapter, NativePurchaseOptions } from './types.js';
