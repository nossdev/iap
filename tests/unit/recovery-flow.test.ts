import { describe, expect, it, vi } from 'vitest';
import type { BackendAdapter } from '../../src/adapters/backend/types.js';
import type { NativeAdapter } from '../../src/adapters/native/types.js';
import { MemoryAdapter } from '../../src/adapters/storage/memory-adapter.js';
import { EntitlementCache } from '../../src/core/entitlement-cache.js';
import {
  DEFAULT_PERMANENT_ERROR_CODES,
  RecoveryOrchestrator,
} from '../../src/core/recovery-flow.js';
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
  permanentErrorCodes?: ReadonlySet<string>;
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
  emitter.on('recovery-dropped-permanent', (payload) =>
    events.push({ name: 'recovery-dropped-permanent', payload }),
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
    maxBatch: 50,
    permanentErrorCodes: opts.permanentErrorCodes ?? new Set(DEFAULT_PERMANENT_ERROR_CODES),
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

    expect(result).toEqual({ recovered: 0, failures: 0, droppedPermanent: 0, inspected: 0 });
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

    expect(result).toEqual({ recovered: 1, failures: 0, droppedPermanent: 0, inspected: 1 });
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
  it('valid:false (transient code) → entry retained, failures count incremented, no entitlements update', async () => {
    const acknowledgeSpy = vi.fn();
    const { recoverer, state, events, unfinished } = makeRecovery({
      nativeAdapter: makeNativeAdapter({ acknowledge: acknowledgeSpy }),
      backend: makeBackend({
        verifyApple: async () => ({
          valid: false,
          // Non-permanent code: not in DEFAULT_PERMANENT_ERROR_CODES, so the
          // entry should be retained for retry on next launch.
          error: 'STALE_TRANSACTION',
          message: 'temporary',
        }),
      }),
    });
    await unfinished.add(sampleAppleTx);

    const result = await recoverer.recoverUnfinishedTransactions();

    expect(result).toEqual({ recovered: 0, failures: 1, droppedPermanent: 0, inspected: 1 });
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

    expect(result).toEqual({ recovered: 0, failures: 1, droppedPermanent: 0, inspected: 1 });
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

    expect(result).toEqual({ recovered: 0, failures: 1, droppedPermanent: 0, inspected: 1 });
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

    expect(result).toEqual({ recovered: 0, failures: 1, droppedPermanent: 0, inspected: 1 });
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

    expect(result).toEqual({ recovered: 2, failures: 1, droppedPermanent: 0, inspected: 3 });
    expect(acknowledgeSpy).toHaveBeenCalledTimes(2); // first Apple + Google
    // Final entitlements come from the LAST successful verify (Google's).
    expect(state.entitlements.map((e) => e.key).sort()).toEqual(['no_ads', 'premium']);
    // Only the rejected entry remains
    const remaining = await unfinished.list();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.productId).toBe('remove_ads'); // the second Apple entry
    expect(remaining[0]?.platform).toBe('apple');
  });

  it('all entries fail with transient code → no entitlement update, no events', async () => {
    const { recoverer, state, events, unfinished } = makeRecovery({
      backend: makeBackend({
        verifyApple: async () => ({
          valid: false,
          // Non-permanent code so entries are retained, not dropped.
          error: 'STALE_TRANSACTION',
        }),
      }),
    });
    await unfinished.add(sampleAppleTx);
    await unfinished.add({ ...sampleAppleTx, token: '2000000999' });

    const result = await recoverer.recoverUnfinishedTransactions();

    expect(result).toEqual({ recovered: 0, failures: 2, droppedPermanent: 0, inspected: 2 });
    expect(state.entitlements).toEqual([]);
    expect(events).toHaveLength(0);
  });
});

describe('RecoveryOrchestrator — parallelism (L1)', () => {
  it('verifies entries in parallel — concurrency observable via shared timing', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const verifyApple = async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 10));
      inFlight -= 1;
      return {
        valid: true as const,
        entitlements: [
          { key: 'premium', productId: 'premium_monthly', expiresAt: null } as EntitlementBase,
        ],
        transaction: { id: 'tx', productId: 'premium_monthly' },
      };
    };
    const acknowledgeSpy = vi.fn(async () => {});
    const { recoverer, unfinished, state } = makeRecovery({
      nativeAdapter: makeNativeAdapter({ acknowledge: acknowledgeSpy }),
      backend: makeBackend({ verifyApple }),
    });
    await unfinished.add({ ...sampleAppleTx, token: 'tok-1' });
    await unfinished.add({ ...sampleAppleTx, token: 'tok-2' });
    await unfinished.add({ ...sampleAppleTx, token: 'tok-3' });

    const result = await recoverer.recoverUnfinishedTransactions();

    expect(result.recovered).toBe(3);
    expect(acknowledgeSpy).toHaveBeenCalledTimes(3);
    expect(state.entitlements).toHaveLength(1);
    // Parallel execution: at least 2 verifies should overlap. (Sequential
    // execution would have maxInFlight === 1 throughout.)
    expect(maxInFlight).toBeGreaterThanOrEqual(2);
  });
});

describe('RecoveryOrchestrator — batch cap (L2)', () => {
  it('inspects at most maxBatch entries; remainder stays for next launch', async () => {
    const verifySpy = vi.fn(async () => ({
      valid: true as const,
      entitlements: [
        { key: 'premium', productId: 'premium_monthly', expiresAt: null } as EntitlementBase,
      ],
      transaction: { id: 'tx', productId: 'premium_monthly' },
    }));
    const { recoverer, unfinished } = makeRecovery({
      backend: makeBackend({ verifyApple: verifySpy }),
    });
    // Pre-seed 100 entries
    for (let i = 0; i < 100; i++) {
      await unfinished.add({ ...sampleAppleTx, token: `tok-${i.toString().padStart(3, '0')}` });
    }

    const result = await recoverer.recoverUnfinishedTransactions();

    // makeRecovery defaults maxBatch to 50
    expect(result.inspected).toBe(50);
    expect(result.recovered).toBe(50);
    expect(verifySpy).toHaveBeenCalledTimes(50);
    // 50 entries remain in the unfinished list for next launch
    expect((await unfinished.list()).length).toBe(50);
  });

  it('does not log the cap warning when entries are within the cap', async () => {
    const verifySpy = vi.fn(async () => ({
      valid: true as const,
      entitlements: [],
      transaction: { id: 'tx', productId: 'premium_monthly' },
    }));
    const infoSpy = vi.spyOn(silentLogger, 'info');
    const { recoverer, unfinished } = makeRecovery({
      backend: makeBackend({ verifyApple: verifySpy }),
    });
    await unfinished.add(sampleAppleTx);

    await recoverer.recoverUnfinishedTransactions();

    // No "X/Y" cap warning since 1 < 50
    const capCalls = infoSpy.mock.calls.filter(
      (c) => typeof c[0] === 'string' && c[0].includes('subsequent launches'),
    );
    expect(capCalls).toHaveLength(0);
    infoSpy.mockRestore();
  });
});

describe('RecoveryOrchestrator — emit dedup (L3)', () => {
  it('does NOT emit entitlements-changed when content is unchanged', async () => {
    const initial: EntitlementBase[] = [
      { key: 'premium', productId: 'premium_monthly', expiresAt: null },
    ];
    const verifyApple = async () => ({
      valid: true as const,
      entitlements: initial,
      transaction: { id: 'tx', productId: 'premium_monthly' },
    });
    const { recoverer, events, unfinished } = makeRecovery({
      backend: makeBackend({ verifyApple }),
      initialEntitlements: initial,
    });
    await unfinished.add(sampleAppleTx);

    const result = await recoverer.recoverUnfinishedTransactions();
    expect(result.recovered).toBe(1);
    // No entitlements-changed because content is identical
    expect(events.filter((e) => e.name === 'entitlements-changed')).toHaveLength(0);
  });

  it('emits entitlements-changed when content actually changed', async () => {
    const initial: EntitlementBase[] = [
      { key: 'premium', productId: 'premium_monthly', expiresAt: '2026-01-01T00:00:00Z' },
    ];
    const verifyApple = async () => ({
      valid: true as const,
      entitlements: [
        // Same key but new expiresAt → content changed
        { key: 'premium', productId: 'premium_monthly', expiresAt: '2026-12-01T00:00:00Z' },
      ] as EntitlementBase[],
      transaction: { id: 'tx', productId: 'premium_monthly' },
    });
    const { recoverer, events, unfinished } = makeRecovery({
      backend: makeBackend({ verifyApple }),
      initialEntitlements: initial,
    });
    await unfinished.add(sampleAppleTx);

    await recoverer.recoverUnfinishedTransactions();
    expect(events.filter((e) => e.name === 'entitlements-changed')).toHaveLength(1);
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
      maxBatch: 50,
      permanentErrorCodes: new Set(DEFAULT_PERMANENT_ERROR_CODES),
    });

    const result = await recoverer.recoverUnfinishedTransactions();
    expect(result.recovered).toBe(1);
    expect(state.entitlements).toHaveLength(1);
    // cache.save threw before returning a timestamp
    expect(state.cachedAt).toBeNull();
  });
});

describe('RecoveryOrchestrator — permanent failure classification', () => {
  it('valid:false with TRANSACTION_NOT_FOUND → entry dropped, ack called, event emitted, droppedPermanent counted', async () => {
    const acknowledgeSpy = vi.fn(async () => {});
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

    expect(result).toEqual({ recovered: 0, failures: 0, droppedPermanent: 1, inspected: 1 });
    expect(acknowledgeSpy).toHaveBeenCalledTimes(1);
    expect(state.entitlements).toEqual([]);
    expect(await unfinished.list()).toEqual([]);
    expect(events).toEqual([
      {
        name: 'recovery-dropped-permanent',
        payload: {
          productId: 'premium_monthly',
          token: '2000000123456789',
          error: 'TRANSACTION_NOT_FOUND',
          message: 'gone',
        },
      },
    ]);
  });

  it('valid:false with PRODUCT_MISMATCH → entry dropped (second default code, no message)', async () => {
    const { recoverer, events, unfinished } = makeRecovery({
      backend: makeBackend({
        verifyApple: async () => ({
          valid: false,
          error: 'PRODUCT_MISMATCH',
        }),
      }),
    });
    await unfinished.add(sampleAppleTx);

    const result = await recoverer.recoverUnfinishedTransactions();

    expect(result.droppedPermanent).toBe(1);
    expect(await unfinished.list()).toEqual([]);
    // Full event-shape assertion catches accidental extra-field regressions.
    // Note the absence of `message` — the spread is conditional on the
    // backend supplying one, so no `message: undefined` leaks into the payload.
    expect(events).toEqual([
      {
        name: 'recovery-dropped-permanent',
        payload: {
          productId: 'premium_monthly',
          token: '2000000123456789',
          error: 'PRODUCT_MISMATCH',
        },
      },
    ]);
  });

  it('custom permanentErrorCodes config drops the consumer-supplied code', async () => {
    const { recoverer, unfinished } = makeRecovery({
      permanentErrorCodes: new Set(['MY_CUSTOM_PERMANENT_CODE']),
      backend: makeBackend({
        verifyApple: async () => ({
          valid: false,
          error: 'MY_CUSTOM_PERMANENT_CODE',
        }),
      }),
    });
    await unfinished.add(sampleAppleTx);

    const result = await recoverer.recoverUnfinishedTransactions();

    expect(result.droppedPermanent).toBe(1);
    expect(await unfinished.list()).toEqual([]);
  });

  it('custom permanentErrorCodes config does NOT drop a default code when overridden', async () => {
    // Override REPLACES the defaults. TRANSACTION_NOT_FOUND should now be
    // treated as transient and retained.
    const { recoverer, unfinished } = makeRecovery({
      permanentErrorCodes: new Set(['ONLY_THIS_ONE']),
      backend: makeBackend({
        verifyApple: async () => ({
          valid: false,
          error: 'TRANSACTION_NOT_FOUND',
        }),
      }),
    });
    await unfinished.add(sampleAppleTx);

    const result = await recoverer.recoverUnfinishedTransactions();

    expect(result).toEqual({ recovered: 0, failures: 1, droppedPermanent: 0, inspected: 1 });
    expect((await unfinished.list()).length).toBe(1);
  });

  it('empty permanentErrorCodes config → all valid:false retained (legacy behavior)', async () => {
    const { recoverer, unfinished } = makeRecovery({
      permanentErrorCodes: new Set(),
      backend: makeBackend({
        verifyApple: async () => ({
          valid: false,
          error: 'TRANSACTION_NOT_FOUND',
        }),
      }),
    });
    await unfinished.add(sampleAppleTx);

    const result = await recoverer.recoverUnfinishedTransactions();

    expect(result).toEqual({ recovered: 0, failures: 1, droppedPermanent: 0, inspected: 1 });
    expect((await unfinished.list()).length).toBe(1);
  });

  it('acknowledge throws during permanent drop → entry STILL removed, warn logged', async () => {
    const acknowledgeSpy = vi.fn(async () => {
      throw new IAPError({
        code: IAPErrorCode.STORE_ERROR,
        message: 'cdv finish failed',
        recoverable: true,
      });
    });
    const { recoverer, events, unfinished } = makeRecovery({
      nativeAdapter: makeNativeAdapter({ acknowledge: acknowledgeSpy }),
      backend: makeBackend({
        verifyApple: async () => ({
          valid: false,
          error: 'TRANSACTION_NOT_FOUND',
        }),
      }),
    });
    await unfinished.add(sampleAppleTx);

    const result = await recoverer.recoverUnfinishedTransactions();

    // Best-effort ack: failure here does NOT block the drop. Entry removed
    // and `recovery-dropped-permanent` still emitted — different from the
    // success path where ack failure prevents removal.
    expect(result.droppedPermanent).toBe(1);
    expect(acknowledgeSpy).toHaveBeenCalledTimes(1);
    expect(await unfinished.list()).toEqual([]);
    expect(events).toHaveLength(1);
    expect(events[0]?.name).toBe('recovery-dropped-permanent');
  });

  it('unfinished.remove throws during permanent drop → still counted as dropped + event still emits + warn logged on next launch dedupe', async () => {
    // Storage that allows the initial seed but throws on subsequent set()
    // calls so `unfinished.remove()` (which calls persist → storage.set)
    // fails. `add` writes via the same path; we sidestep that by pre-seeding
    // raw and toggling failure mode after.
    let allowSet = true;
    const memStorage = new MemoryAdapter('test');
    const wrappedStorage = {
      async get(key: string): Promise<string | null> {
        return memStorage.get(key);
      },
      async set(key: string, value: string): Promise<void> {
        if (!allowSet) throw new Error('disk full');
        return memStorage.set(key, value);
      },
      async remove(key: string): Promise<void> {
        return memStorage.remove(key);
      },
      async clear(): Promise<void> {
        return memStorage.clear();
      },
    };
    const cache = new EntitlementCache<EntitlementBase>(wrappedStorage, silentLogger);
    const unfinished = new UnfinishedTransactionsStore(wrappedStorage, silentLogger);
    await unfinished.add(sampleAppleTx);
    allowSet = false; // any subsequent set() throws — including remove()'s persist

    const emitter = new TypedEventEmitter<EntitlementBase>();
    const events: Array<{ name: string; payload: unknown }> = [];
    emitter.on('recovery-dropped-permanent', (payload) =>
      events.push({ name: 'recovery-dropped-permanent', payload }),
    );

    const recoverer = new RecoveryOrchestrator<EntitlementBase>({
      nativeAdapter: makeNativeAdapter(),
      backend: makeBackend({
        verifyApple: async () => ({ valid: false, error: 'TRANSACTION_NOT_FOUND' }),
      }),
      cache,
      unfinished,
      emitter,
      logger: silentLogger,
      getCurrentEntitlements: () => [],
      setEntitlements: () => {},
      setCachePersisted: () => {},
      maxBatch: 50,
      permanentErrorCodes: new Set(DEFAULT_PERMANENT_ERROR_CODES),
    });

    const result = await recoverer.recoverUnfinishedTransactions();

    // remove() failed but the drop still completes from the orchestrator's
    // perspective: counted as dropped, event still emitted. The entry
    // remains on disk — next launch will re-classify and dedupe.
    expect(result.droppedPermanent).toBe(1);
    expect(events).toHaveLength(1);
    expect(events[0]?.name).toBe('recovery-dropped-permanent');
    // Re-enable set so we can verify the entry is still in storage.
    allowSet = true;
    expect((await unfinished.list()).length).toBe(1);
  });

  it('mixed batch (1 recovered + 1 transient + 1 permanent) → correct counts', async () => {
    let appleVerifyCount = 0;
    const acknowledgeSpy = vi.fn(async () => {});
    const { recoverer, unfinished } = makeRecovery({
      nativeAdapter: makeNativeAdapter({ acknowledge: acknowledgeSpy }),
      backend: makeBackend({
        verifyApple: async () => {
          appleVerifyCount += 1;
          if (appleVerifyCount === 1) {
            return {
              valid: true as const,
              entitlements: [
                { key: 'premium', productId: 'premium_monthly', expiresAt: null },
              ] as EntitlementBase[],
              transaction: { id: 'tx-1', productId: 'premium_monthly' },
            };
          }
          if (appleVerifyCount === 2) {
            return { valid: false, error: 'STALE_TRANSACTION' };
          }
          return { valid: false, error: 'TRANSACTION_NOT_FOUND' };
        },
      }),
    });

    await unfinished.add(sampleAppleTx);
    await unfinished.add({ ...sampleAppleTx, token: '2000000999' });
    await unfinished.add({ ...sampleAppleTx, token: '2000000888' });

    const result = await recoverer.recoverUnfinishedTransactions();

    expect(result).toEqual({ recovered: 1, failures: 1, droppedPermanent: 1, inspected: 3 });
    // Ack called twice: once for the recovered entry, once for the dropped
    // permanent entry (best-effort cleanup of StoreKit's queue).
    expect(acknowledgeSpy).toHaveBeenCalledTimes(2);
    // Only the transient-failure entry remains for next-launch retry.
    const remaining = await unfinished.list();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.token).toBe('2000000999');
  });
});
