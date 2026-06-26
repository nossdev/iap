import type { Platform } from './transaction.js';

/**
 * The user's App Store / Google Play storefront — i.e. the country their
 * store account is registered to, which is the platform-blessed signal for
 * region-dependent decisions (regional pricing/offers, and gating
 * external-payment links whose eligibility the OS itself keys to storefront
 * country, *not* device locale).
 *
 * `countryCode` is normalized to **ISO 3166-1 alpha-2** across platforms so
 * consumers compare one consistent value (Apple's native code is alpha-3,
 * Google's is alpha-2). The raw native code is preserved in `countryCodeRaw`.
 *
 * Treat the value as a **UX / targeting hint** and read it live (never cache):
 * for compliance- or entitlement-sensitive enforcement, trust the server-side
 * signed storefront (App Store Server API `storefront` / Play Developer API
 * `regionCode`) instead, since the client value can be unreliable (TestFlight
 * historically reports `"USA"`) or empty (EU alternative distribution).
 */
export interface Storefront {
  /**
   * ISO 3166-1 alpha-2 country code (normalized), e.g. `'US'`. In the rare
   * case the native value can't be normalized (an unrecognized code), this
   * falls back to the uppercased raw value — compare against `countryCodeRaw`
   * if you need certainty about the format.
   */
  countryCode: string;
  /** Raw native value (whitespace-trimmed): alpha-3 on iOS (`'USA'`), alpha-2 on Android (`'US'`). */
  countryCodeRaw: string;
  /** Apple-defined storefront identifier (iOS only); `undefined` on Android. */
  storefrontId?: string;
  /** Store the value came from. */
  platform: Platform;
}
