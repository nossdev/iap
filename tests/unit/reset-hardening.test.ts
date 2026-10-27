import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NativeAdapter } from '../../src/adapters/native/types.js';
import type { StorageAdapter } from '../../src/adapters/storage/types.js';
import type { EntitlementBase } from '../../src/types/entitlement.js';

/**
 * `reset()`'s hard edges: it leaves nothing of iap behind, it refuses to
 * delete a live purchase's unfinished-transaction record, and it still
 * wipes after `destroy()`.
 *
 * Separate from the `reset()` block in local-mode.test.ts, which covers the
 * happy path and the event. These are the ones that would otherwise be found
 * in production.
 */

let mockedPlatform: 'ios' | 'android' | 'web' = 'ios';
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
  dispose: vi.fn().mockResolvedValue(undefined),
};

vi.mock('../../src/adapters/native/index.js', () => ({
  selectNativeAdapter: vi.fn(async () => adapter),
}));

vi.mock('../../src/core/app-resume-listener.js', () => ({
  attachAppResumeListener: vi.fn(async () => null),
}));

import { MemoryAdapter } from '../../src/adapters/storage/memory-adapter.js';
import { ALL_IAP_STORAGE_KEYS, IAP_STORAGE_KEYS } from '../../src/core/storage-keys.js';
import { createIAP } from '../../src/createIAP.js';
import { IAPError, IAPErrorCode } from '../../src/lib/errors.js';
import type { IAPConfigInput } from '../../src/types/config.js';
import { appleTransaction } from '../mocks/transactions.js';

interface RecordingStorage {
  storage: StorageAdapter;
  /** Keys written and not since removed — what a reset has to leave empty. */
  live: Set<string>;
  removed: string[];
  clears: number;
}

/**
 * A real adapter that tracks which keys are *live*.
 *
 * The live set is what makes the completeness assertion meaningful: checking
 * that `remove` was called with each registry key is true by construction of
 * the loop and says nothing about whether anything else survived.
 */
function recordingStorage(options: { failOn?: string } = {}): RecordingStorage {
  const inner = new MemoryAdapter('test');
  const live = new Set<string>();
  const removed: string[] = [];
  const tracker = { clears: 0 };

  const storage: StorageAdapter = {
    get: (key) => inner.get(key),
    set: async (key, value) => {
      live.add(key);
      await inner.set(key, value);
    },
    remove: async (key) => {
      removed.push(key);
      if (key === options.failOn) throw new Error('storage is on fire');
      live.delete(key);
      await inner.remove(key);
    },
    clear: async () => {
      tracker.clears += 1;
      live.clear();
      await inner.clear();
    },
  };

  return {
    storage,
    live,
    removed,
    get clears() {
      return tracker.clears;
    },
  };
}

function localConfig(storage: StorageAdapter, over: Partial<IAPConfigInput> = {}): IAPConfigInput {
  return {
    products: [{ id: 'household_yearly', type: 'subscription' }],
    verification: {
      mode: 'local',
      entitlements: (purchase: {
        productId: string;
        expiresAt: string | null;
      }): EntitlementBase[] => [
        { key: 'household', productId: purchase.productId, expiresAt: purchase.expiresAt },
      ],
    },
    storage: { type: 'custom', namespace: 'test', adapter: storage },
    options: { logLevel: 'silent', refreshOnResume: false },
    ...over,
  } as IAPConfigInput;
}

/** Resolves once the orchestrator has marked the product in flight. */
function started(iap: { on: (e: 'purchase-started', h: () => void) => unknown }): Promise<void> {
  return new Promise((resolve) => {
    iap.on('purchase-started', () => resolve());
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedPlatform = 'ios';
  getOwnedTransactions.mockResolvedValue([]);
  purchaseProduct.mockResolvedValue(appleTransaction());
});

describe('reset() — completeness', () => {
  it('leaves no key of iap live, whatever wrote it', async () => {
    const { storage, live } = recordingStorage();
    const iap = createIAP(localConfig(storage));
    await iap.initialize();

    // Everything iap persists, by the paths that persist it: a purchase
    // writes the unfinished entry and then the cache.
    await iap.purchase({ productId: 'household_yearly' });
    getOwnedTransactions.mockResolvedValue([appleTransaction()]);
    await iap.refresh();
    // And a mark left by an earlier session, which no live store rewrites.
    await storage.set(IAP_STORAGE_KEYS.pendingPurchases, '[]');
    expect(live.size).toBeGreaterThan(0);

    await iap.reset();

    // The assertion that survives a fourth store being added: nothing iap
    // ever wrote is still readable, rather than "the three keys we thought
    // to name were passed to remove".
    expect([...live]).toEqual([]);
    for (const key of ALL_IAP_STORAGE_KEYS) {
      expect(await storage.get(key), `"${key}" should be gone`).toBeNull();
    }
  });

  it('removes every registry key by name, not only via the stores', async () => {
    const { storage, removed } = recordingStorage();
    const iap = createIAP(localConfig(storage));
    await iap.initialize();

    await iap.reset();

    // By name because the Preferences adapter can only remove keys it has
    // *seen* this session — an empty set on a fresh launch — so clearing
    // the namespace alone is a no-op there, and a store whose `clear()`
    // nobody remembered to call would leave its key behind.
    for (const key of ALL_IAP_STORAGE_KEYS) {
      expect(removed, `reset() should remove "${key}"`).toContain(key);
    }
  });

  it('clears the namespace as well, for anything an older version wrote', async () => {
    const recording = recordingStorage();
    const iap = createIAP(localConfig(recording.storage));
    await iap.initialize();

    await recording.storage.set('iap_v5_legacy_receipt', 'something');
    await iap.reset();

    // Best-effort and adapter-dependent — the memory adapter can enumerate
    // by prefix, the Preferences adapter cannot — but it is the only step
    // that can reach a key no registry names.
    expect(recording.clears).toBe(1);
    expect(await recording.storage.get('iap_v5_legacy_receipt')).toBeNull();
  });

  it('keeps clearing the rest when one key refuses to be removed', async () => {
    const failing = IAP_STORAGE_KEYS.unfinishedTransactions;
    const { storage, removed } = recordingStorage({ failOn: failing });
    const iap = createIAP(localConfig(storage));
    await iap.initialize();

    // Best-effort on storage: a failure to clear one key is logged and the
    // rest is still cleared.
    await expect(iap.reset()).resolves.toBeUndefined();
    for (const key of ALL_IAP_STORAGE_KEYS) {
      expect(removed).toContain(key);
    }
  });
});

describe('reset() — a purchase in flight', () => {
  it('refuses, rather than deleting the purchase’s unfinished record', async () => {
    let settle: (value: unknown) => void = () => {};
    purchaseProduct.mockImplementation(
      () =>
        new Promise((resolve) => {
          settle = resolve;
        }),
    );

    const { storage, removed } = recordingStorage();
    const iap = createIAP(localConfig(storage));
    await iap.initialize();

    const inFlight = started(iap);
    const buying = iap.purchase({ productId: 'household_yearly' });
    await inFlight;

    // That record is written *before* verification precisely so a purchase
    // survives a crash. Deleting it mid-flight leaves a purchase neither
    // acknowledged nor tracked, which Play auto-refunds in three days.
    const error = await iap.reset().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(IAPError);
    expect((error as IAPError).code).toBe(IAPErrorCode.ALREADY_IN_PROGRESS);
    expect(removed).toEqual([]);

    settle(appleTransaction());
    await buying.catch(() => {});
  });

  it('names the product, and says the caller can retry', async () => {
    let settle: (value: unknown) => void = () => {};
    purchaseProduct.mockImplementation(
      () =>
        new Promise((resolve) => {
          settle = resolve;
        }),
    );

    const { storage } = recordingStorage();
    const iap = createIAP(localConfig(storage));
    await iap.initialize();

    const inFlight = started(iap);
    const buying = iap.purchase({ productId: 'household_yearly' });
    await inFlight;

    const error = (await iap.reset().catch((e: unknown) => e)) as IAPError;
    expect(error.message).toContain('household_yearly');
    // Recoverable: await the purchase and try again. The code's default
    // says otherwise, because its other caller — a double `purchase()` of
    // one product — is a caller bug.
    expect(error.recoverable).toBe(true);
    // And without the per-code hint, which would tell someone debugging a
    // failed reset that they double-called `purchase()`.
    expect(error.message).not.toContain('before starting another');

    settle(appleTransaction());
    await buying.catch(() => {});
  });

  it('is in flight before a consumer appUserId fetcher resolves', async () => {
    // The window this closes: resolving the fetcher — a consumer network
    // round-trip — used to happen before the product was marked, so
    // `reset()` saw nothing in flight and wiped the queue under a purchase
    // that was already committed to running.
    let releaseFetcher: () => void = () => {};
    const fetching = new Promise<void>((resolve) => {
      releaseFetcher = resolve;
    });

    const { storage, removed } = recordingStorage();
    const iap = createIAP(localConfig(storage));
    await iap.initialize();

    const buying = iap.purchase({
      productId: 'household_yearly',
      appUserId: async () => {
        await fetching;
        return '00000000-0000-4000-8000-00000000a11c';
      },
    });
    // Let `purchase()` run up to the fetcher's await. No `purchase-started`
    // yet — that still fires after validation, deliberately.
    await Promise.resolve();

    await expect(iap.reset()).rejects.toBeInstanceOf(IAPError);
    expect(removed).toEqual([]);

    releaseFetcher();
    await buying.catch(() => {});
  });
});

describe('reset() after destroy()', () => {
  it('still wipes, because that is when nothing can re-persist', async () => {
    const { storage, live } = recordingStorage();
    const iap = createIAP(localConfig(storage));
    await iap.initialize();
    await iap.purchase({ productId: 'household_yearly' });
    getOwnedTransactions.mockResolvedValue([appleTransaction()]);
    await iap.refresh();
    expect(live.size).toBeGreaterThan(0);

    await iap.destroy();

    // `destroy()` deliberately *keeps* the cache so the next instance sees
    // the user's entitlements immediately — and nulls the orchestrator, so
    // there is nothing left that could write after the wipe. Returning
    // early here would leave the cache, the queue and the pending marks on
    // the device while telling the caller their data was gone, which for a
    // privacy control is the worst of the three options.
    await expect(iap.reset()).resolves.toBeUndefined();
    expect([...live]).toEqual([]);
    expect(await storage.get(IAP_STORAGE_KEYS.entitlements)).toBeNull();
  });
});
