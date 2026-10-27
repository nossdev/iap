import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NativeAdapter } from '../../src/adapters/native/types.js';
import type { LocallyVerifiedPurchase } from '../../src/core/local-verification.js';
import type { EntitlementBase } from '../../src/types/entitlement.js';

/**
 * `verification.appUserId` as a getter, so the binding follows the session.
 *
 * The string form is captured at `createIAP()` time, which in a multi-user
 * app is the previous user's id after a switch — and every purchase made
 * afterwards is then refused as a mismatch, with the instance needing to be
 * torn down and rebuilt to recover.
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

import { createIAP } from '../../src/createIAP.js';
import { IAPError } from '../../src/lib/errors.js';
import type { IAPConfigInput } from '../../src/types/config.js';
import { appleTransaction } from '../mocks/transactions.js';

const ALICE = '00000000-0000-4000-8000-00000000a11c';
const BOB = '00000000-0000-4000-8000-00000000b0b0';

function entitlementsFor(purchase: LocallyVerifiedPurchase): EntitlementBase[] {
  return [{ key: 'household', productId: purchase.productId, expiresAt: purchase.expiresAt }];
}

function localConfig(
  appUserId: string | (() => string | null) | undefined,
  over: Partial<IAPConfigInput> = {},
): IAPConfigInput {
  return {
    products: [{ id: 'household_yearly', type: 'subscription' }],
    verification: { mode: 'local', entitlements: entitlementsFor, appUserId },
    storage: { type: 'memory', namespace: 'test' },
    options: { logLevel: 'silent', refreshOnResume: false },
    ...over,
  } as IAPConfigInput;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedPlatform = 'ios';
  acknowledge.mockResolvedValue(undefined);
  getOwnedTransactions.mockResolvedValue([]);
});

describe('verification.appUserId as a getter', () => {
  it('is read at the time of each check, so a login change takes effect', async () => {
    let signedIn: string | null = ALICE;
    const iap = createIAP(localConfig(() => signedIn));
    await iap.initialize();

    purchaseProduct.mockResolvedValue(appleTransaction({ appUserId: ALICE }));
    expect((await iap.purchase({ productId: 'household_yearly' })).status).toBe('success');

    // The switch. With the string form this is the bug: the binding is
    // still Alice's, so Bob's purchase is refused and the only recovery is
    // to tear the instance down and build a new one.
    signedIn = BOB;
    purchaseProduct.mockResolvedValue(
      appleTransaction({ appUserId: BOB, token: 'bob-token', purchaseReference: 'bob-ref' }),
    );
    expect((await iap.purchase({ productId: 'household_yearly' })).status).toBe('success');
  });

  it('still refuses a purchase bound to someone else', async () => {
    const iap = createIAP(localConfig(() => ALICE));
    await iap.initialize();

    purchaseProduct.mockResolvedValue(appleTransaction({ appUserId: BOB }));
    const result = await iap.purchase({ productId: 'household_yearly' });

    expect(result.status).toBe('verification_failed');
    expect(acknowledge).not.toHaveBeenCalled();
  });

  it('accepts the string form unchanged', async () => {
    const iap = createIAP(localConfig(ALICE));
    await iap.initialize();

    purchaseProduct.mockResolvedValue(appleTransaction({ appUserId: ALICE }));
    expect((await iap.purchase({ productId: 'household_yearly' })).status).toBe('success');
  });

  it('rejects a non-UUID string at config time, as before', () => {
    expect(() => createIAP(localConfig('not-a-uuid'))).toThrowError(IAPError);
  });

  it('rejects a value that is neither a UUID nor a function', () => {
    expect(() => createIAP(localConfig(42 as never))).toThrowError(IAPError);
  });
});

describe('a binding the app cannot currently supply', () => {
  it('refuses the purchase rather than dropping the check', async () => {
    const iap = createIAP(localConfig(() => null));
    await iap.initialize();

    // The purchase carries *someone's* binding. Treating "signed out" as
    // "this app uses no binding" would accept it — a weaker check than the
    // app asked for, silently, and the one failure mode a binding exists
    // to prevent.
    purchaseProduct.mockResolvedValue(appleTransaction({ appUserId: BOB }));
    const result = await iap.purchase({ productId: 'household_yearly' });

    expect(result.status).toBe('verification_failed');
    expect(acknowledge).not.toHaveBeenCalled();
  });

  it('refuses a purchase carrying no binding at all', async () => {
    const iap = createIAP(localConfig(() => null));
    await iap.initialize();

    purchaseProduct.mockResolvedValue(appleTransaction({ appUserId: null }));
    expect((await iap.purchase({ productId: 'household_yearly' })).status).toBe(
      'verification_failed',
    );
  });

  it('keeps the current entitlements on a refresh, rather than revoking them', async () => {
    let signedIn: string | null = ALICE;
    const iap = createIAP(localConfig(() => signedIn));
    await iap.initialize();

    getOwnedTransactions.mockResolvedValue([appleTransaction({ appUserId: ALICE })]);
    await iap.refresh();
    expect(iap.hasEntitlement('household')).toBe(true);

    // A multi-user app restores its session asynchronously, so a refresh
    // can land while the binding is unresolved. "I cannot tell you" must
    // not read as "you own nothing" — the same asymmetry that governs an
    // empty answer from the store.
    signedIn = null;
    await iap.refresh();
    expect(iap.hasEntitlement('household')).toBe(true);

    signedIn = ALICE;
    await iap.refresh();
    expect(iap.hasEntitlement('household')).toBe(true);
  });

  it('fails a restore outright, instead of acknowledging anything', async () => {
    const iap = createIAP(localConfig(() => null));
    await iap.initialize();

    getOwnedTransactions.mockResolvedValue([appleTransaction({ appUserId: ALICE })]);
    await expect(iap.restorePurchases()).rejects.toThrowError(IAPError);
    expect(acknowledge).not.toHaveBeenCalled();
  });

  it('treats a getter that throws the same way, rather than crashing', async () => {
    const iap = createIAP(
      localConfig(() => {
        throw new Error('the session store is not ready');
      }),
    );
    await iap.initialize();

    purchaseProduct.mockResolvedValue(appleTransaction({ appUserId: ALICE }));
    const result = await iap.purchase({ productId: 'household_yearly' });

    expect(result.status).toBe('verification_failed');
    expect(acknowledge).not.toHaveBeenCalled();
  });

  it('treats an empty string as no account, not as a binding', async () => {
    const iap = createIAP(localConfig(() => ''));
    await iap.initialize();

    purchaseProduct.mockResolvedValue(appleTransaction({ appUserId: '' }));
    expect((await iap.purchase({ productId: 'household_yearly' })).status).toBe(
      'verification_failed',
    );
  });
});

describe('no binding configured', () => {
  it('checks nothing, as before', async () => {
    const iap = createIAP(localConfig(undefined));
    await iap.initialize();

    // A purchase from before the app started binding carries none, and a
    // purchase bound to anyone passes — which is what "this app does not
    // bind purchases" has always meant.
    purchaseProduct.mockResolvedValue(appleTransaction({ appUserId: null }));
    expect((await iap.purchase({ productId: 'household_yearly' })).status).toBe('success');

    purchaseProduct.mockResolvedValue(
      appleTransaction({ appUserId: BOB, token: 'other', purchaseReference: 'other-ref' }),
    );
    expect((await iap.purchase({ productId: 'household_yearly' })).status).toBe('success');
  });
});
