import { beforeEach, describe, expect, it, vi } from 'vitest';

let mockedPlatform: 'ios' | 'android' | 'web' = 'ios';
vi.mock('@capacitor/core', () => ({
  Capacitor: {
    getPlatform: () => mockedPlatform,
    isNativePlatform: () => mockedPlatform !== 'web',
  },
}));

const nativePurchasesMock = vi.hoisted(() => ({
  isBillingSupported: vi.fn(),
  getProducts: vi.fn(),
  purchaseProduct: vi.fn(),
  getPurchases: vi.fn(),
  acknowledgePurchase: vi.fn(),
  manageSubscriptions: vi.fn(),
}));

vi.mock('@capgo/native-purchases', () => ({
  NativePurchases: nativePurchasesMock,
  PURCHASE_TYPE: { INAPP: 'inapp', SUBS: 'subs' },
}));

import { CapgoNativeAdapter } from '../../src/adapters/native/capgo/native-adapter.js';

/** base64url-encode a UTF-8 string, as Apple encodes a JWS segment. */
function base64Url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function makeJws(claims: Record<string, unknown>): string {
  return ['eyJhbGciOiJFUzI1NiJ9', base64Url(JSON.stringify(claims)), 'c2ln'].join('.');
}

/** An iOS period object as the plugin emits it. */
const period = (numberOfUnits: number, unitString: string, unit: number) => ({
  numberOfUnits,
  unit,
  unitString,
});

const adapter = new CapgoNativeAdapter();

beforeEach(() => {
  vi.clearAllMocks();
  mockedPlatform = 'ios';
});

describe('CapgoNativeAdapter.getProducts — subscription offers', () => {
  /**
   * The legend this test pins is the whole reason it exists. capgo's iOS
   * source comments its mapping as "SKProductDiscount.PaymentMode-compatible:
   * freeTrial=0, payUpFront=1, payAsYouGo=2" — but real
   * `SKProductDiscount.PaymentMode` is payAsYouGo=0, payUpFront=1,
   * freeTrial=2. The comment is wrong about Apple; the code is what ships,
   * and capgo's Android side independently uses the same 0/1/2 order.
   *
   * So: both platforms agree with each other and disagree with the name in
   * the comment. Mapping from Apple's documented legend would label every
   * free trial "pay as you go" — on a paywall, the difference between
   * "7 days free" and "$0.99/week".
   */
  it.each([
    [0, 'free-trial'],
    [1, 'pay-up-front'],
    [2, 'pay-as-you-go'],
  ])(
    'maps paymentMode %i to %s (capgo order, not SKProductDiscount order)',
    async (mode, expected) => {
      nativePurchasesMock.getProducts.mockResolvedValue({
        products: [
          {
            identifier: 'premium',
            title: 'Premium',
            description: 'All features',
            price: 4.99,
            priceString: '$4.99',
            currencyCode: 'USD',
            subscriptionGroupIdentifier: 'group-1',
            subscriptionPeriod: period(1, 'month', 2),
            introductoryPrice: {
              identifier: 'intro',
              type: 0,
              price: 0,
              priceString: '$0.00',
              currencyCode: 'USD',
              paymentMode: mode,
              numberOfPeriods: 1,
              subscriptionPeriod: period(1, 'week', 1),
            },
            discounts: [],
          },
        ],
      });

      const [product] = await adapter.getProducts([{ id: 'premium', type: 'subscription' }]);
      expect(product?.introductoryOffer?.payment).toBe(expected);
    },
  );

  it('maps an unrecognised paymentMode to unknown rather than guessing', async () => {
    nativePurchasesMock.getProducts.mockResolvedValue({
      products: [
        {
          identifier: 'premium',
          title: 'Premium',
          description: '',
          price: 1,
          priceString: '$1.00',
          currencyCode: 'USD',
          subscriptionPeriod: period(1, 'month', 2),
          // -1 is what capgo emits for a StoreKit payment mode it does not know.
          introductoryPrice: {
            identifier: '',
            type: -1,
            price: 0,
            priceString: '$0.00',
            currencyCode: 'USD',
            paymentMode: -1,
            numberOfPeriods: 1,
            subscriptionPeriod: period(3, 'day', 0),
          },
          discounts: [],
        },
      ],
    });

    const [product] = await adapter.getProducts([{ id: 'premium', type: 'subscription' }]);
    expect(product?.introductoryOffer?.payment).toBe('unknown');
    expect(product?.introductoryOffer?.type).toBe('unknown');
  });

  it('normalizes a full iOS subscription with an intro offer and promotional offers', async () => {
    nativePurchasesMock.getProducts.mockResolvedValue({
      products: [
        {
          identifier: 'household_yearly',
          title: 'Household',
          description: 'One subscription, every phone',
          price: 49.99,
          priceString: '$49.99',
          currencyCode: 'USD',
          subscriptionGroupIdentifier: 'household',
          subscriptionPeriod: period(1, 'year', 3),
          introductoryPrice: {
            identifier: '',
            type: 0,
            price: 0,
            priceString: '$0.00',
            currencyCode: 'USD',
            paymentMode: 0,
            numberOfPeriods: 1,
            subscriptionPeriod: period(2, 'week', 1),
          },
          discounts: [
            {
              identifier: 'winback-2026',
              type: 2,
              price: 19.99,
              priceString: '$19.99',
              currencyCode: 'USD',
              paymentMode: 1,
              numberOfPeriods: 1,
              subscriptionPeriod: period(1, 'year', 3),
            },
          ],
        },
      ],
    });

    const [product] = await adapter.getProducts([{ id: 'household_yearly', type: 'subscription' }]);

    expect(product).toMatchObject({
      id: 'household_yearly',
      type: 'subscription',
      priceString: '$49.99',
      priceMicros: '49990000',
      currency: 'USD',
      subscriptionPeriod: 'P1Y',
      subscriptionGroupId: 'household',
      introductoryOffer: {
        // An iOS intro offer has no identifier of its own; capgo sends "".
        id: null,
        type: 'introductory',
        payment: 'free-trial',
        priceString: '$0.00',
        priceMicros: '0',
        currency: 'USD',
        period: 'P2W',
        periodCount: 1,
      },
      promotionalOffers: [
        {
          id: 'winback-2026',
          type: 'win-back',
          payment: 'pay-up-front',
          priceMicros: '19990000',
          period: 'P1Y',
        },
      ],
    });
  });

  it('surfaces Android offer identification and tolerates its missing period', async () => {
    mockedPlatform = 'android';
    nativePurchasesMock.getProducts.mockResolvedValue({
      products: [
        {
          // On Android `identifier` is the base plan id and `planIdentifier`
          // is the Play product id.
          identifier: 'monthly-plan',
          planIdentifier: 'household',
          offerToken: 'token-abc',
          offerId: null,
          title: 'Household',
          description: '',
          price: 2.99,
          priceString: '₱149.00',
          currencyCode: 'PHP',
          // Android sets NO top-level subscriptionPeriod and no group id,
          // although the plugin's types declare both as required. Reading
          // them naively is a TypeError on a real device.
          introductoryPrice: {
            identifier: '',
            type: 0,
            price: 0,
            priceString: '₱0.00',
            currencyCode: 'PHP',
            paymentMode: 0,
            numberOfPeriods: 0,
            subscriptionPeriod: period(1, 'month', 2),
          },
          discounts: [],
        },
      ],
    });

    const [product] = await adapter.getProducts([{ id: 'monthly-plan', type: 'subscription' }]);

    expect(product).toMatchObject({
      id: 'monthly-plan',
      androidOfferToken: 'token-abc',
      androidOfferId: null,
      subscriptionPeriod: null,
      subscriptionGroupId: null,
      introductoryOffer: { payment: 'free-trial', period: 'P1M', periodCount: 0 },
    });
  });

  it('reports no offers for a non-subscription product', async () => {
    nativePurchasesMock.getProducts.mockResolvedValue({
      products: [
        {
          identifier: 'coins_100',
          title: '100 coins',
          description: '',
          price: 0.99,
          priceString: '$0.99',
          currencyCode: 'USD',
          // capgo's placeholder for a product with no subscription.
          subscriptionGroupIdentifier: '',
          subscriptionPeriod: { numberOfUnits: 0, unit: 0 },
          introductoryPrice: null,
          discounts: [],
        },
      ],
    });

    const [product] = await adapter.getProducts([{ id: 'coins_100', type: 'consumable' }]);

    expect(product).toMatchObject({
      id: 'coins_100',
      type: 'consumable',
      introductoryOffer: null,
      promotionalOffers: [],
      subscriptionPeriod: null,
      subscriptionGroupId: null,
    });
  });

  it('does not throw when the plugin omits every optional field', async () => {
    // The minimum the plugin's required fields guarantee. Anything beyond
    // this is a field some platform or some version does not send.
    nativePurchasesMock.getProducts.mockResolvedValue({
      products: [
        {
          identifier: 'bare',
          title: 'Bare',
          description: '',
          price: 1,
          priceString: '$1.00',
          currencyCode: 'USD',
        },
      ],
    });

    const [product] = await adapter.getProducts([{ id: 'bare', type: 'subscription' }]);
    expect(product).toMatchObject({
      id: 'bare',
      introductoryOffer: null,
      promotionalOffers: [],
      subscriptionPeriod: null,
    });
  });
});

describe('CapgoNativeAdapter — the purchase reference', () => {
  it('reads originalTransactionId out of the iOS JWS payload', async () => {
    nativePurchasesMock.purchaseProduct.mockResolvedValue({
      transactionId: '2000001099999999',
      productIdentifier: 'premium',
      purchaseDate: '2026-10-27T00:00:00Z',
      jwsRepresentation: makeJws({
        originalTransactionId: '2000001043762129',
        productId: 'premium',
      }),
      willCancel: null,
    });

    const tx = await adapter.purchaseProduct({
      productId: 'premium',
      productType: 'subscription',
    });

    // The renewal's own id is the acknowledge handle; the original id is the
    // reference that survives renewals.
    expect(tx.token).toBe('2000001099999999');
    expect(tx.purchaseReference).toBe('2000001043762129');
  });

  it('falls back to the transaction id when the JWS is absent', async () => {
    nativePurchasesMock.purchaseProduct.mockResolvedValue({
      transactionId: '2000001099999999',
      productIdentifier: 'premium',
      receipt: 'base64receipt',
      willCancel: null,
    });

    const tx = await adapter.purchaseProduct({
      productId: 'premium',
      productType: 'subscription',
    });
    expect(tx.purchaseReference).toBe('2000001099999999');
  });

  it('falls back when the JWS is unreadable rather than failing the purchase', async () => {
    nativePurchasesMock.purchaseProduct.mockResolvedValue({
      transactionId: '2000001099999999',
      productIdentifier: 'premium',
      jwsRepresentation: 'not.a.jws',
      willCancel: null,
    });

    const tx = await adapter.purchaseProduct({
      productId: 'premium',
      productType: 'subscription',
    });
    expect(tx.purchaseReference).toBe('2000001099999999');
  });

  it('falls back when the JWS carries no originalTransactionId claim', async () => {
    nativePurchasesMock.purchaseProduct.mockResolvedValue({
      transactionId: '2000001099999999',
      productIdentifier: 'premium',
      jwsRepresentation: makeJws({ productId: 'premium' }),
      willCancel: null,
    });

    const tx = await adapter.purchaseProduct({
      productId: 'premium',
      productType: 'subscription',
    });
    expect(tx.purchaseReference).toBe('2000001099999999');
  });

  it('uses the purchase token on Android, where it is already stable', async () => {
    mockedPlatform = 'android';
    nativePurchasesMock.purchaseProduct.mockResolvedValue({
      transactionId: 'GPA.1234-5678-9012-34567',
      productIdentifier: 'household',
      purchaseToken: 'play-token-xyz',
      purchaseState: '1',
      orderId: 'GPA.1234-5678-9012-34567',
      willCancel: null,
    });

    const tx = await adapter.purchaseProduct({
      productId: 'household',
      productType: 'subscription',
    });
    expect(tx.token).toBe('play-token-xyz');
    expect(tx.purchaseReference).toBe('play-token-xyz');
  });
});

describe('CapgoNativeAdapter — the purchase binding', () => {
  it('returns the binding the purchase was made with', async () => {
    nativePurchasesMock.purchaseProduct.mockResolvedValue({
      transactionId: '1',
      productIdentifier: 'premium',
      appAccountToken: '6ba7b812-9dad-11d1-80b4-00c04fd430c8',
      willCancel: null,
    });

    const tx = await adapter.purchaseProduct({
      productId: 'premium',
      productType: 'subscription',
    });
    expect(tx.appUserId).toBe('6ba7b812-9dad-11d1-80b4-00c04fd430c8');
  });

  it('reports null when the purchase carried no binding', async () => {
    nativePurchasesMock.purchaseProduct.mockResolvedValue({
      transactionId: '1',
      productIdentifier: 'premium',
      willCancel: null,
    });

    const tx = await adapter.purchaseProduct({
      productId: 'premium',
      productType: 'subscription',
    });
    expect(tx.appUserId).toBeNull();
  });
});

describe('CapgoNativeAdapter — renewal detail', () => {
  it.each([
    ['subscribed', 'subscribed'],
    ['expired', 'expired'],
    ['revoked', 'revoked'],
    ['inGracePeriod', 'in-grace-period'],
    ['inBillingRetryPeriod', 'in-billing-retry'],
    ['unknown', 'unknown'],
  ])('maps subscriptionState %s to %s', async (native, expected) => {
    nativePurchasesMock.purchaseProduct.mockResolvedValue({
      transactionId: '1',
      productIdentifier: 'premium',
      subscriptionState: native,
      willCancel: false,
      expirationDate: '2026-11-27T00:00:00Z',
    });

    const tx = await adapter.purchaseProduct({
      productId: 'premium',
      productType: 'subscription',
    });
    expect(tx.subscription?.state).toBe(expected);
  });

  it('maps a state it does not recognise to unknown', async () => {
    nativePurchasesMock.purchaseProduct.mockResolvedValue({
      transactionId: '1',
      productIdentifier: 'premium',
      subscriptionState: 'someFutureState',
      willCancel: null,
    });

    const tx = await adapter.purchaseProduct({
      productId: 'premium',
      productType: 'subscription',
    });
    expect(tx.subscription?.state).toBe('unknown');
  });

  it('takes renewal detail from renewalInfo when present', async () => {
    nativePurchasesMock.purchaseProduct.mockResolvedValue({
      transactionId: '1',
      productIdentifier: 'premium_monthly',
      subscriptionState: 'subscribed',
      expirationDate: '2026-11-27T00:00:00Z',
      willCancel: false,
      renewalInfo: {
        willAutoRenew: true,
        renewalDate: '2026-11-27T00:00:00Z',
        autoRenewProductId: 'premium_yearly',
      },
    });

    const tx = await adapter.purchaseProduct({
      productId: 'premium_monthly',
      productType: 'subscription',
    });

    expect(tx.subscription).toEqual({
      state: 'subscribed',
      autoRenewing: true,
      renewsAt: '2026-11-27T00:00:00Z',
      renewalProductId: 'premium_yearly',
      expiresAt: '2026-11-27T00:00:00Z',
    });
  });

  it('derives autoRenewing from willCancel when renewalInfo is absent', async () => {
    // Older plugin builds and some StoreKit states give willCancel only.
    nativePurchasesMock.purchaseProduct.mockResolvedValue({
      transactionId: '1',
      productIdentifier: 'premium',
      subscriptionState: 'subscribed',
      willCancel: true,
      expirationDate: '2026-11-27T00:00:00Z',
    });

    const tx = await adapter.purchaseProduct({
      productId: 'premium',
      productType: 'subscription',
    });
    expect(tx.subscription?.autoRenewing).toBe(false);
    expect(tx.subscription?.renewsAt).toBeNull();
  });

  it('reports null autoRenewing when the store said nothing either way', async () => {
    nativePurchasesMock.purchaseProduct.mockResolvedValue({
      transactionId: '1',
      productIdentifier: 'premium',
      subscriptionState: 'subscribed',
      willCancel: null,
    });

    const tx = await adapter.purchaseProduct({
      productId: 'premium',
      productType: 'subscription',
    });
    expect(tx.subscription?.autoRenewing).toBeNull();
  });

  it('reports no renewal detail on Android, where the plugin exposes none', async () => {
    mockedPlatform = 'android';
    nativePurchasesMock.purchaseProduct.mockResolvedValue({
      transactionId: 'GPA.1',
      productIdentifier: 'household',
      purchaseToken: 'play-token',
      purchaseState: '1',
      // capgo always sends willCancel: null on Android, and no state,
      // no expiry and no renewal info at all.
      willCancel: null,
    });

    const tx = await adapter.purchaseProduct({
      productId: 'household',
      productType: 'subscription',
    });
    expect(tx.subscription).toBeNull();
  });

  it('reports no renewal detail for a non-subscription purchase', async () => {
    nativePurchasesMock.purchaseProduct.mockResolvedValue({
      transactionId: '1',
      productIdentifier: 'coins_100',
      willCancel: null,
    });

    const tx = await adapter.purchaseProduct({
      productId: 'coins_100',
      productType: 'consumable',
    });
    expect(tx.subscription).toBeNull();
  });
});
