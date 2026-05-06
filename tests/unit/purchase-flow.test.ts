import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BackendAdapter } from '../../src/adapters/backend/types.js';
import type { NativeAdapter, NativePurchaseOptions } from '../../src/adapters/native/types.js';
import { MemoryAdapter } from '../../src/adapters/storage/memory-adapter.js';
import { EntitlementCache } from '../../src/core/entitlement-cache.js';
import { PurchaseOrchestrator } from '../../src/core/purchase-flow.js';
import { UnfinishedTransactionsStore } from '../../src/core/unfinished-transactions.js';
import { TypedEventEmitter } from '../../src/events/emitter.js';
import { IAPError, IAPErrorCode } from '../../src/lib/errors.js';
import type { EntitlementBase } from '../../src/types/entitlement.js';
import type { ConfiguredProduct } from '../../src/types/product.js';
import type { NativeTransaction } from '../../src/types/transaction.js';
import { makeSilentLogger } from '../mocks/http-helpers.js';
import {
  makeAppleTransaction,
  makeBackend,
  makeGoogleTransaction,
  makeNativeAdapter,
} from '../mocks/orchestrator-builders.js';

const silentLogger = makeSilentLogger();

const products: ConfiguredProduct[] = [
  { id: 'premium_monthly', type: 'subscription', androidPlanId: 'monthly' },
  { id: 'remove_ads', type: 'product' },
  { id: 'coin_pack_100', type: 'consumable' },
];

function makeOrchestrator<T extends EntitlementBase = EntitlementBase>(opts: {
  nativeAdapter?: NativeAdapter;
  backend?: BackendAdapter<T>;
  getAuthHeaders?: () => Promise<Record<string, string>>;
}): {
  orchestrator: PurchaseOrchestrator<T>;
  emitter: TypedEventEmitter<T>;
  cache: EntitlementCache<T>;
  unfinished: UnfinishedTransactionsStore;
  storage: MemoryAdapter;
  events: Array<{ name: string; payload: unknown }>;
  state: { entitlements: T[]; cachedAt: number | null };
} {
  const storage = new MemoryAdapter('test');
  const cache = new EntitlementCache<T>(storage, silentLogger);
  const unfinished = new UnfinishedTransactionsStore(storage, silentLogger);
  const emitter = new TypedEventEmitter<T>();
  const state: { entitlements: T[]; cachedAt: number | null } = {
    entitlements: [],
    cachedAt: null,
  };

  const events: Array<{ name: string; payload: unknown }> = [];
  for (const event of [
    'purchase-started',
    'purchase-success',
    'purchase-cancelled',
    'purchase-pending',
    'purchase-failed',
    'verification-failed',
    'entitlements-changed',
  ] as const) {
    emitter.on(event, (payload) => {
      events.push({ name: event, payload });
    });
  }

  const orchestrator = new PurchaseOrchestrator<T>({
    // Default purchaseProduct returns an Apple transaction so tests that do
    // not override nativeAdapter still get a plausible native result.
    nativeAdapter:
      opts.nativeAdapter ??
      makeNativeAdapter({ purchaseProduct: async () => makeAppleTransaction() }),
    backend: opts.backend ?? makeBackend<T>(),
    cache,
    unfinished,
    emitter,
    logger: silentLogger,
    products,
    getCurrentEntitlements: () => state.entitlements,
    setEntitlements: (next) => {
      state.entitlements = next.map((item) => Object.freeze({ ...item }) as T);
    },
    setCachePersisted: (cachedAt) => {
      state.cachedAt = cachedAt;
    },
    getAuthHeaders: opts.getAuthHeaders ?? (async () => ({})),
  });

  return { orchestrator, emitter, cache, unfinished, storage, events, state };
}

describe('PurchaseOrchestrator — happy path', () => {
  it('success: native ok → backend valid → acknowledge → cache + entitlements + events', async () => {
    const acknowledgeSpy = vi.fn(async () => {});
    const verifyAppleSpy = vi.fn(async () => ({
      valid: true as const,
      entitlements: [
        {
          key: 'premium',
          productId: 'premium_monthly',
          expiresAt: '2026-12-01T00:00:00Z',
        } as EntitlementBase,
      ],
      transaction: { id: 'apple-tx-1', productId: 'premium_monthly' },
    }));

    const { orchestrator, events, unfinished, storage, state } = makeOrchestrator({
      nativeAdapter: makeNativeAdapter({
        purchaseProduct: async () => makeAppleTransaction('premium_monthly'),
        acknowledge: acknowledgeSpy,
      }),
      backend: makeBackend({ verifyApple: verifyAppleSpy }),
    });

    const result = await orchestrator.purchase({ productId: 'premium_monthly' });

    expect(result.status).toBe('success');
    if (result.status === 'success') {
      expect(result.productId).toBe('premium_monthly');
      expect(result.transaction.id).toBe('apple-tx-1');
      expect(result.entitlements).toHaveLength(1);
    }
    expect(state.entitlements[0]?.key).toBe('premium');
    expect(acknowledgeSpy).toHaveBeenCalledTimes(1);
    expect(verifyAppleSpy).toHaveBeenCalledTimes(1);

    // unfinished entry was added then removed
    expect(await unfinished.list()).toEqual([]);
    // entitlements persisted to cache (key is namespace-relative; MemoryAdapter prepends 'test.')
    expect(await storage.get('entitlements')).toBeTruthy();

    // event sequence
    const names = events.map((e) => e.name);
    expect(names).toEqual(['purchase-started', 'purchase-success', 'entitlements-changed']);
  });

  it('routes Google transactions to verifyGoogle with the expected body shape', async () => {
    const verifyGoogleSpy = vi.fn(async () => ({
      valid: true as const,
      entitlements: [],
      transaction: { id: 'google-tx-1', productId: 'premium_monthly' },
    }));
    const { orchestrator } = makeOrchestrator({
      nativeAdapter: makeNativeAdapter({
        purchaseProduct: async () => makeGoogleTransaction('premium_monthly'),
      }),
      backend: makeBackend({ verifyGoogle: verifyGoogleSpy }),
    });

    await orchestrator.purchase({ productId: 'premium_monthly' });

    expect(verifyGoogleSpy).toHaveBeenCalledTimes(1);
    expect(verifyGoogleSpy).toHaveBeenCalledWith({
      productId: 'premium_monthly',
      purchaseToken: 'play-token-premium_monthly',
      packageName: 'com.example.app',
      type: 'subscription',
    });
  });

  it('routes Apple transactions to verifyApple with the expected body shape', async () => {
    const verifyAppleSpy = vi.fn(async () => ({
      valid: true as const,
      entitlements: [],
      transaction: { id: 'apple-tx-2', productId: 'remove_ads' },
    }));
    const appleNonSubTx: NativeTransaction = {
      platform: 'apple',
      productId: 'remove_ads',
      token: '2000000444444444',
      productType: 'product',
    };
    const { orchestrator } = makeOrchestrator({
      nativeAdapter: makeNativeAdapter({
        purchaseProduct: async () => appleNonSubTx,
      }),
      backend: makeBackend({ verifyApple: verifyAppleSpy }),
    });

    await orchestrator.purchase({ productId: 'remove_ads' });

    expect(verifyAppleSpy).toHaveBeenCalledWith({
      productId: 'remove_ads',
      transactionId: '2000000444444444',
      type: 'product',
    });
  });
});

describe('PurchaseOrchestrator — failure paths', () => {
  it('cancelled: native USER_CANCELLED → no backend call, no acknowledge', async () => {
    const verifySpy = vi.fn();
    const acknowledgeSpy = vi.fn();
    const { orchestrator, events } = makeOrchestrator({
      nativeAdapter: makeNativeAdapter({
        purchaseProduct: async () => {
          throw new IAPError({
            code: IAPErrorCode.USER_CANCELLED,
            message: 'cancelled',
          });
        },
        acknowledge: acknowledgeSpy,
      }),
      backend: makeBackend({ verifyApple: verifySpy as never }),
    });

    const result = await orchestrator.purchase({ productId: 'premium_monthly' });
    expect(result.status).toBe('cancelled');
    expect(verifySpy).not.toHaveBeenCalled();
    expect(acknowledgeSpy).not.toHaveBeenCalled();
    expect(events.map((e) => e.name)).toEqual(['purchase-started', 'purchase-cancelled']);
  });

  it('failed: native STORE_ERROR → no backend call, no acknowledge', async () => {
    const verifySpy = vi.fn();
    const { orchestrator, events } = makeOrchestrator({
      nativeAdapter: makeNativeAdapter({
        purchaseProduct: async () => {
          throw new IAPError({
            code: IAPErrorCode.STORE_ERROR,
            message: 'sandbox unavailable',
          });
        },
      }),
      backend: makeBackend({ verifyApple: verifySpy as never }),
    });

    const result = await orchestrator.purchase({ productId: 'premium_monthly' });
    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error.code).toBe(IAPErrorCode.STORE_ERROR);
    }
    expect(verifySpy).not.toHaveBeenCalled();
    expect(events.map((e) => e.name)).toEqual(['purchase-started', 'purchase-failed']);
  });

  it('pending: native PURCHASE_PENDING → emits purchase-pending', async () => {
    const { orchestrator, events } = makeOrchestrator({
      nativeAdapter: makeNativeAdapter({
        purchaseProduct: async () => {
          throw new IAPError({
            code: IAPErrorCode.PURCHASE_PENDING,
            message: 'awaiting bank',
          });
        },
      }),
    });

    const result = await orchestrator.purchase({ productId: 'premium_monthly' });
    expect(result.status).toBe('pending');
    expect(events.map((e) => e.name)).toEqual(['purchase-started', 'purchase-pending']);
  });

  it('verification_failed: backend valid:false → no acknowledge, entry persisted', async () => {
    const acknowledgeSpy = vi.fn();
    const { orchestrator, events, unfinished, state } = makeOrchestrator({
      nativeAdapter: makeNativeAdapter({
        purchaseProduct: async () => makeAppleTransaction('premium_monthly'),
        acknowledge: acknowledgeSpy,
      }),
      backend: makeBackend({
        verifyApple: async () => ({
          valid: false,
          error: 'TRANSACTION_NOT_FOUND',
          message: 'Apple says no',
        }),
      }),
    });

    const result = await orchestrator.purchase({ productId: 'premium_monthly' });
    expect(result.status).toBe('verification_failed');
    if (result.status === 'verification_failed') {
      expect(result.error.code).toBe(IAPErrorCode.VERIFICATION_REJECTED);
      // H3: message preserves both human-readable and stable machine code
      expect(result.error.message).toContain('Apple says no');
      expect(result.error.message).toContain('TRANSACTION_NOT_FOUND');
    }
    expect(acknowledgeSpy).not.toHaveBeenCalled();
    // CRITICAL: entitlements must NOT update on a backend rejection
    expect(state.entitlements).toEqual([]);
    // The unfinished entry persists for retry on next refresh.
    const stillUnfinished = await unfinished.list();
    expect(stillUnfinished).toHaveLength(1);
    expect(stillUnfinished[0]?.token).toBe('apple-token-premium_monthly');
    expect(events.map((e) => e.name)).toEqual(['purchase-started', 'verification-failed']);
  });

  it('verification_failed: backend throws (network) → no acknowledge, entry persisted', async () => {
    const acknowledgeSpy = vi.fn();
    const { orchestrator, events, unfinished, state } = makeOrchestrator({
      nativeAdapter: makeNativeAdapter({
        purchaseProduct: async () => makeAppleTransaction('premium_monthly'),
        acknowledge: acknowledgeSpy,
      }),
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

    const result = await orchestrator.purchase({ productId: 'premium_monthly' });
    expect(result.status).toBe('verification_failed');
    expect(acknowledgeSpy).not.toHaveBeenCalled();
    expect(state.entitlements).toEqual([]);
    expect((await unfinished.list()).length).toBe(1);
    expect(events.map((e) => e.name)).toEqual(['purchase-started', 'verification-failed']);
  });
});

describe('PurchaseOrchestrator — concurrency', () => {
  it('rejects a second purchase of the same product while first is in flight', async () => {
    let resolveFirst!: () => void;
    const firstResolves = new Promise<void>((r) => {
      resolveFirst = r;
    });

    const { orchestrator } = makeOrchestrator({
      nativeAdapter: makeNativeAdapter({
        purchaseProduct: async () => {
          await firstResolves;
          return makeAppleTransaction('premium_monthly');
        },
      }),
    });

    const first = orchestrator.purchase({ productId: 'premium_monthly' });
    // Yield once so the first call has entered runFlow and registered the lock.
    await Promise.resolve();

    try {
      await orchestrator.purchase({ productId: 'premium_monthly' });
      throw new Error('should have rejected');
    } catch (error) {
      expect(error).toBeInstanceOf(IAPError);
      expect((error as IAPError).code).toBe(IAPErrorCode.ALREADY_IN_PROGRESS);
    }

    resolveFirst();
    await first; // let the first call complete
  });

  it('allows a second purchase of a DIFFERENT product concurrently', async () => {
    let resolveFirst!: () => void;
    const firstResolves = new Promise<void>((r) => {
      resolveFirst = r;
    });

    const { orchestrator } = makeOrchestrator({
      nativeAdapter: makeNativeAdapter({
        purchaseProduct: async ({ productId }) => {
          if (productId === 'premium_monthly') {
            await firstResolves;
          }
          return {
            platform: 'apple',
            productId,
            token: `tok-${productId}`,
            productType: 'product',
          } as NativeTransaction;
        },
      }),
    });

    const first = orchestrator.purchase({ productId: 'premium_monthly' });
    await Promise.resolve();
    const second = orchestrator.purchase({ productId: 'remove_ads' });
    // second should resolve immediately without waiting for first
    const secondResult = await second;
    expect(secondResult.status).toBe('success');

    resolveFirst();
    await first;
  });
});

describe('PurchaseOrchestrator — guards', () => {
  it('throws PRODUCT_NOT_FOUND for unconfigured productId', async () => {
    const { orchestrator } = makeOrchestrator({});
    try {
      await orchestrator.purchase({ productId: 'not_a_real_product' });
      throw new Error('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(IAPError);
      expect((error as IAPError).code).toBe(IAPErrorCode.PRODUCT_NOT_FOUND);
    }
  });

  it('rejects Google transaction with no packageName before calling backend', async () => {
    const verifyGoogleSpy = vi.fn();
    const { orchestrator, events } = makeOrchestrator({
      nativeAdapter: makeNativeAdapter({
        purchaseProduct: async () =>
          ({
            platform: 'google',
            productId: 'premium_monthly',
            token: 'play-tok',
            // packageName intentionally missing
            productType: 'subscription',
          }) as NativeTransaction,
      }),
      backend: makeBackend({ verifyGoogle: verifyGoogleSpy as never }),
    });

    const result = await orchestrator.purchase({ productId: 'premium_monthly' });
    expect(result.status).toBe('verification_failed');
    expect(verifyGoogleSpy).not.toHaveBeenCalled();
    expect(events.map((e) => e.name)).toEqual(['purchase-started', 'verification-failed']);
  });
});

describe('PurchaseOrchestrator — restartability', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let consoleErrorSpy: { mockRestore: () => void };
  beforeEach(() => {
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  it('lock is released even if runFlow throws unexpectedly', async () => {
    let throwOnce = true;
    const { orchestrator } = makeOrchestrator({
      nativeAdapter: makeNativeAdapter({
        purchaseProduct: async () => {
          if (throwOnce) {
            throwOnce = false;
            throw new Error('unexpected non-IAPError');
          }
          return makeAppleTransaction('premium_monthly');
        },
      }),
    });

    // First call: throws unexpectedly
    const first = await orchestrator.purchase({ productId: 'premium_monthly' });
    expect(first.status).toBe('failed');

    // Second call must succeed (lock released).
    const second = await orchestrator.purchase({ productId: 'premium_monthly' });
    expect(second.status).toBe('success');
  });
});

describe('PurchaseOrchestrator — defensive paths post-backend-success', () => {
  // PLAN.md §2.1 says: once the backend confirms valid:true, the user is
  // entitled. Subsequent failures (acknowledge / cache.save / unfinished.remove)
  // are best-effort — we still report success and update in-memory state.
  // These tests assert that contract.

  it('H2: acknowledge() failure post-success — result is still success, state still updated', async () => {
    const acknowledgeSpy = vi.fn(async () => {
      throw new IAPError({
        code: IAPErrorCode.STORE_ERROR,
        message: 'cdv finish() failed',
        recoverable: true,
      });
    });
    const { orchestrator, events, state } = makeOrchestrator({
      nativeAdapter: makeNativeAdapter({
        purchaseProduct: async () => makeAppleTransaction('premium_monthly'),
        acknowledge: acknowledgeSpy,
      }),
      backend: makeBackend({
        verifyApple: async () => ({
          valid: true as const,
          entitlements: [
            { key: 'premium', productId: 'premium_monthly', expiresAt: null } as EntitlementBase,
          ],
          transaction: { id: 'tx-ack-fails', productId: 'premium_monthly' },
        }),
      }),
    });

    const result = await orchestrator.purchase({ productId: 'premium_monthly' });
    expect(result.status).toBe('success');
    expect(state.entitlements).toHaveLength(1);
    expect(state.entitlements[0]?.key).toBe('premium');
    expect(acknowledgeSpy).toHaveBeenCalledTimes(1);
    // Both success events fire even though ack threw.
    expect(events.map((e) => e.name)).toEqual([
      'purchase-started',
      'purchase-success',
      'entitlements-changed',
    ]);
  });

  it('H3: cache.save() failure post-success — result is still success, state still updated', async () => {
    // Inject a failing storage at the cache layer.
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
    const failingCache = new EntitlementCache<EntitlementBase>(failingStorage, silentLogger);
    const memStore = new MemoryAdapter('test');
    const unfinished = new UnfinishedTransactionsStore(memStore, silentLogger);
    const emitter = new TypedEventEmitter<EntitlementBase>();
    const state: { entitlements: EntitlementBase[]; cachedAt: number | null } = {
      entitlements: [],
      cachedAt: null,
    };
    const events: string[] = [];
    for (const name of ['purchase-success', 'entitlements-changed'] as const) {
      emitter.on(name, () => events.push(name));
    }

    const orchestrator = new PurchaseOrchestrator<EntitlementBase>({
      nativeAdapter: makeNativeAdapter({
        purchaseProduct: async () => makeAppleTransaction('premium_monthly'),
      }),
      backend: makeBackend({
        verifyApple: async () => ({
          valid: true as const,
          entitlements: [
            { key: 'premium', productId: 'premium_monthly', expiresAt: null },
          ] as EntitlementBase[],
          transaction: { id: 'tx-save-fails', productId: 'premium_monthly' },
        }),
      }),
      cache: failingCache,
      unfinished,
      emitter,
      logger: silentLogger,
      products,
      getCurrentEntitlements: () => state.entitlements,
      setEntitlements: (next) => {
        state.entitlements = next.map((item) => Object.freeze({ ...item }));
      },
      setCachePersisted: (ts) => {
        state.cachedAt = ts;
      },
      getAuthHeaders: async () => ({}),
    });

    const result = await orchestrator.purchase({ productId: 'premium_monthly' });
    expect(result.status).toBe('success');
    // In-memory state updated even though save threw.
    expect(state.entitlements).toHaveLength(1);
    // cachedAt was NOT updated since save() threw before returning a timestamp.
    expect(state.cachedAt).toBeNull();
    expect(events).toEqual(['purchase-success', 'entitlements-changed']);
  });

  it('H4: unfinished.remove() failure post-success — result is still success', async () => {
    // Use a storage that succeeds on set/get but fails on remove.
    const tracker = new MemoryAdapter('test');
    const flakyStorage = {
      async get(key: string) {
        return tracker.get(key);
      },
      async set(key: string, value: string) {
        await tracker.set(key, value);
      },
      async remove(_key: string): Promise<void> {
        throw new Error('remove failed');
      },
      async clear() {
        await tracker.clear();
      },
    };
    const cache = new EntitlementCache<EntitlementBase>(tracker, silentLogger);
    const unfinished = new UnfinishedTransactionsStore(flakyStorage, silentLogger);
    const emitter = new TypedEventEmitter<EntitlementBase>();
    const state: { entitlements: EntitlementBase[]; cachedAt: number | null } = {
      entitlements: [],
      cachedAt: null,
    };

    const orchestrator = new PurchaseOrchestrator<EntitlementBase>({
      nativeAdapter: makeNativeAdapter({
        purchaseProduct: async () => makeAppleTransaction('premium_monthly'),
      }),
      backend: makeBackend({
        verifyApple: async () => ({
          valid: true as const,
          entitlements: [
            { key: 'premium', productId: 'premium_monthly', expiresAt: null },
          ] as EntitlementBase[],
          transaction: { id: 'tx-remove-fails', productId: 'premium_monthly' },
        }),
      }),
      cache,
      unfinished,
      emitter,
      logger: silentLogger,
      products,
      getCurrentEntitlements: () => state.entitlements,
      setEntitlements: (next) => {
        state.entitlements = next.map((item) => Object.freeze({ ...item }));
      },
      setCachePersisted: (ts) => {
        state.cachedAt = ts;
      },
      getAuthHeaders: async () => ({}),
    });

    const result = await orchestrator.purchase({ productId: 'premium_monthly' });
    expect(result.status).toBe('success');
    expect(state.entitlements).toHaveLength(1);
    // unfinished.remove() failure throws inside the persist call (because the
    // store always re-reads + re-writes). The orchestrator catches and warns.
    // The list still contains the entry — Phase 6 recovery will retry it.
  });

  it('H1: cachedAt is set on successful purchase (was previously stale)', async () => {
    const before = Date.now();
    const { orchestrator, state } = makeOrchestrator({
      nativeAdapter: makeNativeAdapter({
        purchaseProduct: async () => makeAppleTransaction('premium_monthly'),
      }),
      backend: makeBackend({
        verifyApple: async () => ({
          valid: true as const,
          entitlements: [
            { key: 'premium', productId: 'premium_monthly', expiresAt: null },
          ] as EntitlementBase[],
          transaction: { id: 'tx-1', productId: 'premium_monthly' },
        }),
      }),
    });

    expect(state.cachedAt).toBeNull();
    await orchestrator.purchase({ productId: 'premium_monthly' });
    const after = state.cachedAt;
    if (after === null) throw new Error('cachedAt should have been set');
    expect(after).toBeGreaterThanOrEqual(before);
  });
});

// ─── appUserId pre-attach ─────────────────────────────────────────────────────

const VALID_UUID = '550e8400-e29b-41d4-a716-446655440000';

describe('PurchaseOrchestrator — appUserId pre-attach', () => {
  describe('string mode', () => {
    it('forwards a valid UUID v4 string as appAccountToken on the native call', async () => {
      const purchaseSpy = vi.fn(async (_opts: NativePurchaseOptions) =>
        makeAppleTransaction('premium_monthly'),
      );
      const { orchestrator } = makeOrchestrator({
        nativeAdapter: makeNativeAdapter({ purchaseProduct: purchaseSpy }),
      });

      await orchestrator.purchase({ productId: 'premium_monthly', appUserId: VALID_UUID });

      expect(purchaseSpy).toHaveBeenCalledTimes(1);
      const opts = purchaseSpy.mock.calls[0]?.[0];
      expect(opts?.appAccountToken).toBe(VALID_UUID);
    });

    it('omits appAccountToken when appUserId is not provided (current behavior preserved)', async () => {
      const purchaseSpy = vi.fn(async (_opts: NativePurchaseOptions) =>
        makeAppleTransaction('premium_monthly'),
      );
      const { orchestrator } = makeOrchestrator({
        nativeAdapter: makeNativeAdapter({ purchaseProduct: purchaseSpy }),
      });

      await orchestrator.purchase({ productId: 'premium_monthly' });

      const opts = purchaseSpy.mock.calls[0]?.[0];
      expect(opts?.appAccountToken).toBeUndefined();
    });

    it('throws INVALID_APP_USER_ID synchronously on non-UUID string, never invoking native', async () => {
      const purchaseSpy = vi.fn(async (_opts: NativePurchaseOptions) =>
        makeAppleTransaction('premium_monthly'),
      );
      const { orchestrator } = makeOrchestrator({
        nativeAdapter: makeNativeAdapter({ purchaseProduct: purchaseSpy }),
      });

      await expect(
        orchestrator.purchase({ productId: 'premium_monthly', appUserId: 'not-a-uuid' }),
      ).rejects.toMatchObject({
        name: 'IAPError',
        code: IAPErrorCode.INVALID_APP_USER_ID,
      });
      expect(purchaseSpy).not.toHaveBeenCalled();
    });

    it('throws INVALID_APP_USER_ID on empty string', async () => {
      const { orchestrator } = makeOrchestrator({});
      await expect(
        orchestrator.purchase({ productId: 'premium_monthly', appUserId: '' }),
      ).rejects.toMatchObject({ code: IAPErrorCode.INVALID_APP_USER_ID });
    });
  });

  describe('async fetcher mode', () => {
    it('invokes the fetcher exactly once and forwards the resolved UUID', async () => {
      const fetcher = vi.fn(async () => VALID_UUID);
      const purchaseSpy = vi.fn(async (_opts: NativePurchaseOptions) =>
        makeAppleTransaction('premium_monthly'),
      );
      const { orchestrator } = makeOrchestrator({
        nativeAdapter: makeNativeAdapter({ purchaseProduct: purchaseSpy }),
      });

      await orchestrator.purchase({ productId: 'premium_monthly', appUserId: fetcher });

      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(purchaseSpy.mock.calls[0]?.[0]?.appAccountToken).toBe(VALID_UUID);
    });

    it('throws INVALID_APP_USER_ID when fetcher resolves to a non-UUID', async () => {
      const fetcher = vi.fn(async () => 'still-not-a-uuid');
      const purchaseSpy = vi.fn(async () => makeAppleTransaction('premium_monthly'));
      const { orchestrator } = makeOrchestrator({
        nativeAdapter: makeNativeAdapter({ purchaseProduct: purchaseSpy }),
      });

      await expect(
        orchestrator.purchase({ productId: 'premium_monthly', appUserId: fetcher }),
      ).rejects.toMatchObject({ code: IAPErrorCode.INVALID_APP_USER_ID });
      // Fetcher was awaited; native was not invoked because validation fails after.
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(purchaseSpy).not.toHaveBeenCalled();
    });

    it('wraps fetcher rejection as APP_USER_ID_FETCH_FAILED with cause', async () => {
      const original = new Error('backend 503');
      const fetcher = vi.fn(async () => {
        throw original;
      });
      const { orchestrator } = makeOrchestrator({});

      let caught: unknown;
      try {
        await orchestrator.purchase({ productId: 'premium_monthly', appUserId: fetcher });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(IAPError);
      const e = caught as IAPError;
      expect(e.code).toBe(IAPErrorCode.APP_USER_ID_FETCH_FAILED);
      expect(e.cause).toBe(original);
    });

    it('does not emit purchase-started when validation fails (failure is pre-flight)', async () => {
      const { orchestrator, events } = makeOrchestrator({});
      await expect(
        orchestrator.purchase({ productId: 'premium_monthly', appUserId: 'bad' }),
      ).rejects.toMatchObject({ code: IAPErrorCode.INVALID_APP_USER_ID });
      expect(events.map((e) => e.name)).toEqual([]);
    });

    it('does not pollute inFlight on validation failure (next purchase succeeds)', async () => {
      // Regression guard: resolveAppUserId runs BEFORE inFlight.add(), so a
      // failed pre-flight must not block a subsequent retry of the same
      // productId with ALREADY_IN_PROGRESS. If someone refactors the order
      // (e.g. adding inFlight.add before validation for "consistency"),
      // this test catches it.
      const { orchestrator } = makeOrchestrator({
        nativeAdapter: makeNativeAdapter({
          purchaseProduct: async () => makeAppleTransaction('premium_monthly'),
        }),
      });
      await expect(
        orchestrator.purchase({ productId: 'premium_monthly', appUserId: 'bad' }),
      ).rejects.toMatchObject({ code: IAPErrorCode.INVALID_APP_USER_ID });
      const result = await orchestrator.purchase({
        productId: 'premium_monthly',
        appUserId: VALID_UUID,
      });
      expect(result.status).toBe('success');
    });
  });

  describe('async fetcher mode — ctx.authHeaders convenience parameter', () => {
    it('passes ctx.authHeaders populated from backend.getAuthHeaders to the fetcher', async () => {
      const expectedHeaders = { Authorization: 'Bearer abc123', 'X-Tenant': 't-1' };
      const getAuthHeaders = vi.fn(async () => expectedHeaders);
      const fetcher = vi.fn(async (ctx: { authHeaders: Record<string, string> }) => {
        // Simulate using ctx.authHeaders for a fetch — assert what we received.
        expect(ctx.authHeaders).toEqual(expectedHeaders);
        return VALID_UUID;
      });
      const purchaseSpy = vi.fn(async (_opts: NativePurchaseOptions) =>
        makeAppleTransaction('premium_monthly'),
      );
      const { orchestrator } = makeOrchestrator({
        nativeAdapter: makeNativeAdapter({ purchaseProduct: purchaseSpy }),
        getAuthHeaders,
      });

      const result = await orchestrator.purchase({
        productId: 'premium_monthly',
        appUserId: fetcher,
      });

      expect(result.status).toBe('success');
      expect(getAuthHeaders).toHaveBeenCalledTimes(1);
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(purchaseSpy.mock.calls[0]?.[0]?.appAccountToken).toBe(VALID_UUID);
    });

    it('zero-arg fetcher (0.2.x form) continues to work — extra ctx arg is ignored at runtime', async () => {
      // Regression guard: changing the resolveAppUserId signature must not
      // break existing zero-arg fetchers. JS ignores extra args, so calling
      // a `() => Promise<string>` with a ctx object is a no-op for the body.
      const fetcher = vi.fn(async () => VALID_UUID);
      const getAuthHeaders = vi.fn(async () => ({ Authorization: 'Bearer xyz' }));
      const { orchestrator } = makeOrchestrator({
        nativeAdapter: makeNativeAdapter({
          purchaseProduct: async () => makeAppleTransaction('premium_monthly'),
        }),
        getAuthHeaders,
      });

      const result = await orchestrator.purchase({
        productId: 'premium_monthly',
        appUserId: fetcher,
      });

      expect(result.status).toBe('success');
      expect(fetcher).toHaveBeenCalledTimes(1);
      // getAuthHeaders is awaited regardless (we don't sniff fetcher.length),
      // but the fetcher body never reads it.
      expect(getAuthHeaders).toHaveBeenCalledTimes(1);
    });

    it('custom-adapter consumer (no getAuthHeaders configured) sees ctx.authHeaders === {}', async () => {
      // createIAP wraps an absent config.backend.getAuthHeaders with
      // `async () => ({})`, so consumers using a custom BackendAdapter
      // get an empty object — never undefined — when destructuring
      // ctx.authHeaders.
      const fetcher = vi.fn(async (ctx: { authHeaders: Record<string, string> }) => {
        expect(ctx.authHeaders).toEqual({});
        return VALID_UUID;
      });
      const { orchestrator } = makeOrchestrator({
        nativeAdapter: makeNativeAdapter({
          purchaseProduct: async () => makeAppleTransaction('premium_monthly'),
        }),
        getAuthHeaders: async () => ({}),
      });

      const result = await orchestrator.purchase({
        productId: 'premium_monthly',
        appUserId: fetcher,
      });

      expect(result.status).toBe('success');
      expect(fetcher).toHaveBeenCalledTimes(1);
    });

    it('does not invoke getAuthHeaders when appUserId is a string (no fetcher)', async () => {
      // Optimization guard: string-form supplies skip the await entirely.
      // If someone refactors purchase() to always resolve headers eagerly,
      // this test catches the regression.
      const getAuthHeaders = vi.fn(async () => ({ Authorization: 'Bearer abc' }));
      const { orchestrator } = makeOrchestrator({
        nativeAdapter: makeNativeAdapter({
          purchaseProduct: async () => makeAppleTransaction('premium_monthly'),
        }),
        getAuthHeaders,
      });

      await orchestrator.purchase({ productId: 'premium_monthly', appUserId: VALID_UUID });

      expect(getAuthHeaders).not.toHaveBeenCalled();
    });

    it('ctx-form fetcher rejection still wraps as APP_USER_ID_FETCH_FAILED with cause', async () => {
      // Back-compat guarantee: the runtime cast in resolveAppUserId is purely
      // a TS construct, but if a future refactor changes the call shape we
      // want explicit coverage that ctx-form rejections wrap identically to
      // zero-arg ones. Pairs with the existing zero-arg rejection test.
      const cause = new Error('uuid endpoint 500');
      const fetcher = async (_ctx: { authHeaders: Record<string, string> }) => {
        throw cause;
      };
      const { orchestrator } = makeOrchestrator({
        nativeAdapter: makeNativeAdapter({
          purchaseProduct: async () => makeAppleTransaction('premium_monthly'),
        }),
        getAuthHeaders: async () => ({ Authorization: 'Bearer x' }),
      });
      await expect(
        orchestrator.purchase({ productId: 'premium_monthly', appUserId: fetcher }),
      ).rejects.toMatchObject({
        code: IAPErrorCode.APP_USER_ID_FETCH_FAILED,
        cause,
      });
    });
  });
});
