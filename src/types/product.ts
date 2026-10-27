export type ProductType = 'subscription' | 'product' | 'consumable';

export interface ConfiguredProduct {
  id: string;
  type: ProductType;
  /**
   * Required for Android subscriptions — the base plan identifier configured in
   * Google Play Console. Ignored on iOS and for non-subscription products.
   *
   * Keep it in step with Play Console. When it matches no offer, the native
   * plugin does **not** fail — it falls back to the first available base
   * plan, so a stale value silently purchases a different plan. See
   * `docs/guide/native-layer.md`.
   */
  androidPlanId?: string;
}

/** What kind of offer this is, as the store classifies it. */
export type SubscriptionOfferType = 'introductory' | 'promotional' | 'win-back' | 'unknown';

/**
 * How the offer is paid for.
 *
 * - `free-trial` — no charge for the offer period.
 * - `pay-up-front` — one discounted charge covering the whole offer period.
 * - `pay-as-you-go` — a discounted charge each period, for `periodCount`
 *   periods.
 */
export type SubscriptionOfferPayment = 'free-trial' | 'pay-up-front' | 'pay-as-you-go' | 'unknown';

/**
 * An introductory or promotional offer on a subscription, normalized across
 * platforms.
 *
 * Render `priceString` as-is; it is the store's own localized string, in the
 * store's currency and format. Never reconstruct a price from `priceMicros`
 * for display — that is for arithmetic and comparison only.
 */
export interface SubscriptionOffer {
  /**
   * The store's identifier for the offer. `null` for an offer the store does
   * not name — typically an iOS introductory offer, or an Android base-plan
   * intro phase (which has no offer id of its own).
   */
  id: string | null;
  type: SubscriptionOfferType;
  payment: SubscriptionOfferPayment;
  /** Localized price string for the offer, e.g. "$0.00" or "₱49.00". */
  priceString: string;
  /** BigInt-safe string of micro-units, e.g. "0" or "49000000". */
  priceMicros: string;
  /** ISO 4217 code, e.g. "PHP". */
  currency: string;
  /** Offer period as an ISO 8601 duration, e.g. "P1W". `null` if unknown. */
  period: string | null;
  /**
   * How many periods the offer applies for. `1` for a free trial or a
   * pay-up-front offer; higher for pay-as-you-go. `0` when the store did not
   * say (Android reports `0` for an infinitely recurring phase).
   */
  periodCount: number;
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

  // ----- Subscription detail. Absent/null for non-subscriptions. -----

  /**
   * The recurring billing period as an ISO 8601 duration, e.g. `"P1M"`.
   *
   * **iOS only.** `null` on Android: the native plugin collapses Play's
   * pricing phases before exposing them and never surfaces a base plan's
   * billing period, so it is not reachable. Where you need the cadence on
   * both platforms, take it from your own product configuration — you chose
   * the base plan's period in Play Console.
   */
  subscriptionPeriod?: string | null;

  /**
   * The subscription group this product belongs to. Products in one group are
   * mutually exclusive, and on iOS introductory-offer eligibility is assessed
   * per group rather than per product.
   *
   * **iOS only.** `null` on Android, which has no equivalent concept exposed.
   */
  subscriptionGroupId?: string | null;

  /**
   * The introductory offer on this subscription, or `null` when it has none.
   *
   * **Whether *this user* is eligible for it cannot be known on the device.**
   * The native plugin exposes no eligibility query on either platform, so an
   * offer being present here means "this product has one", not "this user
   * will get it". The store's own purchase sheet applies eligibility at
   * purchase time and is the authority. Write paywall copy that reads
   * correctly either way, or confirm eligibility server-side.
   */
  introductoryOffer?: SubscriptionOffer | null;

  /**
   * Promotional and win-back offers on this subscription. Empty when there
   * are none. Same eligibility caveat as {@link Product.introductoryOffer}.
   */
  promotionalOffers?: SubscriptionOffer[];

  /**
   * Android: Play's token for the specific offer this entry describes, and
   * the offer's id (`null` for a base plan with no offer).
   *
   * Exposed for identification and server-side reasoning only. A purchase
   * **cannot** select an offer by token: the native plugin's purchase call
   * takes a base plan id, and picks the offer itself. See
   * `docs/guide/native-layer.md`.
   */
  androidOfferToken?: string | null;
  androidOfferId?: string | null;
}
