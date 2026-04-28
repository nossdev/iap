import { describe, expect, it } from 'vitest';
import { MemoryAdapter } from '../../src/adapters/storage/memory-adapter.js';
import { EntitlementCache } from '../../src/core/entitlement-cache.js';
import type { EntitlementBase } from '../../src/types/entitlement.js';
import { makeSilentLogger } from '../mocks/http-helpers.js';

interface AppEntitlement extends EntitlementBase {
  tier?: 'basic' | 'pro';
}

const silentLogger = makeSilentLogger();

function makeCache(): {
  cache: EntitlementCache<AppEntitlement>;
  storage: MemoryAdapter;
} {
  const storage = new MemoryAdapter('test');
  const cache = new EntitlementCache<AppEntitlement>(storage, silentLogger);
  return { cache, storage };
}

describe('EntitlementCache', () => {
  it('returns null when nothing has been saved', async () => {
    const { cache } = makeCache();
    expect(await cache.load()).toBeNull();
  });

  it('roundtrips entitlements with cachedAt timestamp', async () => {
    const { cache } = makeCache();
    const before = Date.now();
    await cache.save([
      { key: 'premium', productId: 'premium_monthly', expiresAt: '2026-12-01T00:00:00Z' },
    ]);
    const after = Date.now();

    const result = await cache.load();
    expect(result).not.toBeNull();
    expect(result?.entitlements).toHaveLength(1);
    expect(result?.entitlements[0]?.key).toBe('premium');
    expect(result?.cachedAt).toBeGreaterThanOrEqual(before);
    expect(result?.cachedAt).toBeLessThanOrEqual(after);
  });

  it('preserves consumer-defined fields on the entitlement', async () => {
    const { cache } = makeCache();
    await cache.save([
      { key: 'premium', productId: 'premium_monthly', expiresAt: null, tier: 'pro' },
    ]);
    const result = await cache.load();
    expect(result?.entitlements[0]?.tier).toBe('pro');
  });

  it('drops malformed JSON and returns null', async () => {
    const { cache, storage } = makeCache();
    await storage.set('entitlements', 'this is not json');
    const result = await cache.load();
    expect(result).toBeNull();
    // The corrupt entry was cleared.
    expect(await storage.get('entitlements')).toBeNull();
  });

  it('drops envelope with wrong shape and returns null', async () => {
    const { cache, storage } = makeCache();
    await storage.set('entitlements', JSON.stringify({ unrelated: true }));
    expect(await cache.load()).toBeNull();
    expect(await storage.get('entitlements')).toBeNull();
  });

  it('drops individual entitlements that fail base validation', async () => {
    const { cache, storage } = makeCache();
    const envelope = {
      cachedAt: Date.now(),
      entitlements: [
        { key: 'premium', productId: 'premium_monthly', expiresAt: null },
        { key: '', productId: 'remove_ads', expiresAt: null }, // invalid key
        { productId: 'orphan', expiresAt: null }, // missing key
      ],
    };
    await storage.set('entitlements', JSON.stringify(envelope));

    const result = await cache.load();
    expect(result?.entitlements).toHaveLength(1);
    expect(result?.entitlements[0]?.key).toBe('premium');
  });

  it('clear() removes the cache key', async () => {
    const { cache, storage } = makeCache();
    await cache.save([{ key: 'premium', productId: 'premium_monthly', expiresAt: null }]);
    expect(await storage.get('entitlements')).not.toBeNull();
    await cache.clear();
    expect(await storage.get('entitlements')).toBeNull();
    expect(await cache.load()).toBeNull();
  });

  it('save() throws IAPError(STORAGE_ERROR) when the underlying storage fails', async () => {
    const failingStorage = {
      async get() {
        return null;
      },
      async set() {
        throw new Error('disk full');
      },
      async remove() {
        // ok
      },
      async clear() {
        // ok
      },
    };
    const cache = new (await import('../../src/core/entitlement-cache.js')).EntitlementCache(
      failingStorage,
      silentLogger,
    );
    try {
      await cache.save([{ key: 'premium', productId: 'premium_monthly', expiresAt: null }]);
      throw new Error('should have rejected');
    } catch (error) {
      const { IAPError, IAPErrorCode } = await import('../../src/lib/errors.js');
      expect(error).toBeInstanceOf(IAPError);
      expect((error as InstanceType<typeof IAPError>).code).toBe(IAPErrorCode.STORAGE_ERROR);
    }
  });

  it('load() tolerates a storage.get() failure by returning null', async () => {
    const failingStorage = {
      async get() {
        throw new Error('storage offline');
      },
      async set() {},
      async remove() {},
      async clear() {},
    };
    const cache = new (await import('../../src/core/entitlement-cache.js')).EntitlementCache(
      failingStorage,
      silentLogger,
    );
    expect(await cache.load()).toBeNull();
  });
});
