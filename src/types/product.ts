export type ProductType = 'subscription' | 'product' | 'consumable';

export interface ConfiguredProduct {
  id: string;
  type: ProductType;
  /**
   * Required for Android subscriptions — the base plan identifier configured in
   * Google Play Console. Ignored on iOS and for non-subscription products.
   */
  androidPlanId?: string;
}

/**
 * Native product info merged with configured metadata.
 * Library-public shape — kept stable across Capacitor versions.
 */
export interface Product {
  id: string;
  type: ProductType;
  title: string;
  description: string;
  /** Localized price string, e.g. "$4.99". Always render this — never hardcode. */
  priceString: string;
  /** BigInt as string to avoid precision loss, e.g. "4990000". */
  priceMicros: string;
  /** ISO 4217 code, e.g. "USD". */
  currency: string;
}
