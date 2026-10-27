import { beforeEach, describe, expect, it } from 'vitest';
import { MemoryAdapter } from '../../src/adapters/storage/memory-adapter.js';
import { PendingPurchasesStore } from '../../src/core/pending-purchases.js';
import { makeSilentLogger } from '../mocks/http-helpers.js';

/**
 * The product ids iap has announced as awaiting clearance.
 *
 * It is persisted because a pending purchase resolves out of band and
 * usually in another session — a Play e-wallet payment can take hours with
 * the app closed. Without a record that survives a launch, nothing could
 * ever tell the consumer the pending state had ended.
 */

const silentLogger = makeSilentLogger();

describe('PendingPurchasesStore', () => {
  let store: PendingPurchasesStore;
  let storage: MemoryAdapter;

  beforeEach(() => {
    storage = new MemoryAdapter('test');
    store = new PendingPurchasesStore(storage, silentLogger);
  });

  it('round-trips, dedupes, and removes', async () => {
    expect(await store.list()).toEqual([]);
    await store.add('a');
    await store.add('a');
    await store.add('b');
    expect(await store.list()).toEqual(['a', 'b']);
    expect(await store.has('a')).toBe(true);
    await store.remove('a');
    expect(await store.list()).toEqual(['b']);
    expect(await store.has('a')).toBe(false);
    await store.remove('nope');
    expect(await store.list()).toEqual(['b']);
  });

  it('survives a launch — the whole reason it is persisted', async () => {
    await store.add('household_yearly');
    // A Play e-wallet purchase clears hours later, with the app long closed.
    const nextSession = new PendingPurchasesStore(storage, silentLogger);
    expect(await nextSession.list()).toEqual(['household_yearly']);
  });

  it('reads a corrupt payload as empty rather than throwing', async () => {
    await storage.set('pending_purchases', 'not json at all');
    expect(await store.list()).toEqual([]);

    await storage.set('pending_purchases', JSON.stringify({ not: 'a list' }));
    expect(await store.list()).toEqual([]);

    await storage.set('pending_purchases', JSON.stringify(['ok', 42, '']));
    expect(await store.list()).toEqual([]);
  });

  it('does not throw when storage refuses the write', async () => {
    // Losing a pending marker costs a stale UI hint; throwing here would
    // break the purchase call that was only reporting a pending result.
    const failing = {
      async get(): Promise<string | null> {
        return null;
      },
      async set(): Promise<void> {
        throw new Error('disk full');
      },
      async remove() {},
      async clear() {},
    };
    const brittle = new PendingPurchasesStore(failing, silentLogger);
    await expect(brittle.add('a')).resolves.toBeUndefined();
  });
});

describe('PendingPurchasesStore — takeIfPresent', () => {
  let store: PendingPurchasesStore;

  beforeEach(() => {
    store = new PendingPurchasesStore(new MemoryAdapter('test'), silentLogger);
  });

  it('reports the mark it removed, and false when there was none', async () => {
    await store.add('a');
    expect(await store.takeIfPresent('a')).toBe(true);
    expect(await store.list()).toEqual([]);
    expect(await store.takeIfPresent('a')).toBe(false);
    expect(await store.takeIfPresent('never-added')).toBe(false);
  });

  it('hands the mark to exactly one of two concurrent callers', async () => {
    // This is the whole reason the method exists. `purchase-pending-resolved`
    // promises to fire at most once per pending purchase, and the two paths
    // that resolve one can interleave: the iOS transaction listener is
    // fire-and-forget, so it can run alongside the reconciliation that fires
    // on resume. A check-then-remove would let both observe the mark.
    await store.add('household_yearly');

    const results = await Promise.all([
      store.takeIfPresent('household_yearly'),
      store.takeIfPresent('household_yearly'),
      store.takeIfPresent('household_yearly'),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await store.list()).toEqual([]);
  });

  it('does not lose a neighbouring mark to a concurrent take', async () => {
    await store.add('a');
    await store.add('b');

    await Promise.all([store.takeIfPresent('a'), store.takeIfPresent('b')]);

    expect(await store.list()).toEqual([]);
  });

  it('keeps other marks when one is taken', async () => {
    await store.add('a');
    await store.add('b');
    expect(await store.takeIfPresent('a')).toBe(true);
    expect(await store.list()).toEqual(['b']);
  });
});

describe('PendingPurchasesStore — the age limit', () => {
  let store: PendingPurchasesStore;
  let storage: MemoryAdapter;

  beforeEach(() => {
    storage = new MemoryAdapter('test');
    store = new PendingPurchasesStore(storage, silentLogger);
  });

  /** Write the stored payload directly, dated. */
  async function seed(entries: Array<{ productId: string; recordedAt: string }>) {
    await storage.set('pending_purchases', JSON.stringify(entries));
  }

  const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();

  it('keeps a mark inside the window', async () => {
    await seed([{ productId: 'recent', recordedAt: daysAgo(29) }]);
    expect(await store.list()).toEqual(['recent']);
  });

  it('drops a mark past the window, silently', async () => {
    // Expiry is iap giving up on knowing, not the store saying the purchase
    // failed — so it must not surface as `cancelled`. Dropping it here is
    // what keeps `reconcilePending` from asking the store on every single
    // foreground for the life of the install.
    await seed([{ productId: 'ancient', recordedAt: daysAgo(31) }]);
    expect(await store.list()).toEqual([]);
  });

  it('prunes the stored payload, not just the returned list', async () => {
    await seed([
      { productId: 'ancient', recordedAt: daysAgo(400) },
      { productId: 'recent', recordedAt: daysAgo(1) },
    ]);

    expect(await store.list()).toEqual(['recent']);

    // The expired entry is gone from storage too, or it would be re-filtered
    // on every read forever.
    const raw = await storage.get('pending_purchases');
    expect(raw).not.toContain('ancient');
  });

  it('drops an entry whose timestamp cannot be parsed', async () => {
    await seed([{ productId: 'broken', recordedAt: 'not a date' }]);
    expect(await store.list()).toEqual([]);
  });

  it('keeps an entry written before the field existed, and ages it from now', async () => {
    // The upgrade path: the old payload was a bare string array. Dropping
    // those would abandon a live pending purchase on the release that adds
    // the age limit.
    await storage.set('pending_purchases', JSON.stringify(['legacy']));

    expect(await store.list()).toEqual(['legacy']);

    // Re-marking does not reset the clock, but a legacy entry has no clock
    // to reset — it gets one the first time anything else writes.
    await store.add('fresh');
    const raw = await storage.get('pending_purchases');
    expect(raw).toContain('legacy');
    expect(raw).toContain('fresh');
  });

  it('does not reset the age when a product is re-marked', async () => {
    await seed([{ productId: 'waiting', recordedAt: daysAgo(29) }]);
    await store.add('waiting');

    const stored = JSON.parse((await storage.get('pending_purchases')) ?? '[]') as Array<{
      recordedAt: string;
    }>;
    // Still the original date: a purchase that keeps being re-announced must
    // not be able to stay pending indefinitely.
    expect(Date.parse(stored[0]?.recordedAt ?? '')).toBeLessThan(Date.now() - 20 * 86_400_000);
  });
});
