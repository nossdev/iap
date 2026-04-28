import { describe, expect, it, vi } from 'vitest';
import type { BackendAdapter, RestoreRequest } from '../../src/adapters/backend/types.js';
import type { NativeAdapter } from '../../src/adapters/native/types.js';
import { MemoryAdapter } from '../../src/adapters/storage/memory-adapter.js';
import { EntitlementCache } from '../../src/core/entitlement-cache.js';
import { RestoreOrchestrator } from '../../src/core/restore-flow.js';
import { UnfinishedTransactionsStore } from '../../src/core/unfinished-transactions.js';
import { TypedEventEmitter } from '../../src/events/emitter.js';
import { IAPError, IAPErrorCode } from '../../src/lib/errors.js';
import type { EntitlementBase } from '../../src/types/entitlement.js';
import type { NativeTransaction } from '../../src/types/transaction.js';
import { makeSilentLogger } from '../mocks/http-helpers.js';
import { makeBackend, makeNativeAdapter } from '../mocks/orchestrator-builders.js';

const silentLogger = makeSilentLogger();

function makeOrchestrator<T extends EntitlementBase = EntitlementBase>(opts: {
  nativeAdapter?: NativeAdapter;
  backend?: BackendAdapter<T>;
  initialEntitlements?: T[];
}): {
  restorer: RestoreOrchestrator<T>;
  state: { entitlements: T[]; cachedAt: number | null };
  events: Array<{ name: string; payload: unknown }>;
  unfinished: UnfinishedTransactionsStore;
  storage: MemoryAdapter;
} {
  const storage = new MemoryAdapter('test');
  const cache = new EntitlementCache<T>(storage, silentLogger);
  const unfinished = new UnfinishedTransactionsStore(storage, silentLogger);
  const emitter = new TypedEventEmitter<T>();
  const state: { entitlements: T[]; cachedAt: number | null } = {
    entitlements: opts.initialEntitlements ?? [],
    cachedAt: null,
  };

  const events: Array<{ name: string; payload: unknown }> = [];
  for (const name of ['restore-started', 'restore-completed', 'entitlements-changed'] as const) {
    emitter.on(name, (payload) => events.push({ name, payload }));
  }

  const restorer = new RestoreOrchestrator<T>({
    nativeAdapter: opts.nativeAdapter ?? makeNativeAdapter(),
    backend: opts.backend ?? makeBackend<T>(),
    cache,
    unfinished,
    emitter,
    logger: silentLogger,
    getCurrentEntitlements: () => state.entitlements,
    setEntitlements: (next) => {
      state.entitlements = next.map((item) => Object.freeze({ ...item }) as T);
    },
    setCachePersisted: (ts) => {
      state.cachedAt = ts;
    },
  });

  return { restorer, state, events, unfinished, storage };
}

describe('RestoreOrchestrator — empty owned list', () => {
  it('returns { restored: 0, entitlements: <current> } without calling backend', async () => {
    const restoreSpy = vi.fn();
    const { restorer, events, state } = makeOrchestrator({
      nativeAdapter: makeNativeAdapter({ getOwnedTransactions: async () => [] }),
      backend: makeBackend({ restore: restoreSpy as never }),
    });

    const result = await restorer.restorePurchases();

    expect(result.restored).toBe(0);
    expect(result.entitlements).toEqual([]);
    expect(restoreSpy).not.toHaveBeenCalled();
    expect(state.cachedAt).toBeNull(); // no persistence triggered
    expect(events.map((e) => e.name)).toEqual(['restore-started', 'restore-completed']);
  });

  it('preserves existing entitlements when nothing is owned natively', async () => {
    const initial = [
      { key: 'premium', productId: 'premium_monthly', expiresAt: '2026-12-01T00:00:00Z' },
    ];
    const { restorer, events, state } = makeOrchestrator({
      nativeAdapter: makeNativeAdapter({ getOwnedTransactions: async () => [] }),
      initialEntitlements: initial,
    });

    const result = await restorer.restorePurchases();

    expect(result.restored).toBe(0);
    expect(result.entitlements).toHaveLength(1);
    expect(result.entitlements[0]?.key).toBe('premium');
    expect(state.entitlements).toBe(initial); // unchanged reference
    // No entitlements-changed because state didn't change
    expect(events.map((e) => e.name)).toEqual(['restore-started', 'restore-completed']);
  });
});

describe('RestoreOrchestrator — single platform', () => {
  it('Apple: calls backend.restore with single apple entry, acks the native tx', async () => {
    const ownedAppleTx: NativeTransaction = {
      platform: 'apple',
      productId: 'premium_monthly',
      token: '2000000123456789',
      productType: 'subscription',
    };
    const acknowledgeSpy = vi.fn(async () => {});
    const restoreSpy = vi.fn(async (_req: RestoreRequest) => ({
      valid: true as const,
      entitlements: [
        { key: 'premium', productId: 'premium_monthly', expiresAt: null } as EntitlementBase,
      ],
      transaction: { id: 'consolidated', productId: 'consolidated' },
    }));

    const { restorer, events, state } = makeOrchestrator({
      nativeAdapter: makeNativeAdapter({
        getOwnedTransactions: async () => [ownedAppleTx],
        acknowledge: acknowledgeSpy,
      }),
      backend: makeBackend({ restore: restoreSpy }),
    });

    const result = await restorer.restorePurchases();

    expect(result.restored).toBe(1);
    expect(result.entitlements).toHaveLength(1);
    expect(state.entitlements[0]?.key).toBe('premium');
    expect(state.cachedAt).not.toBeNull();
    expect(acknowledgeSpy).toHaveBeenCalledTimes(1);
    expect(acknowledgeSpy).toHaveBeenCalledWith(ownedAppleTx);

    expect(restoreSpy).toHaveBeenCalledWith({
      transactions: [
        {
          platform: 'apple',
          productId: 'premium_monthly',
          transactionId: '2000000123456789',
        },
      ],
    });

    expect(events.map((e) => e.name)).toEqual([
      'restore-started',
      'restore-completed',
      'entitlements-changed',
    ]);
  });

  it('Google: calls backend.restore with purchaseToken + packageName', async () => {
    const ownedGoogleTx: NativeTransaction = {
      platform: 'google',
      productId: 'premium_monthly',
      token: 'play-token-abc',
      packageName: 'com.example.app',
      productType: 'subscription',
    };
    const restoreSpy = vi.fn(async (_req: RestoreRequest) => ({
      valid: true as const,
      entitlements: [
        { key: 'premium', productId: 'premium_monthly', expiresAt: null } as EntitlementBase,
      ],
      transaction: { id: 'consolidated', productId: 'consolidated' },
    }));

    const { restorer } = makeOrchestrator({
      nativeAdapter: makeNativeAdapter({ getOwnedTransactions: async () => [ownedGoogleTx] }),
      backend: makeBackend({ restore: restoreSpy }),
    });

    await restorer.restorePurchases();

    expect(restoreSpy).toHaveBeenCalledWith({
      transactions: [
        {
          platform: 'google',
          productId: 'premium_monthly',
          purchaseToken: 'play-token-abc',
          packageName: 'com.example.app',
        },
      ],
    });
  });
});

describe('RestoreOrchestrator — multi-product mixed batch', () => {
  it('submits all transactions, acks each, returns consolidated entitlements', async () => {
    const owned: NativeTransaction[] = [
      {
        platform: 'apple',
        productId: 'premium_monthly',
        token: '2000000111',
        productType: 'subscription',
      },
      {
        platform: 'apple',
        productId: 'remove_ads',
        token: '2000000222',
        productType: 'product',
      },
      {
        platform: 'google',
        productId: 'coin_pack_100',
        token: 'play-tok-coin',
        packageName: 'com.example.app',
        productType: 'consumable',
      },
    ];
    const acknowledgeSpy = vi.fn(async () => {});
    let capturedRequest: RestoreRequest | undefined;
    const restoreSpy = async (req: RestoreRequest) => {
      capturedRequest = req;
      return {
        valid: true as const,
        entitlements: [
          { key: 'premium', productId: 'premium_monthly', expiresAt: null },
          { key: 'no_ads', productId: 'remove_ads', expiresAt: null },
        ] as EntitlementBase[],
        transaction: { id: 'consolidated', productId: 'consolidated' },
      };
    };

    const { restorer, state } = makeOrchestrator({
      nativeAdapter: makeNativeAdapter({
        getOwnedTransactions: async () => owned,
        acknowledge: acknowledgeSpy,
      }),
      backend: makeBackend({ restore: restoreSpy }),
    });

    const result = await restorer.restorePurchases();
    expect(result.restored).toBe(3);
    expect(result.entitlements).toHaveLength(2);
    expect(state.entitlements.map((e) => e.key).sort()).toEqual(['no_ads', 'premium']);
    expect(acknowledgeSpy).toHaveBeenCalledTimes(3);

    if (!capturedRequest) throw new Error('backend.restore was not called');
    expect(capturedRequest.transactions).toHaveLength(3);
    expect(capturedRequest.transactions[0]).toMatchObject({
      platform: 'apple',
      transactionId: '2000000111',
    });
    expect(capturedRequest.transactions[2]).toMatchObject({
      platform: 'google',
      purchaseToken: 'play-tok-coin',
      packageName: 'com.example.app',
    });
  });
});

describe('RestoreOrchestrator — failure paths', () => {
  it('throws VERIFICATION_REJECTED when backend returns valid:false', async () => {
    const owned: NativeTransaction[] = [
      {
        platform: 'apple',
        productId: 'premium_monthly',
        token: '2000000111',
        productType: 'subscription',
      },
    ];
    const acknowledgeSpy = vi.fn();
    const { restorer, events, state } = makeOrchestrator({
      nativeAdapter: makeNativeAdapter({
        getOwnedTransactions: async () => owned,
        acknowledge: acknowledgeSpy,
      }),
      backend: makeBackend({
        restore: async () => ({
          valid: false,
          error: 'BATCH_REJECTED',
          message: 'batch contained an unknown transaction',
        }),
      }),
    });

    try {
      await restorer.restorePurchases();
      throw new Error('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(IAPError);
      expect((error as IAPError).code).toBe(IAPErrorCode.VERIFICATION_REJECTED);
      // H3: message preserves both human-readable and stable machine code
      expect((error as IAPError).message).toContain('batch contained an unknown transaction');
      expect((error as IAPError).message).toContain('BATCH_REJECTED');
    }

    // No ack, no entitlement change
    expect(acknowledgeSpy).not.toHaveBeenCalled();
    expect(state.entitlements).toEqual([]);
    expect(events.map((e) => e.name)).toEqual(['restore-started']);
  });

  it('wraps backend transport errors as BACKEND_UNAVAILABLE (preserving IAPError)', async () => {
    const owned: NativeTransaction[] = [
      {
        platform: 'apple',
        productId: 'premium_monthly',
        token: '2000000111',
        productType: 'subscription',
      },
    ];
    const networkErr = new IAPError({
      code: IAPErrorCode.BACKEND_TIMEOUT,
      message: 'timeout',
      recoverable: true,
    });
    const { restorer, events } = makeOrchestrator({
      nativeAdapter: makeNativeAdapter({ getOwnedTransactions: async () => owned }),
      backend: makeBackend({
        restore: async () => {
          throw networkErr;
        },
      }),
    });

    try {
      await restorer.restorePurchases();
      throw new Error('should have thrown');
    } catch (error) {
      // toIAPError should pass-through the original IAPError
      expect(error).toBe(networkErr);
    }
    expect(events.map((e) => e.name)).toEqual(['restore-started']);
  });

  it('wraps native getOwnedTransactions errors with STORE_ERROR fallback', async () => {
    const { restorer } = makeOrchestrator({
      nativeAdapter: makeNativeAdapter({
        getOwnedTransactions: async () => {
          throw new Error('native bridge fault');
        },
      }),
    });

    try {
      await restorer.restorePurchases();
      throw new Error('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(IAPError);
      expect((error as IAPError).code).toBe(IAPErrorCode.STORE_ERROR);
    }
  });

  it('rejects Google owned tx with no packageName before calling backend', async () => {
    const restoreSpy = vi.fn();
    const { restorer } = makeOrchestrator({
      nativeAdapter: makeNativeAdapter({
        getOwnedTransactions: async () =>
          [
            {
              platform: 'google',
              productId: 'premium_monthly',
              token: 'play-tok',
              // packageName missing
              productType: 'subscription',
            },
          ] as NativeTransaction[],
      }),
      backend: makeBackend({ restore: restoreSpy as never }),
    });

    try {
      await restorer.restorePurchases();
      throw new Error('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(IAPError);
      expect((error as IAPError).code).toBe(IAPErrorCode.STORE_ERROR);
    }
    expect(restoreSpy).not.toHaveBeenCalled();
  });
});

describe('RestoreOrchestrator — defensive paths', () => {
  it('acknowledge() failures are swallowed; entitlements still update', async () => {
    const owned: NativeTransaction[] = [
      {
        platform: 'apple',
        productId: 'premium_monthly',
        token: '2000000111',
        productType: 'subscription',
      },
      {
        platform: 'apple',
        productId: 'remove_ads',
        token: '2000000222',
        productType: 'product',
      },
    ];
    let calls = 0;
    const acknowledgeSpy = vi.fn(async () => {
      calls += 1;
      if (calls === 1) {
        throw new IAPError({
          code: IAPErrorCode.STORE_ERROR,
          message: 'first ack failed',
        });
      }
      // second succeeds
    });
    const { restorer, state } = makeOrchestrator({
      nativeAdapter: makeNativeAdapter({
        getOwnedTransactions: async () => owned,
        acknowledge: acknowledgeSpy,
      }),
      backend: makeBackend({
        restore: async () => ({
          valid: true as const,
          entitlements: [
            { key: 'premium', productId: 'premium_monthly', expiresAt: null },
          ] as EntitlementBase[],
          transaction: { id: 'consolidated', productId: 'consolidated' },
        }),
      }),
    });

    const result = await restorer.restorePurchases();
    expect(result.restored).toBe(2);
    expect(state.entitlements).toHaveLength(1);
    expect(acknowledgeSpy).toHaveBeenCalledTimes(2); // both attempted
  });

  it('cache.save() failure leaves in-memory state updated', async () => {
    const failingStorage = {
      async get() {
        return null;
      },
      async set() {
        throw new Error('disk full');
      },
      async remove() {},
      async clear() {},
    };
    const cache = new EntitlementCache<EntitlementBase>(failingStorage, silentLogger);
    const memStorage = new MemoryAdapter('test');
    const unfinished = new UnfinishedTransactionsStore(memStorage, silentLogger);
    const emitter = new TypedEventEmitter<EntitlementBase>();
    const state: { entitlements: EntitlementBase[]; cachedAt: number | null } = {
      entitlements: [],
      cachedAt: null,
    };

    const restorer = new RestoreOrchestrator<EntitlementBase>({
      nativeAdapter: makeNativeAdapter({
        getOwnedTransactions: async () => [
          {
            platform: 'apple',
            productId: 'premium_monthly',
            token: '2000000111',
            productType: 'subscription',
          },
        ],
      }),
      backend: makeBackend({
        restore: async () => ({
          valid: true as const,
          entitlements: [
            { key: 'premium', productId: 'premium_monthly', expiresAt: null },
          ] as EntitlementBase[],
          transaction: { id: 'consolidated', productId: 'consolidated' },
        }),
      }),
      cache,
      unfinished,
      emitter,
      logger: silentLogger,
      getCurrentEntitlements: () => state.entitlements,
      setEntitlements: (next) => {
        state.entitlements = next.map((item) => Object.freeze({ ...item }));
      },
      setCachePersisted: (ts) => {
        state.cachedAt = ts;
      },
    });

    const result = await restorer.restorePurchases();
    expect(result.restored).toBe(1);
    expect(state.entitlements).toHaveLength(1);
    expect(state.cachedAt).toBeNull(); // save threw before timestamp returned
  });
});

describe('RestoreOrchestrator — unfinished list maintenance', () => {
  it('drains unfinished entries that match the restored tokens', async () => {
    const owned: NativeTransaction[] = [
      {
        platform: 'apple',
        productId: 'premium_monthly',
        token: '2000000111',
        productType: 'subscription',
      },
    ];
    const { restorer, unfinished } = makeOrchestrator({
      nativeAdapter: makeNativeAdapter({ getOwnedTransactions: async () => owned }),
      backend: makeBackend({
        restore: async () => ({
          valid: true as const,
          entitlements: [
            { key: 'premium', productId: 'premium_monthly', expiresAt: null },
          ] as EntitlementBase[],
          transaction: { id: 'consolidated', productId: 'consolidated' },
        }),
      }),
    });

    // Pre-seed unfinished with the same token to simulate a leftover
    // from a previous session.
    await unfinished.add(owned[0] as NativeTransaction);
    expect((await unfinished.list()).length).toBe(1);

    await restorer.restorePurchases();
    expect((await unfinished.list()).length).toBe(0);
  });

  it('H2: tolerates unfinished.remove() failure during drain — restore still succeeds', async () => {
    const owned: NativeTransaction[] = [
      {
        platform: 'apple',
        productId: 'premium_monthly',
        token: '2000000111',
        productType: 'subscription',
      },
    ];
    const { restorer, unfinished, state } = makeOrchestrator({
      nativeAdapter: makeNativeAdapter({ getOwnedTransactions: async () => owned }),
      backend: makeBackend({
        restore: async () => ({
          valid: true as const,
          entitlements: [
            { key: 'premium', productId: 'premium_monthly', expiresAt: null },
          ] as EntitlementBase[],
          transaction: { id: 'consolidated', productId: 'consolidated' },
        }),
      }),
    });

    // Stub the drain call to throw — exercises the warn-and-continue branch.
    const removeSpy = vi.spyOn(unfinished, 'remove').mockImplementation(async () => {
      throw new Error('storage write failed during drain');
    });

    const result = await restorer.restorePurchases();
    expect(result.restored).toBe(1);
    expect(state.entitlements).toHaveLength(1);
    expect(removeSpy).toHaveBeenCalledTimes(1);
    removeSpy.mockRestore();
  });
});
