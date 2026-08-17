import { getPlatform } from '../../lib/platform.js';
import type { NativeAdapter } from './types.js';
import { WebStubAdapter } from './web/web-stub.js';

/**
 * Select the appropriate native adapter for the runtime platform.
 *
 * - iOS / Android → capgo adapter wrapping `@capgo/native-purchases` (^8.0.0,
 *   the Capacitor 8 line), reached via dynamic import so the adapter's *code*
 *   doesn't run on web.
 * - web → no-op stub (purchases reject with PLATFORM_NOT_SUPPORTED).
 *
 * The deferral is execution-only, not module-graph: `tsup` builds with
 * `splitting: false`, so esbuild inlines this dynamic import into the single
 * chunk and hoists `@capgo/native-purchases` to a static top-level import in
 * both `dist/index.js` and `dist/index.cjs`. The plugin's `registerPlugin`
 * side effect therefore still fires at import time, including on web. Enabling
 * `splitting` for the ESM build would emit a separate chunk and make the
 * deferral real; until then, don't rely on this to keep the plugin out of a web
 * bundle. (`@capacitor/app`, imported dynamically in `app-resume-listener.ts`,
 * *is* genuinely deferred — it isn't reachable from this static graph.)
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
