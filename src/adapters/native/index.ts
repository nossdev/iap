import { getPlatform } from '../../lib/platform.js';
import type { NativeAdapter } from './types.js';
import { V7NativeAdapter } from './v7/native-adapter.js';
import { WebStubAdapter } from './web/web-stub.js';

/**
 * Select the appropriate native adapter for the runtime platform.
 *
 * - iOS / Android → v7 adapter wrapping `@capgo/native-purchases@7.16.2`
 * - web → no-op stub (purchases reject with PLATFORM_NOT_SUPPORTED)
 */
export function selectNativeAdapter(): NativeAdapter {
  const platform = getPlatform();
  if (platform === 'ios' || platform === 'android') {
    return new V7NativeAdapter();
  }
  return new WebStubAdapter();
}

export { V7NativeAdapter, WebStubAdapter };
export type { NativeAdapter, NativePurchaseOptions } from './types.js';
