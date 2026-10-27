import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NativeAdapter } from '../../src/adapters/native/types.js';
import type { EntitlementBase } from '../../src/types/entitlement.js';

/**
 * `purchase({ androidOfferToken })` — buying a *specific* one-time offer.
 *
 * Play allows several one-time purchase offers on one product (an
 * introductory price, a limited-time discount), and the native layer takes
 * the first unless told which. Naming one is what this adds.
 *
 * The interesting half is what it refuses. The plugin reads `offerToken`
 * only on its one-time-purchase path; for a subscription it selects by base
 * plan and picks the offer itself, so a token passed there is dropped and a
 * different offer's price can be charged. iap refuses rather than forwards.
 */

let mockedPlatform: 'ios' | 'android' | 'web' = 'android';
vi.mock('@capacitor/core', () => ({
  Capacitor: {
    getPlatform: () => mockedPlatform,
    isNativePlatform: () => mockedPlatform !== 'web',
  },
}));

const purchaseProduct = vi.fn();
const getOwnedTransactions = vi.fn();

const adapter: NativeAdapter = {
  isAvailable: vi.fn().mockResolvedValue(true),
  getProducts: vi.fn().mockResolvedValue([]),
  purchaseProduct,
  getOwnedTransactions,
  acknowledge: vi.fn().mockResolvedValue(undefined),
  consume: vi.fn().mockResolvedValue(undefined),
  dispose: vi.fn().mockResolvedValue(undefined),
};

vi.mock('../../src/adapters/native/index.js', () => ({
  selectNativeAdapter: vi.fn(async () => adapter),
}));

vi.mock('../../src/core/app-resume-listener.js', () => ({
  attachAppResumeListener: vi.fn(async () => null),
}));

import { createIAP } from '../../src/createIAP.js';
import { IAPError, IAPErrorCode } from '../../src/lib/errors.js';
import type { IAPConfigInput } from '../../src/types/config.js';
import { playTransaction } from '../mocks/transactions.js';

const TOKEN = 'offer-token-intro-50pc';

function config(): IAPConfigInput {
  return {
    products: [
      { id: 'coins_100', type: 'consumable' },
      { id: 'remove_ads', type: 'product' },
      { id: 'household_yearly', type: 'subscription', androidPlanId: 'yearly' },
    ],
    verification: { mode: 'local', entitlements: (): EntitlementBase[] => [] },
    storage: { type: 'memory', namespace: 'test' },
    android: { packageName: 'com.example.app' },
    options: { logLevel: 'silent', refreshOnResume: false },
  } as IAPConfigInput;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedPlatform = 'android';
  getOwnedTransactions.mockResolvedValue([]);
});

describe('a one-time product', () => {
  it('forwards the offer token to the native layer', async () => {
    purchaseProduct.mockResolvedValue(
      playTransaction({ productId: 'remove_ads', productType: 'product' }),
    );
    const iap = createIAP(config());
    await iap.initialize();

    const result = await iap.purchase({ productId: 'remove_ads', androidOfferToken: TOKEN });

    expect(result.status).toBe('success');
    expect(purchaseProduct).toHaveBeenCalledWith(
      expect.objectContaining({ productId: 'remove_ads', androidOfferToken: TOKEN }),
    );
  });

  it('forwards it for a consumable too', async () => {
    purchaseProduct.mockResolvedValue(
      playTransaction({ productId: 'coins_100', productType: 'consumable' }),
    );
    const iap = createIAP(config());
    await iap.initialize();

    await iap.purchase({ productId: 'coins_100', androidOfferToken: TOKEN });

    expect(purchaseProduct).toHaveBeenCalledWith(
      expect.objectContaining({ androidOfferToken: TOKEN }),
    );
  });

  it('omits the key entirely when no token is given', async () => {
    purchaseProduct.mockResolvedValue(
      playTransaction({ productId: 'remove_ads', productType: 'product' }),
    );
    const iap = createIAP(config());
    await iap.initialize();

    await iap.purchase({ productId: 'remove_ads' });

    // Not `androidOfferToken: undefined` — the plugin reads the key's
    // presence, and an explicit undefined crossing the bridge is a
    // different thing from an absent one.
    expect(purchaseProduct.mock.calls[0]?.[0]).not.toHaveProperty('androidOfferToken');
  });
});

describe('a subscription', () => {
  it('refuses an offer token rather than letting the store ignore it', async () => {
    const iap = createIAP(config());
    await iap.initialize();

    const error = await iap
      .purchase({ productId: 'household_yearly', androidOfferToken: TOKEN })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(IAPError);
    expect((error as IAPError).code).toBe(IAPErrorCode.INVALID_PURCHASE_OPTIONS);
    // The native subscription path selects by base plan and picks the offer
    // itself, so forwarding this would charge a different offer's price
    // while the consumer believed they had chosen one.
    expect((error as IAPError).message).toContain('androidPlanId');
    // And nothing was started.
    expect(purchaseProduct).not.toHaveBeenCalled();
  });

  it('refuses pre-flight, without emitting purchase-started', async () => {
    const iap = createIAP(config());
    await iap.initialize();
    const events: string[] = [];
    iap.on('purchase-started', () => events.push('started'));

    await iap.purchase({ productId: 'household_yearly', androidOfferToken: TOKEN }).catch(() => {});

    // Same class as the other caller-bug throws: it surfaces to the awaiter
    // without polluting the event stream.
    expect(events).toEqual([]);
  });

  it('still buys normally with no token, selecting by base plan', async () => {
    purchaseProduct.mockResolvedValue(
      playTransaction({ productId: 'household_yearly', productType: 'subscription' }),
    );
    const iap = createIAP(config());
    await iap.initialize();

    const result = await iap.purchase({ productId: 'household_yearly' });

    expect(result.status).toBe('success');
    expect(purchaseProduct).toHaveBeenCalledWith(
      expect.objectContaining({ androidPlanId: 'yearly' }),
    );
  });
});

describe('on iOS', () => {
  it('refuses a subscription token there too, since no platform honours it', async () => {
    mockedPlatform = 'ios';
    const iap = createIAP(config());
    await iap.initialize();

    const error = await iap
      .purchase({ productId: 'household_yearly', androidOfferToken: TOKEN })
      .catch((e: unknown) => e);

    // StoreKit promotional offers need a server-signed payload the plugin
    // does not accept, so there is nothing to forward on either platform.
    expect((error as IAPError).code).toBe(IAPErrorCode.INVALID_PURCHASE_OPTIONS);
  });

  it('forwards a token for a one-time product, which iOS harmlessly ignores', async () => {
    mockedPlatform = 'ios';
    purchaseProduct.mockResolvedValue(
      playTransaction({ productId: 'remove_ads', productType: 'product' }),
    );
    const iap = createIAP(config());
    await iap.initialize();

    const result = await iap.purchase({ productId: 'remove_ads', androidOfferToken: TOKEN });

    // The asymmetry is deliberate: StoreKit has one price per product, so
    // there is no wrong offer to charge and nothing to protect against.
    // Refusing here would make an `android*` option platform-fatal for no
    // benefit.
    expect(result.status).toBe('success');
    expect(purchaseProduct).toHaveBeenCalledWith(
      expect.objectContaining({ androidOfferToken: TOKEN }),
    );
  });
});

describe('an unusable token', () => {
  it.each([
    ['an empty string', ''],
    ['whitespace', '   '],
  ])('refuses %s rather than letting the store choose', async (_label, token) => {
    const iap = createIAP(config());
    await iap.initialize();

    const error = await iap
      .purchase({ productId: 'remove_ads', androidOfferToken: token })
      .catch((e: unknown) => e);

    // Same harm as the subscription case, on the path the feature is for:
    // `token ?? ''` after a catalog refresh would have dropped the option
    // and charged whichever offer the store picked.
    expect(error).toBeInstanceOf(IAPError);
    expect((error as IAPError).code).toBe(IAPErrorCode.INVALID_PURCHASE_OPTIONS);
    expect(purchaseProduct).not.toHaveBeenCalled();
  });

  it('treats null as "no offer chosen", which is what Product reports', async () => {
    purchaseProduct.mockResolvedValue(
      playTransaction({ productId: 'remove_ads', productType: 'product' }),
    );
    const iap = createIAP(config());
    await iap.initialize();

    // `Product.androidOfferToken` is `string | null`, and `null` there
    // means the product has no specific offer — so this is "let the store
    // choose", not a bad token. Distinct from `''`, which comes from a
    // `?? ''` on a catalog that moved and *did* mean to name one.
    const result = await iap.purchase({
      productId: 'remove_ads',
      androidOfferToken: null as unknown as string,
    });

    expect(result.status).toBe('success');
    expect(purchaseProduct.mock.calls[0]?.[0]).not.toHaveProperty('androidOfferToken');
  });
});
