import { describe, expect, it, vi } from 'vitest';
import type { NativeAdapter } from '../../src/adapters/native/types.js';
import { finalizeTransaction } from '../../src/core/finalize-transaction.js';
import type { ProductType } from '../../src/types/product.js';
import { appleTransaction, playTransaction } from '../mocks/transactions.js';

/**
 * Acknowledge or consume — the decision all four settle paths share.
 *
 * It is worth testing in isolation because getting it wrong is silent in
 * both directions: consuming a subscription is refused by the store, while
 * merely acknowledging a consumable leaves Play reporting it owned forever
 * and the user unable to buy it again.
 */

function makeAdapter(over: Partial<NativeAdapter> = {}): NativeAdapter {
  return {
    isAvailable: vi.fn().mockResolvedValue(true),
    getProducts: vi.fn().mockResolvedValue([]),
    purchaseProduct: vi.fn(),
    getOwnedTransactions: vi.fn().mockResolvedValue([]),
    acknowledge: vi.fn().mockResolvedValue(undefined),
    consume: vi.fn().mockResolvedValue(undefined),
    ...over,
  };
}

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

describe('finalizeTransaction', () => {
  it('consumes an Android consumable', async () => {
    const nativeAdapter = makeAdapter();
    const transaction = playTransaction({ productType: 'consumable' });

    await finalizeTransaction({ nativeAdapter, transaction, logger });

    // Consuming acknowledges *and* releases ownership, so it is one call,
    // never both.
    expect(nativeAdapter.consume).toHaveBeenCalledWith(transaction);
    expect(nativeAdapter.acknowledge).not.toHaveBeenCalled();
  });

  it.each<ProductType>(['product', 'subscription'])(
    'acknowledges an Android %s, which stays owned on purpose',
    async (productType) => {
      const nativeAdapter = makeAdapter();
      const transaction = playTransaction({ productType });

      await finalizeTransaction({ nativeAdapter, transaction, logger });

      expect(nativeAdapter.acknowledge).toHaveBeenCalledWith(transaction);
      expect(nativeAdapter.consume).not.toHaveBeenCalled();
    },
  );

  it('acknowledges an iOS consumable, because finish() is the whole of it there', async () => {
    const nativeAdapter = makeAdapter();
    const transaction = appleTransaction({ productType: 'consumable' });

    await finalizeTransaction({ nativeAdapter, transaction, logger });

    // The plugin rejects consumePurchase() on iOS, and there is nothing to
    // release: `Transaction.finish()` ends a consumable's lifecycle.
    expect(nativeAdapter.acknowledge).toHaveBeenCalledWith(transaction);
    expect(nativeAdapter.consume).not.toHaveBeenCalled();
  });

  it('falls back to acknowledging when the adapter cannot consume, and says so', async () => {
    const warn = vi.fn();
    const nativeAdapter = makeAdapter({ consume: undefined });
    const transaction = playTransaction({ productType: 'consumable' });

    await finalizeTransaction({
      nativeAdapter,
      transaction,
      logger: { ...logger, warn },
    });

    // A custom adapter, or a build against a plugin predating
    // consumePurchase(). The refund window matters most, so acknowledge —
    // but the product will stay owned, which the consumer needs told.
    expect(nativeAdapter.acknowledge).toHaveBeenCalledWith(transaction);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[0]).toContain('ALREADY_PURCHASED');
  });

  it('propagates a consume failure, so the caller can retain and retry', async () => {
    const consume = vi.fn().mockRejectedValue(new Error('billing unavailable'));
    const nativeAdapter = makeAdapter({ consume });

    // Not swallowed: until the consume succeeds Play still reports the
    // product owned, and the unfinished entry the caller keeps on this
    // throw is what gets it retried.
    await expect(
      finalizeTransaction({
        nativeAdapter,
        transaction: playTransaction({ productType: 'consumable' }),
        logger,
      }),
    ).rejects.toThrowError('billing unavailable');
  });

  it('acknowledges on the way out of a failed consume, for the refund window', async () => {
    const consume = vi.fn().mockRejectedValue(new Error('billing unavailable'));
    const nativeAdapter = makeAdapter({ consume });
    const transaction = playTransaction({ productType: 'consumable' });

    await finalizeTransaction({ nativeAdapter, transaction, logger }).catch(() => {});

    // A failed consume leaves the purchase neither consumed nor
    // acknowledged, and Google auto-refunds an unacknowledged purchase
    // after three days — so a transient billing error would cost the user a
    // purchase iap had already granted. Acknowledging stops that clock
    // without closing anything off: an acknowledged purchase can still be
    // consumed, so the retry stays open.
    expect(nativeAdapter.acknowledge).toHaveBeenCalledWith(transaction);
  });

  it('still reports the consume failure when the fallback acknowledge also fails', async () => {
    const nativeAdapter = makeAdapter({
      consume: vi.fn().mockRejectedValue(new Error('billing unavailable')),
      // Which is the normal case: whatever broke the consume has usually
      // broken this too, and if the consume in fact succeeded and only the
      // bridge reply failed, there is no purchase left to acknowledge.
      acknowledge: vi.fn().mockRejectedValue(new Error('not found')),
    });

    await expect(
      finalizeTransaction({
        nativeAdapter,
        transaction: playTransaction({ productType: 'consumable' }),
        logger,
      }),
      // The original error, not the safety net's.
    ).rejects.toThrowError('billing unavailable');
  });
});
