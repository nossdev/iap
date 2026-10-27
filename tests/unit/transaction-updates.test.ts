import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BackendAdapter } from '../../src/adapters/backend/types.js';
import type { NativeAdapter } from '../../src/adapters/native/types.js';
import { MemoryAdapter } from '../../src/adapters/storage/memory-adapter.js';
import { EntitlementCache } from '../../src/core/entitlement-cache.js';
import { PendingPurchasesStore } from '../../src/core/pending-purchases.js';
import {
  DEFAULT_PERMANENT_ERROR_CODES,
  RecoveryOrchestrator,
} from '../../src/core/recovery-flow.js';
import { TransactionUpdateOrchestrator } from '../../src/core/transaction-updates.js';
import { UnfinishedTransactionsStore } from '../../src/core/unfinished-transactions.js';
import { TypedEventEmitter } from '../../src/events/emitter.js';
import type { EntitlementBase } from '../../src/types/entitlement.js';
import type { NativeTransaction } from '../../src/types/transaction.js';
import { makeSilentLogger } from '../mocks/http-helpers.js';
import { makeBackend, makeNativeAdapter } from '../mocks/orchestrator-builders.js';

/**
 * Transactions that arrive outside a `purchase()` call: renewals, refunds,
 * Ask-to-Buy approvals, and the Play pending purchase that clears hours
 * later with the app closed.
 */

const silentLogger = makeSilentLogger();

const HOUSEHOLD: EntitlementBase = {
  key: 'household',
  productId: 'household_yearly',
  expiresAt: null,
};

function renewal(productId = 'household_yearly'): NativeTransaction {
  return {
    platform: 'apple',
    productId,
    token: `renewal-token-${productId}`,
    purchaseReference: `original-${productId}`,
    productType: 'subscription',
  };
}

function playPurchase(productId = 'household_yearly'): NativeTransaction {
  return {
    platform: 'google',
    productId,
    token: `play-token-${productId}`,
    purchaseReference: `play-token-${productId}`,
    packageName: 'com.example.app',
    productType: 'subscription',
  };
}

function makeHarness(opts: {
  nativeAdapter?: NativeAdapter;
  backend?: BackendAdapter<EntitlementBase>;
  inFlight?: Set<string>;
  active?: boolean;
}) {
  const storage = new MemoryAdapter('test');
  const cache = new EntitlementCache<EntitlementBase>(storage, silentLogger);
  const unfinished = new UnfinishedTransactionsStore(storage, silentLogger);
  const pending = new PendingPurchasesStore(storage, silentLogger);
  const emitter = new TypedEventEmitter<EntitlementBase>();
  const state: { entitlements: EntitlementBase[]; cachedAt: number | null } = {
    entitlements: [],
    cachedAt: null,
  };

  const events: Array<{ name: string; payload: unknown }> = [];
  for (const name of [
    'transaction-updated',
    'purchase-pending-resolved',
    'entitlements-changed',
  ] as const) {
    emitter.on(name, (payload) => events.push({ name, payload }));
  }

  const nativeAdapter = opts.nativeAdapter ?? makeNativeAdapter();
  const shared = {
    nativeAdapter,
    backend: opts.backend ?? makeBackend<EntitlementBase>(),
    cache,
    unfinished,
    pending,
    emitter,
    logger: silentLogger,
    getCurrentEntitlements: () => state.entitlements,
    setEntitlements: (next: EntitlementBase[]) => {
      state.entitlements = next.map((e) => Object.freeze({ ...e }));
    },
    setCachePersisted: (ts: number) => {
      state.cachedAt = ts;
    },
  };

  const recoverer = new RecoveryOrchestrator<EntitlementBase>({
    ...shared,
    maxBatch: 50,
    permanentErrorCodes: new Set(DEFAULT_PERMANENT_ERROR_CODES),
  });

  const inFlight = opts.inFlight ?? new Set<string>();
  const active = { value: opts.active ?? true };
  const updates = new TransactionUpdateOrchestrator<EntitlementBase>({
    nativeAdapter,
    recoverer,
    pending,
    emitter,
    logger: silentLogger,
    isPurchaseInFlight: (productId) => inFlight.has(productId),
    isActive: () => active.value,
  });

  return { updates, recoverer, pending, unfinished, events, state, inFlight, active };
}

/** A backend that confirms whatever it is handed. */
function confirmingBackend(entitlements: EntitlementBase[] = [HOUSEHOLD]) {
  const response = {
    valid: true as const,
    entitlements,
    transaction: { id: 'tx', productId: 'household_yearly' },
  };
  return makeBackend<EntitlementBase>({
    verifyApple: vi.fn().mockResolvedValue(response),
    verifyGoogle: vi.fn().mockResolvedValue(response),
  });
}

describe('an update arriving with no purchase in flight', () => {
  it('verifies it, acknowledges it, and updates entitlements', async () => {
    const acknowledge = vi.fn().mockResolvedValue(undefined);
    const { updates, state, unfinished } = makeHarness({
      nativeAdapter: makeNativeAdapter({ acknowledge }),
      backend: confirmingBackend(),
    });

    await updates.handle(renewal());

    expect(state.entitlements).toEqual([HOUSEHOLD]);
    expect(acknowledge).toHaveBeenCalledTimes(1);
    // Settled, so it must not be left behind for recovery to redo.
    expect(await unfinished.list()).toEqual([]);
  });

  it('emits transaction-updated once, and entitlements-changed once', async () => {
    const { updates, events } = makeHarness({ backend: confirmingBackend() });

    await updates.handle(renewal());

    expect(events.map((e) => e.name)).toEqual(['transaction-updated', 'entitlements-changed']);
    expect(events[0]?.payload).toEqual({
      productId: 'household_yearly',
      purchase: {
        platform: 'apple',
        productId: 'household_yearly',
        purchaseReference: 'original-household_yearly',
        appUserId: null,
        subscription: null,
      },
    });
  });

  it('leaves the transaction for recovery when the backend rejects it', async () => {
    const { updates, state, unfinished } = makeHarness({
      backend: makeBackend<EntitlementBase>({
        verifyApple: vi.fn().mockResolvedValue({ valid: false, error: 'BACKEND_DOWN' }),
      }),
    });

    await updates.handle(renewal());

    expect(state.entitlements).toEqual([]);
    // Persisted before verifying, so a failure is retried next launch.
    expect((await unfinished.list()).map((e) => e.token)).toEqual([
      'renewal-token-household_yearly',
    ]);
  });

  it('never throws, so a native listener callback cannot explode', async () => {
    const { updates } = makeHarness({
      nativeAdapter: makeNativeAdapter({
        acknowledge: vi.fn().mockRejectedValue(new Error('store offline')),
      }),
      backend: makeBackend<EntitlementBase>({
        verifyApple: vi.fn().mockRejectedValue(new Error('network down')),
      }),
    });

    await expect(updates.handle(renewal())).resolves.toBeUndefined();
  });
});

describe('an update for a product already being purchased', () => {
  it('is left to the purchase flow, which owns the transaction', async () => {
    // StoreKit delivers the same transaction to Transaction.updates that
    // purchaseProduct() resolves with. Settling it here too would verify
    // twice, acknowledge twice, and emit a spurious entitlements-changed.
    const verifyApple = vi.fn();
    const { updates, events } = makeHarness({
      inFlight: new Set(['household_yearly']),
      backend: makeBackend<EntitlementBase>({ verifyApple }),
    });

    await updates.handle(renewal());

    expect(verifyApple).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });
});

describe('a pending purchase that resolves', () => {
  it('reports purchased when the transaction arrives, and grants', async () => {
    const { updates, pending, events, state } = makeHarness({ backend: confirmingBackend() });
    await pending.add('household_yearly');

    await updates.handle(renewal());

    expect(state.entitlements).toEqual([HOUSEHOLD]);
    expect(events).toContainEqual({
      name: 'purchase-pending-resolved',
      payload: { productId: 'household_yearly', status: 'purchased' },
    });
    // Resolved, so the marker is gone and cannot fire twice.
    expect(await pending.list()).toEqual([]);
  });

  it('does not report purchased when the verification failed', async () => {
    // The pending purchase is still pending as far as anyone can tell —
    // telling the consumer it succeeded would show paid-for content that
    // the backend has not confirmed.
    const { updates, pending, events } = makeHarness({
      backend: makeBackend<EntitlementBase>({
        verifyApple: vi.fn().mockResolvedValue({ valid: false, error: 'BACKEND_DOWN' }),
      }),
    });
    await pending.add('household_yearly');

    await updates.handle(renewal());

    expect(events.filter((e) => e.name === 'purchase-pending-resolved')).toEqual([]);
    expect(await pending.list()).toEqual(['household_yearly']);
  });

  it('reports nothing for a product that was never marked pending', async () => {
    const { updates, events } = makeHarness({ backend: confirmingBackend() });

    await updates.handle(renewal());

    expect(events.filter((e) => e.name === 'purchase-pending-resolved')).toEqual([]);
  });
});

describe('reconciling pending purchases against the store', () => {
  it('settles and reports purchased when the store now owns it', async () => {
    // The Android path: no update event exists there, so a pending purchase
    // that cleared is only discovered by asking the store at launch/resume.
    const acknowledge = vi.fn().mockResolvedValue(undefined);
    const { updates, pending, events, state } = makeHarness({
      nativeAdapter: makeNativeAdapter({
        acknowledge,
        getOwnedTransactions: vi.fn().mockResolvedValue([playPurchase()]),
        getPendingProductIds: vi.fn().mockResolvedValue([]),
      }),
      backend: confirmingBackend(),
    });
    await pending.add('household_yearly');

    await updates.reconcilePending();

    // Not just announced — verified and acknowledged, or Play refunds it.
    expect(acknowledge).toHaveBeenCalledTimes(1);
    expect(state.entitlements).toEqual([HOUSEHOLD]);
    expect(events).toContainEqual({
      name: 'purchase-pending-resolved',
      payload: { productId: 'household_yearly', status: 'purchased' },
    });
  });

  it('reports cancelled when the store has neither owned nor pending', async () => {
    const { updates, pending, events } = makeHarness({
      nativeAdapter: makeNativeAdapter({
        getOwnedTransactions: vi.fn().mockResolvedValue([]),
        getPendingProductIds: vi.fn().mockResolvedValue([]),
      }),
    });
    await pending.add('household_yearly');

    await updates.reconcilePending();

    expect(events).toContainEqual({
      name: 'purchase-pending-resolved',
      payload: { productId: 'household_yearly', status: 'cancelled' },
    });
    expect(await pending.list()).toEqual([]);
  });

  it('says nothing while the store still reports it pending', async () => {
    const { updates, pending, events } = makeHarness({
      nativeAdapter: makeNativeAdapter({
        getOwnedTransactions: vi.fn().mockResolvedValue([]),
        getPendingProductIds: vi.fn().mockResolvedValue(['household_yearly']),
      }),
    });
    await pending.add('household_yearly');

    await updates.reconcilePending();

    expect(events).toEqual([]);
    expect(await pending.list()).toEqual(['household_yearly']);
  });

  it('never guesses cancelled on a platform that cannot report pending state', async () => {
    // iOS. A deferred purchase that is never approved produces no signal at
    // all, so "not owned" is indistinguishable from "still waiting" — and
    // announcing cancelled would clear a paywall's pending copy while the
    // parent is still deciding.
    const { updates, pending, events } = makeHarness({
      nativeAdapter: makeNativeAdapter({
        getOwnedTransactions: vi.fn().mockResolvedValue([]),
        getPendingProductIds: vi.fn().mockResolvedValue(null),
      }),
    });
    await pending.add('household_yearly');

    await updates.reconcilePending();

    expect(events).toEqual([]);
    expect(await pending.list()).toEqual(['household_yearly']);
  });

  it('treats a missing getPendingProductIds the same as cannot-tell', async () => {
    const adapter = makeNativeAdapter({
      getOwnedTransactions: vi.fn().mockResolvedValue([]),
    });
    // An adapter that does not implement the optional method at all.
    expect(adapter.getPendingProductIds).toBeUndefined();

    const { updates, pending, events } = makeHarness({ nativeAdapter: adapter });
    await pending.add('household_yearly');

    await updates.reconcilePending();

    expect(events).toEqual([]);
    expect(await pending.list()).toEqual(['household_yearly']);
  });

  it('does nothing, and asks the store nothing, when nothing is pending', async () => {
    const getOwnedTransactions = vi.fn().mockResolvedValue([]);
    const { updates, events } = makeHarness({
      nativeAdapter: makeNativeAdapter({ getOwnedTransactions }),
    });

    await updates.reconcilePending();

    expect(getOwnedTransactions).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });

  it('keeps the marker when the store cannot be reached', async () => {
    const { updates, pending, events } = makeHarness({
      nativeAdapter: makeNativeAdapter({
        getOwnedTransactions: vi.fn().mockRejectedValue(new Error('store offline')),
      }),
    });
    await pending.add('household_yearly');

    await expect(updates.reconcilePending()).resolves.toBeUndefined();
    expect(events).toEqual([]);
    expect(await pending.list()).toEqual(['household_yearly']);
  });

  it('resolves several tracked products independently', async () => {
    const { updates, pending, events } = makeHarness({
      nativeAdapter: makeNativeAdapter({
        getOwnedTransactions: vi.fn().mockResolvedValue([playPurchase('bought')]),
        getPendingProductIds: vi.fn().mockResolvedValue(['still_waiting']),
      }),
      backend: confirmingBackend([]),
    });
    await pending.add('bought');
    await pending.add('still_waiting');
    await pending.add('vanished');

    await updates.reconcilePending();

    const resolved = events
      .filter((e) => e.name === 'purchase-pending-resolved')
      .map((e) => e.payload);
    expect(resolved).toHaveLength(2);
    expect(resolved).toContainEqual({ productId: 'bought', status: 'purchased' });
    expect(resolved).toContainEqual({ productId: 'vanished', status: 'cancelled' });
    expect(await pending.list()).toEqual(['still_waiting']);
  });
});

describe('two settlement paths overlapping', () => {
  /**
   * Both of these overlaps are reachable in production: `initialize()`
   * registers the listener and then reconciles, and the iOS plugin can
   * notify as soon as the listener exists; the resume listener does not
   * debounce, so two foreground events run two reconciliations.
   *
   * Settling twice means verifying twice and acknowledging twice — and on
   * Android a second acknowledge of an already-acked token errors, which the
   * settle path reads as a failure and retains the entry for.
   */
  it('settles once, acknowledges once, and emits once when handle races reconcile', async () => {
    const acknowledge = vi.fn().mockResolvedValue(undefined);
    const verifyApple = vi.fn().mockResolvedValue({
      valid: true,
      entitlements: [HOUSEHOLD],
      transaction: { id: 'tx', productId: 'household_yearly' },
    });
    const tx = renewal();
    const { updates, pending, events } = makeHarness({
      nativeAdapter: makeNativeAdapter({
        acknowledge,
        getOwnedTransactions: vi.fn().mockResolvedValue([tx]),
        getPendingProductIds: vi.fn().mockResolvedValue([]),
      }),
      backend: makeBackend({ verifyApple }),
    });
    await pending.add('household_yearly');

    await Promise.all([updates.handle(tx), updates.reconcilePending()]);

    expect(acknowledge).toHaveBeenCalledTimes(1);
    expect(verifyApple).toHaveBeenCalledTimes(1);
    expect(events.filter((e) => e.name === 'purchase-pending-resolved')).toEqual([
      {
        name: 'purchase-pending-resolved',
        payload: { productId: 'household_yearly', status: 'purchased' },
      },
    ]);
  });

  it('joins a reconciliation already in flight instead of starting a second', async () => {
    const acknowledge = vi.fn().mockResolvedValue(undefined);
    const getOwnedTransactions = vi.fn().mockResolvedValue([playPurchase()]);
    const { updates, pending, events } = makeHarness({
      nativeAdapter: makeNativeAdapter({
        acknowledge,
        getOwnedTransactions,
        getPendingProductIds: vi.fn().mockResolvedValue([]),
      }),
      backend: confirmingBackend(),
    });
    await pending.add('household_yearly');

    await Promise.all([updates.reconcilePending(), updates.reconcilePending()]);

    expect(getOwnedTransactions).toHaveBeenCalledTimes(1);
    expect(acknowledge).toHaveBeenCalledTimes(1);
    expect(events.filter((e) => e.name === 'purchase-pending-resolved')).toHaveLength(1);
  });
});

describe('a pending purchase settled somewhere else', () => {
  /**
   * The marker is cleared by whichever path settles the transaction, not
   * only by this orchestrator. A path that settled the purchase and left the
   * marker behind would have it reported `cancelled` on a later reconcile —
   * telling the consumer a purchase failed after it succeeded.
   */
  it('is resolved by the settle path itself, not by its caller', async () => {
    const { recoverer, pending, events } = makeHarness({
      nativeAdapter: makeNativeAdapter({ acknowledge: vi.fn().mockResolvedValue(undefined) }),
      backend: confirmingBackend(),
    });
    await pending.add('household_yearly');

    // Settled directly, with no TransactionUpdateOrchestrator involved —
    // this is the path launch recovery and a purchase retry both take.
    expect(await recoverer.settleTransaction(renewal())).toBe('settled');

    expect(await pending.list()).toEqual([]);
    expect(events).toContainEqual({
      name: 'purchase-pending-resolved',
      payload: { productId: 'household_yearly', status: 'purchased' },
    });
  });

  it('is not reported cancelled once the marker is gone', async () => {
    // The sequence that used to produce a false cancelled: settled
    // elsewhere, the store has consumed it, then a reconcile runs.
    const { updates, recoverer, pending, events } = makeHarness({
      nativeAdapter: makeNativeAdapter({
        acknowledge: vi.fn().mockResolvedValue(undefined),
        getOwnedTransactions: vi.fn().mockResolvedValue([]),
        getPendingProductIds: vi.fn().mockResolvedValue([]),
      }),
      backend: confirmingBackend(),
    });
    await pending.add('household_yearly');
    await recoverer.settleTransaction(renewal());

    await updates.reconcilePending();

    expect(events.filter((e) => e.name === 'purchase-pending-resolved')).toEqual([
      {
        name: 'purchase-pending-resolved',
        payload: { productId: 'household_yearly', status: 'purchased' },
      },
    ]);
  });
});

describe('after teardown', () => {
  it('ignores a transaction that arrives once the instance is inactive', async () => {
    // A native callback can fire during or after destroy(). Settling then
    // writes through the shared state closures and repopulates a torn-down
    // instance.
    const verifyApple = vi.fn();
    const { updates, events, active } = makeHarness({
      backend: makeBackend({ verifyApple }),
    });
    active.value = false;

    await updates.handle(renewal());

    expect(verifyApple).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });

  it('skips reconciliation once the instance is inactive', async () => {
    const getOwnedTransactions = vi.fn().mockResolvedValue([]);
    const { updates, pending, active } = makeHarness({
      nativeAdapter: makeNativeAdapter({ getOwnedTransactions }),
    });
    await pending.add('household_yearly');
    active.value = false;

    await updates.reconcilePending();

    expect(getOwnedTransactions).not.toHaveBeenCalled();
    expect(await pending.list()).toEqual(['household_yearly']);
  });
});

describe('a revoked transaction', () => {
  it('is verified but never persisted, so it cannot clog recovery forever', async () => {
    // A revocation verifies valid:false with a code no permanent-error list
    // knows, so persisting it would retain it and re-verify at every launch,
    // crowding out entries that can still succeed.
    const verifyApple = vi.fn().mockResolvedValue({ valid: false, error: 'REVOKED' });
    const { updates, unfinished } = makeHarness({
      backend: makeBackend({ verifyApple }),
    });

    await updates.handle({
      ...renewal(),
      subscription: {
        state: 'revoked',
        autoRenewing: false,
        renewsAt: null,
        renewalProductId: null,
        expiresAt: '2026-10-01T00:00:00Z',
      },
    });

    expect(verifyApple).toHaveBeenCalledTimes(1);
    expect(await unfinished.list()).toEqual([]);
  });
});

describe('a transaction the platform already finished', () => {
  /**
   * The iOS feed's shape: capgo calls `transaction.finish()` before it
   * notifies listeners, so by the time iap sees the transaction the platform
   * has finished it. `acknowledgePurchase` then looks it up in
   * `Transaction.all` and rejects "not found or already finished" — which
   * `Transaction.all` guarantees for a finished consumable.
   *
   * Read as a failure, that would retain the entry forever and never resolve
   * a pending purchase that in fact completed.
   */
  it('settles despite a failing acknowledge, and resolves the pending mark', async () => {
    const { updates, pending, events, unfinished } = makeHarness({
      nativeAdapter: makeNativeAdapter({
        acknowledge: vi
          .fn()
          .mockRejectedValue(new Error('Transaction not found or already finished.')),
      }),
      backend: confirmingBackend(),
    });
    await pending.add('household_yearly');

    await updates.handle(renewal());

    expect(events).toContainEqual({
      name: 'purchase-pending-resolved',
      payload: { productId: 'household_yearly', status: 'purchased' },
    });
    expect(await unfinished.list()).toEqual([]);
  });

  it('still treats a failing acknowledge as a failure on the Android path', async () => {
    // Nothing finished a Play purchase found by reconciliation, so an ack
    // failure there is real and the entry must be retained.
    const { updates, pending, unfinished, events } = makeHarness({
      nativeAdapter: makeNativeAdapter({
        acknowledge: vi.fn().mockRejectedValue(new Error('billing unavailable')),
        getOwnedTransactions: vi.fn().mockResolvedValue([playPurchase()]),
        getPendingProductIds: vi.fn().mockResolvedValue([]),
      }),
      backend: confirmingBackend(),
    });
    await pending.add('household_yearly');

    await updates.reconcilePending();

    expect(events.filter((e) => e.name === 'purchase-pending-resolved')).toEqual([]);
    expect(await pending.list()).toEqual(['household_yearly']);
    expect((await unfinished.list()).map((e) => e.productId)).toEqual(['household_yearly']);
  });
});
