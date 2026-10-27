import type {
  SKProductDiscount as PluginDiscount,
  Product as PluginProduct,
} from '@capgo/native-purchases';
import { toIso8601Duration } from '../../../lib/subscription-period.js';
import type {
  ConfiguredProduct,
  Product,
  ProductType,
  SubscriptionOffer,
  SubscriptionOfferPayment,
  SubscriptionOfferType,
} from '../../../types/product.js';

/**
 * The plugin's `Product`, retyped with what it *actually* delivers.
 *
 * `@capgo/native-purchases` declares `subscriptionPeriod` and
 * `subscriptionGroupIdentifier` as required, but its Android side sets
 * neither — so `p.subscriptionPeriod.unitString` is a TypeError on a real
 * device while typechecking clean. Narrowing them here is the only place
 * that lie is contained.
 */
type DeliveredProduct = Omit<
  PluginProduct,
  'subscriptionPeriod' | 'subscriptionGroupIdentifier' | 'introductoryPrice' | 'discounts'
> & {
  subscriptionPeriod?: unknown;
  subscriptionGroupIdentifier?: string;
  introductoryPrice?: PluginDiscount | null;
  discounts?: PluginDiscount[];
};

/**
 * Match the plugin's product payloads back to what the consumer asked for,
 * and return one {@link Product} per request.
 *
 * Two Android quirks make this more than a map():
 *
 * 1. **`identifier` is not the product id for a subscription.** capgo reports
 *    `identifier` = the base plan id and `planIdentifier` = the Play product
 *    id, while iap queries by product id (what `config.products[].id` holds).
 *    Keying on `identifier` alone misses every Android subscription, so the
 *    type falls back to `'product'` and the returned `id` is a base plan the
 *    consumer never configured — `getProducts().find(p => p.id === …)` then
 *    never matches. Resolve through either key, and report the configured id.
 *
 * 2. **One payload per offer.** capgo emits a separate entry for every offer
 *    on a base plan, and only the base-plan entry (`offerId === null`) carries
 *    `introductoryPrice`/`discounts`. Returned as-is that is several products
 *    sharing one id, most with no offers — so collapse to one, preferring the
 *    base plan the consumer named and the entry that actually has the offers.
 *
 * A payload matching no request is dropped: an entry the consumer did not ask
 * for is not actionable, and mistyping it is worse than omitting it.
 */
export function resolveProducts(
  payloads: PluginProduct[],
  requests: ConfiguredProduct[],
): Product[] {
  const products: Product[] = [];

  for (const request of requests) {
    const candidates = payloads.filter((payload) => {
      const p = payload as DeliveredProduct;
      return p.identifier === request.id || p.planIdentifier === request.id;
    });
    if (candidates.length === 0) continue;

    products.push(normalizeProduct(pickCandidate(candidates, request.androidPlanId), request));
  }

  return products;
}

/**
 * Choose among several payloads for one product: the base plan the consumer
 * configured if it is here, then the entry carrying the offers (the base
 * plan, `offerId === null`), else the first the store gave.
 */
function pickCandidate(candidates: PluginProduct[], androidPlanId?: string): PluginProduct {
  const named =
    androidPlanId !== undefined
      ? candidates.find((c) => (c as DeliveredProduct).identifier === androidPlanId)
      : undefined;
  const basePlan = candidates.find((c) => ((c as DeliveredProduct).offerId ?? null) === null);
  // `candidates` is non-empty at both call sites; the index is for the checker.
  return named ?? basePlan ?? (candidates[0] as PluginProduct);
}

function normalizeProduct(raw: PluginProduct, request: { id: string; type: ProductType }): Product {
  const p = raw as DeliveredProduct;
  return {
    // The id the consumer configured, so a Product round-trips to
    // `purchase({ productId })`. On Android `p.identifier` is a base plan,
    // which is reported separately as `androidBasePlanId`.
    id: request.id,
    type: request.type,
    title: p.title,
    description: p.description,
    priceString: p.priceString,
    priceMicros: toMicros(p.price),
    currency: p.currencyCode,

    // `toIso8601Duration` returns null for the `{ numberOfUnits: 0, unit: 0 }`
    // placeholder a non-subscription carries, and for Android's absent value.
    subscriptionPeriod: toIso8601Duration(p.subscriptionPeriod),
    // capgo sends "" rather than null for a product with no group.
    subscriptionGroupId: p.subscriptionGroupIdentifier || null,
    introductoryOffer: p.introductoryPrice ? normalizeOffer(p.introductoryPrice) : null,
    promotionalOffers: (p.discounts ?? []).map(normalizeOffer),
    androidOfferToken: p.offerToken ?? null,
    androidOfferId: p.offerId ?? null,
    // Android only: the base plan this entry describes. Null on iOS, where
    // `identifier` is the product id and there is no base-plan concept.
    androidBasePlanId: p.planIdentifier !== undefined ? p.identifier : null,
  };
}

/** Price in micro-units as a string, avoiding float precision loss on render. */
function toMicros(price: number | undefined): string {
  // `Math.round(undefined * 1e6).toString()` is the string "NaN", which
  // looks like a price and poisons any arithmetic done with it. A price
  // the store did not send is "0"; `priceString` stays the thing to show.
  if (typeof price !== 'number' || !Number.isFinite(price)) return '0';
  return Math.round(price * 1_000_000).toString();
}

function normalizeOffer(discount: PluginDiscount): SubscriptionOffer {
  return {
    // An iOS introductory offer and an Android base-plan intro phase both
    // arrive with an empty identifier; neither is named by its store.
    id: discount.identifier || null,
    type: mapOfferType(discount.type),
    payment: mapOfferPayment(discount.paymentMode),
    priceString: discount.priceString,
    priceMicros: toMicros(discount.price),
    currency: discount.currencyCode,
    period: toIso8601Duration(discount.subscriptionPeriod),
    periodCount: discount.numberOfPeriods,
  };
}

/** capgo's offer-type integers: introductory=0, promotional=1, winBack=2. */
function mapOfferType(type: number): SubscriptionOfferType {
  switch (type) {
    case 0:
      return 'introductory';
    case 1:
      return 'promotional';
    case 2:
      return 'win-back';
    default:
      // capgo emits -1 for a StoreKit offer type it does not know.
      return 'unknown';
  }
}

/**
 * Map capgo's `paymentMode` integer.
 *
 * **Read the legend from capgo's code, not from its comment.** capgo's iOS
 * source labels this mapping "SKProductDiscount.PaymentMode-compatible:
 * freeTrial=0, payUpFront=1, payAsYouGo=2" — but Apple's actual
 * `SKProductDiscount.PaymentMode` is payAsYouGo=0, payUpFront=1,
 * freeTrial=2. The comment is wrong about Apple; the numbers it emits are
 * what ships, and capgo's Android side independently uses the same order
 * (price 0 → 0, non-recurring → 1, otherwise → 2).
 *
 * So both platforms agree with each other and disagree with the name in the
 * comment. Mapping from Apple's documented legend would report every free
 * trial as pay-as-you-go.
 */
function mapOfferPayment(paymentMode: number): SubscriptionOfferPayment {
  switch (paymentMode) {
    case 0:
      return 'free-trial';
    case 1:
      return 'pay-up-front';
    case 2:
      return 'pay-as-you-go';
    default:
      return 'unknown';
  }
}
