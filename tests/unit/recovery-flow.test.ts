import { describe, expect, it, vi } from 'vitest';
import type { BackendAdapter } from '../../src/adapters/backend/types.js';
import type { NativeAdapter } from '../../src/adapters/native/types.js';
import { MemoryAdapter } from '../../src/adapters/storage/memory-adapter.js';
import { EntitlementCache } from '../../src/core/entitlement-cache.js';
import { RecoveryOrchestrator } from '../../src/core/recovery-flow.js';
import { UnfinishedTransactionsStore } from '../../src/core/unfinished-transactions.js';
import { TypedEventEmitter } from '../../src/events/emitter.js';
import { IAPError, IAPErrorCode } from '../../src/lib/errors.js';
import type { EntitlementBase } from '../../src/types/entitlement.js';
import type { NativeTransaction } from '../../src/types/transaction.js';
import { makeSilentLogger } from '../mocks/http-helpers.js';
import { makeBackend, makeNativeAdapter } from '../mocks/orchestrator-builders.js';

const silentLogger = makeSilentLogger();

function makeRecovery<T extends EntitlementBase = EntitlementBase>(opts: {
  nativeAdapter?: NativeAdapter;
  backend?: BackendAdapter<T>;
  initialEntitlements?: T[];
}): {
  recoverer: RecoveryOrchestrator<T>;
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
  emitter.on('entitlements-changed', (payload) =>
    events.push({ name: 'entitlements-changed', payload }),
  );

  const recoverer = new RecoveryOrchestrator<T>({
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

  return { recoverer, state, events, unfinished, storage };
}

const sampleAppleTx: NativeTransaction = {
  platform: 'apple',
  productId: 'premium_monthly',
  token: '2000000123456789',
  productType: 'subscription',
};

const sampleGoogleTx: NativeTransaction = {
  platform: 'google',
  productId: 'remove_ads',
  token: 'play-token-abc',
  packageName: 'com.example.app',
  productType: 'product',
};

describe('RecoveryOrchestrator — empty list', () => {
  it('returns zero counts and no backend call when nothing to recover', async () => {
    const verifySpy = vi.fn();
    const { recoverer } = makeRecovery({
      backend: makeBackend({ verifyApple: verifySpy as never, verifyGoogle: verifySpy as never }),
    });

    const result = await recoverer.recoverUnfinishedTransactions();

    expect(result).toEqual({ recovered: 0, failures: 0, inspected: 0 });
    expect(verifySpy).not.toHaveBeenCalled();
  });
});

describe('RecoveryOrchestrator — single entry happy path', () => {
  it('Apple: verify → ack → remove → entitlements applied', async () => {
    const acknowledgeSpy = vi.fn(async () => {});
    const verifyAppleSpy = vi.fn(async () => ({
      valid: true as const,
      entitlements: [
        { key: 'premium', productId: 'premium_monthly', expiresAt: null } as EntitlementBase,
      ],
      transaction: { id: 'tx', productId: 'premium_monthly' },
    }));

    const { recoverer, state, events, unfinished } = makeRecovery({
      nativeAdapter: makeNativeAdapter({ acknowledge: acknowledgeSpy }),
      backend: makeBackend({ verifyApple: verifyAppleSpy }),
    });

    // Pre-seed unfinished with one Apple entry
    await unfinished.add(sampleAppleTx);

    const result = await recoverer.recoverUnfinishedTransactions();

    expect(result).toEqual({ recovered: 1, failures: 0, inspected: 1 });
    expect(verifyAppleSpy).toHaveBeenCalledWith({
      productId: 'premium_monthly',
      transactionId: '2000000123456789',
      type: 'subscription',
    });
    expect(acknowledgeSpy).toHaveBeenCalledTimes(1);
    expect(state.entitlements).toHaveLength(1);
    expect(state.entitlements[0]?.key).toBe('premium');
    expect(state.cachedAt).not.toBeNull();
    expect(await unfinished.list()).toEqual([]);
    expect(events).toHaveLength(1);
    expect(events[0]?.name).toBe('entitlements-changed');
  });

  it('Google: verify with packageName → ack → remove', async () => {
    const verifyGoogleSpy = vi.fn(async () => ({
      valid: true as const,
      entitlements: [
        { key: 'no_ads', productId: 'remove_ads', expiresAt: null } as EntitlementBase,
      ],
      transaction: { id: 'tx', productId: 'remove_ads' },
    }));

    const { recoverer, unfinished } = makeRecovery({
      backend: makeBackend({ verifyGoogle: verifyGoogleSpy }),
    });
    await unfinished.add(sampleGoogleTx);

    const result = await recoverer.recoverUnfinishedTransactions();

    expect(result.recovered).toBe(1);
    expect(verifyGoogleSpy).toHaveBeenCalledWith({
      productId: 'remove_ads',
      purchaseToken: 'play-token-abc',
      packageName: 'com.example.app',
      type: 'product',
    });
    expect(await unfinished.list()).toEqual([]);
  });
});

describe('RecoveryOrchestrator — failure paths', () => {
  it('valid:false → entry retained, failures count incremented, no entitlements update', async () => {
    const acknowledgeSpy = vi.fn();
    const { recoverer, state, events, unfinished } = makeRecovery({
      nativeAdapter: makeNativeAdapter({ acknowledge: acknowledgeSpy }),
      backend: makeBackend({
        verifyApple: async () => ({
          valid: false,
          error: 'TRANSACTION_NOT_FOUND',
          message: 'gone',
        }),
      }),
    });
    await unfinished.add(sampleAppleTx);

    const result = await recoverer.recoverUnfinishedTransactions();

    expect(result).toEqual({ recovered: 0, failures: 1, inspected: 1 });
    expect(acknowledgeSpy).not.toHaveBeenCalled();
    expect(state.entitlements).toEqual([]);
    expect((await unfinished.list()).length).toBe(1);
    expect(events).toHaveLength(0);
  });

  it('verify throws (transport) → entry retained, failures incremented, no throw', async () => {
    const { recoverer, unfinished } = makeRecovery({
      backend: makeBackend({
        verifyApple: async () => {
          throw new IAPError({
            code: IAPErrorCode.BACKEND_TIMEOUT,
            message: 'timeout',
            recoverable: true,
          });
        },
      }),
    });
    await unfinished.add(sampleAppleTx);

    const result = await recoverer.recoverUnfinishedTransactions();

    expect(result).toEqual({ recovered: 0, failures: 1, inspected: 1 });
    expect((await unfinished.list()).length).toBe(1);
  });

  it('acknowledge fails → entry retained for next launch', async () => {
    const acknowledgeSpy = vi.fn(async () => {
      throw new IAPError({
        code: IAPErrorCode.STORE_ERROR,
        message: 'cdv finish failed',
        recoverable: true,
      });
    });
    const { recoverer, state, unfinished, events } = makeRecovery({
      nativeAdapter: makeNativeAdapter({ acknowledge: acknowledgeSpy }),
      backend: makeBackend({
        verifyApple: async () => ({
          valid: true as const,
          entitlements: [
            { key: 'premium', productId: 'premium_monthly', expiresAt: null } as EntitlementBase,
          ],
          transaction: { id: 'tx', productId: 'premium_monthly' },
        }),
      }),
    });
    await unfinished.add(sampleAppleTx);

    const result = await recoverer.recoverUnfinishedTransactions();

    expect(result).toEqual({ recovered: 0, failures: 1, inspected: 1 });
    expect(acknowledgeSpy).toHaveBeenCalledTimes(1);
    // CRITICAL: ack failed → entitlements NOT applied (avoid phantom grants)
    expect(state.entitlements).toEqual([]);
    // Entry retained
    expect((await unfinished.list()).length).toBe(1);
    expect(events).toHaveLength(0);
  });

  it('Google entry missing packageName → fails verify with STORE_ERROR; entry retained', async () => {
    const verifyGoogleSpy = vi.fn();
    const { recoverer, unfinished, storage } = makeRecovery({
      backend: makeBackend({ verifyGoogle: verifyGoogleSpy as never }),
    });
    // Pre-seed via raw storage to bypass UnfinishedTransactionsStore.add()
    // (which doesn't accept a NativeTransaction without packageName).
    await storage.set(
      'unfinished_transactions',
      JSON.stringify([
        {
          platform: 'google',
          productId: 'remove_ads',
          token: 'play-tok',
          productType: 'product',
          recordedAt: new Date().toISOString(),
          // packageName intentionally missing
        },
      ]),
    );

    const result = await recoverer.recoverUnfinishedTransactions();

    expect(result).toEqual({ recovered: 0, failures: 1, inspected: 1 });
    expect(verifyGoogleSpy).not.toHaveBeenCalled();
    // Entry stays for next launch
    expect((await unfinished.list()).length).toBe(1);
  });
});

describe('RecoveryOrchestrator — multi-entry batch', () => {
  it('processes mixed Apple + Google + valid:false entries; recovers 2/3', async () => {
    const acknowledgeSpy = vi.fn(async () => {});
    let verifyAppleCallCount = 0;
    const { recoverer, state, unfinished } = makeRecovery({
      nativeAdapter: makeNativeAdapter({ acknowledge: acknowledgeSpy }),
      backend: makeBackend({
        verifyApple: async () => {
          verifyAppleCallCount += 1;
          if (verifyAppleCallCount === 1) {
            return {
              valid: true as const,
              entitlements: [
                {
                  key: 'premium',
                  productId: 'premium_monthly',
                  expiresAt: null,
                } as EntitlementBase,
              ],
              transaction: { id: 'tx-apple-1', productId: 'premium_monthly' },
            };
          }
          // Second Apple verify is rejected
          return {
            valid: false,
            error: 'STALE_TRANSACTION',
            message: 'old',
          };
        },
        verifyGoogle: async () => ({
          valid: true as const,
          entitlements: [
            { key: 'premium', productId: 'premium_monthly', expiresAt: null },
            { key: 'no_ads', productId: 'remove_ads', expiresAt: null },
          ] as EntitlementBase[],
          transaction: { id: 'tx-google', productId: 'remove_ads' },
        }),
      }),
    });

    await unfinished.add(sampleAppleTx);
    await unfinished.add({
      ...sampleAppleTx,
      productId: 'remove_ads',
      token: '2000000999',
      productType: 'product',
    });
    await unfinished.add(sampleGoogleTx);

    const result = await recoverer.recoverUnfinishedTransactions();

    expect(result).toEqual({ recovered: 2, failures: 1, inspected: 3 });
    expect(acknowledgeSpy).toHaveBeenCalledTimes(2); // first Apple + Google
    // Final entitlements come from the LAST successful verify (Google's).
    expect(state.entitlements.map((e) => e.key).sort()).toEqual(['no_ads', 'premium']);
    // Only the rejected entry remains
    const remaining = await unfinished.list();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.productId).toBe('remove_ads'); // the second Apple entry
    expect(remaining[0]?.platform).toBe('apple');
  });

  it('all entries fail → no entitlement update, no events', async () => {
    const { recoverer, state, events, unfinished } = makeRecovery({
      backend: makeBackend({
        verifyApple: async () => ({
          valid: false,
          error: 'TRANSACTION_NOT_FOUND',
        }),
      }),
    });
    await unfinished.add(sampleAppleTx);
    await unfinished.add({ ...sampleAppleTx, token: '2000000999' });

    const result = await recoverer.recoverUnfinishedTransactions();

    expect(result).toEqual({ recovered: 0, failures: 2, inspected: 2 });
    expect(state.entitlements).toEqual([]);
    expect(events).toHaveLength(0);
  });
});

describe('RecoveryOrchestrator — defensive paths', () => {
  it('cache.save failure leaves in-memory state updated', async () => {
    const failingStorage = {
      async get() {
        return null;
      },
      async set(): Promise<void> {
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
    await unfinished.add(sampleAppleTx);

    const recoverer = new RecoveryOrchestrator<EntitlementBase>({
      nativeAdapter: makeNativeAdapter(),
      backend: makeBackend({
        verifyApple: async () => ({
          valid: true as const,
          entitlements: [
            { key: 'premium', productId: 'premium_monthly', expiresAt: null },
          ] as EntitlementBase[],
          transaction: { id: 'tx', productId: 'premium_monthly' },
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

    const result = await recoverer.recoverUnfinishedTransactions();
    expect(result.recovered).toBe(1);
    expect(state.entitlements).toHaveLength(1);
    // cache.save threw before returning a timestamp
    expect(state.cachedAt).toBeNull();
  });
});
