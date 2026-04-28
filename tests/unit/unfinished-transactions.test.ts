import { describe, expect, it } from 'vitest';
import { MemoryAdapter } from '../../src/adapters/storage/memory-adapter.js';
import { UnfinishedTransactionsStore } from '../../src/core/unfinished-transactions.js';
import { IAPError, IAPErrorCode } from '../../src/lib/errors.js';
import type { NativeTransaction } from '../../src/types/transaction.js';
import { makeSilentLogger } from '../mocks/http-helpers.js';

const silentLogger = makeSilentLogger();

function makeStore(): { store: UnfinishedTransactionsStore; storage: MemoryAdapter } {
  const storage = new MemoryAdapter('test');
  const store = new UnfinishedTransactionsStore(storage, silentLogger);
  return { store, storage };
}

const sampleApple: NativeTransaction = {
  platform: 'apple',
  productId: 'premium_monthly',
  token: '2000000123456789',
  productType: 'subscription',
};

const sampleGoogle: NativeTransaction = {
  platform: 'google',
  productId: 'premium_monthly',
  token: 'play-tok-abc',
  packageName: 'com.example.app',
  productType: 'subscription',
};

describe('UnfinishedTransactionsStore', () => {
  it('returns empty list when nothing has been added', async () => {
    const { store } = makeStore();
    expect(await store.list()).toEqual([]);
  });

  it('add() appends; list() returns the entries', async () => {
    const { store } = makeStore();
    await store.add(sampleApple);
    const result = await store.list();
    expect(result).toHaveLength(1);
    expect(result[0]?.token).toBe(sampleApple.token);
    expect(result[0]?.platform).toBe('apple');
    expect(result[0]?.recordedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('add() preserves packageName for Google entries', async () => {
    const { store } = makeStore();
    await store.add(sampleGoogle);
    const result = await store.list();
    expect(result[0]?.packageName).toBe('com.example.app');
  });

  it('add() is idempotent on duplicate token', async () => {
    const { store } = makeStore();
    await store.add(sampleApple);
    await store.add(sampleApple); // dup
    expect((await store.list()).length).toBe(1);
  });

  it('add() does NOT collapse different tokens for the same product', async () => {
    const { store } = makeStore();
    await store.add(sampleApple);
    await store.add({ ...sampleApple, token: '2000000999999999' });
    expect((await store.list()).length).toBe(2);
  });

  it('remove() drops the entry by token', async () => {
    const { store } = makeStore();
    await store.add(sampleApple);
    await store.add(sampleGoogle);
    await store.remove(sampleApple.token);
    const result = await store.list();
    expect(result).toHaveLength(1);
    expect(result[0]?.token).toBe(sampleGoogle.token);
  });

  it('remove() with unknown token is a no-op', async () => {
    const { store } = makeStore();
    await store.add(sampleApple);
    await store.remove('does-not-exist');
    expect((await store.list()).length).toBe(1);
  });

  it('clear() empties the list', async () => {
    const { store } = makeStore();
    await store.add(sampleApple);
    await store.add(sampleGoogle);
    await store.clear();
    expect(await store.list()).toEqual([]);
  });

  it('drops malformed JSON and returns empty list', async () => {
    const { store, storage } = makeStore();
    await storage.set('unfinished_transactions', 'not json');
    expect(await store.list()).toEqual([]);
    expect(await storage.get('unfinished_transactions')).toBeNull();
  });

  it('drops envelope of wrong shape and returns empty list', async () => {
    const { store, storage } = makeStore();
    await storage.set('unfinished_transactions', JSON.stringify({ unrelated: true }));
    expect(await store.list()).toEqual([]);
    expect(await storage.get('unfinished_transactions')).toBeNull();
  });

  it('drops list with one invalid entry (treats as fully invalid envelope)', async () => {
    const { store, storage } = makeStore();
    await storage.set(
      'unfinished_transactions',
      JSON.stringify([
        // Missing required fields
        { platform: 'apple' },
      ]),
    );
    expect(await store.list()).toEqual([]);
  });

  it('add() throws IAPError(STORAGE_ERROR) when storage write fails', async () => {
    const failing = {
      async get() {
        return null;
      },
      async set() {
        throw new Error('disk full');
      },
      async remove() {},
      async clear() {},
    };
    const store = new UnfinishedTransactionsStore(failing, silentLogger);
    try {
      await store.add(sampleApple);
      throw new Error('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(IAPError);
      expect((error as IAPError).code).toBe(IAPErrorCode.STORAGE_ERROR);
    }
  });

  it('list() tolerates a storage.get() failure by returning empty', async () => {
    const failing = {
      async get(): Promise<string | null> {
        throw new Error('storage offline');
      },
      async set() {},
      async remove() {},
      async clear() {},
    };
    const store = new UnfinishedTransactionsStore(failing, silentLogger);
    expect(await store.list()).toEqual([]);
  });
});
