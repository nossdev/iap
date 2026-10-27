import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NativeAdapter } from '../../src/adapters/native/types.js';
import type { LocallyVerifiedPurchase } from '../../src/core/local-verification.js';
import type { EntitlementBase } from '../../src/types/entitlement.js';

/**
 * Android consumables, end to end.
 *
 * The bug this covers: a consumable that cleared out of band — a restore,
 * launch recovery, or the transaction-update feed — was acknowledged but
 * never consumed, because nothing on those paths could tell a consumable
 * from a one-time purchase. Play then kept reporting it owned and buying it
 * again failed `ALREADY_PURCHASED`, permanently. The entitlement was fine;
 * the product was simply unbuyable for good.
 */

let mockedPlatform: 'ios' | 'android' | 'web' = 'android';
vi.mock('@capacitor/core', () => ({
  Capacitor: {
    getPlatform: () => mockedPlatform,
    isNativePlatform: () => mockedPlatform !== 'web',
  },
}));

const acknowledge = vi.fn();
const consume = vi.fn();
const purchaseProduct = vi.fn();
const getOwnedTransactions = vi.fn();

const adapter: NativeAdapter = {
  isAvailable: vi.fn().mockResolvedValue(true),
  getProducts: vi.fn().mockResolvedValue([]),
  purchaseProduct,
  getOwnedTransactions,
  acknowledge,
  consume,
  dispose: vi.fn().mockResolvedValue(undefined),
};

vi.mock('../../src/adapters/native/index.js', () => ({
  selectNativeAdapter: vi.fn(async () => adapter),
}));

vi.mock('../../src/core/app-resume-listener.js', () => ({
  attachAppResumeListener: vi.fn(async () => null),
}));

import { MemoryAdapter } from '../../src/adapters/storage/memory-adapter.js';
import type { StorageAdapter } from '../../src/adapters/storage/types.js';
import { IAP_STORAGE_KEYS } from '../../src/core/storage-keys.js';
import { createIAP } from '../../src/createIAP.js';
import type { IAPConfigInput } from '../../src/types/config.js';
import { playTransaction } from '../mocks/transactions.js';

const COINS = 'coins_100';

/** A consumable grants nothing standing — see `LocallyVerifiedPurchase`. */
function entitlementsFor(_purchase: LocallyVerifiedPurchase): EntitlementBase[] {
  return [];
}

function config(over: Partial<IAPConfigInput> = {}): IAPConfigInput {
  return {
    products: [
      { id: COINS, type: 'consumable' },
      { id: 'remove_ads', type: 'product' },
    ],
    verification: { mode: 'local', entitlements: entitlementsFor },
    storage: { type: 'memory', namespace: 'test' },
    android: { packageName: 'com.example.app' },
    options: { logLevel: 'silent', refreshOnResume: false },
    ...over,
  } as IAPConfigInput;
}

const coinsTx = (over = {}) =>
  playTransaction({ productId: COINS, productType: 'consumable', ...over });

beforeEach(() => {
  vi.clearAllMocks();
  mockedPlatform = 'android';
  acknowledge.mockResolvedValue(undefined);
  consume.mockResolvedValue(undefined);
  getOwnedTransactions.mockResolvedValue([]);
});

describe('an Android consumable', () => {
  it('is consumed after a purchase, so it can be bought again', async () => {
    purchaseProduct.mockResolvedValue(coinsTx());
    const iap = createIAP(config());
    await iap.initialize();

    const result = await iap.purchase({ productId: COINS });

    expect(result.status).toBe('success');
    expect(consume).toHaveBeenCalledTimes(1);
    // Consuming acknowledges too, so acknowledging as well would be a
    // second call against a purchase the store no longer has.
    expect(acknowledge).not.toHaveBeenCalled();
  });

  it('is consumed when it clears through a restore', async () => {
    getOwnedTransactions.mockResolvedValue([coinsTx()]);
    const iap = createIAP(config());
    await iap.initialize();

    await iap.restorePurchases();

    // This is the path that was broken: the transaction came from the
    // store, not from a purchase() call, so its type had to come from the
    // configured catalog.
    expect(consume).toHaveBeenCalledTimes(1);
    expect(acknowledge).not.toHaveBeenCalled();
  });

  it('is only acknowledged, never consumed, when it is not a consumable', async () => {
    purchaseProduct.mockResolvedValue(
      playTransaction({ productId: 'remove_ads', productType: 'product' }),
    );
    const iap = createIAP(config());
    await iap.initialize();

    await iap.purchase({ productId: 'remove_ads' });

    expect(acknowledge).toHaveBeenCalledTimes(1);
    expect(consume).not.toHaveBeenCalled();
  });

  it('keeps its unfinished entry when the consume fails, for the next launch', async () => {
    purchaseProduct.mockResolvedValue(coinsTx());
    consume.mockRejectedValue(new Error('billing service disconnected'));
    const storage = new MemoryAdapter('test');
    const iap = createIAP(
      config({ storage: { type: 'custom', namespace: 'test', adapter: storage } }),
    );
    await iap.initialize();

    const result = await iap.purchase({ productId: COINS });

    // The entitlement side still succeeded — verification passed — but the
    // store was not told, so the record has to survive for recovery to
    // retry it. Same shape as a failed acknowledge.
    expect(result.status).toBe('success');
    expect(consume).toHaveBeenCalledTimes(1);
    // Asserted against storage, not inferred from the result: the name of
    // this test is a claim about what is on disk.
    expect(await storage.get(IAP_STORAGE_KEYS.unfinishedTransactions)).toContain('play-token');
    // And acknowledged on the way out, so Google does not auto-refund
    // while the consume is still pending a retry.
    expect(acknowledge).toHaveBeenCalledTimes(1);
  });

  it('is consumed by launch recovery when a previous session could not', async () => {
    // The path the whole change is for, and the one no test reached: the
    // product type has to survive in the *stored entry*, because recovery
    // re-verifies from that rather than from a live transaction.
    const storage: StorageAdapter = new MemoryAdapter('test');
    const custom = { type: 'custom', namespace: 'test', adapter: storage } as const;

    purchaseProduct.mockResolvedValue(coinsTx());
    consume.mockRejectedValue(new Error('billing service disconnected'));
    const first = createIAP(config({ storage: custom }));
    await first.initialize();
    await first.purchase({ productId: COINS });
    await first.destroy();

    // Next launch, billing healthy again.
    consume.mockReset();
    consume.mockResolvedValue(undefined);
    acknowledge.mockClear();
    getOwnedTransactions.mockResolvedValue([coinsTx()]);

    const second = createIAP(config({ storage: custom }));
    await second.initialize();

    expect(consume).toHaveBeenCalledTimes(1);
    expect(await storage.get(IAP_STORAGE_KEYS.unfinishedTransactions)).not.toContain('play-token');
  });

  it('stops retrying once the store no longer has the purchase', async () => {
    // The trap consuming has and acknowledging does not: if the consume
    // lands on Play but the bridge reply (or the bookkeeping after it)
    // fails, Billing 8.x has already dropped the purchase — so every later
    // consume rejects, and the entry would be retried at every launch
    // forever, burning a recovery slot and a verify each time.
    const storage: StorageAdapter = new MemoryAdapter('test');
    const custom = { type: 'custom', namespace: 'test', adapter: storage } as const;

    purchaseProduct.mockResolvedValue(coinsTx());
    consume.mockRejectedValue(new Error('bridge reply lost'));
    const first = createIAP(config({ storage: custom }));
    await first.initialize();
    await first.purchase({ productId: COINS });
    await first.destroy();

    // Next launch: the consume still rejects, but the store reports the
    // purchase gone — which is a positive signal that it did land.
    getOwnedTransactions.mockResolvedValue([]);
    const second = createIAP(config({ storage: custom }));
    await second.initialize();

    expect(await storage.get(IAP_STORAGE_KEYS.unfinishedTransactions)).not.toContain('play-token');
  });

  it('keeps retrying while the store still reports the purchase owned', async () => {
    const storage: StorageAdapter = new MemoryAdapter('test');
    const custom = { type: 'custom', namespace: 'test', adapter: storage } as const;

    purchaseProduct.mockResolvedValue(coinsTx());
    consume.mockRejectedValue(new Error('billing service disconnected'));
    const first = createIAP(config({ storage: custom }));
    await first.initialize();
    await first.purchase({ productId: COINS });
    await first.destroy();

    // Still owned, so the failure is genuinely transient and the entry
    // must survive. A store that says "still here" must not be read the
    // same way as one that says "gone".
    getOwnedTransactions.mockResolvedValue([coinsTx()]);
    const second = createIAP(config({ storage: custom }));
    await second.initialize();

    expect(await storage.get(IAP_STORAGE_KEYS.unfinishedTransactions)).toContain('play-token');
  });
});

describe('an iOS consumable', () => {
  it('is acknowledged, because finish() is the whole of it there', async () => {
    mockedPlatform = 'ios';
    purchaseProduct.mockResolvedValue({
      ...coinsTx(),
      platform: 'apple' as const,
      packageName: undefined,
      raw: undefined,
    });
    const iap = createIAP(config());
    await iap.initialize();

    await iap.purchase({ productId: COINS });

    // The plugin rejects consumePurchase() outright on iOS.
    expect(acknowledge).toHaveBeenCalledTimes(1);
    expect(consume).not.toHaveBeenCalled();
  });
});
