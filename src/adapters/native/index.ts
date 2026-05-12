import { getPlatform } from '../../lib/platform.js';
import type { NativeAdapter } from './types.js';
import { WebStubAdapter } from './web/web-stub.js';

/**
 * Select the appropriate native adapter for the runtime platform.
 *
 * - iOS / Android → capgo adapter wrapping `@capgo/native-purchases@^7.16`
 *   (also runs on Capacitor 8), loaded via dynamic import so web builds
 *   don't pull the plugin's ESM in (and don't pay its native-registration
 *   side effects on page load).
 * - web → no-op stub (purchases reject with PLATFORM_NOT_SUPPORTED).
 *
 * Async because the capgo module is loaded lazily; web returns synchronously
 * but is still wrapped in a Promise for a uniform call signature.
 */
export async function selectNativeAdapter(): Promise<NativeAdapter> {
  const platform = getPlatform();
  if (platform === 'ios' || platform === 'android') {
    const mod = await import('./capgo/native-adapter.js');
    return new mod.CapgoNativeAdapter();
  }
  return new WebStubAdapter();
}

export type { NativeAdapter, NativePurchaseOptions } from './types.js';
