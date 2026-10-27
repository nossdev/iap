import { describe, expect, it, vi } from 'vitest';
import type { BackendAdapter } from '../../src/adapters/backend/types.js';
import type { NativeAdapter } from '../../src/adapters/native/types.js';
import { MemoryAdapter } from '../../src/adapters/storage/memory-adapter.js';
import { EntitlementCache } from '../../src/core/entitlement-cache.js';
import { PurchaseOrchestrator } from '../../src/core/purchase-flow.js';
import { RestoreOrchestrator } from '../../src/core/restore-flow.js';
import { UnfinishedTransactionsStore } from '../../src/core/unfinished-transactions.js';
import { TypedEventEmitter } from '../../src/events/emitter.js';
import type { EntitlementBase } from '../../src/types/entitlement.js';
import type { ConfiguredProduct } from '../../src/types/product.js';
import type { NativeTransaction } from '../../src/types/transaction.js';
import { makeSilentLogger } from '../mocks/http-helpers.js';
import {
  makeBackend,
  makeGoogleTransaction,
  makeNativeAdapter,
} from '../mocks/orchestrator-builders.js';

/**
 * The store's own view of a purchase has to reach the consumer, or every
 * typed field the native adapter normalizes is write-only.
 *
 * Two routes matter, and they answer different questions:
 * - `purchase()` — what was just bought.
 * - `restorePurchases()` — what this account owns now, which is the only
 *   route to a purchase reference after a reinstall or on a new device,
 *   where the install that made the purchase is gone.
 */

const silentLogger = makeSilentLogger();

function makeDeps<T extends EntitlementBase>(opts: {
  nativeAdapter?: NativeAdapter;
  backend?: BackendAdapter<T>;
}) {
  const storage = new MemoryAdapter('test');
  const state: { entitlements: T[]; cachedAt: number | null } = {
    entitlements: [],
    cachedAt: null,
  };
  return {
    nativeAdapter: opts.nativeAdapter ?? makeNativeAdapter(),
    backend: opts.backend ?? makeBackend<T>(),
    cache: new EntitlementCache<T>(storage, silentLogger),
    unfinished: new UnfinishedTransactionsStore(storage, silentLogger),
    emitter: new TypedEventEmitter<T>(),
    logger: silentLogger,
    getCurrentEntitlements: () => state.entitlements,
    setEntitlements: (next: T[]) => {
      state.entitlements = next.map((item) => Object.freeze({ ...item }) as T);
    },
    setCachePersisted: (cachedAt: number) => {
      state.cachedAt = cachedAt;
    },
    getAuthHeaders: async () => ({}),
  };
}

function makePurchaser(opts: {
  products: ConfiguredProduct[];
  nativeAdapter?: NativeAdapter;
  backend?: BackendAdapter<EntitlementBase>;
}): PurchaseOrchestrator {
  return new PurchaseOrchestrator({ ...makeDeps(opts), products: opts.products });
}

function makeRestorer(opts: {
  nativeAdapter?: NativeAdapter;
  backend?: BackendAdapter<EntitlementBase>;
}): RestoreOrchestrator {
  return new RestoreOrchestrator(makeDeps(opts));
}

/** An Apple transaction whose reference deliberately differs from its token. */
function appleRenewal(): NativeTransaction {
  return {
    platform: 'apple',
    productId: 'household_yearly',
    token: '2000001099999999',
    purchaseReference: '2000001043762129',
    productType: 'subscription',
    appUserId: '6ba7b812-9dad-11d1-80b4-00c04fd430c8',
    subscription: {
      state: 'subscribed',
      autoRenewing: true,
      renewsAt: '2026-11-27T00:00:00Z',
      renewalProductId: 'household_yearly',
      expiresAt: '2026-11-27T00:00:00Z',
    },
  };
}

const EXPECTED_APPLE_PURCHASE = {
  platform: 'apple',
  productId: 'household_yearly',
  purchaseReference: '2000001043762129',
  appUserId: '6ba7b812-9dad-11d1-80b4-00c04fd430c8',
  subscription: {
    state: 'subscribed',
    autoRenewing: true,
    renewsAt: '2026-11-27T00:00:00Z',
    renewalProductId: 'household_yearly',
    expiresAt: '2026-11-27T00:00:00Z',
  },
};

describe('purchase() surfaces the store view of the purchase', () => {
  it('carries the reference, the binding and the renewal detail on success', async () => {
    const orchestrator = makePurchaser({
      products: [{ id: 'household_yearly', type: 'subscription' }],
      nativeAdapter: makeNativeAdapter({
        purchaseProduct: vi.fn().mockResolvedValue(appleRenewal()),
      }),
    });

    const result = await orchestrator.purchase({ productId: 'household_yearly' });
    expect(result.status).toBe('success');
    if (result.status !== 'success') return;

    expect(result.purchase).toEqual(EXPECTED_APPLE_PURCHASE);
  });

  it('keeps the reference distinct from the backend transaction id', async () => {
    // The backend's `transaction.id` is its own identifier for the receipt,
    // not the store's renewal-stable reference. A consumer that conflated
    // them would re-mint a token against the wrong value.
    const orchestrator = makePurchaser({
      products: [{ id: 'household_yearly', type: 'subscription' }],
      nativeAdapter: makeNativeAdapter({
        purchaseProduct: vi.fn().mockResolvedValue(appleRenewal()),
      }),
    });

    const result = await orchestrator.purchase({ productId: 'household_yearly' });
    if (result.status !== 'success') throw new Error('expected success');
    expect(result.purchase.purchaseReference).not.toBe(result.transaction.id);
  });

  it('reports null for a purchase that carried no binding or renewal detail', async () => {
    const orchestrator = makePurchaser({
      products: [{ id: 'coins_100', type: 'consumable' }],
      nativeAdapter: makeNativeAdapter({
        purchaseProduct: vi.fn().mockResolvedValue({
          platform: 'google',
          productId: 'coins_100',
          token: 'play-token-coins',
          purchaseReference: 'play-token-coins',
          packageName: 'com.example.app',
          productType: 'consumable',
        } satisfies NativeTransaction),
      }),
    });

    const result = await orchestrator.purchase({ productId: 'coins_100' });
    if (result.status !== 'success') throw new Error('expected success');
    expect(result.purchase).toEqual({
      platform: 'google',
      productId: 'coins_100',
      purchaseReference: 'play-token-coins',
      appUserId: null,
      subscription: null,
    });
  });
});

describe('restorePurchases() surfaces what the account owns', () => {
  it('returns one store-purchase entry per owned transaction', async () => {
    const restorer = makeRestorer({
      nativeAdapter: makeNativeAdapter({
        getOwnedTransactions: vi.fn().mockResolvedValue([appleRenewal()]),
      }),
      backend: makeBackend({
        restore: vi.fn().mockResolvedValue({
          valid: true,
          entitlements: [{ key: 'household', productId: 'household_yearly', expiresAt: null }],
        }),
      }),
    });

    const result = await restorer.restorePurchases();

    expect(result.restored).toBe(1);
    expect(result.purchases).toEqual([EXPECTED_APPLE_PURCHASE]);
  });

  it('returns an empty list when the store reports nothing owned', async () => {
    // The short-circuit path: restore does not call the backend at all here,
    // so `purchases` has to be populated independently of the response.
    const restorer = makeRestorer({
      nativeAdapter: makeNativeAdapter({
        getOwnedTransactions: vi.fn().mockResolvedValue([]),
      }),
    });

    const result = await restorer.restorePurchases();
    expect(result.restored).toBe(0);
    expect(result.purchases).toEqual([]);
  });

  it('reports every owned transaction, in the order the store gave them', async () => {
    const restorer = makeRestorer({
      nativeAdapter: makeNativeAdapter({
        getOwnedTransactions: vi
          .fn()
          .mockResolvedValue([makeGoogleTransaction('premium_monthly'), appleRenewal()]),
      }),
      backend: makeBackend({
        restore: vi.fn().mockResolvedValue({ valid: true, entitlements: [] }),
      }),
    });

    const result = await restorer.restorePurchases();
    expect(result.purchases.map((p) => p.purchaseReference)).toEqual([
      'play-token-premium_monthly',
      '2000001043762129',
    ]);
  });
});
