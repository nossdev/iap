import { describe, expect, it, vi } from 'vitest';
import type { StorageAdapter } from '../../src/adapters/storage/types.js';
import { EntitlementCache } from '../../src/core/entitlement-cache.js';
import { UnfinishedTransactionsStore } from '../../src/core/unfinished-transactions.js';
import { IAPError, IAPErrorCode } from '../../src/lib/errors.js';
import { makeSilentLogger } from '../mocks/http-helpers.js';
import { playTransaction } from '../mocks/transactions.js';

/**
 * A storage failure that is **not** transient has to keep its own code all
 * the way up.
 *
 * `PreferencesAdapter` raises `INVALID_CONFIG` when its plugin is missing,
 * deliberately not a `STORAGE_ERROR`. The stores used to rebuild every
 * caught error as a `recoverable: true` STORAGE_ERROR, which is the signal
 * the recovery loop acts on — so the entry would be retried at every launch
 * forever for a cause no retry can fix. Testing it at the adapter alone
 * missed that: the property held there and was destroyed one layer up.
 */
const silentLogger = makeSilentLogger();

function failingStorage(error: unknown): StorageAdapter {
  return {
    get: vi.fn(async () => null),
    set: vi.fn(async () => {
      throw error;
    }),
    remove: vi.fn(async () => {}),
    clear: vi.fn(async () => {}),
  };
}

const configError = new IAPError({
  code: IAPErrorCode.INVALID_CONFIG,
  message: '@capacitor/preferences is not installed.',
});

describe('a non-transient storage failure keeps its code', () => {
  it('through EntitlementCache.save()', async () => {
    const cache = new EntitlementCache(failingStorage(configError), silentLogger);

    const error = (await cache.save([]).catch((e: unknown) => e)) as IAPError;

    expect(error.code).toBe(IAPErrorCode.INVALID_CONFIG);
    // The flag that decides whether the recovery loop retries forever.
    expect(error.recoverable).toBe(false);
  });

  it('through UnfinishedTransactionsStore.add()', async () => {
    const store = new UnfinishedTransactionsStore(failingStorage(configError), silentLogger);

    const error = (await store.add(playTransaction()).catch((e: unknown) => e)) as IAPError;

    expect(error.code).toBe(IAPErrorCode.INVALID_CONFIG);
    expect(error.recoverable).toBe(false);
  });
});

describe('an ordinary storage failure still becomes a recoverable STORAGE_ERROR', () => {
  it('through EntitlementCache.save()', async () => {
    const cache = new EntitlementCache(failingStorage(new Error('disk full')), silentLogger);

    const error = (await cache.save([]).catch((e: unknown) => e)) as IAPError;

    // The behaviour that must not change: a genuine, transient storage
    // failure is still classified as retryable.
    expect(error).toBeInstanceOf(IAPError);
    expect(error.code).toBe(IAPErrorCode.STORAGE_ERROR);
    expect(error.recoverable).toBe(true);
  });

  it('through UnfinishedTransactionsStore.add()', async () => {
    const store = new UnfinishedTransactionsStore(
      failingStorage(new Error('disk full')),
      silentLogger,
    );

    const error = (await store.add(playTransaction()).catch((e: unknown) => e)) as IAPError;

    expect(error.code).toBe(IAPErrorCode.STORAGE_ERROR);
    expect(error.recoverable).toBe(true);
  });
});
