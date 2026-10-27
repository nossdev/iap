import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NativeAdapter, TransactionWatchHandle } from '../../src/adapters/native/types.js';
import type { NativeTransaction } from '../../src/types/transaction.js';

/**
 * The lifecycle half of the transaction-update feature: that `initialize()`
 * actually subscribes, that `destroy()` actually unsubscribes, and that
 * pending purchases are reconciled at launch and on resume.
 *
 * The orchestrator's own behaviour is covered in
 * `transaction-updates.test.ts`; this file only asserts the wiring, which is
 * the part that can be complete and still never run.
 */

let mockedPlatform: 'ios' | 'android' | 'web' = 'ios';
vi.mock('@capacitor/core', () => ({
  Capacitor: {
    getPlatform: () => mockedPlatform,
    isNativePlatform: () => mockedPlatform !== 'web',
  },
}));

/** Captured so a test can drive the listener the adapter registered. */
let registered: ((tx: NativeTransaction) => void) | null = null;
const watchRemove = vi.fn().mockResolvedValue(undefined);
const watchTransactions = vi.fn(
  async (onUpdate: (tx: NativeTransaction) => void): Promise<TransactionWatchHandle | null> => {
    registered = onUpdate;
    return { remove: watchRemove };
  },
);
const getPendingProductIds = vi.fn().mockResolvedValue([]);
const getOwnedTransactions = vi.fn().mockResolvedValue([]);

const adapter: NativeAdapter = {
  isAvailable: vi.fn().mockResolvedValue(true),
  getProducts: vi.fn().mockResolvedValue([]),
  purchaseProduct: vi.fn(),
  getOwnedTransactions,
  acknowledge: vi.fn().mockResolvedValue(undefined),
  watchTransactions,
  getPendingProductIds,
  dispose: vi.fn().mockResolvedValue(undefined),
};

vi.mock('../../src/adapters/native/index.js', () => ({
  selectNativeAdapter: vi.fn(async () => adapter),
}));

// No @capacitor/app in the test env, so the resume listener is exercised by
// calling the handler the module hands back rather than via a real event.
let resumeHandler: (() => void | Promise<void>) | null = null;
const resumeRemove = vi.fn().mockResolvedValue(undefined);
vi.mock('../../src/core/app-resume-listener.js', () => ({
  attachAppResumeListener: vi.fn(async (opts: { onResume: () => void | Promise<void> }) => {
    resumeHandler = opts.onResume;
    return { remove: resumeRemove };
  }),
}));

import { createIAP } from '../../src/createIAP.js';
import { IAPError, IAPErrorCode } from '../../src/lib/errors.js';
import type { IAPConfigInput } from '../../src/types/config.js';

const config: IAPConfigInput = {
  products: [{ id: 'household_yearly', type: 'subscription' }],
  backend: {
    adapter: {
      verifyApple: vi.fn().mockResolvedValue({
        valid: true,
        entitlements: [{ key: 'household', productId: 'household_yearly', expiresAt: null }],
        transaction: { id: 'tx', productId: 'household_yearly' },
      }),
      verifyGoogle: vi.fn(),
      getEntitlements: vi.fn().mockResolvedValue([]),
      restore: vi.fn().mockResolvedValue({ valid: true, entitlements: [] }),
    },
  },
  options: { logLevel: 'silent' },
};

beforeEach(() => {
  vi.clearAllMocks();
  mockedPlatform = 'ios';
  registered = null;
  resumeHandler = null;
  getOwnedTransactions.mockResolvedValue([]);
  getPendingProductIds.mockResolvedValue([]);
});

describe('initialize() subscribes to the native transaction feed', () => {
  it('registers a listener on a native platform', async () => {
    const iap = createIAP(config);
    await iap.initialize();

    expect(watchTransactions).toHaveBeenCalledTimes(1);
    expect(registered).toBeTypeOf('function');
  });

  it('does not subscribe on web', async () => {
    mockedPlatform = 'web';
    const iap = createIAP(config);
    await iap.initialize();

    expect(watchTransactions).not.toHaveBeenCalled();
  });

  it('routes an arriving transaction through to entitlements', async () => {
    const iap = createIAP(config);
    await iap.initialize();

    const changed: unknown[] = [];
    iap.on('entitlements-changed', (payload) => changed.push(payload));
    const updated: unknown[] = [];
    iap.on('transaction-updated', (payload) => updated.push(payload));

    registered?.({
      platform: 'apple',
      productId: 'household_yearly',
      token: 'renewal-token',
      purchaseReference: 'original-token',
      productType: 'subscription',
    });
    // The listener is fire-and-forget; let its microtasks drain.
    await vi.waitFor(() => expect(changed).toHaveLength(1));

    expect(updated).toHaveLength(1);
    expect(iap.hasEntitlement('household')).toBe(true);
  });

  it('survives an adapter that cannot subscribe', async () => {
    watchTransactions.mockRejectedValueOnce(new Error('no listeners here'));
    const iap = createIAP(config);
    await expect(iap.initialize()).resolves.toBeUndefined();
  });

  it('survives an adapter with no transaction feed at all', async () => {
    // Android today: the plugin notifies no listeners, so the adapter may
    // legitimately resolve null. Recovery and resume cover the same ground.
    watchTransactions.mockResolvedValueOnce(null);
    const iap = createIAP(config);
    await expect(iap.initialize()).resolves.toBeUndefined();
  });
});

describe('destroy() unsubscribes', () => {
  it('removes the listener it registered', async () => {
    const iap = createIAP(config);
    await iap.initialize();
    await iap.destroy();

    expect(watchRemove).toHaveBeenCalledTimes(1);
  });

  it('continues teardown when removal throws', async () => {
    watchRemove.mockRejectedValueOnce(new Error('already gone'));
    const iap = createIAP(config);
    await iap.initialize();

    await expect(iap.destroy()).resolves.toBeUndefined();
    // The adapter's own dispose still ran.
    expect(adapter.dispose).toHaveBeenCalledTimes(1);
  });
});

describe('pending purchases are reconciled', () => {
  it('asks the store nothing at launch when nothing is pending', async () => {
    const iap = createIAP(config);
    await iap.initialize();

    // reconcilePending short-circuits on an empty tracked list.
    expect(getOwnedTransactions).not.toHaveBeenCalled();
  });

  it('attaches a resume handler at all', async () => {
    // Returning from the store's own payment UI is when a pending purchase
    // has most likely resolved, and on Android it is the only signal. That
    // the handler actually reconciles is proved end-to-end by the next test;
    // asserting the absence of a call here would pass with the
    // reconciliation deleted.
    const iap = createIAP(config);
    await iap.initialize();

    expect(resumeHandler).toBeTypeOf('function');
  });

  it('resolves a pending purchase that cleared while the app was closed', async () => {
    mockedPlatform = 'android';
    const iap = createIAP(config);
    await iap.initialize();

    // The purchase was announced pending in an earlier session.
    const resolved: unknown[] = [];
    iap.on('purchase-pending-resolved', (payload) => resolved.push(payload));

    // Simulate that session by driving a pending result through purchase(),
    // then the store reporting it owned on the next resume.
    // Mapping a native message to PURCHASE_PENDING is the real adapter's
    // job (see `capgo/map-purchase-error.ts`), so a stub has to reject with
    // the coded error rather than the raw string.
    (adapter.purchaseProduct as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new IAPError({
        code: IAPErrorCode.PURCHASE_PENDING,
        message: 'Purchase of "household_yearly" is pending external clearance.',
      }),
    );
    const pendingResult = await iap.purchase({ productId: 'household_yearly' });
    expect(pendingResult.status).toBe('pending');

    getOwnedTransactions.mockResolvedValue([
      {
        platform: 'google',
        productId: 'household_yearly',
        token: 'play-token',
        purchaseReference: 'play-token',
        packageName: 'com.example.app',
        productType: 'subscription',
      } satisfies NativeTransaction,
    ]);
    (
      config.backend.adapter as { verifyGoogle: ReturnType<typeof vi.fn> }
    ).verifyGoogle.mockResolvedValue({
      valid: true,
      entitlements: [{ key: 'household', productId: 'household_yearly', expiresAt: null }],
      transaction: { id: 'tx', productId: 'household_yearly' },
    });

    await resumeHandler?.();

    expect(getOwnedTransactions).toHaveBeenCalled();
    expect(resolved).toEqual([{ productId: 'household_yearly', status: 'purchased' }]);
    expect(iap.hasEntitlement('household')).toBe(true);
  });
});
