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
  /**
   * Offer period as an ISO 8601 duration, e.g. `"P1W"`. `null` if unknown.
   *
   * Single-component on Android: the native plugin's period parser keeps
   * only the largest non-zero unit, so a Play period of `P1M15D` arrives
   * as `P1M`.
   */
  period: string | null;
  /**
   * How many periods the offer applies for.
   *
   * On iOS: `1` for a free trial or a pay-up-front offer, higher for
   * pay-as-you-go.
   *
   * **On Android this is usually `0`**, and that does not mean zero
   * periods. It is Play's `getBillingCycleCount()`, which reports `0` for
   * both a non-recurring phase and an infinitely recurring one — so a
   * pay-up-front Android offer reports `0` too. Treat `0` as "the store
   * did not say" and do not render it as a count.
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
   *
   * **On Android, do not render these as the offer's own terms.** The
   * native plugin builds each promotional entry from the base plan's
   * *standard* recurring pricing phase, not from the promotional phase —
   * so a free-trial promo arrives as `payment: 'pay-as-you-go'` at the
   * full price. Use them to know an offer exists and to identify it; take
   * the terms from your backend or from Play Console. iOS reports the
   * offer's real terms, and {@link Product.introductoryOffer} is
   * unaffected on both platforms.
   */
  promotionalOffers?: SubscriptionOffer[];

  /**
   * Android: Play's token for the specific offer this entry describes, and
   * the offer's id (`null` for a base plan with no offer).
   *
   * This is the **base** offer's token for a one-time product, and the base
   * plan's for a subscription: `getProducts()` returns one `Product` per
   * configured id, and the base entry is the one it keeps. To choose a
   * *discounted* one-time offer, read {@link Product.androidOneTimeOffers},
   * which carries every offer the store returned.
   *
   * For a **subscription** it is identification and server-side reasoning
   * only. A subscription purchase cannot select an offer by token — the
   * native plugin's subscription path takes a base plan id and picks the
   * offer within it itself. See `docs/guide/native-layer.md`.
   */
  androidOfferToken?: string | null;
  androidOfferId?: string | null;

  /**
   * Android: the base plan this entry describes, as configured in Play
   * Console. `null` on iOS, which has no base-plan concept — there a
   * product id identifies the subscription directly.
   *
   * `id` is always the product id you configured, on both platforms, so it
   * round-trips to `purchase({ productId })`. This is the extra level Play
   * adds underneath it.
   */
  androidBasePlanId?: string | null;

  /**
   * Android one-time products: every purchase offer the store returned for
   * this product, including the discounted ones.
   *
   * Play allows several one-time purchase offers on one product — a base
   * price plus, say, a launch discount — and reports each as its own entry
   * with its own price and token. A `Product`'s own `price`/`priceString`
   * and {@link Product.androidOfferToken} describe the **base** offer,
   * because one `Product` is returned per configured id. This is where the
   * rest live, so a paywall can show a discount and
   * `purchase({ androidOfferToken })` can buy it.
   *
   * Absent when the product has a single offer, on iOS (one price per
   * product, no offer concept here), and for subscriptions — whose offers
   * are {@link Product.introductoryOffer} and
   * {@link Product.promotionalOffers}, and which cannot be selected at
   * purchase time at all.
   */
  androidOneTimeOffers?: AndroidOneTimeOffer[];
}

/**
 * One of several Android one-time purchase offers on a single product.
 *
 * The token is the only way to buy a specific one, and it is a **per-query
 * device token**: it comes from the `getProducts()` call that returned this
 * offer, and it goes stale. Read it fresh rather than persisting it — the
 * store rejects an unknown token, which iap surfaces as
 * `INVALID_PURCHASE_OPTIONS`.
 */
export interface AndroidOneTimeOffer {
  /** `null` for the base offer; Play's offer id for a discounted one. */
  offerId: string | null;
  /** Pass to `purchase({ androidOfferToken })`. Goes stale; see above. */
  offerToken: string;
  /** Localized and display-ready — e.g. `"$2.49"`. */
  priceString: string;
  /** Numeric price in the currency's major units. */
  price: number;
  currencyCode: string;
}
