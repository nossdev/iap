import { Capacitor } from '@capacitor/core';
import { NativePurchases } from '@capgo/native-purchases';
import { toAlpha2 } from '../../../lib/iso-country.js';
import { getPlatform } from '../../../lib/platform.js';
import type { Storefront } from '../../../types/storefront.js';
import type { Platform } from '../../../types/transaction.js';

/** Raw storefront shape the plugin `getStorefront` resolves to. */
type NativeStorefront = { countryCode?: string; storefrontId?: string };

/**
 * The plugin surface for `getStorefront`, declared locally because some
 * installed `@capgo/native-purchases` builds predate it. Availability is
 * detected via the Capacitor plugin header (see {@link nativeStorefrontRegistered}),
 * NOT by inspecting this optional method: on a device `registerPlugin` returns
 * a Proxy that fabricates a function for any property name, so a `typeof
 * np.getStorefront === 'function'` check is always true and would not detect
 * an older plugin.
 */
type StorefrontCapablePlugin = {
  getStorefront?: () => Promise<NativeStorefront>;
};

/** Minimal shape of the Capacitor plugin-header registry we read. */
type CapacitorPluginHeaders = {
  PluginHeaders?: ReadonlyArray<{ name: string; methods?: ReadonlyArray<{ name: string }> }>;
};

/**
 * Whether the *native* `@capgo/native-purchases` build actually registered a
 * `getStorefront` method. Reads the Capacitor plugin header (the list the
 * native bridge injects) so older plugins resolve `null` without crossing the
 * bridge (which would log a native "not implemented" error on every call), and
 * the method lights up automatically once capgo ships it.
 */
export function nativeStorefrontRegistered(): boolean {
  const headers = (Capacitor as CapacitorPluginHeaders).PluginHeaders;
  return (
    headers
      ?.find((h) => h.name === 'NativePurchases')
      ?.methods?.some((m) => m.name === 'getStorefront') ?? false
  );
}

export function normalizeStorefront(raw: NativeStorefront): Storefront | null {
  const code = raw?.countryCode?.trim();
  if (!code) return null;

  const platform: Platform = getPlatform() === 'android' ? 'google' : 'apple';
  return {
    // alpha-2 when recognized; otherwise the uppercased raw code as a
    // best-effort fallback (see `Storefront.countryCode`).
    countryCode: toAlpha2(code) ?? code.toUpperCase(),
    countryCodeRaw: code,
    storefrontId: raw.storefrontId,
    platform,
  };
}

/**
 * Read the current storefront from the native plugin — which sources it from
 * StoreKit 2 `Storefront.current` on iOS and `getBillingConfigAsync()` on
 * Android — normalizing `countryCode` to alpha-2.
 *
 * Silent by design: every form of unavailability — an older plugin with no
 * native method registered, a native rejection, an empty country — resolves
 * to `null` rather than throwing.
 */
export async function readStorefront(): Promise<Storefront | null> {
  if (!nativeStorefrontRegistered()) return null;
  const np = NativePurchases as typeof NativePurchases & StorefrontCapablePlugin;
  try {
    const raw = await np.getStorefront?.();
    return raw ? normalizeStorefront(raw) : null;
  } catch {
    return null;
  }
}
