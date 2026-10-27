import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NativeAdapter } from '../../src/adapters/native/types.js';
import type { LocallyVerifiedPurchase } from '../../src/core/local-verification.js';
import type { EntitlementBase } from '../../src/types/entitlement.js';
import type { NativeTransaction } from '../../src/types/transaction.js';

/**
 * Local verification end to end, through `createIAP` — a purchase bought,
 * verified and acknowledged with no backend of any kind.
 *
 * The point of these is that the *flows* are untouched by local mode: the
 * same purchase orchestrator, the same acknowledge-after-verify ordering,
 * the same unfinished-transaction bookkeeping. Only the answer to "is this
 * purchase real" comes from somewhere else.
 */

let mockedPlatform: 'ios' | 'android' | 'web' = 'ios';
vi.mock('@capacitor/core', () => ({
  Capacitor: {
    getPlatform: () => mockedPlatform,
    isNativePlatform: () => mockedPlatform !== 'web',
  },
}));

const acknowledge = vi.fn();
const purchaseProduct = vi.fn();
const getOwnedTransactions = vi.fn();

const adapter: NativeAdapter = {
  isAvailable: vi.fn().mockResolvedValue(true),
  getProducts: vi.fn().mockResolvedValue([]),
  purchaseProduct,
  getOwnedTransactions,
  acknowledge,
  dispose: vi.fn().mockResolvedValue(undefined),
};

vi.mock('../../src/adapters/native/index.js', () => ({
  selectNativeAdapter: vi.fn(async () => adapter),
}));

vi.mock('../../src/core/app-resume-listener.js', () => ({
  attachAppResumeListener: vi.fn(async () => null),
}));

import { LocalVerificationAdapter } from '../../src/adapters/backend/local-adapter.js';
import { MemoryAdapter } from '../../src/adapters/storage/memory-adapter.js';
import { createIAP } from '../../src/createIAP.js';
import { IAPErrorCode } from '../../src/lib/errors.js';
import type { IAPConfigInput } from '../../src/types/config.js';
import { appleTransaction, playTransaction } from '../mocks/transactions.js';

const HOUSEHOLD: EntitlementBase = {
  key: 'household',
  productId: 'household_yearly',
  expiresAt: null,
};

/** The Wren shape: one entitlement per verified purchase of the product. */
function entitlementsFor(purchase: LocallyVerifiedPurchase): EntitlementBase[] {
  return [{ key: 'household', productId: purchase.productId, expiresAt: purchase.expiresAt }];
}

function localConfig(over: Partial<IAPConfigInput> = {}): IAPConfigInput {
  return {
    products: [{ id: 'household_yearly', type: 'subscription' }],
    verification: { mode: 'local', entitlements: entitlementsFor },
    storage: { type: 'memory', namespace: 'test' },
    options: { logLevel: 'silent', refreshOnResume: false },
    ...over,
  } as IAPConfigInput;
}

const appleTx = appleTransaction;
const playTx = playTransaction;

beforeEach(() => {
  vi.clearAllMocks();
  mockedPlatform = 'ios';
  acknowledge.mockResolvedValue(undefined);
  getOwnedTransactions.mockResolvedValue([]);
});

describe('a purchase finishes with no backend', () => {
  it.each([
    ['iOS', 'ios' as const, appleTx],
    ['Android', 'android' as const, playTx],
  ])('%s: verified locally, acknowledged, entitlement granted', async (_name, platform, tx) => {
    mockedPlatform = platform;
    purchaseProduct.mockResolvedValue(tx());

    const iap = createIAP(localConfig());
    await iap.initialize();
    const result = await iap.purchase({ productId: 'household_yearly' });

    expect(result.status).toBe('success');
    // The invariant that matters, and it is unchanged by local mode: the
    // transaction is acknowledged only after verification said yes.
    expect(acknowledge).toHaveBeenCalledTimes(1);
    expect(iap.hasEntitlement('household')).toBe(true);
  });

  it('leaves the transaction unacknowledged when the binding does not match', async () => {
    mockedPlatform = 'ios';
    purchaseProduct.mockResolvedValue(
      appleTx({ appUserId: '00000000-0000-4000-8000-000000000001' }),
    );

    const iap = createIAP(
      localConfig({
        verification: {
          mode: 'local',
          entitlements: entitlementsFor,
          appUserId: '00000000-0000-4000-8000-000000000002',
        },
      }),
    );
    await iap.initialize();
    const result = await iap.purchase({ productId: 'household_yearly' });

    expect(result.status).toBe('verification_failed');
    // Not acknowledged, so the store keeps it and recovery can retry — the
    // same guarantee the backend path gives.
    expect(acknowledge).not.toHaveBeenCalled();
    expect(iap.hasEntitlement('household')).toBe(false);
  });

  it('refuses an expired subscription rather than granting it', async () => {
    mockedPlatform = 'ios';
    purchaseProduct.mockResolvedValue(
      appleTx({
        subscription: {
          state: 'expired',
          autoRenewing: false,
          renewsAt: null,
          renewalProductId: null,
          expiresAt: '2020-01-01T00:00:00Z',
        },
      }),
    );

    const iap = createIAP(localConfig());
    await iap.initialize();
    const result = await iap.purchase({ productId: 'household_yearly' });

    expect(result.status).toBe('verification_failed');
    expect(acknowledge).not.toHaveBeenCalled();
  });
});

describe('refresh with no backend', () => {
  it('re-derives entitlements from what the store owns', async () => {
    // This is why refreshOnResume keeps working offline: there is nothing to
    // reach. The store is the source of truth.
    getOwnedTransactions.mockResolvedValue([playTx()]);
    mockedPlatform = 'android';

    const iap = createIAP(localConfig());
    await iap.initialize();
    await iap.refresh();

    expect(iap.hasEntitlement('household')).toBe(true);
  });

  it('keeps entitlements when the store reports nothing owned', async () => {
    getOwnedTransactions.mockResolvedValue([playTx()]);
    mockedPlatform = 'android';

    const iap = createIAP(localConfig());
    await iap.initialize();
    await iap.refresh();
    expect(iap.hasEntitlement('household')).toBe(true);

    // An empty answer is ambiguous and must not downgrade anyone: Play
    // resolves getPurchases() with an empty array when the query *fails* —
    // disconnected billing service, signed-out account, non-OK response —
    // rather than rejecting. So "owns nothing" and "could not tell you" look
    // identical, and treating the first as authoritative would wipe a paying
    // user's access on a transient store error.
    getOwnedTransactions.mockResolvedValue([]);
    await iap.refresh();

    expect(iap.hasEntitlement('household')).toBe(true);
  });

  it('drops an entitlement when the store reports the purchase revoked', async () => {
    // The unambiguous downgrade, and the one iOS actually reports locally.
    // `Transaction.all` keeps revoked transactions, so a refund shows up as
    // a transaction that is present and revoked rather than as an absence.
    getOwnedTransactions.mockResolvedValue([appleTx()]);
    const iap = createIAP(localConfig());
    await iap.initialize();
    await iap.refresh();
    expect(iap.hasEntitlement('household')).toBe(true);

    getOwnedTransactions.mockResolvedValue([
      appleTx({
        subscription: {
          state: 'revoked',
          autoRenewing: false,
          renewsAt: null,
          renewalProductId: null,
          expiresAt: null,
        },
      }),
    ]);
    await iap.refresh();

    // Without this check a refunded non-expiring purchase would grant
    // forever — it has no expiry to fall back on.
    expect(iap.hasEntitlement('household')).toBe(false);
  });

  it('derives one entitlement per key even when iOS reports history', async () => {
    // getPurchases() on iOS bundles Transaction.all, so one subscription
    // appears once per renewal. Each maps to the same entitlement key.
    getOwnedTransactions.mockResolvedValue([
      appleTx({ token: 'renewal-3' }),
      appleTx({ token: 'renewal-2' }),
      appleTx({ token: 'renewal-1' }),
    ]);

    const iap = createIAP(localConfig());
    await iap.initialize();
    await iap.refresh();

    expect(iap.getEntitlements()).toHaveLength(1);
  });

  it('restores the same way, since it is the same question', async () => {
    getOwnedTransactions.mockResolvedValue([appleTx()]);

    const iap = createIAP(localConfig());
    await iap.initialize();
    const result = await iap.restorePurchases();

    expect(result.restored).toBe(1);
    expect(iap.hasEntitlement('household')).toBe(true);
    expect(result.purchases[0]?.purchaseReference).toBe('2000001043762129');
  });
});

describe('config validation for local mode', () => {
  it('accepts a config with no backend at all', () => {
    expect(() => createIAP(localConfig())).not.toThrow();
  });

  it('refuses a config with neither backend nor verification', () => {
    expect(() =>
      createIAP({ products: [{ id: 'household_yearly', type: 'subscription' }] } as IAPConfigInput),
    ).toThrowError(/backend or verification/);
  });

  it('refuses a config with both', () => {
    // Two answers to the same question, with no rule for which wins.
    expect(() =>
      createIAP(
        localConfig({
          backend: {
            baseUrl: 'https://api.example.com',
            endpoints: { verifyApple: '/a', entitlements: '/e', restore: '/r' },
            getAuthHeaders: async () => ({}),
          },
        }),
      ),
    ).toThrowError(/not both/);
  });

  it('refuses local mode without an entitlements mapper', () => {
    // iap cannot know what a product entitles a user to, and there is no
    // backend to ask.
    expect(() =>
      createIAP(localConfig({ verification: { mode: 'local' } as IAPConfigInput['verification'] })),
    ).toThrowError(/entitlements must be a function/);
  });

  it('refuses local mode without a static product list', () => {
    const config = localConfig();
    (config as { products?: unknown }).products = undefined;
    expect(() => createIAP(config)).toThrowError(/products is required in local verification/);
  });
});

describe('offline semantics', () => {
  it('keeps the cached entitlements when a refresh fails', async () => {
    // Wren's rule, and iap's: a network error never downgrades. Only an
    // authoritative negative or an expiry does.
    getOwnedTransactions.mockResolvedValue([appleTx()]);
    const iap = createIAP(localConfig());
    await iap.initialize();
    await iap.refresh();
    expect(iap.hasEntitlement('household')).toBe(true);

    getOwnedTransactions.mockRejectedValue(new Error('store unreachable'));
    await expect(iap.refresh()).rejects.toThrow();

    // Still entitled: the failure told us nothing about the purchase.
    expect(iap.hasEntitlement('household')).toBe(true);
  });

  it('enforces expiresAt against the device clock', async () => {
    getOwnedTransactions.mockResolvedValue([]);
    const iap = createIAP(localConfig());
    await iap.initialize();

    // Seed a cached entitlement that expires shortly.
    const expiresAt = new Date(Date.now() + 50).toISOString();
    getOwnedTransactions.mockResolvedValue([
      appleTx({
        subscription: {
          state: 'subscribed',
          autoRenewing: true,
          renewsAt: null,
          renewalProductId: null,
          expiresAt,
        },
      }),
    ]);
    await iap.refresh();
    expect(iap.hasEntitlement('household')).toBe(true);

    // No refresh, no network — the deadline alone takes it away, which is
    // the only downgrade that happens offline.
    await vi.waitFor(() => expect(iap.hasEntitlement('household')).toBe(false), { timeout: 500 });
    expect(iap.getEntitlements()).toEqual([]);
    expect(iap.getEntitlement('household')).toBeNull();
  });

  it('honours the grace window past expiresAt', async () => {
    const iap = createIAP(
      localConfig({
        options: { logLevel: 'silent', refreshOnResume: false, entitlementGraceMs: 60_000 },
      }),
    );
    await iap.initialize();

    getOwnedTransactions.mockResolvedValue([
      appleTx({
        subscription: {
          state: 'subscribed',
          autoRenewing: true,
          renewsAt: null,
          renewalProductId: null,
          // Already past, but well inside the grace window.
          expiresAt: new Date(Date.now() - 5_000).toISOString(),
        },
      }),
    ]);
    await iap.refresh();

    // A renewal receipt is not instantaneous; locking a paying user out in
    // that window is the worse error.
    expect(iap.hasEntitlement('household')).toBe(true);
  });

  it('reports when the entitlements were last confirmed', async () => {
    const iap = createIAP(localConfig());
    await iap.initialize();
    expect(iap.getEntitlementsVerifiedAt()).toBeNull();

    getOwnedTransactions.mockResolvedValue([appleTx()]);
    await iap.refresh();

    const verifiedAt = iap.getEntitlementsVerifiedAt();
    expect(verifiedAt).not.toBeNull();
    // Exposed so an app can decide its own staleness tolerance — iap does
    // not revoke on staleness.
    expect(Date.now() - Date.parse(verifiedAt ?? '')).toBeLessThan(5_000);
  });
});

describe('reset()', () => {
  it('leaves nothing of iap in storage', async () => {
    getOwnedTransactions.mockResolvedValue([appleTx()]);
    purchaseProduct.mockResolvedValue(appleTx());

    const iap = createIAP(localConfig());
    await iap.initialize();
    await iap.purchase({ productId: 'household_yearly' });
    await iap.refresh();
    expect(iap.hasEntitlement('household')).toBe(true);

    await iap.reset();

    expect(iap.getEntitlements()).toEqual([]);
    expect(iap.getEntitlementsVerifiedAt()).toBeNull();
  });

  it('emits entitlements-changed carrying the real previous list', async () => {
    getOwnedTransactions.mockResolvedValue([appleTx()]);
    const iap = createIAP(localConfig());
    await iap.initialize();
    await iap.refresh();

    const changed: Array<{ entitlements: unknown[]; previous: unknown[] }> = [];
    iap.on('entitlements-changed', (payload) => changed.push(payload));
    await iap.reset();

    expect(changed).toHaveLength(1);
    expect(changed[0]?.entitlements).toEqual([]);
    // The real previous list, not an empty one. Diffing `previous` against
    // `entitlements` is the documented use, and on the one event that
    // removes everything an empty `previous` would read as "nothing
    // changed".
    expect(changed[0]?.previous).toEqual([HOUSEHOLD]);
  });

  it('emits nothing when there was nothing to remove', async () => {
    // The emitter's de-duplication rule elsewhere: identical lists do not
    // emit. `{ [], [] }` would be a change event describing no change.
    const iap = createIAP(localConfig());
    await iap.initialize();

    const changed: unknown[] = [];
    iap.on('entitlements-changed', (payload) => changed.push(payload));
    await iap.reset();

    expect(changed).toEqual([]);
  });

  it('leaves the instance usable, unlike destroy()', async () => {
    getOwnedTransactions.mockResolvedValue([appleTx()]);
    const iap = createIAP(localConfig());
    await iap.initialize();
    await iap.reset();

    // The purchase is still the user's — they paid for it — so a refresh
    // brings the entitlement back. reset() erases iap's record, not the
    // store's.
    await iap.refresh();
    expect(iap.hasEntitlement('household')).toBe(true);
  });
});

describe('LocalVerificationAdapter — defensive paths', () => {
  function makeAdapter(getNative: () => NativeAdapter | null) {
    return new LocalVerificationAdapter<EntitlementBase>({
      getNativeAdapter: getNative,
      getProducts: () => [{ id: 'household_yearly', type: 'subscription' }],
      entitlements: entitlementsFor,
      getCurrentEntitlements: () => [],
      graceMs: 0,
      logger: { debug() {}, info() {}, warn() {}, error() {} },
    });
  }

  it('refuses to read the store before initialize()', async () => {
    // The native adapter is constructed in initialize(), after this one.
    const local = makeAdapter(() => null);
    await expect(local.getEntitlements()).rejects.toMatchObject({
      code: IAPErrorCode.NOT_INITIALIZED,
    });
  });

  it('throws rather than granting if the extracted verify paths are reached', async () => {
    // The router prefers verifyNative, so these are unreachable. They exist
    // because BackendAdapter requires them, and failing loudly beats
    // silently returning a valid response from a path that checked nothing.
    const local = makeAdapter(() => adapter);
    await expect(local.verifyApple()).rejects.toMatchObject({
      code: IAPErrorCode.INVALID_CONFIG,
    });
    await expect(local.verifyGoogle()).rejects.toMatchObject({
      code: IAPErrorCode.INVALID_CONFIG,
    });
  });

  it('answers restore from the store, ignoring the request it was handed', async () => {
    // A local check needs fields RestoreRequest does not carry, so the
    // request is ignored in favour of asking the store directly.
    getOwnedTransactions.mockResolvedValue([appleTx()]);
    const local = makeAdapter(() => adapter);

    const response = await local.restore({ transactions: [] });

    expect(response).toMatchObject({ valid: true });
    if (response.valid) expect(response.entitlements).toHaveLength(1);
  });
});

describe('a refused purchase stays refused — the paths that are not purchase()', () => {
  /**
   * The invariant "a purchase whose local check fails is never acknowledged"
   * has three paths through it, and the purchase path was the only one that
   * honoured it. These are the other two.
   */
  it('restore acknowledges only the transactions that passed', async () => {
    mockedPlatform = 'ios';
    getOwnedTransactions.mockResolvedValue([
      appleTx({ token: 'ok', productId: 'household_yearly' }),
      // Refused: a product the app does not sell.
      appleTx({ token: 'unknown-product', productId: 'retired_tier' }),
      // Refused: expired.
      appleTx({
        token: 'expired',
        subscription: {
          state: 'expired',
          autoRenewing: false,
          renewsAt: null,
          renewalProductId: null,
          expiresAt: '2020-01-01T00:00:00Z',
        },
      }),
    ]);

    const iap = createIAP(localConfig());
    await iap.initialize();
    await iap.restorePurchases();

    // Acknowledging a refused transaction finalises it: on Android that
    // waives Play's refund window for a purchase just declared invalid, and
    // on iOS it finish()es it so the store never redelivers it.
    const acked = acknowledge.mock.calls.map((call) => (call[0] as NativeTransaction).token);
    expect(acked).toEqual(['ok']);
  });

  it('refuses a restore outright when nothing passed', async () => {
    getOwnedTransactions.mockResolvedValue([appleTx({ productId: 'retired_tier' })]);

    const iap = createIAP(localConfig());
    await iap.initialize();

    await expect(iap.restorePurchases()).rejects.toThrow(/NO_VERIFIED_PURCHASES/);
    expect(acknowledge).not.toHaveBeenCalled();
  });

  it('a purchase refused at purchase time is still refused after a relaunch', async () => {
    // Recovery re-verifies from the **stored entry**, not a live
    // transaction. The entry used to drop the binding, the expiry and the
    // purchase state — so a refused expired subscription came back one
    // launch later, verified against an amputated object, and was granted
    // as a never-expiring entitlement.
    mockedPlatform = 'ios';
    const expired = appleTx({
      subscription: {
        state: 'subscribed',
        autoRenewing: true,
        renewsAt: null,
        renewalProductId: null,
        expiresAt: '2020-01-01T00:00:00Z',
      },
    });

    const storage = new MemoryAdapter('shared');
    const config = localConfig({
      storage: { type: 'custom', namespace: 'shared', adapter: storage },
    });

    purchaseProduct.mockResolvedValue(expired);
    const first = createIAP(config);
    await first.initialize();
    expect((await first.purchase({ productId: 'household_yearly' })).status).toBe(
      'verification_failed',
    );
    expect(acknowledge).not.toHaveBeenCalled();

    // Next launch, same storage: recovery picks the entry up.
    acknowledge.mockClear();
    getOwnedTransactions.mockResolvedValue([]);
    const second = createIAP(config);
    await second.initialize();

    expect(acknowledge).not.toHaveBeenCalled();
    expect(second.hasEntitlement('household')).toBe(false);
  });

  it('recovers a legitimate purchase that carries a binding', async () => {
    // The mirror failure: with verification.appUserId set, a dropped
    // appUserId made every recovered entry fail BINDING_MISMATCH — which is
    // not a permanent error, so it retried every launch, was never
    // acknowledged, and Play refunded it after three days.
    mockedPlatform = 'ios';
    const bound = '550e8400-e29b-41d4-a716-446655440000';
    const storage = new MemoryAdapter('shared2');
    const config = localConfig({
      storage: { type: 'custom', namespace: 'shared2', adapter: storage },
      verification: { mode: 'local', entitlements: entitlementsFor, appUserId: bound },
    });

    // First session: the purchase succeeds natively but the ack fails, so
    // the entry is left for recovery.
    purchaseProduct.mockResolvedValue(appleTx({ appUserId: bound.toUpperCase() }));
    acknowledge.mockRejectedValueOnce(new Error('store busy'));
    const first = createIAP(config);
    await first.initialize();
    await first.purchase({ productId: 'household_yearly' });

    // Next launch: recovery must verify it, not refuse it.
    acknowledge.mockClear();
    acknowledge.mockResolvedValue(undefined);
    getOwnedTransactions.mockResolvedValue([]);
    const second = createIAP(config);
    await second.initialize();

    expect(acknowledge).toHaveBeenCalledTimes(1);
    expect(second.hasEntitlement('household')).toBe(true);
  });
});

describe('local mode consolidates rather than replaces', () => {
  it('an unrelated purchase does not revoke an existing entitlement', async () => {
    // The flows replace state with a verify response, as a backend's would
    // be consolidated. Returning one purchase's worth silently wiped
    // everything else — in memory and on disk — until the next refresh.
    mockedPlatform = 'ios';
    const sub = appleTx({ token: 'sub-token', productId: 'household_yearly' });
    const coins = appleTx({ token: 'coins-token', productId: 'coins', productType: 'product' });

    getOwnedTransactions.mockResolvedValue([sub]);
    const iap = createIAP(
      localConfig({
        products: [
          { id: 'household_yearly', type: 'subscription' },
          { id: 'coins', type: 'product' },
        ],
        verification: {
          mode: 'local',
          entitlements: (purchase) => [
            { key: `ent_${purchase.productId}`, productId: purchase.productId, expiresAt: null },
          ],
        },
      }),
    );
    await iap.initialize();
    await iap.refresh();
    expect(iap.hasEntitlement('ent_household_yearly')).toBe(true);

    // Buy the other thing. The store now reports both.
    getOwnedTransactions.mockResolvedValue([sub, coins]);
    purchaseProduct.mockResolvedValue(coins);
    await iap.purchase({ productId: 'coins' });

    expect(iap.hasEntitlement('ent_coins')).toBe(true);
    expect(iap.hasEntitlement('ent_household_yearly')).toBe(true);
  });

  it('keeps the longest-lasting entitlement when a key is derived twice', async () => {
    // iOS reports historical renewals alongside the current one. Keeping
    // the first seen discarded the live renewal in favour of an older one
    // still inside the grace window, so access lapsed while the
    // subscription had another month to run.
    mockedPlatform = 'ios';
    const soon = new Date(Date.now() + 60_000).toISOString();
    const later = new Date(Date.now() + 30 * 86_400_000).toISOString();
    const withExpiry = (token: string, expiresAt: string) =>
      appleTx({
        token,
        subscription: {
          state: 'subscribed',
          autoRenewing: true,
          renewsAt: null,
          renewalProductId: null,
          expiresAt,
        },
      });

    getOwnedTransactions.mockResolvedValue([
      withExpiry('old-renewal', soon),
      withExpiry('current-renewal', later),
    ]);

    const iap = createIAP(localConfig());
    await iap.initialize();
    await iap.refresh();

    expect(iap.getEntitlement('household')?.expiresAt).toBe(later);
  });
});

describe('the entitlement mapper is not trusted blindly', () => {
  it('grants nothing for a mapper that returns a non-entitlement', async () => {
    // Unlike a backend response, this value never went through a schema. An
    // object with no key could be cached, never match hasEntitlement, and
    // then be dropped by the cache next launch — so entitlements would
    // differ between sessions for no visible reason.
    mockedPlatform = 'ios';
    purchaseProduct.mockResolvedValue(appleTx());
    const iap = createIAP(
      localConfig({
        verification: {
          mode: 'local',
          entitlements: () => [{ nonsense: true } as unknown as EntitlementBase],
        },
      }),
    );
    await iap.initialize();

    const result = await iap.purchase({ productId: 'household_yearly' });
    expect(result.status).toBe('success');
    expect(iap.getEntitlements()).toEqual([]);
  });

  it('does not reject the purchase when the mapper returns a non-array', async () => {
    // It used to throw a raw TypeError out of purchase() — after the
    // transaction had already been acknowledged — which is outside the
    // documented "throws only on impossible states" contract.
    mockedPlatform = 'ios';
    purchaseProduct.mockResolvedValue(appleTx());
    const iap = createIAP(
      localConfig({
        verification: {
          mode: 'local',
          entitlements: () => null as unknown as EntitlementBase[],
        },
      }),
    );
    await iap.initialize();

    await expect(iap.purchase({ productId: 'household_yearly' })).resolves.toMatchObject({
      status: 'success',
    });
    expect(iap.getEntitlements()).toEqual([]);
  });

  it('does not let a throwing mapper break the purchase', async () => {
    mockedPlatform = 'ios';
    purchaseProduct.mockResolvedValue(appleTx());
    const iap = createIAP(
      localConfig({
        verification: {
          mode: 'local',
          entitlements: () => {
            throw new Error('mapper exploded');
          },
        },
      }),
    );
    await iap.initialize();

    await expect(iap.purchase({ productId: 'household_yearly' })).resolves.toMatchObject({
      status: 'success',
    });
  });
});
