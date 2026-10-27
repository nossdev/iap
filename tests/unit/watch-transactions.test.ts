import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NativeTransaction } from '../../src/types/transaction.js';

let mockedPlatform: 'ios' | 'android' | 'web' = 'ios';
vi.mock('@capacitor/core', () => ({
  Capacitor: {
    getPlatform: () => mockedPlatform,
    isNativePlatform: () => mockedPlatform !== 'web',
  },
}));

const nativePurchasesMock = vi.hoisted(() => ({
  addListener: vi.fn(),
  getPurchases: vi.fn(),
}));

vi.mock('@capgo/native-purchases', () => ({
  NativePurchases: nativePurchasesMock,
  PURCHASE_TYPE: { INAPP: 'inapp', SUBS: 'subs' },
}));

import {
  getCapgoPendingProductIds,
  watchCapgoTransactions,
} from '../../src/adapters/native/capgo/watch-transactions.js';
import { makeSilentLogger } from '../mocks/http-helpers.js';

const logger = makeSilentLogger();

/** Captured listener callbacks, keyed by the plugin event name. */
let listeners: Record<string, (payload: unknown) => void>;
let removes: Record<string, ReturnType<typeof vi.fn>>;

beforeEach(() => {
  vi.clearAllMocks();
  mockedPlatform = 'ios';
  listeners = {};
  removes = {};
  nativePurchasesMock.addListener.mockImplementation(
    async (event: string, handler: (payload: unknown) => void) => {
      listeners[event] = handler;
      removes[event] = vi.fn().mockResolvedValue(undefined);
      return { remove: removes[event] };
    },
  );
});

describe('watchCapgoTransactions', () => {
  it('subscribes to both plugin events', async () => {
    const handle = await watchCapgoTransactions(() => {}, logger);

    expect(handle).not.toBeNull();
    expect(Object.keys(listeners).sort()).toEqual([
      'transactionUpdated',
      'transactionVerificationFailed',
    ]);
  });

  it('hands the consumer a normalized transaction, not the plugin shape', async () => {
    const received: NativeTransaction[] = [];
    await watchCapgoTransactions((tx) => received.push(tx), logger);

    // A renewal as StoreKit reports it, via capgo.
    listeners.transactionUpdated?.({
      transactionId: '2000001099999999',
      productIdentifier: 'household_yearly',
      productType: 'subs',
      purchaseDate: '2026-10-27T00:00:00Z',
      receipt: 'base64receipt',
      subscriptionState: 'subscribed',
      expirationDate: '2026-11-27T00:00:00Z',
      willCancel: false,
    });

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      platform: 'apple',
      productId: 'household_yearly',
      token: '2000001099999999',
      productType: 'subscription',
      subscription: { state: 'subscribed', autoRenewing: true },
    });
  });

  it('swallows a throwing handler, because this runs on a native callback', async () => {
    // A throw here has nowhere useful to go: it would surface as an
    // unhandled rejection inside the bridge, or vanish.
    await watchCapgoTransactions(() => {
      throw new Error('consumer blew up');
    }, logger);

    expect(() =>
      listeners.transactionUpdated?.({
        transactionId: '1',
        productIdentifier: 'household_yearly',
        willCancel: null,
      }),
    ).not.toThrow();
  });

  it('returns null when the update listener cannot be registered', async () => {
    // An older plugin, or a platform where the event does not exist. The
    // caller degrades to reconciliation rather than failing initialize().
    nativePurchasesMock.addListener.mockRejectedValueOnce(new Error('no such event'));

    expect(await watchCapgoTransactions(() => {}, logger)).toBeNull();
  });

  it('still returns a handle when only the verification listener fails', async () => {
    nativePurchasesMock.addListener
      .mockImplementationOnce(async (event: string, handler: (p: unknown) => void) => {
        listeners[event] = handler;
        removes[event] = vi.fn().mockResolvedValue(undefined);
        return { remove: removes[event] };
      })
      .mockRejectedValueOnce(new Error('no such event'));

    const handle = await watchCapgoTransactions(() => {}, logger);

    // The update feed is the one that matters; the other is informational.
    expect(handle).not.toBeNull();
    expect(listeners.transactionUpdated).toBeTypeOf('function');
  });

  it('does not log the transaction id of a failed verification', async () => {
    // It is a receipt identifier (PLAN.md §16: never log raw tokens).
    const warn = vi.fn();
    await watchCapgoTransactions(() => {}, { ...logger, warn });

    listeners.transactionVerificationFailed?.({
      transactionId: '2000001099999999',
      error: 'The transaction could not be verified.',
    });

    expect(warn).toHaveBeenCalledTimes(1);
    const logged = warn.mock.calls.flat().join(' ');
    expect(logged).toContain('could not be verified');
    expect(logged).not.toContain('2000001099999999');
  });

  it('removes every listener it registered', async () => {
    const handle = await watchCapgoTransactions(() => {}, logger);
    await handle?.remove();

    expect(removes.transactionUpdated).toHaveBeenCalledTimes(1);
    expect(removes.transactionVerificationFailed).toHaveBeenCalledTimes(1);
  });

  it('removes the rest when one removal throws', async () => {
    const handle = await watchCapgoTransactions(() => {}, logger);
    removes.transactionUpdated?.mockRejectedValueOnce(new Error('already gone'));

    await expect(handle?.remove()).resolves.toBeUndefined();
    expect(removes.transactionVerificationFailed).toHaveBeenCalledTimes(1);
  });
});

describe('getCapgoPendingProductIds', () => {
  it("treats Play's PENDING state ('2') as awaiting clearance", async () => {
    // The constant that matters. Play's `Purchase.PurchaseState` is
    // UNSPECIFIED_STATE=0, PURCHASED=1, PENDING=2, and the plugin
    // stringifies that int verbatim. The plugin's own .d.ts claims "0" means
    // pending, which is wrong — `getPurchaseState()` returns only 1 or 2, so
    // a filter on '0' would match nothing and report every pending purchase
    // as vanished.
    mockedPlatform = 'android';
    nativePurchasesMock.getPurchases.mockResolvedValue({
      purchases: [
        { productIdentifier: 'waiting', purchaseState: '2', purchaseToken: 'a' },
        { productIdentifier: 'owned', purchaseState: '1', purchaseToken: 'b' },
        { productIdentifier: 'also_waiting', purchaseState: '2', purchaseToken: 'c' },
      ],
    });

    expect(await getCapgoPendingProductIds(logger)).toEqual(['waiting', 'also_waiting']);
  });

  it('counts any non-purchased state as not-yet-granted', async () => {
    // Expressed as "has it, does not own it" rather than `=== '2'`, so
    // UNSPECIFIED_STATE and any state Play adds later read as still waiting
    // rather than as gone. Reporting `cancelled` is the irreversible
    // mistake; staying pending self-corrects on the next pass.
    mockedPlatform = 'android';
    nativePurchasesMock.getPurchases.mockResolvedValue({
      purchases: [
        { productIdentifier: 'unspecified', purchaseState: '0', purchaseToken: 'a' },
        { productIdentifier: 'future_state', purchaseState: '7', purchaseToken: 'b' },
        { productIdentifier: 'owned', purchaseState: '1', purchaseToken: 'c' },
      ],
    });

    expect(await getCapgoPendingProductIds(logger)).toEqual(['unspecified', 'future_state']);
  });

  it('returns an empty list when Play reports nothing pending', async () => {
    mockedPlatform = 'android';
    nativePurchasesMock.getPurchases.mockResolvedValue({
      purchases: [{ productIdentifier: 'owned', purchaseState: '1', purchaseToken: 'b' }],
    });

    // Empty, not null: Android genuinely knows that nothing is waiting.
    expect(await getCapgoPendingProductIds(logger)).toEqual([]);
  });

  it('returns null on iOS, which cannot enumerate deferred purchases', async () => {
    mockedPlatform = 'ios';

    // The distinction matters: `[]` would let the caller conclude a deferred
    // purchase had been cancelled while the parent was still deciding.
    expect(await getCapgoPendingProductIds(logger)).toBeNull();
    expect(nativePurchasesMock.getPurchases).not.toHaveBeenCalled();
  });

  it('returns null when the store cannot be read', async () => {
    mockedPlatform = 'android';
    nativePurchasesMock.getPurchases.mockRejectedValue(new Error('store offline'));

    // Cannot tell is not the same as nothing pending.
    expect(await getCapgoPendingProductIds(logger)).toBeNull();
  });
});
